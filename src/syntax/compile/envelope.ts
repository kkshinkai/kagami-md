/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  BlockQuoteSyntax,
  BlockSyntax,
  BulletListSyntax,
  ClauseSyntax,
  DocumentSyntax,
  FrontMatterSyntax,
  ListItemSyntax,
  OrderedListSyntax,
  TextBlockSyntax,
} from '../syntax/block.js';

/** Divide a block at its first and last syntax child when it closes. */
export function finishNode(
  node: BlockSyntax | FrontMatterSyntax | ClauseSyntax | DocumentSyntax
): undefined {
  const first = node.firstChild;
  const last = node.lastChild;

  if (first && last) {
    node.leading = first.start - node.start;
    node.trailing = node.end - last.end;
  } else if (
    node instanceof BlockQuoteSyntax ||
    node instanceof ListItemSyntax ||
    node instanceof TextBlockSyntax
  ) {
    node.trailing = node.end - node.start - node.leading;
  } else if (
    node instanceof DocumentSyntax ||
    node instanceof BulletListSyntax ||
    node instanceof OrderedListSyntax
  ) {
    node.leading = 0;
    node.trailing = node.end - node.start;
  }
}
