/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { DelimitedSyntax, LinkSyntax, type Syntax } from '../syntax/index.js';

/** The inline constituents whose bodies can carry formatting. */
export type InlineBranch = DelimitedSyntax | LinkSyntax;

/** The formatting commands' names for delimiter marks. */
export type InlineFormat = 'bold' | 'italic' | 'strike' | 'highlight';
export const inlineFormats: readonly InlineFormat[] = ['bold', 'italic', 'strike', 'highlight'];

/** The formatting represented by a delimited constituent. */
export function inlineFormat(node: Syntax): InlineFormat | null {
  if (!(node instanceof DelimitedSyntax)) return null;
  switch (node.type) {
    case 'strongEmphasis': return 'bold';
    case 'emphasis': return 'italic';
    case 'strikethrough': return 'strike';
    case 'highlight': return 'highlight';
  }
}

/** The source range inside a delimiter pair or a link's brackets. */
export function inlineBody(node: InlineBranch): { from: number; to: number } {
  if (node instanceof DelimitedSyntax) return { from: node.openingDelimiter.end, to: node.closingDelimiter.start };
  return { from: node.openingBracket.end, to: node.closingBracket.start };
}
