/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { queryEvents } from '../compile/query.js';
import { closingFences } from '../constructs/query/closing-fences.js';

/** The longest closing fence in a field, with each line starting at `column`. */
export function longestClosingFence(text: string, marker: '`' | '~' | '$', column: number): number {
  const events = queryEvents(text, closingFences(marker), column);
  let longest = 0;

  for (const [kind, token] of events) {
    if (kind === 'enter' &&
        (token.type === 'codeFencedFenceSequence' || token.type === 'mathFlowFenceSequence')) {
      longest = Math.max(longest, token.end.offset - token.start.offset);
    }
  }

  return longest;
}
