/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { codes } from '../kernel/utils/symbol/index.js';
// ZWSP edge mark: Reading and writing use the same predicate from section 6 of
// private-docs/design/spaces-and-empty-paragraphs.md. Setext text is paragraph text;
// ATX headings and cells cannot open blocks. Empty-field placement belongs to the unparser.
import { edgeMarkCode } from '../constructs/text/edge-mark.js';

import { transduce } from './read.js';
import { Bindings } from './reading.js';

/** ZWSP edge mark: The kinds of text that have a mark. */
export type EdgeMarkKind = 'paragraph' | 'atxHeading' | 'tableCell';

/** ZWSP edge mark: What the place of a paragraph offers. */
export interface EdgeMarkPlace {
  /** A task check: the paragraph is the first content of an item that is no task item. */
  taskMarker?: boolean | undefined;
  /** A callout's declaration: the paragraph is the first content of a quote. */
  calloutDeclaration?: boolean | undefined;
}


/**
 * ZWSP edge mark: Whether the unparser writes a mark before `text`, the text of a block of
 * `kind`, so that it reads back.
 *
 * @param text
 *   Text of a block.
 * @param kind
 *   What the block is.
 * @param also
 *   What the place of a paragraph offers.
 * @returns
 *   Whether a mark is written.
 */
export function needsEdgeMark(text: string, kind: EdgeMarkKind, also?: EdgeMarkPlace): boolean {
  const place = also || {};
  let start = 0;

  // ZWSP edge mark: Unroll needs(Z r) without a recursive call stack. If the final
  // suffix needs no mark, neither does any of its leading user-authored characters.
  while (text.charCodeAt(start) === edgeMarkCode) {
    start++;
  }

  // ZWSP edge mark: the empty text needs a mark by the deviation, and each
  // leading Z protects the next. No block or inline reading is needed for it.
  if (start === text.length) {
    return true;
  }

  if (
    text.charCodeAt(start) !== codes.space &&
    text.charCodeAt(start) !== codes.ht
  ) {
    return false;
  }

  if (kind !== 'paragraph') {
    return true;
  }

  // ZWSP edge mark: holds is the field reader's answer, including its empty result for
  // spaces only. Check each suffix required by needs(Z r), never predict block openings.
  do {
    const source = text.slice(start);
    const result = transduce(
      source,
      {
        phrasing: 'paragraph',
        settle: true,
        firstInListItem: Boolean(place.taskMarker),
        firstInBlockQuote: Boolean(place.calloutDeclaration),
      },
      Bindings.none
    );

    if (result.kind !== 'inline') {
      return false;
    }

    if (
      result.children.some(function (node) {
        return node.type === 'taskMarker' || node.type === 'calloutDeclaration';
      })
    ) {
      return false;
    }
  } while (start-- > 0);

  return true;
}
