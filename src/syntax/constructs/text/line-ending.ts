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
import { markdownLineEnding } from '../../kernel/utils/character/index.js';
import { codes, types } from '../../kernel/utils/symbol/index.js';

export const lineEnding: Construct = { name: 'lineEnding', tokenize: tokenizeLineEnding };

function tokenizeLineEnding(this: TokenizeContext, effects: Effects, ok: State): State {
  return start;

  function start(code: Code): State | undefined {
    assert(markdownLineEnding(code), 'expected eol');
    effects.enter(types.lineEnding);
    effects.consume(code);
    effects.exit(types.lineEnding);
    return factorySpace(effects, ok, types.linePrefix);
  }
}

export const text = {
  [codes.carriageReturn]: lineEnding,
  [codes.lineFeed]: lineEnding,
  [codes.carriageReturnLineFeed]: lineEnding,
};
