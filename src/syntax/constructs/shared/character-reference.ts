/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-FileCopyrightText: Titus Wormer <tituswormer@gmail.com>
 * SPDX-License-Identifier: MPL-2.0 AND MIT
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Derived from micromark, https://github.com/micromark/micromark. */

import type { Code, Construct, Effects, State, TokenizeContext } from '../../types/index.js';
import { assert } from '../../kernel/assert.js';
import { decodeNamedCharacterReference } from '../../kernel/utils/decode-named-character-reference/index.js';
import {
  asciiAlphanumeric,
  asciiDigit,
  asciiHexDigit,
} from '../../kernel/utils/character/index.js';
import { codes, constants, types } from '../../kernel/utils/symbol/index.js';

export const characterReference: Construct = {
  name: 'characterReference',
  tokenize: tokenizeCharacterReference,
};

function tokenizeCharacterReference(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
  const self = this;
  let size = 0;
  let max: number;
  let test: (code: Code) => boolean;

  return start;

  /**
   * Start of character reference.
   *
   * ```markdown
   * > | a&amp;b
   *      ^
   * > | a&#123;b
   *      ^
   * > | a&#x9;b
   *      ^
   * ```
   */
  function start(code: Code): State | undefined {
    assert(code === codes.ampersand, 'expected `&`');
    effects.enter(types.characterReference);
    effects.enter(types.characterReferenceMarker);
    effects.consume(code);
    effects.exit(types.characterReferenceMarker);
    return open;
  }

  /**
   * After `&`, at `#` for numeric references or alphanumeric for named
   * references.
   *
   * ```markdown
   * > | a&amp;b
   *       ^
   * > | a&#123;b
   *       ^
   * > | a&#x9;b
   *       ^
   * ```
   */
  function open(code: Code): State | undefined {
    if (code === codes.numberSign) {
      effects.enter(types.characterReferenceMarkerNumeric);
      effects.consume(code);
      effects.exit(types.characterReferenceMarkerNumeric);
      return numeric;
    }

    effects.enter(types.characterReferenceValue);
    max = constants.characterReferenceNamedSizeMax;
    test = asciiAlphanumeric;
    return value(code);
  }

  /**
   * After `#`, at `x` for hexadecimals or digit for decimals.
   *
   * ```markdown
   * > | a&#123;b
   *        ^
   * > | a&#x9;b
   *        ^
   * ```
   */
  function numeric(code: Code): State | undefined {
    if (code === codes.uppercaseX || code === codes.lowercaseX) {
      effects.enter(types.characterReferenceMarkerHexadecimal);
      effects.consume(code);
      effects.exit(types.characterReferenceMarkerHexadecimal);
      effects.enter(types.characterReferenceValue);
      max = constants.characterReferenceHexadecimalSizeMax;
      test = asciiHexDigit;
      return value;
    }

    effects.enter(types.characterReferenceValue);
    max = constants.characterReferenceDecimalSizeMax;
    test = asciiDigit;
    return value(code);
  }

  /**
   * After markers (`&#x`, `&#`, or `&`), in value, before `;`.
   *
   * The character reference kind defines what and how many characters are
   * allowed.
   *
   * ```markdown
   * > | a&amp;b
   *       ^^^
   * > | a&#123;b
   *        ^^^
   * > | a&#x9;b
   *         ^
   * ```
   */
  function value(code: Code): State | undefined {
    if (code === codes.semicolon && size) {
      const token = effects.exit(types.characterReferenceValue);

      if (
        test === asciiAlphanumeric &&
        !decodeNamedCharacterReference(self.sliceSerialize(token))
      ) {
        return nok(code);
      }

      // To do: `markdown-rs` uses a different name:
      // `CharacterReferenceMarkerSemi`.
      effects.enter(types.characterReferenceMarker);
      effects.consume(code);
      effects.exit(types.characterReferenceMarker);
      effects.exit(types.characterReference);
      return ok;
    }

    if (test(code) && size++ < max) {
      effects.consume(code);
      return value;
    }

    return nok(code);
  }
}

export const string = {
  [codes.ampersand]: characterReference,
};

export const text = {
  [codes.ampersand]: characterReference,
};
