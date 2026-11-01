/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { FootnoteLabelSyntax, TableCellSyntax } from '../syntax/block.js';
import {
  DelimiterTokenSyntax,
  PendingATXHeadingMarkerSyntax,
  PendingBlockQuoteMarkerSyntax,
  PendingCodeFenceSyntax,
  PendingFootnoteLabelSyntax,
  PendingHTMLBlockSyntax,
  PendingListMarkerSyntax,
  PendingMathFenceSyntax,
  PendingSetextUnderlineSyntax,
  PendingSyntax,
  PendingTableSyntax,
  PendingThematicBreakSyntax,
  TextTokenSyntax,
  TriviaTokenSyntax,
  type StringSegmentSyntax,
  type LineEndingSyntax,
} from '../syntax/inline.js';
import { type SourceRange } from '../syntax/syntax.js';
// The text of a paragraph that ends in a block the editor does not convert yet, read for the
// editor. The design is in private-docs/design/syntax/for-the-editor.md, "Pending"; the rows
// are those of private-docs/rules/pending.md.
//
// Kagami’s own. The text is read as blocks with the phrasing document grammar.
// When its last block runs to the end of the text and has the shape of a row, that block
// is the row’s node, made from its tokens, and what stands before it is read as the field it
// is. No character is looked at: a shape is told by the kinds of the tokens and where they end.

import type { Event, Token, TokenType } from '../types/index.js';

import type { Options } from './types.js';
import { assert } from '../kernel/assert.js';
import { types } from '../kernel/utils/symbol/index.js';
import { createCompiler as compiler } from './tree.js';
import { finishNode } from './envelope.js';
import { parseEvents } from './events.js';
import { postprocess } from '../kernel/postprocess.js';
import { normalizeIdentifier } from '../kernel/utils/normalize-identifier/index.js';
import { toString } from './to-string.js';
import type { Bindings } from '../syntax/reading.js';

/** Build only the pending tail selected by the paragraph's structural events. */
export function pendingTail(
  events: Array<Event>,
  value: string,
  inlineOptions: Options.Text
): PendingSyntax | undefined {
  return new PendingCompiler(events, value, inlineOptions).read();
}

/** Compile one pending tail and its nested fields from a shared event reading. */
class PendingCompiler {
  constructor(
    readonly events: Array<Event>,
    readonly value: string,
    readonly options: Options.Text
  ) {}

  /** Select the final block only when it reaches the end of the input. */
  read(): PendingSyntax | undefined {
    const enter = lastBlock(this.events);
    if (enter === undefined || this.events[enter][1].end.offset !== this.value.length) return;
    return this.block(enter);
  }

  /** Make the pending node of a block when it has the shape of a Pending row. */
  block(enter: number): PendingSyntax | undefined {
    const block = this.events[enter][1];
    const tokens = this.tokens(enter, 'enter');

    switch (block.type) {
      case types.codeFenced:
        return this.codeFence(enter, tokens);
      case 'mathFlow':
        return this.mathFence(enter, tokens);
      case types.listOrdered:
      case types.listUnordered:
        return this.listMarker(block, tokens);
      case types.atxHeading:
        return this.atxHeading(block, tokens);
      case types.thematicBreak:
        return this.thematicBreak(block);
      case types.blockQuote:
        return this.blockQuote(enter, tokens);
      case 'gfmFootnoteDefinition':
        return this.footnote(block, tokens);
      case types.setextHeading:
        return this.setextHeading(block, tokens);
      case 'table':
        return this.table(enter, tokens);
      case types.htmlFlow:
        return this.html(block);
      default:
        return;
    }
  }

  /** Read the selected block's events in their existing order. */
  tokens(enter: number, kind: 'enter' | 'exit'): Array<Token> {
    const block = this.events[enter][1];
    const tokens: Array<Token> = [];
    let index = enter;
    while (++index < this.events.length && this.events[index][1] !== block) {
      const event = this.events[index];
      if (event[0] === kind) tokens.push(event[1]);
    }
    return tokens;
  }

  /** An opening code fence, alone on its line. */
  codeFence(enter: number, tokens: Array<Token>): PendingCodeFenceSyntax | undefined {
    const block = this.events[enter][1];
    const start = block.start.offset;
    const end = block.end.offset;
    if (block.start.line !== block.end.line) {
      return;
    }

    const pendingCodeFence = new PendingCodeFenceSyntax();
    pendingCodeFence.start = start;
    pendingCodeFence.end = end;
    pendingCodeFence.fence = new DelimiterTokenSyntax(
      'codeFence',
      get(tokens, types.codeFencedFenceSequence).start.offset,
      get(tokens, types.codeFencedFenceSequence).end.offset
    );
    for (const token of this.tokens(enter, 'exit')) {
      if (token.type === types.codeFencedFenceInfo) {
        pendingCodeFence.info = new DelimiterTokenSyntax(
          'infoString',
          token.start.offset,
          token.end.offset
        );
      } else if (token.type === types.codeFencedFenceMeta) {
        pendingCodeFence.meta = new DelimiterTokenSyntax(
          'codeFenceMeta',
          token.start.offset,
          token.end.offset
        );
      } else if (token.type === types.whitespace) {
        const separators = pendingCodeFence.info
          ? pendingCodeFence.infoSeparators
          : pendingCodeFence.separators;
        separators.push(
          new TriviaTokenSyntax('codeFenceWhitespace', token.start.offset, token.end.offset)
        );
      }
    }
    return pendingCodeFence;
  }

  /** An opening math fence, alone on its line. */
  mathFence(enter: number, tokens: Array<Token>): PendingMathFenceSyntax | undefined {
    const block = this.events[enter][1];
    const start = block.start.offset;
    const end = block.end.offset;
    if (block.start.line !== block.end.line) {
      return;
    }

    const meta = find(tokens, 'mathFlowFenceMeta');
    const pendingMathFence = new PendingMathFenceSyntax();
    pendingMathFence.start = start;
    pendingMathFence.end = end;
    pendingMathFence.fence = new DelimiterTokenSyntax(
      'mathFence',
      get(tokens, 'mathFlowFenceSequence').start.offset,
      get(tokens, 'mathFlowFenceSequence').end.offset
    );
    for (const token of this.tokens(enter, 'exit')) {
      if (token.type === types.whitespace) {
        pendingMathFence.separators.push(
          new TriviaTokenSyntax('mathFenceWhitespace', token.start.offset, token.end.offset)
        );
      }
    }
    pendingMathFence.meta = meta
      ? new DelimiterTokenSyntax('mathMeta', meta.start.offset, meta.end.offset)
      : null;
    return pendingMathFence;
  }

  /** One list marker, and nothing after it. */
  listMarker(block: Token, tokens: Array<Token>): PendingListMarkerSyntax | undefined {
    const start = block.start.offset;
    const end = block.end.offset;
    if (
      count(tokens, types.listItemPrefix) !== 1 ||
      !endsWith(tokens, types.listItemMarker, end)
    ) {
      return;
    }

    const pendingListMarker = new PendingListMarkerSyntax();
    pendingListMarker.start = start;
    pendingListMarker.end = end;
    pendingListMarker.marker = new DelimiterTokenSyntax(
      'listMarker',
      get(tokens, types.listItemPrefix).start.offset,
      get(tokens, types.listItemPrefix).end.offset
    );
    return pendingListMarker;
  }

  /** One heading marker sequence, and nothing after it. */
  atxHeading(block: Token, tokens: Array<Token>): PendingATXHeadingMarkerSyntax | undefined {
    const start = block.start.offset;
    const end = block.end.offset;
    if (
      count(tokens, types.atxHeadingSequence) !== 1 ||
      !endsWith(tokens, types.atxHeadingSequence, end)
    ) {
      return;
    }

    const pendingATXHeadingMarker = new PendingATXHeadingMarkerSyntax();
    pendingATXHeadingMarker.start = start;
    pendingATXHeadingMarker.end = end;
    pendingATXHeadingMarker.marker = new DelimiterTokenSyntax(
      'atxHeadingMarker',
      get(tokens, types.atxHeadingSequence).start.offset,
      get(tokens, types.atxHeadingSequence).end.offset
    );
    return pendingATXHeadingMarker;
  }

  /** A thematic break whose marker run is still being typed. */
  thematicBreak(block: Token): PendingThematicBreakSyntax {
    const start = block.start.offset;
    const end = block.end.offset;
    const pendingThematicBreak = new PendingThematicBreakSyntax();
    pendingThematicBreak.start = start;
    pendingThematicBreak.end = end;
    return pendingThematicBreak;
  }

  /** Quote markers, and nothing after them. */
  blockQuote(enter: number, tokens: Array<Token>): PendingBlockQuoteMarkerSyntax | undefined {
    const block = this.events[enter][1];
    const start = block.start.offset;
    const end = block.end.offset;
    if (!emptyQuotes(block, tokens)) return;
    const pendingBlockQuoteMarker = new PendingBlockQuoteMarkerSyntax();
    pendingBlockQuoteMarker.start = start;
    pendingBlockQuoteMarker.end = end;
    pendingBlockQuoteMarker.markers = ranges(tokens, types.blockQuoteMarker).map(
      function (range) {
        return new DelimiterTokenSyntax('blockQuoteMarker', range.start, range.end);
      }
    );
    pendingBlockQuoteMarker.lineEndings = lineEndingsIn(tokens);
    for (const token of this.tokens(enter, 'exit')) {
      if (
        token.type === types.blockQuotePrefixWhitespace ||
        token.type === types.linePrefix ||
        token.type === types.lineSuffix
      ) {
        pendingBlockQuoteMarker.separators.push(
          new TriviaTokenSyntax('blockQuoteWhitespace', token.start.offset, token.end.offset)
        );
      }
    }
    return pendingBlockQuoteMarker;
  }

  /** A footnote label and its colon, and nothing after them. */
  footnote(block: Token, tokens: Array<Token>): PendingFootnoteLabelSyntax | undefined {
    const start = block.start.offset;
    const end = block.end.offset;
    const events = this.events;
    const value = this.value;
    const inlineOptions = this.options;
    if (
      count(tokens, 'gfmFootnoteDefinition') !== 0 ||
      !endsWith(tokens, types.definitionMarker, end)
    ) {
      return;
    }

    const labelToken = get(tokens, 'gfmFootnoteDefinitionLabelString');
    const innerStart = labelToken.start.offset;
    const innerEnd = labelToken.end.offset;
    const closing = tokens.find(
      (token) =>
        token.type === 'gfmFootnoteDefinitionLabelMarker' && token.start.offset === innerEnd
    );
    assert(closing, 'expected the closing label marker');
    const colon = get(tokens, types.definitionMarker);
    const labelEnter = events.findIndex(
      ([kind, token]) => kind === 'enter' && token === labelToken
    );
    const footnoteLabel = new FootnoteLabelSyntax();
    footnoteLabel.start = innerStart;
    footnoteLabel.end = innerEnd;
    footnoteLabel.children = compiler({ ...inlineOptions, contentType: 'string' })(
      events.slice(labelEnter + 1, matchingExit(events, labelEnter)),
      value
    ).children as Array<StringSegmentSyntax>;
    const pendingFootnoteLabel = new PendingFootnoteLabelSyntax();
    pendingFootnoteLabel.start = start;
    pendingFootnoteLabel.end = end;
    pendingFootnoteLabel.opening = new DelimiterTokenSyntax(
      'footnoteOpeningMarker',
      start,
      innerStart
    );
    pendingFootnoteLabel.label = footnoteLabel;
    pendingFootnoteLabel.closingBracket = new DelimiterTokenSyntax(
      'closingBracket',
      closing.start.offset,
      closing.end.offset
    );
    pendingFootnoteLabel.colon = new DelimiterTokenSyntax(
      'colon',
      colon.start.offset,
      colon.end.offset
    );
    return pendingFootnoteLabel;
  }

  /** An underline, alone on the last line; the heading's text stays in the paragraph. */
  setextHeading(block: Token, tokens: Array<Token>): PendingSetextUnderlineSyntax | undefined {
    const end = block.end.offset;
    if (!endsWith(tokens, types.setextHeadingLine, end)) {
      return;
    }

    const pendingSetextUnderline = new PendingSetextUnderlineSyntax();
    pendingSetextUnderline.start = get(tokens, types.setextHeadingLine).start.offset;
    pendingSetextUnderline.end = end;
    return pendingSetextUnderline;
  }

  /** A header row and a delimiter row, with no row after them. */
  table(enter: number, tokens: Array<Token>): PendingTableSyntax | undefined {
    const block = this.events[enter][1];
    const start = block.start.offset;
    const end = block.end.offset;
    if (!endsWith(tokens, 'tableDelimiterRow', end)) {
      return;
    }

    const lineEnding = get(tokens, types.lineEnding);
    const pendingTable = new PendingTableSyntax();
    pendingTable.start = start;
    pendingTable.end = end;
    for (const token of this.tokens(enter, 'exit')) {
      if (token.type === types.lineEnding) break;
      if (token.type === types.whitespace) {
        pendingTable.separators.push(
          new TriviaTokenSyntax('tableCellWhitespace', token.start.offset, token.end.offset)
        );
      }
    }
    pendingTable.cells = this.tableCells(enter);
    pendingTable.cellDividers = ranges(tokens, 'tableCellDivider', lineEnding.start.offset).map(
      function (range) {
        return new DelimiterTokenSyntax('tableCellDivider', range.start, range.end);
      }
    );
    pendingTable.lineEnding = new TextTokenSyntax(
      'lineEnding',
      lineEnding.start.offset,
      lineEnding.end.offset
    );
    pendingTable.delimiterRow = new DelimiterTokenSyntax(
      'tableDelimiterRowMarker',
      get(tokens, 'tableDelimiterRow').start.offset,
      get(tokens, 'tableDelimiterRow').end.offset
    );
    return pendingTable;
  }

  /** The start of an HTML block, alone on its line. */
  html(block: Token): PendingHTMLBlockSyntax | undefined {
    const start = block.start.offset;
    const end = block.end.offset;
    const value = this.value;
    const inlineOptions = this.options;
    if (block.start.line !== block.end.line) {
      return;
    }

    assert(block._htmlKind, 'expected a start condition on an HTML block');
    // Kagami: the pending line is still a paragraph's inline content. The
    // inline HTML construct distinguishes a complete tag from `<pre`.
    const children = compiler(inlineOptions)(
      parseEvents(value.slice(start), inlineOptions, block.start),
      value
    ).children;

    const pendingHTMLBlock = new PendingHTMLBlockSyntax();
    pendingHTMLBlock.start = start;
    pendingHTMLBlock.end = end;
    pendingHTMLBlock.startCondition = block._htmlKind;
    pendingHTMLBlock.children = children;
    return pendingHTMLBlock;
  }

  /** Build the header cells from their own events. */
  tableCells(enter: number): Array<TableCellSyntax> {
    const events = this.events;
    const definitions = this.definitionsBefore(enter);
    const cells: Array<TableCellSyntax> = [];
    for (let index = enter + 1; index < events.length; index++) {
      const [kind, token] = events[index];
      if (kind !== 'enter') continue;
      if (token.type === 'tableDelimiterRow') break;
      if (token.type !== 'tableHeader') continue;
      const end = matchingExit(events, index);
      cells.push(this.tableCell(events.slice(index + 1, end), token, definitions));
      index = end;
    }
    return cells;
  }

  /** The cell's tokens distinguish content from padding and escaped pipes. */
  tableCell(
    events: Array<Event>,
    header: Token,
    definitions: ReadonlyMap<string, Bindings.Definition>
  ): TableCellSyntax {
    const cell = new TableCellSyntax();
    cell.start = header.start.offset;
    cell.end = cell.start;
    for (let index = 0; index < events.length; index++) {
      const [kind, token] = events[index];
      if (kind !== 'enter') continue;
      if (token.type === types.whitespace) {
        cell.start = token.end.offset;
        cell.end = cell.start;
      } else if (token.type === 'tableContent') {
        const content = postprocess(events.slice(index, matchingExit(events, index) + 1));
        cell.start = token.start.offset;
        cell.end = token.end.offset;
        const fragment = compiler(this.options, definitions)(content.slice(1, -1), this.value);
        cell.children = fragment.children;
        cell.references.add(fragment.references);
        finishNode(cell);
        return cell;
      }
    }
    return cell;
  }

  /** Earlier definitions supply semantics directly to the header's references. */
  definitionsBefore(before: number): ReadonlyMap<string, Bindings.Definition> {
    const events = this.events;
    const definitions = new Map<string, Bindings.Definition>();
    for (let index = 0; index < before; index++) {
      const [kind, token] = events[index];
      if (kind !== 'enter' || token.type !== types.definition) continue;
      const end = matchingExit(events, index);
      const content = events.slice(index + 1, end);
      const label = content.find(
        ([event, part]) => event === 'enter' && part.type === types.definitionLabelString
      );
      assert(label, 'expected a definition label');
      const identifier = normalizeIdentifier(label[2].sliceSerialize(label[1])).toLowerCase();
      if (!definitions.has(identifier)) {
        definitions.set(identifier, this.definitionValue(content));
      }
      index = end;
    }
    return definitions;
  }

  /** Decode definition strings with the compiler used by complete definitions. */
  definitionValue(events: Array<Event>): Bindings.Definition {
    let destination = '';
    let title: string | null = null;
    for (let index = 0; index < events.length; index++) {
      const [kind, token] = events[index];
      if (kind !== 'enter') continue;
      if (token.type === types.definitionTitle) {
        title = '';
        continue;
      }
      if (
        token.type !== types.definitionDestinationString &&
        token.type !== types.definitionTitleString
      ) continue;
      const end = matchingExit(events, index);
      const fragment = compiler({ ...this.options, contentType: 'string' })(
        events.slice(index + 1, end),
        this.value
      );
      const text = toString(fragment, this.value);
      if (token.type === types.definitionDestinationString) destination = text;
      else title = text;
      index = end;
    }
    return { destination, title };
  }
}

/**
 * Find the last block of a text read as blocks.
 *
 * @param events
 *   Events.
 * @returns
 *   Index of the event that enters it; `undefined` when there is none.
 */
function lastBlock(events: Array<Event>): number | undefined {
  let index = events.length - 1;

  // Line endings and prefixes after the last block are no block.
  while (
    index >= 0 &&
    (events[index][1].type === types.lineEnding ||
      events[index][1].type === types.lineEndingBlank ||
      events[index][1].type === types.linePrefix ||
      events[index][1].type === types.lineSuffix)
  ) {
    index--;
  }

  if (index < 0) {
    return;
  }

  const block = events[index][1];

  while (events[index][1] !== block || events[index][0] !== 'enter') {
    index--;
  }

  return index;
}

/**
 * Whether a block quote is empty quotes, one in the other, whose markers end the text: `>`,
 * `>>`, `>` over `>`. Each quote has a marker on the last line.
 *
 * @param block
 *   The outer quote.
 * @param tokens
 *   Tokens in it.
 * @returns
 *   Whether it is.
 */
function emptyQuotes(block: Token, tokens: Array<Token>): boolean {
  let quotes = 1;
  let inner = block;
  let markers = 0;
  let index = -1;

  while (++index < tokens.length) {
    const token = tokens[index];

    if (token.type === types.blockQuote) {
      // A quote after the inner one is beside it, not in it.
      if (token.end.offset > inner.end.offset) {
        return false;
      }

      inner = token;
      quotes++;
    } else if (token.type === types.blockQuoteMarker) {
      if (token.start.line === block.end.line) {
        markers++;
      }
    } else if (
      token.type !== types.blockQuotePrefix &&
      token.type !== types.blockQuotePrefixWhitespace &&
      token.type !== types.lineEnding &&
      token.type !== types.lineEndingBlank &&
      token.type !== types.linePrefix &&
      token.type !== types.lineSuffix
    ) {
      return false;
    }
  }

  return markers === quotes && endsWith(tokens, types.blockQuoteMarker, block.end.offset);
}

/** Find the matching exit of an already-recognized token. */
function matchingExit(events: Array<Event>, enter: number): number {
  const token = events[enter][1];
  let exit = enter;
  while (events[++exit][1] !== token) {
    // Nested tokens belong to this constituent.
  }
  return exit;
}

/**
 * The line endings among tokens, as nodes.
 *
 * @param tokens
 *   Tokens.
 * @returns
 *   Line endings.
 */
function lineEndingsIn(
  tokens: Array<Token>
): Array<LineEndingSyntax> {
  const result: Array<LineEndingSyntax> = [];
  let index = -1;

  while (++index < tokens.length) {
    if (tokens[index].type === types.lineEnding || tokens[index].type === types.lineEndingBlank) {
      result.push(
        new TextTokenSyntax('lineEnding', tokens[index].start.offset, tokens[index].end.offset)
      );
    }
  }

  return result;
}

/**
 * The first token of a type.
 *
 * @param tokens
 *   Tokens.
 * @param type
 *   Type.
 * @returns
 *   Token, if there is one.
 */
function find(tokens: Array<Token>, type: TokenType): Token | undefined {
  let index = -1;

  while (++index < tokens.length) {
    if (tokens[index].type === type) {
      return tokens[index];
    }
  }
}

/**
 * The first token of a type, which is there.
 *
 * @param tokens
 *   Tokens.
 * @param type
 *   Type.
 * @returns
 *   Token.
 */
function get(tokens: Array<Token>, type: TokenType): Token {
  const token = find(tokens, type);
  assert(token, 'expected `' + type + '`');
  return token;
}

/**
 * How many tokens there are of a type.
 *
 * @param tokens
 *   Tokens.
 * @param type
 *   Type.
 * @returns
 *   Count.
 */
function count(tokens: Array<Token>, type: TokenType): number {
  let result = 0;
  let index = -1;

  while (++index < tokens.length) {
    if (tokens[index].type === type) {
      result++;
    }
  }

  return result;
}

/**
 * The ranges of the tokens of a type.
 *
 * @param tokens
 *   Tokens.
 * @param type
 *   Type.
 * @param before
 *   Offset the tokens end at or before (default: anywhere).
 * @returns
 *   Ranges.
 */
function ranges(
  tokens: Array<Token>,
  type: TokenType,
  before?: number | undefined
): Array<SourceRange> {
  const result: Array<SourceRange> = [];
  let index = -1;

  while (++index < tokens.length) {
    if (
      tokens[index].type === type &&
      (before === undefined || tokens[index].end.offset <= before)
    ) {
      result.push(range(tokens[index]));
    }
  }

  return result;
}

/**
 * Whether a token of a type ends at a point: what a block ends with.
 *
 * @param tokens
 *   Tokens.
 * @param type
 *   Type.
 * @param end
 *   Offset.
 * @returns
 *   Whether one does.
 */
function endsWith(tokens: Array<Token>, type: TokenType, end: number): boolean {
  let index = -1;

  while (++index < tokens.length) {
    if (tokens[index].type === type && tokens[index].end.offset === end) {
      return true;
    }
  }

  return false;
}

/**
 * The range of a token.
 *
 * @param token
 *   Token.
 * @returns
 *   Range.
 */
function range(token: Token): SourceRange {
  return { start: token.start.offset, end: token.end.offset };
}
