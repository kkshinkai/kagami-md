/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { HTMLFlowCondition } from '../types/index.js';
import { queryEvents } from '../compile/query.js';
import { htmlBlockEnd } from '../constructs/query/html-block-end.js';

/** The first line meeting the HTML end condition, counted from 0; null if none does. */
export function htmlBlockEnds(text: string, startCondition: HTMLFlowCondition): number | null {
  for (const [kind, token] of queryEvents(text, htmlBlockEnd(startCondition))) {
    if (kind === 'enter' && token.type === 'htmlBlockEnd') {
      return token.start.line - 1;
    }
  }

  return null;
}
