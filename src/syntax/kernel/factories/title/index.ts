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
import { factorySpace } from '../space/index.js';
import { markdownLineEnding } from '../../utils/character/index.js';
import { codes, constants, types } from '../../utils/symbol/index.js';

/**
 * Parse titles.
 *
 * ###### Examples
 *
 * ```markdown
 * "a"
 * 'b'
 * (c)
 * "a
 * b"
 * 'a
 *     b'
 * (a\)b)
 * ```
 *
 * @param effects
 *   Context.
 * @param ok
 *   State switched to when successful.
 * @param nok
 *   State switched to when unsuccessful.
 * @param type
 *   Type of the whole title (`"a"`, `'b'`, `(c)`).
 * @param markerType
 *   Type for the markers (`"`, `'`, `(`, and `)`).
 * @param stringType
 *   Type for the value (`a`).
 * @returns
 *   Start state.
 */
export function factoryTitle(
  effects: Effects,
  ok: State,
  nok: State,
  type: TokenType,
  markerType: TokenType,
  stringType: TokenType,
  unfinished?: State
): State {
  let marker: NonNullable<Code>;

  return start;

  /**
   * Start of title.
   *
   * ```markdown
   * > | "a"
   *     ^
   * ```
   */
  function start(code: Code): State | undefined {
    if (
      code === codes.quotationMark ||
      code === codes.apostrophe ||
      code === codes.leftParenthesis
    ) {
      effects.enter(type);
      effects.enter(markerType);
      effects.consume(code);
      effects.exit(markerType);
      marker = code === codes.leftParenthesis ? codes.rightParenthesis : code;
      return begin;
    }

    return nok(code);
  }

  /**
   * After opening marker.
   *
   * This is also used at the closing marker.
   *
   * ```markdown
   * > | "a"
   *      ^
   * ```
   */
  function begin(code: Code): State | undefined {
    if (code === marker) {
      effects.enter(markerType);
      effects.consume(code);
      effects.exit(markerType);
      effects.exit(type);
      return ok;
    }

    // Kagami: an opening marker alone is a nonempty unfinished title, with no value token.
    if (code === codes.eof && unfinished) {
      effects.exit(type);
      return unfinished(code);
    }
    effects.enter(stringType);
    return atBreak(code);
  }

  /**
   * At something, before something else.
   *
   * ```markdown
   * > | "a"
   *      ^
   * ```
   */
  function atBreak(code: Code): State | undefined {
    if (code === marker) {
      effects.exit(stringType);
      return begin(marker);
    }

    if (code === codes.eof) {
      // Kagami: a boundary query may ask whether later source could finish this title.
      if (unfinished) {
        effects.exit(stringType);
        effects.exit(type);
        return unfinished(code);
      }
      return nok(code);
    }

    // Note: blank lines can’t exist in content.
    if (markdownLineEnding(code)) {
      // To do: use `space_or_tab_eol_with_options`, connect.
      effects.enter(types.lineEnding);
      effects.consume(code);
      effects.exit(types.lineEnding);
      return factorySpace(effects, atBreak, types.linePrefix);
    }

    effects.enter(types.chunkString, { contentType: constants.contentTypeString });
    return inside(code);
  }

  function inside(code: Code): State | undefined {
    if (code === marker || code === codes.eof || markdownLineEnding(code)) {
      effects.exit(types.chunkString);
      return atBreak(code);
    }

    effects.consume(code);
    return code === codes.backslash ? escape : inside;
  }

  /**
   * After `\`, at a special character.
   *
   * ```markdown
   * > | "a\*b"
   *      ^
   * ```
   */
  function escape(code: Code): State | undefined {
    if (code === marker || code === codes.backslash) {
      effects.consume(code);
      return inside;
    }

    return inside(code);
  }
}
