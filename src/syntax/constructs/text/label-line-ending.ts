/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-FileCopyrightText: Titus Wormer <tituswormer@gmail.com>
 * SPDX-License-Identifier: MPL-2.0 AND MIT
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Derived from micromark, https://github.com/micromark/micromark. */

/**
 * A line ending in a footnote label field read on its own. Kagami's own,
 * written on the model of `line-ending.ts`: the line ending is taken and nothing after it.
 * Link labels use `line-ending.ts`, as their factory consumes continuation indentation.
 */
import type { Code, Construct, Effects, State } from '../../types/index.js';
import { assert } from '../../kernel/assert.js';
import { markdownLineEnding } from '../../kernel/utils/character/index.js';
import { codes, types } from '../../kernel/utils/symbol/index.js';

export const labelLineEnding: Construct = { name: 'lineEnding', tokenize: tokenizeLabelLineEnding };

function tokenizeLabelLineEnding(effects: Effects, ok: State): State {
  return start;

  /**
   * At a line ending in a label.
   *
   * ```markdown
   * > | [a
   *       ^
   * > |   b]: u
   * ```
   */
  function start(code: Code): State | undefined {
    assert(markdownLineEnding(code), 'expected eol');
    effects.enter(types.lineEnding);
    effects.consume(code);
    effects.exit(types.lineEnding);
    return ok;
  }
}

export const string = {
  [codes.carriageReturn]: labelLineEnding,
  [codes.lineFeed]: labelLineEnding,
  [codes.carriageReturnLineFeed]: labelLineEnding,
};
