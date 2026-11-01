/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-FileCopyrightText: Titus Wormer <tituswormer@gmail.com>
 * SPDX-License-Identifier: MPL-2.0 AND MIT
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Derived from micromark, https://github.com/micromark/micromark. */

import type { Code, Effects, State, TokenType } from '../../../types/index.js';
import {
  asciiControl,
  markdownLineEndingOrSpace,
  markdownLineEnding,
} from '../../utils/character/index.js';
import { codes, constants, types } from '../../utils/symbol/index.js';

/**
 * Parse destinations.
 *
 * ###### Examples
 *
 * ```markdown
 * <a>
 * <a\>b>
 * <a b>
 * <a)>
 * a
 * a\)b
 * a(b)c
 * a(b)
 * ```
 *
 * @param effects
 *   Context.
 * @param ok
 *   State switched to when successful.
 * @param nok
 *   State switched to when unsuccessful.
 * @param type
 *   Type for whole (`<a>` or `b`).
 * @param literalType
 *   Type when enclosed (`<a>`).
 * @param literalMarkerType
 *   Type for enclosing (`<` and `>`).
 * @param rawType
 *   Type when not enclosed (`b`).
 * @param stringType
 *   Type for the value (`a` or `b`).
 * @param max
 *   Depth of nested parens (inclusive).
 * @returns
 *   Start state.
 */
export function factoryDestination(
  effects: Effects,
  ok: State,
  nok: State,
  type: TokenType,
  literalType: TokenType,
  literalMarkerType: TokenType,
  rawType: TokenType,
  stringType: TokenType,
  max?: number
): State {
  const limit = max || Number.POSITIVE_INFINITY;
  let balance = 0;

  return start;

  /**
   * Start of destination.
   *
   * ```markdown
   * > | <aa>
   *     ^
   * > | aa
   *     ^
   * ```
   */
  function start(code: Code): State | undefined {
    if (code === codes.lessThan) {
      effects.enter(type);
      effects.enter(literalType);
      effects.enter(literalMarkerType);
      effects.consume(code);
      effects.exit(literalMarkerType);
      return enclosedBefore;
    }

    // ASCII control, space, closing paren.
    if (
      code === codes.eof ||
      code === codes.space ||
      code === codes.rightParenthesis ||
      asciiControl(code)
    ) {
      return nok(code);
    }

    effects.enter(type);
    effects.enter(rawType);
    effects.enter(stringType);
    effects.enter(types.chunkString, {
      contentType: constants.contentTypeString,
    });
    return raw(code);
  }

  /**
   * After `<`, at an enclosed destination.
   *
   * ```markdown
   * > | <aa>
   *      ^
   * ```
   */
  function enclosedBefore(code: Code): State | undefined {
    if (code === codes.greaterThan) {
      effects.enter(literalMarkerType);
      effects.consume(code);
      effects.exit(literalMarkerType);
      effects.exit(literalType);
      effects.exit(type);
      return ok;
    }

    effects.enter(stringType);
    effects.enter(types.chunkString, {
      contentType: constants.contentTypeString,
    });
    return enclosed(code);
  }

  /**
   * In enclosed destination.
   *
   * ```markdown
   * > | <aa>
   *      ^
   * ```
   */
  function enclosed(code: Code): State | undefined {
    if (code === codes.greaterThan) {
      effects.exit(types.chunkString);
      effects.exit(stringType);
      return enclosedBefore(code);
    }

    if (
      code === codes.eof ||
      code === codes.lessThan ||
      markdownLineEnding(code)
    ) {
      return nok(code);
    }

    effects.consume(code);
    return code === codes.backslash ? enclosedEscape : enclosed;
  }

  /**
   * After `\`, at a special character.
   *
   * ```markdown
   * > | <a\*a>
   *        ^
   * ```
   */
  function enclosedEscape(code: Code): State | undefined {
    if (
      code === codes.lessThan ||
      code === codes.greaterThan ||
      code === codes.backslash
    ) {
      effects.consume(code);
      return enclosed;
    }

    return enclosed(code);
  }

  /**
   * In raw destination.
   *
   * ```markdown
   * > | aa
   *     ^
   * ```
   */
  function raw(code: Code): State | undefined {
    if (
      !balance &&
      (code === codes.eof ||
        code === codes.rightParenthesis ||
        markdownLineEndingOrSpace(code))
    ) {
      effects.exit(types.chunkString);
      effects.exit(stringType);
      effects.exit(rawType);
      effects.exit(type);
      return ok(code);
    }

    if (balance < limit && code === codes.leftParenthesis) {
      effects.consume(code);
      balance++;
      return raw;
    }

    if (code === codes.rightParenthesis) {
      effects.consume(code);
      balance--;
      return raw;
    }

    // ASCII control (but *not* `\0`) and space and `(`.
    // Note: in `markdown-rs`, `\0` exists in codes, in `micromark-js` it
    // doesn’t.
    if (
      code === codes.eof ||
      code === codes.space ||
      code === codes.leftParenthesis ||
      asciiControl(code)
    ) {
      return nok(code);
    }

    effects.consume(code);
    return code === codes.backslash ? rawEscape : raw;
  }

  /**
   * After `\`, at special character.
   *
   * ```markdown
   * > | a\*a
   *       ^
   * ```
   */
  function rawEscape(code: Code): State | undefined {
    if (
      code === codes.leftParenthesis ||
      code === codes.rightParenthesis ||
      code === codes.backslash
    ) {
      effects.consume(code);
      return raw;
    }

    return raw(code);
  }
}
