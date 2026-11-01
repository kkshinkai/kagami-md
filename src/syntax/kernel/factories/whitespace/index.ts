/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-FileCopyrightText: Titus Wormer <tituswormer@gmail.com>
 * SPDX-License-Identifier: MPL-2.0 AND MIT
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Derived from micromark, https://github.com/micromark/micromark. */

import type { Code, Effects, State } from '../../../types/index.js';
import { factorySpace } from '../space/index.js';
import { markdownLineEnding, markdownSpace } from '../../utils/character/index.js';
import { types } from '../../utils/symbol/index.js';

/**
 * Parse spaces and tabs.
 *
 * There is no `nok` parameter:
 *
 * *   line endings or spaces in markdown are often optional, in which case this
 *     factory can be used and `ok` will be switched to whether spaces were found
 *     or not
 * *   one line ending or space can be detected with
 *     `markdownLineEndingOrSpace(code)` right before using `factoryWhitespace`
 *
 * @param effects
 *   Context.
 * @param ok
 *   State switched to when successful.
 * @returns
 *   Start state.
 */
export function factoryWhitespace(effects: Effects, ok: State): State {
  let seen: boolean;

  return start;

  function start(code: Code): State | undefined {
    if (markdownLineEnding(code)) {
      effects.enter(types.lineEnding);
      effects.consume(code);
      effects.exit(types.lineEnding);
      seen = true;
      return start;
    }

    if (markdownSpace(code)) {
      return factorySpace(
        effects,
        start,
        seen ? types.linePrefix : types.lineSuffix
      )(code);
    }

    return ok(code);
  }
}
