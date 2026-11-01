/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-FileCopyrightText: Titus Wormer <tituswormer@gmail.com>
 * SPDX-License-Identifier: MPL-2.0 AND MIT
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Derived from micromark, https://github.com/micromark/micromark. */

import type { Code, Construct, Effects, Event, State, Token, TokenizeContext } from '../../types/index.js';
import { assert } from '../../kernel/assert.js';
import { factorySpace } from '../../kernel/factories/space/index.js';
import {
  markdownLineEndingOrSpace,
  markdownLineEnding,
  markdownSpace,
} from '../../kernel/utils/character/index.js';
import { splice } from '../../kernel/utils/chunked/index.js';
import { codes, constants, types } from '../../kernel/utils/symbol/index.js';

export const headingATX: Construct = {
  name: 'headingATX',
  resolve: resolveHeadingATX,
  tokenize: tokenizeHeadingATX,
};

function resolveHeadingATX(events: Array<Event>, context: TokenizeContext): Array<Event> {
  let contentEnd = events.length - 2;
  let contentStart = 3;
  let content: Token;
  let text: Token;

  // Prefix whitespace, part of the opening.
  if (events[contentStart][1].type === types.whitespace) {
    contentStart += 2;
  }

  // Suffix whitespace, part of the closing.
  if (
    contentEnd - 2 > contentStart &&
    events[contentEnd][1].type === types.whitespace
  ) {
    contentEnd -= 2;
  }

  if (
    events[contentEnd][1].type === types.atxHeadingSequence &&
    (contentStart === contentEnd - 1 ||
      (contentEnd - 4 > contentStart &&
        events[contentEnd - 2][1].type === types.whitespace))
  ) {
    contentEnd -= contentStart + 1 === contentEnd ? 2 : 4;
  }

  if (contentEnd > contentStart) {
    content = {
      type: types.atxHeadingText,
      start: events[contentStart][1].start,
      end: events[contentEnd][1].end,
    };
    text = {
      type: types.chunkText,
      start: events[contentStart][1].start,
      end: events[contentEnd][1].end,
      contentType: constants.contentTypeText,
    };

    splice(events, contentStart, contentEnd - contentStart + 1, [
      ['enter', content, context],
      ['enter', text, context],
      ['exit', text, context],
      ['exit', content, context],
    ]);
  }

  return events;
}

function tokenizeHeadingATX(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
  let size = 0;

  return start;

  /**
   * Start of a heading (atx).
   *
   * ```markdown
   * > | ## aa
   *     ^
   * ```
   */
  function start(code: Code): State | undefined {
    // To do: parse indent like `markdown-rs`.
    effects.enter(types.atxHeading);
    return before(code);
  }

  /**
   * After optional whitespace, at `#`.
   *
   * ```markdown
   * > | ## aa
   *     ^
   * ```
   */
  function before(code: Code): State | undefined {
    assert(code === codes.numberSign, 'expected `#`');
    effects.enter(types.atxHeadingSequence);
    return sequenceOpen(code);
  }

  /**
   * In opening sequence.
   *
   * ```markdown
   * > | ## aa
   *     ^
   * ```
   */
  function sequenceOpen(code: Code): State | undefined {
    if (
      code === codes.numberSign &&
      size++ < constants.atxHeadingOpeningFenceSizeMax
    ) {
      effects.consume(code);
      return sequenceOpen;
    }

    // Always at least one `#`.
    if (code === codes.eof || markdownLineEndingOrSpace(code)) {
      effects.exit(types.atxHeadingSequence);
      return atBreak(code);
    }

    return nok(code);
  }

  /**
   * After something, before something else.
   *
   * ```markdown
   * > | ## aa
   *       ^
   * ```
   */
  function atBreak(code: Code): State | undefined {
    if (code === codes.numberSign) {
      effects.enter(types.atxHeadingSequence);
      return sequenceFurther(code);
    }

    if (code === codes.eof || markdownLineEnding(code)) {
      effects.exit(types.atxHeading);
      // To do: interrupt like `markdown-rs`.
      // // Feel free to interrupt.
      // tokenizer.interrupt = false
      return ok(code);
    }

    if (markdownSpace(code)) {
      return factorySpace(effects, atBreak, types.whitespace)(code);
    }

    // To do: generate `data` tokens, add the `text` token later.
    // Needs edit map, see: `markdown.rs`.
    effects.enter(types.atxHeadingText);
    return data(code);
  }

  /**
   * In further sequence (after whitespace).
   *
   * Could be normal “visible” hashes in the heading or a final sequence.
   *
   * ```markdown
   * > | ## aa ##
   *           ^
   * ```
   */
  function sequenceFurther(code: Code): State | undefined {
    if (code === codes.numberSign) {
      effects.consume(code);
      return sequenceFurther;
    }

    effects.exit(types.atxHeadingSequence);
    return atBreak(code);
  }

  /**
   * In text.
   *
   * ```markdown
   * > | ## aa
   *        ^
   * ```
   */
  function data(code: Code): State | undefined {
    if (
      code === codes.eof ||
      code === codes.numberSign ||
      markdownLineEndingOrSpace(code)
    ) {
      effects.exit(types.atxHeadingText);
      return atBreak(code);
    }

    effects.consume(code);
    return data;
  }
}

export const flow = {
  [codes.numberSign]: headingATX,
};
