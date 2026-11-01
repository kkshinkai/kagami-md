/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { type CaseMapping, caseMappings, cased, caseIgnorable, contains } from './dialect.js';

/** CommonMark lowercase-then-uppercase mapping pinned to Unicode 17.0. */
export function foldCase(value: string): string {
  if (/^[\x00-\x7F]*$/.test(value)) {
    return value.toUpperCase();
  }

  let result = '';

  for (const char of value) {
    const code = char.codePointAt(0)!;
    result += code < 128 ? char.toUpperCase() : mapping(code)?.[1] ?? char;
  }
  return result;
}

/** Unicode 17.0 lowercase. The contextual sigma rule follows Rust 1.90
 * library/alloc/src/str.rs. */
export function lowercase(value: string): string {
  if (/^[\x00-\x7F]*$/.test(value)) {
    return value.toLowerCase();
  }

  const chars = Array.from(value);
  let result = '';

  for (let index = 0; index < chars.length; index++) {
    const char = chars[index]!;
    const code = char.codePointAt(0)!;
    if (char === 'Σ') {
      const final = caseIgnorableThenCased(chars, index - 1, -1) &&
        !caseIgnorableThenCased(chars, index + 1, 1);
      result += final ? 'ς' : 'σ';
    } else {
      result += code < 128 ? char.toLowerCase() : mapping(code)?.[2] ?? char;
    }
  }

  return result;
}

/** Whether the nearest nonignorable character in a direction is cased. */
function caseIgnorableThenCased(chars: Array<string>, index: number, step: number): boolean {
  for (; index >= 0 && index < chars.length; index += step) {
    const code = chars[index]!.codePointAt(0)!;
    if (!contains(caseIgnorable, code)) {
      return contains(cased, code);
    }
  }

  return false;
}

/** Find the pinned case mapping for a code point. */
function mapping(code: number): CaseMapping | undefined {
  let low = 0;
  let high = caseMappings.length;

  while (low < high) {
    const middle = (low + high) >>> 1;
    const entry = caseMappings[middle]!;
    if (code < entry[0]) {
      high = middle;
    } else if (code > entry[0]) {
      low = middle + 1;
    } else {
      return entry;
    }
  }

  return undefined;
}
