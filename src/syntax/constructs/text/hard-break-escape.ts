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
import { markdownLineEnding } from '../../kernel/utils/character/index.js';
import { codes, types } from '../../kernel/utils/symbol/index.js';

export const hardBreakEscape: Construct = {
  name: 'hardBreakEscape',
  tokenize: tokenizeHardBreakEscape,
};

function tokenizeHardBreakEscape(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
  return start;

  /**
   * Start of a hard break (escape).
   *
   * ```markdown
   * > | a\
   *      ^
   *   | b
   * ```
   */
  function start(code: Code): State | undefined {
    assert(code === codes.backslash, 'expected `\\`');
    effects.enter(types.hardBreakEscape);
    effects.consume(code);
    return after;
  }

  /**
   * After `\`, at eol.
   *
   * ```markdown
   * > | a\
   *       ^
   *   | b
   * ```
   */
  function after(code: Code): State | undefined {
    if (markdownLineEnding(code)) {
      effects.exit(types.hardBreakEscape);
      return ok(code);
    }

    return nok(code);
  }
}

export const text = {
  [codes.backslash]: hardBreakEscape,
};
