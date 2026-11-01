/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Node } from 'prosemirror-model';

/** The punctuation family of a list. */
export type ListPattern = 'dash' | 'asterisk' | 'plusSign' | 'decimalDot' | 'decimalRightParenthesis';

/** What the end of a written block leaves open to its next sibling. */
export interface Closing {
  readonly leaf: Closing.Leaf;
  readonly continuation: number | null;
  readonly openList: ListPattern | null;
  readonly openQuote: boolean;
}

export namespace Closing {
  /** The leaf whose continuation may absorb a following line. */
  export type Leaf = 'none' | 'paragraph' | 'definition' | 'definitionComplete' | 'table' | 'indentedCode' | 'fence'
    | 'html';

  /** A block whose syntax cannot consume a following line. */
  export const none: Closing = { leaf: 'none', continuation: null, openList: null, openQuote: false };

  /** Leaves that can continue through an omitted container marker. */
  export function paragraph(leaf: Leaf): Leaf {
    switch (leaf) {
      case 'paragraph':
      case 'definition':
      case 'definitionComplete': return leaf;
      case 'none':
      case 'table':
      case 'indentedCode':
      case 'fence':
      case 'html': return 'none';
      default: return leaf satisfies never;
    }
  }
}

/** The first token of a written block, at its physical column. */
export interface Opening {
  readonly kind: Opening.Kind;
  readonly interruptsParagraph: boolean;
  readonly column: number;
  /** The front matter fence that the first line is, when it is exactly one. */
  readonly frontMatter: Opening.FrontMatterFence | null;
}

export namespace Opening {
  /** A grammar opening exposed to the preceding block. */
  export type Kind = 'text' | 'linkTitle' | 'atxHeading' | 'fence' | 'thematicBreak' | 'blockQuote' | 'listItem' |
    'html' | 'definition' | 'footnoteDefinition' | 'indentedCode' | 'table';

  /** A line that opens front matter at the start of a file and closes it later. */
  export type FrontMatterFence = '---' | '+++';
}

/** A body without its edge blank lines or final line ending, and its exposed edges. */
export interface Unparsed {
  readonly body: string;
  readonly opening: Opening | null;
  readonly closing: Closing;
}

/**
 * The physical placement in which a block must keep its reading. Every fact here is true of any
 * block standing there; what matters to one kind of block only is worked out by that kind's writer
 * from `parent` and `index`.
 */
export interface DisambiguationContext {
  readonly column: number;
  readonly laterColumn: number;
  readonly preceding: Closing | null;
  readonly followed: boolean;
  /** Whether a line ending follows this block's last line in the file. */
  readonly terminated: boolean;
  /** The node the block is written in, and its index there. */
  readonly parent: Node;
  readonly index: number;
  /** Whether blank lines may stand between the parent's children. */
  readonly loose: boolean;
}
