/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-FileCopyrightText: Titus Wormer <tituswormer@gmail.com>
 * SPDX-License-Identifier: MPL-2.0 AND MIT
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Derived from micromark, https://github.com/micromark/micromark. */

import type { Code, Effects, State, TokenType } from '../../types/index.js';
import { factorySpace } from '../../kernel/factories/space/index.js';
import { markdownLineEnding, markdownSpace } from '../../kernel/utils/character/index.js';
import { codes, types } from '../../kernel/utils/symbol/index.js';

/** Parse a closing code or math fence after its optional indentation. */
export function factoryClosingFence(
  effects: Effects,
  ok: State,
  nok: State,
  marker: NonNullable<Code>,
  minimum: number,
  sequenceType: TokenType,
): State {
  let size = 0;

  return beforeSequenceClose;

  /**
   * In closing fence, after optional whitespace, at sequence.
   *
   * ```markdown
   *   | ~~~js
   *   | alert(1)
   * > | ~~~
   *     ^
   * ```
   */
  function beforeSequenceClose(code: Code): State | undefined {
    if (code === marker) {
      effects.enter(sequenceType);
      return sequenceClose(code);
    }

    return nok(code);
  }

  /**
   * In closing fence sequence.
   *
   * ```markdown
   *   | ~~~js
   *   | alert(1)
   * > | ~~~
   *     ^
   * ```
   */
  function sequenceClose(code: Code): State | undefined {
    if (code === marker) {
      size++;
      effects.consume(code);
      return sequenceClose;
    }

    if (size >= minimum) {
      effects.exit(sequenceType);
      return markdownSpace(code)
        ? factorySpace(effects, sequenceCloseAfter, types.whitespace)(code)
        : sequenceCloseAfter(code);
    }

    return nok(code);
  }

  /**
   * After closing fence sequence, after optional whitespace.
   *
   * ```markdown
   *   | ~~~js
   *   | alert(1)
   * > | ~~~
   *        ^
   * ```
   */
  function sequenceCloseAfter(code: Code): State | undefined {
    if (code === codes.eof || markdownLineEnding(code)) {
      return ok(code);
    }

    return nok(code);
  }
}
