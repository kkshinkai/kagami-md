/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-FileCopyrightText: Titus Wormer <tituswormer@gmail.com>
 * SPDX-License-Identifier: MPL-2.0 AND MIT
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Derived from micromark, https://github.com/micromark/micromark. */

import type { Code, Construct, Effects, Event, State, Token, TokenizeContext } from '../types/index.js';
import { assert } from './assert.js';
import { factorySpace } from './factories/space/index.js';
import { markdownLineEnding } from './utils/character/index.js';
import { subtokenize } from './utils/subtokenize/index.js';
import { codes, constants, types } from './utils/symbol/index.js';

/**
 * No name because it must not be turned off.
 */
export const content: Construct = { resolve: resolveContent, tokenize: tokenizeContent };

const continuationConstruct: Construct = { partial: true, tokenize: tokenizeContinuation };

/**
 * Content is transparent: it’s parsed right now. That way, definitions are also
 * parsed right now: before text in paragraphs (specifically, media) are parsed.
 */
function resolveContent(events: Array<Event>): Array<Event> {
  subtokenize(events);
  return events;
}

function tokenizeContent(this: TokenizeContext, effects: Effects, ok: State): State {
  let previous: Token | undefined;

  return chunkStart;

  /**
   * Before a content chunk.
   *
   * ```markdown
   * > | abc
   *     ^
   * ```
   */
  function chunkStart(code: Code): State | undefined {
    assert(
      code !== codes.eof && !markdownLineEnding(code),
      'expected no eof or eol'
    );

    effects.enter(types.content);
    previous = effects.enter(types.chunkContent, {
      contentType: constants.contentTypeContent,
    });
    return chunkInside(code);
  }

  /**
   * In a content chunk.
   *
   * ```markdown
   * > | abc
   *     ^^^
   * ```
   */
  function chunkInside(code: Code): State | undefined {
    if (code === codes.eof) {
      return contentEnd(code);
    }

    // To do: in `markdown-rs`, each line is parsed on its own, and everything
    // is stitched together resolving.
    if (markdownLineEnding(code)) {
      return effects.check(
        continuationConstruct,
        contentContinue,
        contentEnd
      )(code);
    }

    // Data.
    effects.consume(code);
    return chunkInside;
  }

  function contentEnd(code: Code): State | undefined {
    effects.exit(types.chunkContent);
    effects.exit(types.content);
    return ok(code);
  }

  function contentContinue(code: Code): State | undefined {
    assert(markdownLineEnding(code), 'expected eol');
    effects.consume(code);
    effects.exit(types.chunkContent);
    assert(previous, 'expected previous token');
    previous.next = effects.enter(types.chunkContent, {
      contentType: constants.contentTypeContent,
      previous,
    });
    previous = previous.next;
    return chunkInside;
  }
}

function tokenizeContinuation(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
  const self = this;

  return startLookahead;

  function startLookahead(code: Code): State | undefined {
    assert(markdownLineEnding(code), 'expected a line ending');
    effects.exit(types.chunkContent);
    effects.enter(types.lineEnding);
    effects.consume(code);
    effects.exit(types.lineEnding);
    return factorySpace(effects, prefixed, types.linePrefix);
  }

  function prefixed(code: Code): State | undefined {
    if (code === codes.eof || markdownLineEnding(code)) {
      return nok(code);
    }

    // Always populated by defaults.
    assert(
      self.parser.constructs.disable.null,
      'expected `disable.null` to be populated'
    );

    const tail = self.events[self.events.length - 1];

    if (
      !self.parser.constructs.disable.null.includes('codeIndented') &&
      tail &&
      tail[1].type === types.linePrefix &&
      tail[2].sliceSerialize(tail[1], true).length >= constants.tabSize
    ) {
      return ok(code);
    }

    return effects.interrupt(self.parser.constructs.flow, nok, ok)(code);
  }
}
