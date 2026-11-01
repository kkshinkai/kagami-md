/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { parseFrontmatterOpening } from '../syntax/index.js';
import type { ListPattern, Opening } from './unparsed.js';

/** The supplied marker is already a list marker, not unclassified source. */
export function markerPattern(marker: string): ListPattern {
  const punctuation = marker.charAt(marker.length - 1);
  switch (punctuation) {
    case '-': return 'dash';
    case '*': return 'asterisk';
    case '+': return 'plusSign';
    case '.': return 'decimalDot';
    case ')': return 'decimalRightParenthesis';
    default: throw new RangeError('Invalid list marker');
  }
}

/** Whether this opening lets the preceding container marker interrupt a paragraph. */
export function opensAfterMarker(opening: Opening | null): boolean {
  if (!opening || opening.interruptsParagraph) return true;
  switch (opening.kind) {
    case 'listItem':
    case 'blockQuote':
    case 'footnoteDefinition':
      return false;
    default:
      return true;
  }
}

/** The front matter fence a block's first line is, when the line is exactly one. */
export function frontMatterFence(body: string): Opening.FrontMatterFence | null {
  const end = body.indexOf('\n');
  return parseFrontmatterOpening(end < 0 ? body : body.slice(0, end))?.marker ?? null;
}
