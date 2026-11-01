/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Whether a backslash is followed by a pipe. Kagami's own. In a GFM table cell such a backslash
 * is the table's: it keeps the pipe from ending the cell, and is no character of the code or
 * the wiki link it stands in. Constructs that hold literal text check with it before they take
 * a backslash in a cell.
 */
import type { Code, Construct, Effects, State } from '../../types/index.js';
import { assert } from '../../kernel/assert.js';
import { codes } from '../../kernel/utils/symbol/index.js';

export const tablePipeEscape: Construct = { partial: true, tokenize: tokenizeTablePipeEscape };

function tokenizeTablePipeEscape(effects: Effects, ok: State, nok: State): State {
  return start;

  /**
   * At the backslash.
   *
   * ```markdown
   * > | | `a\|b` |
   *         ^
   * ```
   */
  function start(code: Code): State | undefined {
    assert(code === codes.backslash, 'expected `\\`');
    effects.enter('tablePipeEscape');
    effects.consume(code);
    effects.exit('tablePipeEscape');
    return pipe;
  }

  /**
   * After the backslash, at the pipe.
   *
   * ```markdown
   * > | | `a\|b` |
   *          ^
   * ```
   */
  function pipe(code: Code): State | undefined {
    return code === codes.verticalBar ? ok(code) : nok(code);
  }
}

declare module '../../types/index.js' {
  interface TokenTypeMap {
    tablePipeEscape: 'tablePipeEscape';
  }
}
