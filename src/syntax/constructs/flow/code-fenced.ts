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
import { factoryClosingFence } from '../shared/closing-fence.js';
import { markdownLineEnding, markdownSpace } from '../../kernel/utils/character/index.js';
import { codes, constants, types } from '../../kernel/utils/symbol/index.js';

const nonLazyContinuation: Construct = {
  partial: true,
  tokenize: tokenizeNonLazyContinuation,
};

export const codeFenced: Construct = {
  concrete: true,
  name: 'codeFenced',
  tokenize: tokenizeCodeFenced,
};

function tokenizeCodeFenced(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
  const self = this;
  const closeStart: Construct = { partial: true, tokenize: tokenizeCloseStart };
  let initialPrefix = 0;
  let sizeOpen = 0;
  let marker: NonNullable<Code>;

  return start;

  /**
   * Start of code.
   *
   * ```markdown
   * > | ~~~js
   *     ^
   *   | alert(1)
   *   | ~~~
   * ```
   */
  function start(code: Code): State | undefined {
    // To do: parse whitespace like `markdown-rs`.
    return beforeSequenceOpen(code);
  }

  /**
   * In opening fence, after prefix, at sequence.
   *
   * ```markdown
   * > | ~~~js
   *     ^
   *   | alert(1)
   *   | ~~~
   * ```
   */
  function beforeSequenceOpen(code: Code): State | undefined {
    assert(
      code === codes.graveAccent || code === codes.tilde,
      'expected `` ` `` or `~`'
    );

    const tail = self.events[self.events.length - 1];
    initialPrefix =
      tail && tail[1].type === types.linePrefix
        ? tail[2].sliceSerialize(tail[1], true).length
        : 0;

    marker = code;
    effects.enter(types.codeFenced);
    effects.enter(types.codeFencedFence);
    effects.enter(types.codeFencedFenceSequence);
    return sequenceOpen(code);
  }

  /**
   * In opening fence sequence.
   *
   * ```markdown
   * > | ~~~js
   *      ^
   *   | alert(1)
   *   | ~~~
   * ```
   */
  function sequenceOpen(code: Code): State | undefined {
    if (code === marker) {
      sizeOpen++;
      effects.consume(code);
      return sequenceOpen;
    }

    if (sizeOpen < constants.codeFencedSequenceSizeMin) {
      return nok(code);
    }

    effects.exit(types.codeFencedFenceSequence);
    return markdownSpace(code)
      ? factorySpace(effects, infoBefore, types.whitespace)(code)
      : infoBefore(code);
  }

  /**
   * In opening fence, after the sequence (and optional whitespace), before info.
   *
   * ```markdown
   * > | ~~~js
   *        ^
   *   | alert(1)
   *   | ~~~
   * ```
   */
  function infoBefore(code: Code): State | undefined {
    if (code === codes.eof || markdownLineEnding(code)) {
      effects.exit(types.codeFencedFence);
      return self.interrupt
        ? ok(code)
        : effects.check(nonLazyContinuation, atNonLazyBreak, after)(code);
    }

    effects.enter(types.codeFencedFenceInfo);
    effects.enter(types.chunkString, { contentType: constants.contentTypeString });
    return info(code);
  }

  /**
   * In info.
   *
   * ```markdown
   * > | ~~~js
   *        ^
   *   | alert(1)
   *   | ~~~
   * ```
   */
  function info(code: Code): State | undefined {
    if (code === codes.eof || markdownLineEnding(code)) {
      effects.exit(types.chunkString);
      effects.exit(types.codeFencedFenceInfo);
      return infoBefore(code);
    }

    if (markdownSpace(code)) {
      effects.exit(types.chunkString);
      effects.exit(types.codeFencedFenceInfo);
      return factorySpace(effects, metaBefore, types.whitespace)(code);
    }

    if (code === codes.graveAccent && code === marker) {
      return nok(code);
    }

    effects.consume(code);
    return info;
  }

  /**
   * In opening fence, after info and whitespace, before meta.
   *
   * ```markdown
   * > | ~~~js eval
   *           ^
   *   | alert(1)
   *   | ~~~
   * ```
   */
  function metaBefore(code: Code): State | undefined {
    if (code === codes.eof || markdownLineEnding(code)) {
      return infoBefore(code);
    }

    effects.enter(types.codeFencedFenceMeta);
    effects.enter(types.chunkString, { contentType: constants.contentTypeString });
    return meta(code);
  }

  /**
   * In meta.
   *
   * ```markdown
   * > | ~~~js eval
   *           ^
   *   | alert(1)
   *   | ~~~
   * ```
   */
  function meta(code: Code): State | undefined {
    if (code === codes.eof || markdownLineEnding(code)) {
      effects.exit(types.chunkString);
      effects.exit(types.codeFencedFenceMeta);
      return infoBefore(code);
    }

    if (code === codes.graveAccent && code === marker) {
      return nok(code);
    }

    effects.consume(code);
    return meta;
  }

  /**
   * At eol/eof in code, before a non-lazy closing fence or content.
   *
   * ```markdown
   * > | ~~~js
   *          ^
   * > | alert(1)
   *             ^
   *   | ~~~
   * ```
   */
  function atNonLazyBreak(code: Code): State | undefined {
    assert(markdownLineEnding(code), 'expected eol');
    return effects.attempt(closeStart, after, contentBefore)(code);
  }

  /**
   * Before code content, not a closing fence, at eol.
   *
   * ```markdown
   *   | ~~~js
   * > | alert(1)
   *             ^
   *   | ~~~
   * ```
   */
  function contentBefore(code: Code): State | undefined {
    assert(markdownLineEnding(code), 'expected eol');
    effects.enter(types.lineEnding);
    effects.consume(code);
    effects.exit(types.lineEnding);
    return contentStart;
  }

  /**
   * Before code content, not a closing fence.
   *
   * ```markdown
   *   | ~~~js
   * > | alert(1)
   *     ^
   *   | ~~~
   * ```
   */
  function contentStart(code: Code): State | undefined {
    return initialPrefix > 0 && markdownSpace(code)
      ? factorySpace(
          effects,
          beforeContentChunk,
          types.linePrefix,
          initialPrefix + 1
        )(code)
      : beforeContentChunk(code);
  }

  /**
   * Before code content, after optional prefix.
   *
   * ```markdown
   *   | ~~~js
   * > | alert(1)
   *     ^
   *   | ~~~
   * ```
   */
  function beforeContentChunk(code: Code): State | undefined {
    if (code === codes.eof || markdownLineEnding(code)) {
      return effects.check(nonLazyContinuation, atNonLazyBreak, after)(code);
    }

    effects.enter(types.codeFlowValue);
    return contentChunk(code);
  }

  /**
   * In code content.
   *
   * ```markdown
   *   | ~~~js
   * > | alert(1)
   *     ^^^^^^^^
   *   | ~~~
   * ```
   */
  function contentChunk(code: Code): State | undefined {
    if (code === codes.eof || markdownLineEnding(code)) {
      effects.exit(types.codeFlowValue);
      return beforeContentChunk(code);
    }

    effects.consume(code);
    return contentChunk;
  }

  /**
   * After code.
   *
   * ```markdown
   *   | ~~~js
   *   | alert(1)
   * > | ~~~
   *        ^
   * ```
   */
  function after(code: Code): State | undefined {
    effects.exit(types.codeFenced);
    return ok(code);
  }

  function tokenizeCloseStart(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
    return startBefore;

    function startBefore(code: Code): State | undefined {
      assert(markdownLineEnding(code), 'expected eol');
      effects.enter(types.lineEnding);
      effects.consume(code);
      effects.exit(types.lineEnding);
      return start;
    }

    /**
     * Before closing fence, at optional whitespace.
     *
     * ```markdown
     *   | ~~~js
     *   | alert(1)
     * > | ~~~
     *     ^
     * ```
     */
    function start(code: Code): State | undefined {
      // Always populated by defaults.
      assert(
        self.parser.constructs.disable.null,
        'expected `disable.null` to be populated'
      );

      // To do: `enter` here or in next state?
      effects.enter(types.codeFencedFence);
      return markdownSpace(code)
        ? factorySpace(
            effects,
            beforeSequenceClose,
            types.linePrefix,
            self.parser.constructs.disable.null.includes('codeIndented')
              ? undefined
              : constants.tabSize
          )(code)
        : beforeSequenceClose(code);
    }

    /**
     * In closing fence, after optional whitespace, at sequence.
     *
     * ```markdown
     *   | ~~~js
     *   | alert(1)
     * > | ~~~
     *     ^
     * ```
     */
    function beforeSequenceClose(code: Code): State | undefined {
      return factoryClosingFence(
        effects,
        afterSequenceClose,
        nok,
        marker,
        sizeOpen,
        types.codeFencedFenceSequence,
      )(code);
    }

    function afterSequenceClose(code: Code): State | undefined {
      effects.exit(types.codeFencedFence);
      return ok(code);
    }
  }
}

function tokenizeNonLazyContinuation(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
  const self = this;

  return start;

  function start(code: Code): State | undefined {
    if (code === codes.eof) {
      return nok(code);
    }

    assert(markdownLineEnding(code), 'expected eol');
    effects.enter(types.lineEnding);
    effects.consume(code);
    effects.exit(types.lineEnding);
    return lineStart;
  }

  function lineStart(code: Code): State | undefined {
    return self.parser.lazy[self.now().line] ? nok(code) : ok(code);
  }
}

export const flow = {
  [codes.graveAccent]: codeFenced,
  [codes.tilde]: codeFenced,
};
