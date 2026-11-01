/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-FileCopyrightText: Titus Wormer <tituswormer@gmail.com>
 * SPDX-License-Identifier: MPL-2.0 AND MIT
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Derived from micromark, https://github.com/micromark/micromark. */

import { decodeNamedCharacterReference } from '../decode-named-character-reference/index.js';
import { decodeNumericCharacterReference } from '../decode-numeric-character-reference/index.js';
import { codes, constants } from '../symbol/index.js';

const characterEscapeOrReference =
  /\\([!-/:-@[-`{-~])|&(#(?:\d{1,7}|x[\da-f]{1,6})|[\da-z]{1,31});/gi;

/**
 * Decode markdown strings (which occur in places such as fenced code info
 * strings, destinations, labels, and titles).
 *
 * The “string” content type allows character escapes and -references.
 * This decodes those.
 *
 * @param value
 *   Value to decode.
 * @returns
 *   Decoded value.
 */
export function decodeString(value: string): string {
  return value.replace(characterEscapeOrReference, decode);
}

/**
 * @param $0
 *   Match.
 * @param $1
 *   Character escape.
 * @param $2
 *   Character reference.
 * @returns
 *   Decoded value
 */
function decode($0: string, $1: string, $2: string): string {
  if ($1) {
    // Escape.
    return $1;
  }

  // Reference.
  const head = $2.charCodeAt(0);

  if (head === codes.numberSign) {
    const head = $2.charCodeAt(1);
    const hex = head === codes.lowercaseX || head === codes.uppercaseX;
    return decodeNumericCharacterReference(
      $2.slice(hex ? 2 : 1),
      hex ? constants.numericBaseHexadecimal : constants.numericBaseDecimal
    );
  }

  return decodeNamedCharacterReference($2) || $0;
}
