/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Node } from 'prosemirror-model';
import { blanks } from '../unparse/frames.js';

/** Preserve boundary characters when their line count is unchanged. */
export function boundaryText(previous: string, lines: number): string {
  return lineCount(previous) === lines ? previous : '\n'.repeat(lines);
}

/** Count physical line endings without interpreting Markdown. */
export function lineCount(text: string): number {
  let count = 0;
  for (let at = text.indexOf('\n'); at >= 0; at = text.indexOf('\n', at + 1)) count++;
  return count;
}

/** The blank lines owned by the document rather than its first or last unit. */
export function frameCount(doc: Node, side: 'start' | 'end'): number {
  return side === 'start' && doc.firstChild?.type.isInGroup('frontMatter') ? 0 : blanks(doc, side);
}
