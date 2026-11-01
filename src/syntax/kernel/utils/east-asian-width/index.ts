/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// A character's East Asian Width class (Unicode Standard Annex #11), from the pinned table.
import { ambiguousRanges, wideRanges } from './ranges.js';
import { contains } from '../character/dialect.js';

/** Whether a code point is Wide (W) or Fullwidth (F). */
export function isWide(code: number): boolean {
  return contains(wideRanges, code);
}

/** Whether a code point is Ambiguous (A): one column in some fonts and two in others. */
export function isAmbiguous(code: number): boolean {
  return contains(ambiguousRanges, code);
}
