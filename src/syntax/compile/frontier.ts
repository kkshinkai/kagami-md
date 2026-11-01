/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Character-bearing leaves and their completed ancestor paths, in source order.
import type { Syntax } from '../syntax/syntax.js';
import {
  TokenSyntax,
  SoftLineBreakSyntax,
  LiteralAutolinkSyntax,
  PendingThematicBreakSyntax,
  PendingSetextUnderlineSyntax,
} from '../syntax/inline.js';

import type { Frontier, FrontierPiece } from '../syntax/frontier.js';

/**
 * Linearize the content of a field: the children of a paragraph, a heading, a table cell or a
 * callout's title, or the string content of a field of a definition.
 *
 * @param children
 *   Content of the field.
 * @returns
 *   Its frontier.
 */
export function linearize(children: ReadonlyArray<Syntax>): Frontier {
  const pieces: Frontier = [];
  const result: Frontier = [];
  let index = -1;

  for (const child of children) appendNode(child, [], pieces);

  // Layout beside a line ending is not field text. Code/math padding is
  // part of the written construct, even when it stands beside a line ending.
  while (++index < pieces.length) {
    const piece = pieces[index];

    if (!isLayout(piece)) {
      result.push(piece);
      continue;
    }

    const start = index;
    const before = pieces[start - 1];
    while (index + 1 < pieces.length && isLayout(pieces[index + 1])) index++;
    const after = pieces[index + 1];

    if (!(before && isLineEnding(before)) && !(after && isLineEnding(after))) {
      let cursor = start - 1;
      while (++cursor <= index) result.push(pieces[cursor]);
    }
  }

  return result;
}

/** Lay out completed nodes in the grammar's child order. */
function appendNode(node: Syntax, ancestors: Array<Syntax>, pieces: Frontier): void {
  const nodes = ancestors.concat(node);
  if (
    node instanceof TokenSyntax ||
    node instanceof SoftLineBreakSyntax ||
    node instanceof LiteralAutolinkSyntax ||
    node instanceof PendingThematicBreakSyntax ||
    node instanceof PendingSetextUnderlineSyntax
  ) {
    pieces.push({ start: node.start, end: node.end, nodes, tag: node.tag });
    return;
  }
  for (const child of node.getChildren()) appendNode(child, nodes, pieces);
}

/** Layout trivia, as opposed to a code/math padding part. */
function isLayout(piece: FrontierPiece): boolean {
  const tail = piece.nodes[piece.nodes.length - 1];
  return (
    piece.tag === 'Trivia' &&
    !isLineEnding(piece) &&
    tail?.type !== 'codeSpanPadding' &&
    tail?.type !== 'inlineMathPadding'
  );
}

/**
 * Whether a piece is a line ending: a soft break, a line ending, or the line ending of a hard
 * break.
 *
 * @param piece
 *   Piece.
 * @returns
 *   Whether it is.
 */
function isLineEnding(piece: FrontierPiece): boolean {
  const tail = piece.nodes[piece.nodes.length - 1];
  return Boolean(tail && (tail.type === 'lineEnding' || tail.type === 'softLineBreak'));
}
