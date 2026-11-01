/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-FileCopyrightText: Titus Wormer <tituswormer@gmail.com>
 * SPDX-License-Identifier: MPL-2.0 AND MIT
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Derived from micromark, https://github.com/micromark/micromark. */

import type { Code, Effects, State, TokenType, TokenizeContext } from '../../../types/index.js';
import { assert } from '../../assert.js';
import { factorySpace } from '../space/index.js';
import { markdownLineEnding, markdownSpace } from '../../utils/character/index.js';
import { codes, constants, types } from '../../utils/symbol/index.js';

/**
 * Parse labels.
 *
 * > 👉 **Note**: labels in markdown are capped at 999 characters in the string.
 *
 * ###### Examples
 *
 * ```markdown
 * [a]
 * [a
 * b]
 * [a\]b]
 * ```
 *
 * @param effects
 *   Context.
 * @param ok
 *   State switched to when successful.
 * @param nok
 *   State switched to when unsuccessful.
 * @param type
 *   Type of the whole label (`[a]`).
 * @param markerType
 *   Type for the markers (`[` and `]`).
 * @param stringType
 *   Type for the identifier (`a`).
 * @returns
 *   Start state.
 */
export function factoryLabel(
  this: TokenizeContext,
  effects: Effects,
  ok: State,
  nok: State,
  type: TokenType,
  markerType: TokenType,
  stringType: TokenType
): State {
  const self = this;
  let size = 0;
  let seen: boolean;

  return start;

  /**
   * Start of label.
   *
   * ```markdown
   * > | [a]
   *     ^
   * ```
   */
  function start(code: Code): State | undefined {
    assert(code === codes.leftSquareBracket, 'expected `[`');
    effects.enter(type);
    effects.enter(markerType);
    effects.consume(code);
    effects.exit(markerType);
    effects.enter(stringType);
    return atBreak;
  }

  /**
   * In label, at something, before something else.
   *
   * ```markdown
   * > | [a]
   *      ^
   * ```
   */
  function atBreak(code: Code): State | undefined {
    if (
      size > constants.linkReferenceSizeMax ||
      code === codes.eof ||
      code === codes.leftSquareBracket ||
      (code === codes.rightSquareBracket && !seen) ||
      // To do: remove in the future once we’ve switched from
      // `micromark-extension-footnote` to `micromark-extension-gfm-footnote`,
      // which doesn’t need this.
      // Hidden footnotes hook.
      /* c8 ignore next 3 */
      (code === codes.caret &&
        !size &&
        '_hiddenFootnoteSupport' in self.parser.constructs)
    ) {
      return nok(code);
    }

    if (code === codes.rightSquareBracket) {
      effects.exit(stringType);
      effects.enter(markerType);
      effects.consume(code);
      effects.exit(markerType);
      effects.exit(type);
      return ok;
    }

    if (markdownLineEnding(code)) {
      effects.enter(types.lineEnding);
      effects.consume(code);
      effects.exit(types.lineEnding);
      // Kagami: continuation indentation is layout in references and definition labels.
      return factorySpace(effects, atBreak, types.linePrefix);
    }

    effects.enter(types.chunkString, { contentType: constants.contentTypeString });
    return labelInside(code);
  }

  /**
   * In label, in text.
   *
   * ```markdown
   * > | [a]
   *      ^
   * ```
   */
  function labelInside(code: Code): State | undefined {
    if (
      code === codes.eof ||
      code === codes.leftSquareBracket ||
      code === codes.rightSquareBracket ||
      markdownLineEnding(code) ||
      size++ > constants.linkReferenceSizeMax
    ) {
      effects.exit(types.chunkString);
      return atBreak(code);
    }

    effects.consume(code);
    if (!seen) seen = !markdownSpace(code);
    return code === codes.backslash ? labelEscape : labelInside;
  }

  /**
   * After `\`, at a special character.
   *
   * ```markdown
   * > | [a\*a]
   *        ^
   * ```
   */
  function labelEscape(code: Code): State | undefined {
    if (
      code === codes.leftSquareBracket ||
      code === codes.backslash ||
      code === codes.rightSquareBracket
    ) {
      effects.consume(code);
      size++;
      return labelInside;
    }

    return labelInside(code);
  }
}
