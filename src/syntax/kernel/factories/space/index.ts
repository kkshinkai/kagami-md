/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-FileCopyrightText: Titus Wormer <tituswormer@gmail.com>
 * SPDX-License-Identifier: MPL-2.0 AND MIT
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Derived from micromark, https://github.com/micromark/micromark. */

import type { Code, Effects, State, TokenType } from '../../../types/index.js';
import { markdownSpace } from '../../utils/character/index.js';

// To do: implement `spaceOrTab`, `spaceOrTabMinMax`, `spaceOrTabWithOptions`.

/**
 * Parse spaces and tabs.
 *
 * There is no `nok` parameter:
 *
 * *   spaces in markdown are often optional, in which case this factory can be
 *     used and `ok` will be switched to whether spaces were found or not
 * *   one line ending or space can be detected with `markdownSpace(code)` right
 *     before using `factorySpace`
 *
 * ###### Examples
 *
 * Where `␉` represents a tab (plus how much it expands) and `␠` represents a
 * single space.
 *
 * ```markdown
 * ␉
 * ␠␠␠␠
 * ␉␠
 * ```
 *
 * @param effects
 *   Context.
 * @param ok
 *   State switched to when successful.
 * @param type
 *   Type (`' \t'`).
 * @param max
 *   Max (exclusive).
 * @returns
 *   Start state.
 */
export function factorySpace(effects: Effects, ok: State, type: TokenType, max?: number): State {
  const limit = max ? max - 1 : Number.POSITIVE_INFINITY;
  let size = 0;

  return start;

  /** @type {State} */
  function start(code: Code): State | undefined {
    if (markdownSpace(code)) {
      effects.enter(type);
      return prefix(code);
    }

    return ok(code);
  }

  /** @type {State} */
  function prefix(code: Code): State | undefined {
    if (markdownSpace(code) && size++ < limit) {
      effects.consume(code);
      return prefix;
    }

    effects.exit(type);
    return ok(code);
  }
}
