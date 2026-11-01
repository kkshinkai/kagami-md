/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { normalizeIdentifier } from '../kernel/utils/normalize-identifier/index.js';
import { ReferenceQuestions } from '../compile/references.js';
import { type Event, type FullNormalizedExtension } from '../types/index.js';
import { compiler, fromMarkdown } from '../compile/index.js';
import { blockEvents, parseEvents } from '../compile/events.js';
import { createCompiler } from '../compile/tree.js';
import { postprocess } from '../kernel/postprocess.js';
import { types } from '../kernel/utils/symbol/index.js';
import { linearize } from '../compile/frontier.js';
import { BlockSyntax } from './block.js';
// The readers of `./reading.ts`. See private-docs/design/syntax/reading.md.

import type { Extension, Options } from '../compile/types.js';

import { phrasingDocument, inlinePhrasings, partOfFile, stringPhrasings } from '../constructs/bundle.js';

// ZWSP edge mark: compile file candidates after their complete fields are known.
import { edgeMarkFromMarkdown } from '../compile/edge-mark.js';
import { phrasingFromMarkdown } from '../compile/phrasing.js';
import { pendingTail } from '../compile/pending.js';
import { emojiFromMarkdown } from '../compile/emoji.js';
import { frontmatterFromMarkdown } from '../compile/frontmatter.js';
import { gfmAutolinkLiteralFromMarkdown } from '../compile/gfm-autolink-literal.js';
import { gfmFootnoteFromMarkdown } from '../compile/gfm-footnote.js';
import { gfmStrikethroughFromMarkdown } from '../compile/gfm-strikethrough.js';
import { gfmTableFromMarkdown } from '../compile/gfm-table.js';
import { gfmTaskListItemFromMarkdown } from '../compile/gfm-task-list-item.js';
import { highlightFromMarkdown } from '../compile/highlight.js';
import { imageSizeFromMarkdown } from '../compile/image-size.js';
import { mathFromMarkdown } from '../compile/math.js';
import { tagFromMarkdown } from '../compile/tag.js';
import { wikilinkFromMarkdown } from '../compile/wikilink.js';
import type {
  Bindings,
  TransduceOptions,
  Transduction,
  ReadOptions,
  VirtualFile,
} from './reading.js';

/**
 * The line endings, by what each is written as.
 */
const lineEndings: Record<string, VirtualFile.LineEnding> = {
  '\n': 'lineFeed',
  '\r\n': 'carriageReturnLineFeed',
  '\r': 'carriageReturn',
};

/**
 * Read a whole file in one pass: its blocks and their inline content
 * together, so that a reference finds a definition written anywhere in it.
 * Its byte order mark and its line endings are taken off first: the text read
 * has every line ending as one LF.
 *
 * @param file
 *   The text of a file.
 * @param options
 *   What the text is read for.
 * @returns
 *   The file read.
 */
export function parseFile(file: string, options: ReadOptions = { target: 'standard' }): VirtualFile {
  const byteOrderMark = file.charCodeAt(0) === 0xfe_ff;
  const physical = byteOrderMark ? file.slice(1) : file;
  // The line ending and the byte order mark are the file's; the text has neither
  // (private-docs/rules/model-fidelity.md).
  const text = physical.replace(/\r\n?/g, '\n');

  return {
    byteOrderMark,
    lineEnding: preferredLineEnding(physical),
    endsWithLineEnding: /[\n\r]$/.test(physical),
    text,
    document: fromMarkdown(text, { target: options.target, mdastExtensions: extensions() }),
  };
}

/**
 * Read a text as blocks, as a part of a file.
 *
 * @param text
 *   Text.
 * @param options
 *   What the text is read for.
 * @param bindings
 *   What is defined elsewhere.
 * @returns
 *   Blocks.
 */
export function parseBlocks(
  text: string,
  options: ReadOptions = { target: 'standard' },
  bindings?: Bindings
): Array<BlockSyntax> {
  return fromMarkdown(text, {
    target: options.target,
    grammar: partOfFile,
    bindings,
    mdastExtensions: extensions(),
  }).children;
}

/** Evaluate one editable phrasing under its grammar and settlement state. */
export function transduce(
  text: string,
  options: TransduceOptions,
  bindings: Bindings
): Transduction {
  switch (options.phrasing) {
    case 'paragraph':
    case 'setextHeading': {
      const blockOptions = {
        target: 'editor' as const,
        grammar: phrasingDocument,
        bindings,
        mdastExtensions: extensions(),
      };
      const events = blockEvents(text, blockOptions);
      if (ordinaryParagraph(events, options.phrasing)) {
        const inlineOptions = phrasingOptions(options, bindings);
        const fragment = createCompiler(
          inlineOptions,
          undefined,
          options.phrasing === 'paragraph'
        )(parseEvents(text, inlineOptions), text);
        const { children, references } = fragment;
        return { kind: 'inline', identifier: null, references, frontier: linearize(children), children };
      }

      if (options.phrasing === 'paragraph' && !options.settle) {
        const inlineOptions = phrasingOptions(options, bindings);
        const pending = pendingTail(events, text, inlineOptions);
        if (pending) {
          const { children, references } = fromMarkdown(text.slice(0, pending.start), inlineOptions);
          references.add(new ReferenceQuestions(events).labels());
          children.push(pending);
          return { kind: 'pending', references, pending, frontier: linearize(children), children };
        }
      }

      const blocks = compiler(blockOptions)(postprocess(events), text).children;
      return { kind: 'blocks', references: new ReferenceQuestions(events).labels(), blocks };
    }
    case 'atxHeading':
    case 'tableCell':
    case 'calloutTitle': {
      const { children, references } = fromMarkdown(text, phrasingOptions(options, bindings));
      return { kind: 'inline', identifier: null, references, frontier: linearize(children), children };
    }
    case 'linkLabel':
    case 'linkDestination':
    case 'linkTitle':
    case 'footnoteLabel': {
      const { children, references } = fromMarkdown(text, {
        target: 'editor',
        grammar: stringPhrasings[options.phrasing],
        contentType: 'string',
        bindings,
        mdastExtensions: [...extensions(), phrasingFromMarkdown()],
      });
      const identifier = options.phrasing === 'linkLabel' || options.phrasing === 'footnoteLabel'
        ? normalizeIdentifier(text).toLowerCase() : null;
      return { kind: 'inline', identifier, references, frontier: linearize(children), children };
    }
    default: {
      const exhaustive: never = options.phrasing;
      return exhaustive;
    }
  }
}

/** A structural pass leaves paragraph text untouched until its branch is known. */
function ordinaryParagraph(
  events: Array<Event>,
  phrasing: 'paragraph' | 'setextHeading'
): boolean {
  let paragraph = false;
  for (let index = 0; index < events.length; index++) {
    const [kind, token] = events[index];
    if (kind !== 'enter') continue;
    switch (token.type) {
      case types.content:
      case types.linePrefix:
      case types.lineSuffix:
      case types.lineEnding: {
        break;
      }
      case types.lineEndingBlank: {
        if (phrasing === 'paragraph') return false;
        break;
      }
      case types.paragraph: {
        if (paragraph) return false;
        paragraph = true;
        while (events[++index][1] !== token) {
          // Its deferred text chunks belong to the eventual inline reading.
        }
        break;
      }
      default: {
        return false;
      }
    }
  }
  return true;
}

/** The inline grammar offered by this phrasing's location. */
function phrasingOptions(
  options: TransduceOptions,
  bindings: Bindings
): Options.Text {
  let grammar: FullNormalizedExtension;
  switch (options.phrasing) {
    case 'paragraph': {
      if (options.firstInListItem && options.firstInBlockQuote) {
        grammar = inlinePhrasings.paragraphTaskCallout;
      } else if (options.firstInListItem) {
        grammar = inlinePhrasings.paragraphTask;
      } else if (options.firstInBlockQuote) {
        grammar = inlinePhrasings.paragraphCallout;
      } else {
        grammar = inlinePhrasings.paragraph;
      }
      break;
    }
    case 'setextHeading':
    case 'atxHeading':
    case 'tableCell':
    case 'calloutTitle': {
      grammar = inlinePhrasings[options.phrasing];
      break;
    }
    case 'linkLabel':
    case 'linkDestination':
    case 'linkTitle':
    case 'footnoteLabel': {
      grammar = stringPhrasings[options.phrasing];
      break;
    }
    default: {
      const exhaustive: never = options.phrasing;
      return exhaustive;
    }
  }
  const mdastExtensions = [...extensions(), phrasingFromMarkdown()];

  return {
    target: 'editor',
    grammar,
    contentType: 'text',
    bindings,
    tableCell: options.phrasing === 'tableCell',
    mdastExtensions,
  };
}

/**
 * What the compiler is extended with, for every reading.
 *
 * @returns
 *   Extensions.
 */
function extensions(): Array<Extension> {
  return [
    frontmatterFromMarkdown(),
    gfmAutolinkLiteralFromMarkdown(),
    gfmFootnoteFromMarkdown(),
    gfmStrikethroughFromMarkdown(),
    gfmTableFromMarkdown(),
    gfmTaskListItemFromMarkdown(),
    mathFromMarkdown(),
    highlightFromMarkdown(),
    wikilinkFromMarkdown(),
    tagFromMarkdown(),
    emojiFromMarkdown(),
    imageSizeFromMarkdown(),
    // ZWSP edge mark: only file grammars emit the candidates handled here.
    edgeMarkFromMarkdown(),
  ];
}

/**
 * The line ending the file uses: CRLF or CR when strictly more than half of the
 * line endings are that kind, and LF otherwise (a tie included).
 *
 * @param text
 *   Text.
 * @returns
 *   Line ending, or nothing when there is none.
 */
function preferredLineEnding(text: string): VirtualFile.LineEnding | null {
  const counts = new Map<VirtualFile.LineEnding, number>();
  const expression = /\r\n|\r|\n/g;
  let total = 0;
  let match = expression.exec(text);

  while (match) {
    const kind = lineEndings[match[0]]!;
    counts.set(kind, (counts.get(kind) || 0) + 1);
    total++;
    match = expression.exec(text);
  }

  if (total === 0) {
    return null;
  }

  if ((counts.get('carriageReturnLineFeed') || 0) * 2 > total) {
    return 'carriageReturnLineFeed';
  }

  if ((counts.get('carriageReturn') || 0) * 2 > total) {
    return 'carriageReturn';
  }

  return 'lineFeed';
}
