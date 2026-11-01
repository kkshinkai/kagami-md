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
import { asciiPunctuation } from '../../kernel/utils/character/index.js';
import { codes, types } from '../../kernel/utils/symbol/index.js';

export const characterEscape: Construct = {
  name: 'characterEscape',
  tokenize: tokenizeCharacterEscape,
};

function tokenizeCharacterEscape(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
  return start;

  /**
   * Start of character escape.
   *
   * ```markdown
   * > | a\*b
   *      ^
   * ```
   */
  function start(code: Code): State | undefined {
    assert(code === codes.backslash, 'expected `\\`');
    effects.enter(types.characterEscape);
    effects.enter(types.escapeMarker);
    effects.consume(code);
    effects.exit(types.escapeMarker);
    return inside;
  }

  /**
   * After `\`, at punctuation.
   *
   * ```markdown
   * > | a\*b
   *       ^
   * ```
   */
  function inside(code: Code): State | undefined {
    // ASCII punctuation.
    if (asciiPunctuation(code)) {
      effects.enter(types.characterEscapeValue);
      effects.consume(code);
      effects.exit(types.characterEscapeValue);
      effects.exit(types.characterEscape);
      return ok;
    }

    return nok(code);
  }
}

export const string = {
  [codes.backslash]: characterEscape,
};

export const text = {
  [codes.backslash]: characterEscape,
};
