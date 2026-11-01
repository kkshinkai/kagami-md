/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { queryEvents } from '../compile/query.js';
import { markerLine } from '../constructs/query/marker-line.js';

/**
 * Whether a child's first written line keeps its opening after the item's complete
 * marker, optional check and whitespace prefix, starting at physical `column`.
 */
export function fitsOnMarkerLine(prefix: string, line: string, column: number): boolean {
  return queryEvents(prefix + line, markerLine(prefix.length), column).some(
    ([kind, token]) => kind === 'enter' && token.type === 'markerLineFit',
  );
}
