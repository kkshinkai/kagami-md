/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { combineExtensions } from '../kernel/utils/combine-extensions/index.js';
import { normalizeIdentifier } from '../kernel/utils/normalize-identifier/index.js';
import { ReferenceQuestions } from '../compile/references.js';
import type {
  Bindings,
  Event,
  Extension,
  FullNormalizedExtension,
  Target,
} from '../types/index.js';
import { compiler, fromMarkdown } from '../compile/index.js';
import { blockEvents, parseEvents } from '../compile/events.js';
import { createCompiler, createConfig } from '../compile/tree.js';
import { postprocess } from '../kernel/postprocess.js';
import { types } from '../kernel/utils/symbol/index.js';
import { linearize } from '../compile/frontier.js';
import { BlockSyntax, DocumentSyntax } from './block.js';
import { InlineSyntax, PendingSyntax } from './inline.js';
import type { Frontier } from './frontier.js';
import type { Config, Extension as CompileExtension, Options } from '../compile/types.js';

import {
  inlinePhrasings,
  partOfFile,
  phrasingDocument,
  stringPhrasings,
  tag,
  wholeDocument,
  wikilink,
} from '../constructs/bundle.js';

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

// How the editor asks the parser, and what it is given. See
// private-docs/design/syntax/reading.md.
//
// A reading says what a text is. It never says what the caller should do about it. What the
// caller knows of where the text stands goes in as options. What a text is read for, a plain
// syntax tree or the editor, is its target (private-docs/design/syntax/for-the-editor.md).
//
// Positions are offsets into the text that was given, without a byte order mark.

/**
 * A file read: the properties that belong to the file and not to its text, and its document.
 * See private-docs/design/syntax/ranges.md and private-docs/rules/model-fidelity.md.
 */
export interface VirtualFile {
  /** Whether the file began with a byte order mark, which is not in the text that was read. */
  byteOrderMark: boolean;
  /**
   * The line ending the file uses: CRLF when strictly more than half of its line endings are
   * CRLF, CR when strictly more than half are CR, and LF otherwise (a tie included). Null when
   * the file has none.
   */
  lineEnding: VirtualFile.LineEnding | null;
  /** Whether the last line ends with a line ending. */
  endsWithLineEnding: boolean;
  /** The text read: the file without its byte order mark, every line ending one LF. */
  text: string;
  /** The document, its positions in `text`. */
  document: DocumentSyntax;
}

export namespace VirtualFile {
  export type LineEnding = 'lineFeed' | 'carriageReturnLineFeed' | 'carriageReturn';
}

/**
 * Which editable region (phrasing) inside a leaf is being evaluated.
 * A Setext heading's text and a callout's title are read as a paragraph's is,
 * but nothing in them is pending: only a paragraph's text is.
 */
export type Phrasing =
  | 'paragraph'
  | 'atxHeading'
  | 'setextHeading'
  | 'tableCell'
  | 'calloutTitle'
  | 'linkLabel'
  | 'linkDestination'
  | 'linkTitle'
  | 'footnoteLabel';

/** Normalized labels consulted by a reading, including unsuccessful attempts. */
export class ReferenceLabels {
  readonly definitions = new Set<string>();
  readonly footnotes = new Set<string>();

  add(other: ReferenceLabels): void {
    for (const label of other.definitions) this.definitions.add(label);
    for (const label of other.footnotes) this.footnotes.add(label);
  }
}

/**
 * The unified data answer produced by `@kagami/markdown-syntax`'s `transduce` for the editor.
 * Every inline, pending, or block result provides already-linearized `Frontier`s:
 * - `inline` and `pending` carry `frontier: Frontier` at the top level;
 * - `blocks` carry `.frontier: Frontier` on every phrasing-bearing CST node.
 */
export type Transduction =
  | {
      /**
       * The text stays in its current phrasing (inert, or carrying conditional phrasing syntax
       * such as `TaskMarkerSyntax`, `CalloutDeclarationSyntax`, `ATXClosingSequenceSyntax`, or
       * `LinkTitleStartSyntax`).
       */
      kind: 'inline';
      /** The normalized identifier when this is a definition label; otherwise null. */
      identifier: string | null;
      references: ReferenceLabels;
      frontier: Frontier;
      children: Array<InlineSyntax>;
    }
  | {
      /**
       * The text of a paragraph ends in a block construct listed in the Pending rule and has not
       * settled (`!options.settle`). Carries the `PendingSyntax` node and the inline `children`
       * and `frontier` (with `PendingSyntax` at the end of `children`).
       */
      kind: 'pending';
      references: ReferenceLabels;
      pending: PendingSyntax;
      frontier: Frontier;
      children: Array<InlineSyntax>;
    }
  | {
      /**
       * The text converts across the seam into one or more blocks (either immediately because the
       * recognized block does not wait, or because a pending construct settled with `settle: true`).
       * Every phrasing-bearing node inside `blocks` exposes `.frontier: Frontier`.
       */
      kind: 'blocks';
      references: ReferenceLabels;
      blocks: Array<BlockSyntax>;
    };

interface Grammars {
  readonly wholeDocument: FullNormalizedExtension;
  readonly partOfFile: FullNormalizedExtension;
  readonly phrasingDocument: FullNormalizedExtension;
  readonly inlinePhrasings: {
    readonly [K in keyof typeof inlinePhrasings]: FullNormalizedExtension;
  };
  readonly stringPhrasings: {
    readonly [K in keyof typeof stringPhrasings]: FullNormalizedExtension;
  };
}

interface Shared {
  readonly documentConfig: Config;
  readonly phrasingConfig: Config;
  readonly baseGrammars: Grammars;
  tagGrammars?: Grammars;
  wikilinkGrammars?: Grammars;
  tagAndWikilinkGrammars?: Grammars;
}

let shared: Shared | undefined;

function getShared(): Shared {
  if (!shared) {
    const baseMdastExtensions = mdastExtensions();
    shared = {
      documentConfig: createConfig(baseMdastExtensions),
      phrasingConfig: createConfig([...baseMdastExtensions, phrasingFromMarkdown()]),
      baseGrammars: compileGrammars([]),
    };
  }
  return shared;
}

function resolveGrammars(
  state: Shared,
  extensions: ReadonlyArray<Extension> | undefined
): Grammars {
  if (!extensions || extensions.length === 0) {
    return state.baseGrammars;
  }
  if (extensions.length === 1) {
    if (extensions[0] === tag) {
      return (state.tagGrammars ??= compileGrammars([tag]));
    }
    if (extensions[0] === wikilink) {
      return (state.wikilinkGrammars ??= compileGrammars([wikilink]));
    }
  }
  if (
    extensions.length === 2 &&
    ((extensions[0] === wikilink && extensions[1] === tag) ||
      (extensions[0] === tag && extensions[1] === wikilink))
  ) {
    return (state.tagAndWikilinkGrammars ??= compileGrammars([wikilink, tag]));
  }
  return compileGrammars(extensions);
}

/**
 * The line endings, by what each is written as.
 */
const lineEndings: Record<string, VirtualFile.LineEnding> = {
  '\n': 'lineFeed',
  '\r\n': 'carriageReturnLineFeed',
  '\r': 'carriageReturn',
};

/**
 * A compiled Markdown parser bound to one fixed dialect (`target`, `cjkFriendly`, and optional
 * syntax `extensions`). Its construct tables and compiler handlers are assembled once and reused
 * across whole-file, block-fragment, and phrasing readings.
 */
export class Parser {
  readonly target: Target;
  readonly cjkFriendly: boolean;
  private readonly grammars: Grammars;
  private readonly documentConfig: Config;
  private readonly phrasingConfig: Config;

  constructor(options?: Parser.Options) {
    const state = getShared();
    this.target = options?.target ?? 'standard';
    this.cjkFriendly = options?.cjkFriendly ?? this.target === 'editor';
    this.documentConfig = state.documentConfig;
    this.phrasingConfig = state.phrasingConfig;
    this.grammars = resolveGrammars(state, options?.extensions);
  }

  /**
   * Read a whole file in one pass: its blocks and their inline content together, so that a
   * reference finds a definition written anywhere in it. Its byte order mark and its line endings
   * are taken off first: the text read has every line ending as one LF.
   */
  parseFile(file: string): VirtualFile {
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
      document: fromMarkdown(text, {
        target: this.target,
        cjkFriendly: this.cjkFriendly,
        constructs: this.grammars.wholeDocument,
        config: this.documentConfig,
      }),
    };
  }

  /** Read a text as blocks, as a part of a file. */
  parseBlocks(text: string, options?: Parser.BlocksOptions): Array<BlockSyntax> {
    return fromMarkdown(text, {
      target: this.target,
      cjkFriendly: this.cjkFriendly,
      constructs: this.grammars.partOfFile,
      bindings: options?.bindings,
      config: this.documentConfig,
    }).children;
  }

  /** Evaluate one editable phrasing under its grammar and settlement state. */
  transduce(text: string, options: Parser.TransduceOptions): Transduction {
    switch (options.phrasing) {
      case 'paragraph':
      case 'setextHeading': {
        const blockOptions: Options.Document = {
          target: 'editor',
          cjkFriendly: this.cjkFriendly,
          constructs: this.grammars.phrasingDocument,
          phrasingBlocks: true,
          bindings: options.bindings,
          config: this.documentConfig,
        };
        const events = blockEvents(text, blockOptions);
        if (ordinaryParagraph(events, options.phrasing)) {
          const inlineOptions = this.phrasingOptions(options);
          const fragment = createCompiler(
            inlineOptions,
            undefined,
            options.phrasing === 'paragraph'
          )(parseEvents(text, inlineOptions), text);
          const { children, references } = fragment;
          return { kind: 'inline', identifier: null, references, frontier: linearize(children), children };
        }

        if (options.phrasing === 'paragraph' && !options.settle) {
          const inlineOptions = this.phrasingOptions(options);
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
        const { children, references } = fromMarkdown(text, this.phrasingOptions(options));
        return { kind: 'inline', identifier: null, references, frontier: linearize(children), children };
      }
      case 'linkLabel':
      case 'linkDestination':
      case 'linkTitle':
      case 'footnoteLabel': {
        const grammarKey = options.phrasing === 'linkDestination' && options.canOpenTitle === false
          ? 'linkTitle' : options.phrasing;
        const { children, references } = fromMarkdown(text, {
          target: 'editor',
          cjkFriendly: this.cjkFriendly,
          constructs: this.grammars.stringPhrasings[grammarKey],
          contentType: 'string',
          bindings: options.bindings,
          config: this.phrasingConfig,
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

  /** The inline grammar offered by this phrasing's location. */
  private phrasingOptions(options: Parser.TransduceOptions): Options.Text {
    let grammar: FullNormalizedExtension;
    switch (options.phrasing) {
      case 'paragraph': {
        if (options.firstInListItem && options.firstInBlockQuote) {
          grammar = this.grammars.inlinePhrasings.paragraphTaskCallout;
        } else if (options.firstInListItem) {
          grammar = this.grammars.inlinePhrasings.paragraphTask;
        } else if (options.firstInBlockQuote) {
          grammar = this.grammars.inlinePhrasings.paragraphCallout;
        } else {
          grammar = this.grammars.inlinePhrasings.paragraph;
        }
        break;
      }
      case 'setextHeading':
      case 'atxHeading':
      case 'tableCell':
      case 'calloutTitle': {
        grammar = this.grammars.inlinePhrasings[options.phrasing];
        break;
      }
      case 'linkLabel':
      case 'linkDestination':
      case 'linkTitle':
      case 'footnoteLabel': {
        const grammarKey = options.phrasing === 'linkDestination' && options.canOpenTitle === false
          ? 'linkTitle' : options.phrasing;
        grammar = this.grammars.stringPhrasings[grammarKey];
        break;
      }
      default: {
        const exhaustive: never = options.phrasing;
        return exhaustive;
      }
    }
    return {
      target: 'editor',
      cjkFriendly: this.cjkFriendly,
      constructs: grammar,
      contentType: 'text',
      bindings: options.bindings,
      tableCell: options.phrasing === 'tableCell',
      config: this.phrasingConfig,
    };
  }
}

export namespace Parser {
  /** Dialect options compiled once into a `Parser` instance. */
  export interface Options {
    target?: Target;
    /** Use CJK-friendly inline delimiter boundaries (default: `target === 'editor'`). */
    cjkFriendly?: boolean;
    /** Optional syntax extensions combined after the base grammar. */
    extensions?: ReadonlyArray<Extension>;
  }

  /** Per-call context for `Parser.parseBlocks`. */
  export interface BlocksOptions {
    /** Labels defined elsewhere in the document. */
    bindings?: Bindings;
  }

  /** Per-call context and settlement state for `Parser.transduce`. */
  export interface TransduceOptions {
    phrasing: Phrasing;
    /**
     * When `false` (default, while typing on the active line), a construct at the end of a
     * paragraph that matches the Pending table waits in place and returns `kind: 'pending'`.
     * When `true` (on leaving the line, blur, Enter, or when the caret is outside the active
     * pending range), it settles and returns `kind: 'blocks'`.
     */
    settle?: boolean;
    /**
     * The paragraph is the first content of a list item that is not a task item, so a task marker
     * at its start is recognized.
     */
    firstInListItem?: boolean;
    /**
     * The paragraph is the first content of a block quote that is not a callout, so a callout
     * declaration at its start is recognized.
     */
    firstInBlockQuote?: boolean;
    /**
     * The link destination is bare and its definition has no title yet, so a title delimiter
     * after trailing whitespace is recognized (default: `true`).
     */
    canOpenTitle?: boolean;
    /** Labels defined elsewhere in the document. */
    bindings?: Bindings;
  }
}

function extend(
  base: FullNormalizedExtension,
  extensions: ReadonlyArray<Extension>
): FullNormalizedExtension {
  return extensions.length === 0
    ? base
    : (combineExtensions([base, ...extensions]) as FullNormalizedExtension);
}

function compileGrammars(extensions: ReadonlyArray<Extension>): Grammars {
  const plainInline = extend(inlinePhrasings.paragraph, extensions);
  const plainString = extend(stringPhrasings.linkLabel, extensions);
  return {
    wholeDocument: extend(wholeDocument, extensions),
    partOfFile: extend(partOfFile, extensions),
    phrasingDocument: extend(phrasingDocument, extensions),
    inlinePhrasings: {
      paragraph: plainInline,
      setextHeading: plainInline,
      calloutTitle: plainInline,
      tableCell: plainInline,
      paragraphTask: extend(inlinePhrasings.paragraphTask, extensions),
      paragraphCallout: extend(inlinePhrasings.paragraphCallout, extensions),
      paragraphTaskCallout: extend(inlinePhrasings.paragraphTaskCallout, extensions),
      atxHeading: extend(inlinePhrasings.atxHeading, extensions),
    },
    stringPhrasings: {
      linkLabel: plainString,
      linkTitle: plainString,
      linkDestination: extend(stringPhrasings.linkDestination, extensions),
      footnoteLabel: extend(stringPhrasings.footnoteLabel, extensions),
    },
  };
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

/**
 * What the compiler is extended with, for every reading.
 *
 * @returns
 *   Extensions.
 */
function mdastExtensions(): Array<CompileExtension> {
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
