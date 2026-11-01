/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-FileCopyrightText: Titus Wormer <tituswormer@gmail.com>
 * SPDX-License-Identifier: MPL-2.0 AND MIT
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Derived from micromark, https://github.com/micromark/micromark. */

import { codes, values } from '../symbol/index.js';

/**
 * Turn the number (in string form as either hexa- or plain decimal) coming from
 * a numeric character reference into a character.
 *
 * Sort of like `String.fromCodePoint(Number.parseInt(value, base))`, but makes
 * non-characters and control characters safe.
 *
 * @param value
 *   Value to decode.
 * @param base
 *   Numeric base.
 * @returns
 *   Character.
 */
export function decodeNumericCharacterReference(value: string, base: number): string {
  const code = Number.parseInt(value, base);

  if (
    // C0 except for HT, LF, FF, CR, space.
    code < codes.ht ||
    code === codes.vt ||
    (code > codes.cr && code < codes.space) ||
    // Control character (DEL) of C0, and C1 controls.
    (code > codes.tilde && code < 160) ||
    // Lone high surrogates and low surrogates.
    (code > 55_295 && code < 57_344) ||
    // Noncharacters.
    (code > 64_975 && code < 65_008) ||
    /* eslint-disable no-bitwise */
    (code & 65_535) === 65_535 ||
    (code & 65_535) === 65_534 ||
    /* eslint-enable no-bitwise */
    // Out of range
    code > 1_114_111
  ) {
    return values.replacementCharacter;
  }

  return String.fromCodePoint(code);
}
