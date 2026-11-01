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
import { factorySpace } from '../../kernel/factories/space/index.js';
import { markdownLineEnding, markdownSpace } from '../../kernel/utils/character/index.js';
import { codes, constants, types } from '../../kernel/utils/symbol/index.js';

export const thematicBreak: Construct = {
  name: 'thematicBreak',
  tokenize: tokenizeThematicBreak,
};

function tokenizeThematicBreak(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
  let size = 0;
  let sequences = 0;
  let marker: NonNullable<Code>;

  return start;

  /**
   * Start of thematic break.
   *
   * ```markdown
   * > | ***
   *     ^
   * ```
   */
  function start(code: Code): State | undefined {
    effects.enter(types.thematicBreak);
    // To do: parse indent like `markdown-rs`.
    return before(code);
  }

  /**
   * After optional whitespace, at marker.
   *
   * ```markdown
   * > | ***
   *     ^
   * ```
   */
  function before(code: Code): State | undefined {
    assert(
      code === codes.asterisk ||
        code === codes.dash ||
        code === codes.underscore,
      'expected `*`, `-`, or `_`'
    );
    marker = code;
    return atBreak(code);
  }

  /**
   * After something, before something else.
   *
   * ```markdown
   * > | ***
   *     ^
   * ```
   */
  function atBreak(code: Code): State | undefined {
    if (code === marker) {
      sequences++;
      effects.enter(types.thematicBreakSequence);
      return sequence(code);
    }

    if (
      size >= constants.thematicBreakMarkerCountMin &&
      (code === codes.eof || markdownLineEnding(code))
    ) {
      effects.exit(types.thematicBreak)._thematicBreakCanSetext = marker === codes.dash && sequences === 1;
      return ok(code);
    }

    return nok(code);
  }

  /**
   * In sequence.
   *
   * ```markdown
   * > | ***
   *     ^
   * ```
   */
  function sequence(code: Code): State | undefined {
    if (code === marker) {
      effects.consume(code);
      size++;
      return sequence;
    }

    effects.exit(types.thematicBreakSequence);
    return markdownSpace(code)
      ? factorySpace(effects, atBreak, types.whitespace)(code)
      : atBreak(code);
  }
}

export const flow = {
  [codes.asterisk]: thematicBreak,
  [codes.dash]: thematicBreak,
  [codes.underscore]: thematicBreak,
};
