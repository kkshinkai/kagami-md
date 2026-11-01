/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { queryEvents } from '../compile/query.js';
import { paragraphReactions as continuationQuery } from '../constructs/query/paragraph-reactions.js';

/** The continuation lines that interrupt a paragraph, underline it, or delimit a table. */
export function paragraphReactions(text: string, column: number): ReadonlyArray<number> {
  const lines: number[] = [];
  for (const [kind, token] of queryEvents(text, continuationQuery, column)) {
    if (kind === 'enter' && token.type === 'paragraphReaction') {
      lines.push(token.start.line - 1);
    }
  }
  return lines;
}
