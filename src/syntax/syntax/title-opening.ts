/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { queryEvents } from '../compile/query.js';
import { linkTitleStart } from '../constructs/query/title-opening.js';

/** Whether the field can start a definition title on the next line. */
export function startsLinkTitle(text: string): boolean {
  if (text.length === 0) return false;
  return queryEvents(text, linkTitleStart).some(([, token]) => token._startsLinkTitle === true);
}
