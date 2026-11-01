/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-FileCopyrightText: Titus Wormer <tituswormer@gmail.com>
 * SPDX-License-Identifier: MPL-2.0 AND MIT
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Derived from micromark-extension-math, https://github.com/micromark/micromark-extension-math. */

import type { Code, Construct, Effects, Event, State, Token, TokenizeContext } from '../../types/index.js';

type Options = {singleDollarTextMath?: boolean | null | undefined}

// To do: next major: clean spaces in HTML compiler.
// This has to be coordinated together with `mdast-util-math`.

import { assert } from '../../kernel/assert.js'
import {factorySpace} from '../../kernel/factories/space/index.js'
import {markdownLineEnding} from '../../kernel/utils/character/index.js'
import {codes, types} from '../../kernel/utils/symbol/index.js'

/**
 * @param options
 *   Configuration (default: `{}`).
 * @returns
 *   Construct.
 */
export function mathText(options?: Options | null | undefined): Construct {
  const options_ = options || {}
  let single = options_.singleDollarTextMath

  if (single === null || single === undefined) {
    single = true
  }

  return {
    tokenize: tokenizeMathText,
    resolve: resolveMathText,
    previous,
    name: 'mathText'
  }

  function tokenizeMathText(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
    const self = this
    let sizeOpen = 0
    let size: number
    let token: Token

    return start

    /**
     * Start of math (text).
     *
     * ```markdown
     * > | $a$
     *     ^
     * > | \$a$
     *      ^
     * ```
     */
    function start(code: Code): State | undefined {
      assert(code === codes.dollarSign, 'expected `$`')
      assert(previous.call(self, self.previous), 'expected correct previous')
      effects.enter('mathText')
      effects.enter('mathTextSequence')
      return sequenceOpen(code)
    }

    /**
     * In opening sequence.
     *
     * ```markdown
     * > | $a$
     *     ^
     * ```
     */
    function sequenceOpen(code: Code): State | undefined {
      if (code === codes.dollarSign) {
        effects.consume(code)
        sizeOpen++
        return sequenceOpen
      }

      // Not enough markers in the sequence.
      if (sizeOpen < 2 && !single) {
        return nok(code)
      }

      effects.exit('mathTextSequence')
      return between(code)
    }

    /**
     * Between something and something else.
     *
     * ```markdown
     * > | $a$
     *      ^^
     * ```
     */
    function between(code: Code): State | undefined {
      if (code === codes.eof) {
        return nok(code)
      }

      if (code === codes.dollarSign) {
        token = effects.enter('mathTextSequence')
        size = 0
        return sequenceClose(code)
      }

      // Tabs don’t work, and virtual spaces don’t make sense.
      if (code === codes.space) {
        effects.enter('space')
        effects.consume(code)
        effects.exit('space')
        return between
      }

      if (markdownLineEnding(code)) {
        effects.enter(types.lineEnding)
        effects.consume(code)
        effects.exit(types.lineEnding)
        // Kagami: paragraph continuation indentation is layout, also inside math.
        return factorySpace(effects, between, types.linePrefix)
      }

      // Data.
      effects.enter('mathTextData')
      return data(code)
    }

    /**
     * In data.
     *
     * ```markdown
     * > | $a$
     *      ^
     * ```
     */
    function data(code: Code): State | undefined {
      if (
        code === codes.eof ||
        code === codes.space ||
        code === codes.dollarSign ||
        markdownLineEnding(code)
      ) {
        effects.exit('mathTextData')
        return between(code)
      }

      effects.consume(code)
      return data
    }

    /**
     * In closing sequence.
     *
     * ```markdown
     * > | `a`
     *       ^
     * ```
     */
    function sequenceClose(code: Code): State | undefined {
      // More.
      if (code === codes.dollarSign) {
        effects.consume(code)
        size++
        return sequenceClose
      }

      // Done!
      if (size === sizeOpen) {
        effects.exit('mathTextSequence')
        effects.exit('mathText')
        return ok(code)
      }

      // More or less accents: mark as data.
      token.type = 'mathTextData'
      return data(code)
    }
  }
}

function resolveMathText(events: Array<Event>): Array<Event> {
  let tailExitIndex = events.length - 4
  let headEnterIndex = 3
  let index: number
  let enter: number | undefined

  // Kagami: continuation indentation is outside the content, including at its end.
  if (events[tailExitIndex][1].type === types.linePrefix) tailExitIndex -= 2

  // If we start and end with an EOL or a space.
  if (
    (events[headEnterIndex][1].type === types.lineEnding ||
      events[headEnterIndex][1].type === 'space') &&
    (events[tailExitIndex][1].type === types.lineEnding ||
      events[tailExitIndex][1].type === 'space')
  ) {
    index = headEnterIndex

    // And we have data.
    while (++index < tailExitIndex) {
      if (events[index][1].type === 'mathTextData') {
        // Then we have padding.
        events[tailExitIndex][1].type = 'mathTextPadding'
        events[headEnterIndex][1].type = 'mathTextPadding'
        headEnterIndex += 2
        tailExitIndex -= 2
        break
      }
    }
  }

  // Merge adjacent spaces and data.
  index = headEnterIndex - 1
  tailExitIndex++

  while (++index <= tailExitIndex) {
    if (enter === undefined) {
      if (
        index !== tailExitIndex &&
        events[index][1].type !== types.lineEnding &&
        events[index][1].type !== types.linePrefix
      ) {
        enter = index
      }
    } else if (
      index === tailExitIndex ||
      events[index][1].type === types.lineEnding ||
      events[index][1].type === types.linePrefix
    ) {
      events[enter][1].type = 'mathTextData'

      if (index !== enter + 2) {
        events[enter][1].end = events[index - 1][1].end
        events.splice(enter + 2, index - enter - 2)
        tailExitIndex -= index - enter - 2
        index = enter + 2
      }

      enter = undefined
    }
  }

  return events
}

function previous(this: TokenizeContext, code: Code): boolean {
  // If there is a previous code, there will always be a tail.
  return (
    code !== codes.dollarSign ||
    this.events[this.events.length - 1][1].type === types.characterEscape
  )
}

export const text = {[codes.dollarSign]: mathText()}
