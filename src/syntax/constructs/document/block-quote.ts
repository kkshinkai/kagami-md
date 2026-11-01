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
import { markdownSpace } from '../../kernel/utils/character/index.js';
import { codes, constants, types } from '../../kernel/utils/symbol/index.js';

export const blockQuote: Construct = {
  continuation: { tokenize: tokenizeBlockQuoteContinuation },
  exit,
  name: 'blockQuote',
  tokenize: tokenizeBlockQuoteStart,
};

function tokenizeBlockQuoteStart(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
  const self = this;

  return start;

  /**
   * Start of block quote.
   *
   * ```markdown
   * > | > a
   *     ^
   * ```
   */
  function start(code: Code): State | undefined {
    if (code === codes.greaterThan) {
      const state = self.containerState;

      assert(state, 'expected `containerState` to be defined in container');

      if (!state.open) {
        effects.enter(types.blockQuote, { _container: true });
        state.open = true;
      }

      effects.enter(types.blockQuotePrefix);
      effects.enter(types.blockQuoteMarker);
      effects.consume(code);
      effects.exit(types.blockQuoteMarker);
      return after;
    }

    return nok(code);
  }

  /**
   * After `>`, before optional whitespace.
   *
   * ```markdown
   * > | > a
   *      ^
   * ```
   */
  function after(code: Code): State | undefined {
    if (markdownSpace(code)) {
      effects.enter(types.blockQuotePrefixWhitespace);
      effects.consume(code);
      effects.exit(types.blockQuotePrefixWhitespace);
      effects.exit(types.blockQuotePrefix);
      return ok;
    }

    effects.exit(types.blockQuotePrefix);
    return ok(code);
  }
}

/**
 * Start of block quote continuation.
 *
 * ```markdown
 *   | > a
 * > | > b
 *     ^
 * ```
 */
function tokenizeBlockQuoteContinuation(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
  const self = this;

  return contStart;

  /**
   * Start of block quote continuation.
   *
   * Also used to parse the first block quote opening.
   *
   * ```markdown
   *   | > a
   * > | > b
   *     ^
   * ```
   */
  function contStart(code: Code): State | undefined {
    if (markdownSpace(code)) {
      // Always populated by defaults.
      assert(
        self.parser.constructs.disable.null,
        'expected `disable.null` to be populated'
      );

      return factorySpace(
        effects,
        contBefore,
        types.linePrefix,
        self.parser.constructs.disable.null.includes('codeIndented')
          ? undefined
          : constants.tabSize
      )(code);
    }

    return contBefore(code);
  }

  /**
   * At `>`, after optional whitespace.
   *
   * Also used to parse the first block quote opening.
   *
   * ```markdown
   *   | > a
   * > | > b
   *     ^
   * ```
   */
  function contBefore(code: Code): State | undefined {
    return effects.attempt(blockQuote, ok, nok)(code);
  }
}

function exit(this: TokenizeContext, effects: Effects): undefined {
  effects.exit(types.blockQuote);
}

export const document = {
  [codes.greaterThan]: blockQuote,
};
