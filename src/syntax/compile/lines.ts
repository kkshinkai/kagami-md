/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Event, Token, TokenizeContext } from '../types/index.js';
import type { DocumentSpelling } from '../syntax/block.js';
import { assert } from '../kernel/assert.js';
import { constants, types } from '../kernel/utils/symbol/index.js';
import { columns } from './spelling.js';

/**
 * Kagami: find the blank lines around blocks, the spaces before them, and
 * how far the lines that continue a paragraph in a list item or a
 * footnote definition are indented, and leave them on the tokens of blocks,
 * as `prepareList` leaves `_spread` (private-docs/design/syntax/blank-lines.md,
 * lists.md).
 *
 * A blank line holds nothing but the prefixes of containers.
 * It is counted in the innermost container it is in. Between siblings,
 * the upper sibling takes a single blank; with more, the lower takes one
 * and the upper takes the rest. At the ends, the container takes them.
 * The line of a list item’s marker or a footnote definition’s label with
 * nothing after it is no blank line.
 *
 * @param events
 *   Events.
 * @returns
 *   The document's start and end gaps.
 */
export function prepareLines(events: Array<Event>): DocumentSpelling {
  return new LinePreparation().prepare(events);
}

/** State of one pass assigning line endings, blank lines, and indentation to their owners. */
class LinePreparation {
  gaps: DocumentSpelling = { start: 0, end: 0 };
  document: Book = {
    token: undefined,
    blank: 0,
    last: undefined,
    children: 0,
    firstLineEnded: false,
    indents: [],
    indentEnd: -1,
    taken: 0,
  };
  books: Array<Book> = [this.document];
  line: Line = { start: 0, covered: 0, cursor: 1, pending: undefined, literal: undefined };

  prepare(events: Array<Event>): DocumentSpelling {
    const open: Array<Token> = [];

    let linePrefix: [Token, TokenizeContext] | undefined;
    let literal = 0;
    let index = -1;

    while (++index < events.length) {
      const event = events[index]!;
      const token = event[1];
      const book = this.books[this.books.length - 1]!;

      if (event[0] === 'enter') {
        if (!literal && blockTypes.includes(token.type)) {
          this.line.literal = undefined;
          if (book.last) {
            token._leadingBlankLines = book.blank > 1 ? 1 : 0;
            book.last._trailingBlankLines = book.blank - token._leadingBlankLines;
          } else if (book.token) {
            book.token._startBlankLines = book.blank;
          } else {
            this.gaps.start = book.blank;
          }

          // The spaces before a list are before its first item’s marker, and
          // the item’s.
          token._spacesBeforeBlock =
            linePrefix &&
            linePrefix[0].end.offset === token.start.offset &&
            token.type !== types.listOrdered &&
            token.type !== types.listUnordered
              ? columns(linePrefix[1], linePrefix[0])
              : 0;
          book.blank = 0;
          book.last = token;
          book.children++;
        }

        if (containerTypes.includes(token.type)) {
          this.books.push({
            token,
            blank: 0,
            last: undefined,
            children: 0,
            firstLineEnded: false,
            indents: [],
            indentEnd: -1,
            taken: token.type === 'gfmFootnoteDefinition' ? constants.tabSize : 0,
          });
        }

        if (literalTypes.includes(token.type)) {
          literal++;
        }

        open.push(token);
        continue;
      }

      open.pop();

      switch (token.type) {
        case types.lineEnding:
        case types.lineEndingBlank: {
          const counted = this.endLine(token.start.offset, true);
          this.line = {
            start: token.end.offset,
            covered: token.end.offset,
            cursor: 1,
            pending: undefined,
            literal: undefined,
          };

          // At the level of a container, not in literal text.
          if (literal || open[open.length - 1] !== book.token) {
            break;
          }

          if (
            !book.children &&
            !book.firstLineEnded &&
            book.token &&
            (book.token.type === 'listItem' || book.token.type === 'gfmFootnoteDefinition')
          ) {
            book.firstLineEnded = true;
          } else if (token.type === types.lineEndingBlank && !counted) {
            book.blank++;
          }

          break;
        }

        case types.linePrefix: {
          this.cover(token);
          linePrefix = [token, event[2]];
          // Indentation beyond what a container takes, on a line that
          // continues its paragraph.
          const owner = this.books[this.line.cursor - 1];

          if (owner && owner.indentEnd === token.start.offset && inParagraph(open)) {
            owner.indents[owner.indents.length - 1]! += columns(event[2], token);
          }

          break;
        }

        case types.blockQuotePrefix: {
          this.cover(token);
          const owner = this.next(types.blockQuote);
          // Phrasing fragments omit ancestor books; inline padding can also
          // absorb the ending that advances this cursor. Such an interior
          // prefix cannot extend a container beyond its child's body.
          if (owner && owner.token) owner.token._lastPrefixEnd = token.end.offset;
          break;
        }

        case types.listItemIndent:
        case 'gfmFootnoteDefinitionIndent': {
          this.cover(token);
          const owner = this.next(
            token.type === types.listItemIndent ? 'listItem' : 'gfmFootnoteDefinition'
          );

          // Only a line that continues a paragraph of the container’s own
          // shows how far the author indents.
          if (owner && owner.token && ownParagraph(open, owner.token)) {
            owner.indents.push(columns(event[2], token));
            owner.indentEnd = token.end.offset;
          }

          break;
        }

        case types.listItemPrefix: {
          assert(book.token, 'expected an item');
          book.taken = (book.token._spacesBeforeBlock || 0) + columns(event[2], token);
          break;
        }

        case types.codeIndented: {
          // Its token runs over a last line of only spaces, which is no code.
          this.atEnd(book, token.end.offset);
          break;
        }

        // No default
      }

      if (literalTypes.includes(token.type)) {
        // A container may end on a literal's empty final row, including an
        // EOF row whose prefix follows the literal token's end. That row
        // belongs to the field, not also to a container blank-line gap.
        // Indented code alone discards its empty edge rows.
        if (token.type !== types.codeIndented && token.end.offset >= this.line.start) {
          this.line.literal = token;
        }
        literal--;
      }

      if (containerTypes.includes(token.type)) {
        this.atEnd(book, token.end.offset);
        this.close(book);
        this.books.pop();
      }
    }

    const end = events.length > 0 ? events[events.length - 1]![1].end.offset : 0;
    this.atEnd(this.document, end);
    this.endLine(end);

    this.close(this.document);
    return this.gaps;
  }

  /**
   * Give the blank lines at a container's ends to the container.
   *
   * @param book
   *   Container.
   * @returns
   *   Nothing.
   */
  close(book: Book): undefined {
    if (book.token) {
      if (book.children) {
        book.token._endBlankLines = book.blank;
      } else if (book.token.type === types.blockQuote) {
        // The opening marker stands on its own row. Only the rows
        // after it are the quote's ending blank lines.
        book.token._startBlankLines = 0;
        book.token._endBlankLines = Math.max(0, book.blank - 1);
      } else {
        book.token._startBlankLines = book.blank;
      }
    } else if (book.children) {
      this.gaps.end = book.blank;
    } else {
      this.gaps.start = book.blank;
    }

    if (book.token) {
      book.token._startsOnFirstLine = !book.children || !book.firstLineEnded;

      if (book.token.type === 'listItem' || book.token.type === 'gfmFootnoteDefinition') {
        book.token._continuationIndent = continuation(book.indents, book.taken);
      }
    }
  }

  /**
   * A prefix on the line.
   *
   * @param token
   *   Prefix.
   * @returns
   *   Nothing.
   */
  cover(token: Token): undefined {
    if (this.line.covered === token.start.offset) {
      this.line.covered = token.end.offset;
    }
  }

  /**
   * The next open container of `type` on the line: a continued line gives
   * the prefixes of its containers in order, outermost first.
   *
   * @param type
   *   Type of the container.
   * @returns
   *   Container, or nothing.
   */
  next(type: string): Book | undefined {
    while (this.line.cursor < this.books.length) {
      const book = this.books[this.line.cursor++]!;

      if (book.token && book.token.type === type) {
        return book;
      }
    }

    return undefined;
  }

  /**
   * A block that ends at `end` on a line that holds only prefixes so far:
   * if nothing follows on the line, it is a blank line of `book`, though
   * its line ending comes after the block.
   *
   * @param book
   *   Container.
   * @param end
   *   Offset.
   * @returns
   *   Nothing.
   */
  atEnd(book: Book, end: number): undefined {
    if (!this.line.literal && !this.line.pending && end > this.line.start && this.line.covered === end) {
      // A list has no prefix on a continued line. If it closes after a
      // quote's prefix, that blank line is still in the quote, not the
      // list that happened to end there.
      this.line.pending = this.books[Math.min(this.line.cursor - 1, this.books.length - 1)] || book;
    }
  }

  /**
   * The end of the line, at `end`: whether it was a blank line that a
   * block which ended on it takes.
   *
   * @param end
   *   Offset.
   * @param ending
   *   Whether a physical ending terminates this line.
   * @returns
   *   Whether it was.
   */
  endLine(end: number, ending = false): boolean {
    // Kagami: a flow token can stop before its final blank row. A physical
    // ending, or a prefix-only EOF row, proves that the pending literal
    // ending separates two content lines. A following block proves no row.
    if (
      this.line.literal &&
      this.line.covered === end &&
      (ending || end > this.line.start)
    ) {
      this.line.literal._literalFinalBlankLine = true;
    }
    const book = this.line.pending;

    if (!book || this.line.covered !== end) {
      return false;
    }

    if (this.books.includes(book)) {
      // Prefixes can be omitted on a blank line inside a continuing list.
      // If that list is still open at the line ending, it owns the boundary;
      // a prefix-only ancestor must not carry it to a later outer sibling.
      this.books[this.books.length - 1]!.blank++;
    } else if (book.token) {
      if (book.children || book.token.type === types.blockQuote) {
        if (!book.children && book.token.start.line === book.token.end.line) {
          // The sole row is the empty paragraph's, not a container gap.
          return true;
        }
        book.token._endBlankLines = (book.token._endBlankLines || 0) + 1;
      } else {
        book.token._startBlankLines = (book.token._startBlankLines || 0) + 1;
      }
    }

    return true;
  }
}

/**
 * What the lines of a container hold while they are prepared.
 */
interface Book {
  /**
   * Token of the container; nothing for the document.
   */
  token: Token | undefined;
  /**
   * Blank lines since the last child.
   */
  blank: number;
  /**
   * Last child.
   */
  last: Token | undefined;
  /**
   * How many children it has.
   */
  children: number;
  /**
   * Whether the line of its marker or label has ended.
   */
  firstLineEnded: boolean;
  /**
   * Indentation of each line that continues a paragraph of its own, in
   * columns.
   */
  indents: Array<number>;
  /**
   * Offset where the last of those indents ends.
   */
  indentEnd: number;
  /**
   * Columns the container takes of each of its lines.
   */
  taken: number;
}

/**
 * The line being prepared.
 */
interface Line {
  /**
   * Offset where it starts.
   */
  start: number;
  /**
   * Offset up to which it holds only prefixes.
   */
  covered: number;
  /**
   * Index of the next container whose prefix the line gives.
   */
  cursor: number;
  /**
   * Container that takes the line as blank, if nothing follows on it.
   */
  pending: Book | undefined;
  /** Literal whose final row may follow its token and hold only container prefixes. */
  literal: Token | undefined;
}

export const blockTypes: Array<string> = [
  'frontmatter',
  types.atxHeading,
  types.blockQuote,
  types.codeFenced,
  types.codeIndented,
  types.definition,
  'gfmFootnoteDefinition',
  types.htmlFlow,
  'listItem',
  types.listOrdered,
  types.listUnordered,
  'mathFlow',
  types.paragraph,
  types.setextHeading,
  'table',
  types.thematicBreak,
];

export const containerTypes: Array<string> = [
  types.blockQuote,
  'gfmFootnoteDefinition',
  'listItem',
  types.listOrdered,
  types.listUnordered,
];

const literalTypes: Array<string> = [
  types.codeFenced,
  types.codeIndented,
  'frontmatter',
  types.htmlFlow,
  'mathFlow',
];

/**
 * Whether the innermost open token is the text of a paragraph.
 *
 * @param open
 *   Open tokens, outermost first.
 * @returns
 *   Whether it is.
 */
function inParagraph(open: Array<Token>): boolean {
  const tail = open[open.length - 1];
  return Boolean(tail && (tail.type === types.paragraph || tail.type === types.setextHeadingText));
}

/**
 * Whether a line continues a paragraph that is a child of `container`.
 *
 * @param open
 *   Open tokens, outermost first.
 * @param container
 *   Container.
 * @returns
 *   Whether it does.
 */
function ownParagraph(open: Array<Token>, container: Token): boolean {
  const index = open.indexOf(container);
  const child = open[index + 1];
  const grandchild = open[index + 2];
  return Boolean(
    child &&
      grandchild &&
      ((child.type === types.content && grandchild.type === types.paragraph) ||
        (child.type === types.setextHeading && grandchild.type === types.setextHeadingText))
  );
}

/**
 * The indentation the author gives the lines that continue a paragraph: the
 * most frequent of those not lazy, the first of them on a tie, brought within
 * what the container can hold (private-docs/design/syntax/lists.md).
 *
 * @param indents
 *   Indentation of each line, in columns.
 * @param taken
 *   Columns the container takes.
 * @returns
 *   Indentation, or nothing when no line shows it.
 */
function continuation(indents: Array<number>, taken: number): number | null {
  const counts = new Map<number, number>();
  let best: number | undefined;
  let index = -1;

  while (++index < indents.length) {
    const indent = indents[index]!;

    if (indent >= taken) {
      counts.set(indent, (counts.get(indent) || 0) + 1);
    }
  }

  // A map keeps the order in which its keys were first set.
  counts.forEach(function (count, indent) {
    if (best === undefined || count > counts.get(best)!) {
      best = indent;
    }
  });

  return best === undefined ? null : Math.min(best, taken + constants.tabSize - 1);
}
