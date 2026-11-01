/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-FileCopyrightText: Titus Wormer <tituswormer@gmail.com>
 * SPDX-License-Identifier: MPL-2.0 AND MIT
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Derived from micromark, https://github.com/micromark/micromark. */

import type { Code, Effects, HTMLFlowCondition, State } from '../../../types/index.js';
import { assert } from '../../assert.js';
import { asciiAlpha, markdownLineEnding } from '../../utils/character/index.js';
import { htmlRawNames } from '../../utils/html-tag-name/index.js';
import { codes, constants } from '../../utils/symbol/index.js';

/** Continue HTML data until its terminal sequence or a line boundary. */
export function factoryHTMLEnd(
  effects: Effects,
  found: State,
  lineBoundary: State,
  condition: HTMLFlowCondition,
  afterPrefix = false,
): State {
  let buffer = '';

  // The opening construct can already have consumed `<?`, `<!--`, or `<!A`.
  return afterPrefix ? continuationDeclarationInside : continuation;

  /**
   * In continuation.
   *
   * ```markdown
   * > | <!--xxx-->
   *          ^
   * ```
   */
  function continuation(code: Code): State | undefined {
    if (code === codes.dash && condition === constants.htmlComment) {
      effects.consume(code);
      return continuationCommentInside;
    }

    if (code === codes.lessThan && condition === constants.htmlRaw) {
      effects.consume(code);
      return continuationRawTagOpen;
    }

    if (code === codes.greaterThan && condition === constants.htmlDeclaration) {
      effects.consume(code);
      return found;
    }

    if (code === codes.questionMark && condition === constants.htmlInstruction) {
      effects.consume(code);
      return continuationDeclarationInside;
    }

    if (code === codes.rightSquareBracket && condition === constants.htmlCDATA) {
      effects.consume(code);
      return continuationCDATAInside;
    }

    if (code === codes.eof || markdownLineEnding(code)) {
      return lineBoundary(code);
    }

    effects.consume(code);
    return continuation;
  }

  /**
   * In comment continuation, after one `-`, expecting another.
   *
   * ```markdown
   * > | <!--xxx-->
   *             ^
   * ```
   */
  function continuationCommentInside(code: Code): State | undefined {
    if (code === codes.dash) {
      effects.consume(code);
      return continuationDeclarationInside;
    }

    return continuation(code);
  }

  /**
   * In raw continuation, after `<`, at `/`.
   *
   * ```markdown
   * > | <script>console.log(1)</script>
   *                            ^
   * ```
   */
  function continuationRawTagOpen(code: Code): State | undefined {
    if (code === codes.slash) {
      effects.consume(code);
      buffer = '';
      return continuationRawEndTag;
    }

    return continuation(code);
  }

  /**
   * In raw continuation, after `</`, in a raw tag name.
   *
   * ```markdown
   * > | <script>console.log(1)</script>
   *                             ^^^^^^
   * ```
   */
  function continuationRawEndTag(code: Code): State | undefined {
    if (code === codes.greaterThan) {
      const name = buffer.toLowerCase();

      if (htmlRawNames.includes(name)) {
        effects.consume(code);
        return found;
      }

      return continuation(code);
    }

    if (asciiAlpha(code) && buffer.length < constants.htmlRawSizeMax) {
      assert(code !== null); // Always the case.
      effects.consume(code);
      buffer += String.fromCharCode(code);
      return continuationRawEndTag;
    }

    return continuation(code);
  }

  /**
   * In cdata continuation, after `]`, expecting `]>`.
   *
   * ```markdown
   * > | <![CDATA[>&<]]>
   *                  ^
   * ```
   */
  function continuationCDATAInside(code: Code): State | undefined {
    if (code === codes.rightSquareBracket) {
      effects.consume(code);
      return continuationDeclarationInside;
    }

    return continuation(code);
  }

  /**
   * In declaration or instruction continuation, at `>`.
   *
   * ```markdown
   * > | <!-->
   *         ^
   * > | <?>
   *       ^
   * > | <!q>
   *        ^
   * > | <!--ab-->
   *             ^
   * > | <![CDATA[>&<]]>
   *                   ^
   * ```
   */
  function continuationDeclarationInside(code: Code): State | undefined {
    if (code === codes.greaterThan) {
      effects.consume(code);
      return found;
    }

    // More dashes.
    if (code === codes.dash && condition === constants.htmlComment) {
      effects.consume(code);
      return continuationDeclarationInside;
    }

    // Kagami: another `]` still leaves `]]` before a possible CDATA terminator.
    if (code === codes.rightSquareBracket && condition === constants.htmlCDATA) {
      effects.consume(code);
      return continuationDeclarationInside;
    }

    return continuation(code);
  }
}
