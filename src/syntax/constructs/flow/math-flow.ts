/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-FileCopyrightText: Titus Wormer <tituswormer@gmail.com>
 * SPDX-License-Identifier: MPL-2.0 AND MIT
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Derived from micromark-extension-math, https://github.com/micromark/micromark-extension-math. */

import type { Code, Construct, Effects, State, TokenizeContext } from '../../types/index.js';
import { assert } from '../../kernel/assert.js'
import {factorySpace} from '../../kernel/factories/space/index.js'
import {factoryClosingFence} from '../shared/closing-fence.js'
import {markdownLineEnding} from '../../kernel/utils/character/index.js'
import {codes, constants, types} from '../../kernel/utils/symbol/index.js'

export const mathFlow: Construct = {
  tokenize: tokenizeMathFenced,
  concrete: true,
  name: 'mathFlow'
}

const nonLazyContinuation: Construct = {
  tokenize: tokenizeNonLazyContinuation,
  partial: true
}

function tokenizeMathFenced(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
  const self = this
  const tail = self.events[self.events.length - 1]
  const initialSize =
    tail && tail[1].type === types.linePrefix
      ? tail[2].sliceSerialize(tail[1], true).length
      : 0
  let sizeOpen = 0

  return start

  /**
   * Start of math.
   *
   * ```markdown
   * > | $$
   *     ^
   *   | \frac{1}{2}
   *   | $$
   * ```
   */
  function start(code: Code): State | undefined {
    assert(code === codes.dollarSign, 'expected `$`')
    effects.enter('mathFlow')
    effects.enter('mathFlowFence')
    effects.enter('mathFlowFenceSequence')
    return sequenceOpen(code)
  }

  /**
   * In opening fence sequence.
   *
   * ```markdown
   * > | $$
   *      ^
   *   | \frac{1}{2}
   *   | $$
   * ```
   */
  function sequenceOpen(code: Code): State | undefined {
    if (code === codes.dollarSign) {
      effects.consume(code)
      sizeOpen++
      return sequenceOpen
    }

    if (sizeOpen < 2) {
      return nok(code)
    }

    effects.exit('mathFlowFenceSequence')
    return factorySpace(effects, metaBefore, types.whitespace)(code)
  }

  /**
   * In opening fence, before meta.
   *
   * ```markdown
   * > | $$asciimath
   *       ^
   *   | x < y
   *   | $$
   * ```
   */
  function metaBefore(code: Code): State | undefined {
    if (code === codes.eof || markdownLineEnding(code)) {
      return metaAfter(code)
    }

    effects.enter('mathFlowFenceMeta')
    effects.enter(types.chunkString, {contentType: constants.contentTypeString})
    return meta(code)
  }

  /**
   * In meta.
   *
   * ```markdown
   * > | $$asciimath
   *        ^
   *   | x < y
   *   | $$
   * ```
   */
  function meta(code: Code): State | undefined {
    if (code === codes.eof || markdownLineEnding(code)) {
      effects.exit(types.chunkString)
      effects.exit('mathFlowFenceMeta')
      return metaAfter(code)
    }

    if (code === codes.dollarSign) {
      return nok(code)
    }

    effects.consume(code)
    return meta
  }

  /**
   * After meta.
   *
   * ```markdown
   * > | $$
   *       ^
   *   | \frac{1}{2}
   *   | $$
   * ```
   */
  function metaAfter(code: Code): State | undefined {
    // Guaranteed to be eol/eof.
    effects.exit('mathFlowFence')

    if (self.interrupt) {
      return ok(code)
    }

    return effects.attempt(
      nonLazyContinuation,
      beforeNonLazyContinuation,
      after
    )(code)
  }

  /**
   * After eol/eof in math, at a non-lazy closing fence or content.
   *
   * ```markdown
   *   | $$
   * > | \frac{1}{2}
   *     ^
   * > | $$
   *     ^
   * ```
   */
  function beforeNonLazyContinuation(code: Code): State | undefined {
    return effects.attempt(
      {tokenize: tokenizeClosingFence, partial: true},
      after,
      contentStart
    )(code)
  }

  /**
   * Before math content, definitely not before a closing fence.
   *
   * ```markdown
   *   | $$
   * > | \frac{1}{2}
   *     ^
   *   | $$
   * ```
   */
  function contentStart(code: Code): State | undefined {
    return (
      initialSize
        ? factorySpace(
            effects,
            beforeContentChunk,
            types.linePrefix,
            initialSize + 1
          )
        : beforeContentChunk
    )(code)
  }

  /**
   * Before math content, after optional prefix.
   *
   * ```markdown
   *   | $$
   * > | \frac{1}{2}
   *     ^
   *   | $$
   * ```
   */
  function beforeContentChunk(code: Code): State | undefined {
    if (code === codes.eof) {
      return after(code)
    }

    if (markdownLineEnding(code)) {
      return effects.attempt(
        nonLazyContinuation,
        beforeNonLazyContinuation,
        after
      )(code)
    }

    effects.enter('mathFlowValue')
    return contentChunk(code)
  }

  /**
   * In math content.
   *
   * ```markdown
   *   | $$
   * > | \frac{1}{2}
   *      ^
   *   | $$
   * ```
   */
  function contentChunk(code: Code): State | undefined {
    if (code === codes.eof || markdownLineEnding(code)) {
      effects.exit('mathFlowValue')
      return beforeContentChunk(code)
    }

    effects.consume(code)
    return contentChunk
  }

  /**
   * After math (ha!).
   *
   * ```markdown
   *   | $$
   *   | \frac{1}{2}
   * > | $$
   *       ^
   * ```
   */
  function after(code: Code): State | undefined {
    effects.exit('mathFlow')
    return ok(code)
  }

  function tokenizeClosingFence(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
    assert(self.parser.constructs.disable.null, 'expected `disable.null`')
    /**
     * Before closing fence, at optional whitespace.
     *
     * ```markdown
     *   | $$
     *   | \frac{1}{2}
     * > | $$
     *     ^
     * ```
     */
    return factorySpace(
      effects,
      beforeSequenceClose,
      types.linePrefix,
      self.parser.constructs.disable.null.includes('codeIndented')
        ? undefined
        : constants.tabSize
    )

    /**
     * In closing fence, after optional whitespace, at sequence.
     *
     * ```markdown
     *   | $$
     *   | \frac{1}{2}
     * > | $$
     *     ^
     * ```
     */
    function beforeSequenceClose(code: Code): State | undefined {
      effects.enter('mathFlowFence')
      return factoryClosingFence(
        effects,
        afterSequenceClose,
        nok,
        codes.dollarSign,
        sizeOpen,
        'mathFlowFenceSequence'
      )(code)
    }

    function afterSequenceClose(code: Code): State | undefined {
      effects.exit('mathFlowFence')
      return ok(code)
    }
  }
}

function tokenizeNonLazyContinuation(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
  const self = this

  return start

  function start(code: Code): State | undefined {
    if (code === null) {
      return ok(code)
    }

    assert(markdownLineEnding(code), 'expected eol')
    effects.enter(types.lineEnding)
    effects.consume(code)
    effects.exit(types.lineEnding)
    return lineStart
  }

  function lineStart(code: Code): State | undefined {
    return self.parser.lazy[self.now().line] ? nok(code) : ok(code)
  }
}

export const flow = {[codes.dollarSign]: mathFlow}
