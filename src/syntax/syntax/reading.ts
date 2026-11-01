/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BlockSyntax, DocumentSyntax } from './block.js';
import { InlineSyntax, PendingSyntax } from './inline.js';
import type { Frontier } from './frontier.js';
// How the editor asks the parser, and what it is given. The design is in
// private-docs/design/syntax/reading.md; the readers are in `./read.ts`.
//
// A reading says what a text is. It never says what the caller should do about it. What the
// caller knows of where the text stands goes in as options. What a text is read for, a plain
// syntax tree or the editor, is its target (private-docs/design/syntax/for-the-editor.md).
//
// Positions are offsets into the text that was given, without a byte order mark.

// A file.

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
 * What a text is read for: `standard`, a plain syntax tree; `editor`, the tree the editor's
 * content is made from, which holds what the editor holds as text (`ATXClosingSequenceSyntax`).
 */
export type Target = 'standard' | 'editor';

/** What a file, or a part of one, is read for. */
export interface ReadOptions {
  target: Target;
}

// What a reading may refer to.

/**
 * The labels defined elsewhere in the document, normalized, which references in the text may
 * resolve to. Without them, `[a][b]` is not a link. A reader looks a label up when it meets
 * one, and never goes through them all: reading a field costs nothing for the definitions it
 * does not use, and a caller can learn which labels a field looked up.
 */
export interface Bindings {
  /** The first definition of this normalized label, if there is one. */
  definition(label: string): Bindings.Definition | undefined;
  /** Whether this normalized label has a footnote definition. */
  footnote(label: string): boolean;
}

export namespace Bindings {
  export interface Definition {
    destination: string;
    title: string | null;
  }

  /** No definitions and no footnotes: the bindings of a text that stands alone. */
  export const none: Bindings = { definition: () => undefined, footnote: () => false };
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

/**
 * Context and settlement options for `transduce`.
 */
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
}

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

export type Transduce = (
  text: string,
  options: TransduceOptions,
  bindings: Bindings
) => Transduction;
