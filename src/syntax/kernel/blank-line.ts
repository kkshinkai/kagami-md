/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-FileCopyrightText: Titus Wormer <tituswormer@gmail.com>
 * SPDX-License-Identifier: MPL-2.0 AND MIT
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Derived from micromark, https://github.com/micromark/micromark. */

import type { Code, Construct, Effects, State, TokenizeContext } from '../types/index.js';
import { factorySpace } from './factories/space/index.js';
import { markdownLineEnding, markdownSpace } from './utils/character/index.js';
import { codes, types } from './utils/symbol/index.js';

export const blankLine: Construct = { partial: true, tokenize: tokenizeBlankLine };

function tokenizeBlankLine(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
  return start;

  /**
   * Start of blank line.
   *
   * > 👉 **Note**: `␠` represents a space character.
   *
   * ```markdown
   * > | ␠␠␊
   *     ^
   * > | ␊
   *     ^
   * ```
   */
  function start(code: Code): State | undefined {
    return markdownSpace(code)
      ? factorySpace(effects, after, types.linePrefix)(code)
      : after(code);
  }

  /**
   * At eof/eol, after optional whitespace.
   *
   * > 👉 **Note**: `␠` represents a space character.
   *
   * ```markdown
   * > | ␠␠␊
   *       ^
   * > | ␊
   *     ^
   * ```
   */
  function after(code: Code): State | undefined {
    return code === codes.eof || markdownLineEnding(code) ? ok(code) : nok(code);
  }
}
