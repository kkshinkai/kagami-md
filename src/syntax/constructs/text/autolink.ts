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
import {
  asciiAlphanumeric,
  asciiAlpha,
  asciiAtext,
  asciiControl,
} from '../../kernel/utils/character/index.js';
import { codes, constants, types } from '../../kernel/utils/symbol/index.js';

export const autolink: Construct = { name: 'autolink', tokenize: tokenizeAutolink };

function tokenizeAutolink(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
  let size = 0;

  return start;

  /**
   * Start of an autolink.
   *
   * ```markdown
   * > | a<https://example.com>b
   *      ^
   * > | a<user@example.com>b
   *      ^
   * ```
   */
  function start(code: Code): State | undefined {
    assert(code === codes.lessThan, 'expected `<`');
    effects.enter(types.autolink);
    effects.enter(types.autolinkMarker);
    effects.consume(code);
    effects.exit(types.autolinkMarker);
    effects.enter(types.autolinkProtocol);
    return open;
  }

  /**
   * After `<`, at protocol or atext.
   *
   * ```markdown
   * > | a<https://example.com>b
   *       ^
   * > | a<user@example.com>b
   *       ^
   * ```
   */
  function open(code: Code): State | undefined {
    if (asciiAlpha(code)) {
      effects.consume(code);
      return schemeOrEmailAtext;
    }

    if (code === codes.atSign) {
      return nok(code);
    }

    return emailAtext(code);
  }

  /**
   * At second byte of protocol or atext.
   *
   * ```markdown
   * > | a<https://example.com>b
   *        ^
   * > | a<user@example.com>b
   *        ^
   * ```
   */
  function schemeOrEmailAtext(code: Code): State | undefined {
    // ASCII alphanumeric and `+`, `-`, and `.`.
    if (
      code === codes.plusSign ||
      code === codes.dash ||
      code === codes.dot ||
      asciiAlphanumeric(code)
    ) {
      // Count the previous alphabetical from `open` too.
      size = 1;
      return schemeInsideOrEmailAtext(code);
    }

    return emailAtext(code);
  }

  /**
   * In ambiguous protocol or atext.
   *
   * ```markdown
   * > | a<https://example.com>b
   *        ^
   * > | a<user@example.com>b
   *        ^
   * ```
   */
  function schemeInsideOrEmailAtext(code: Code): State | undefined {
    if (code === codes.colon) {
      effects.consume(code);
      size = 0;
      return urlInside;
    }

    // ASCII alphanumeric and `+`, `-`, and `.`.
    if (
      (code === codes.plusSign ||
        code === codes.dash ||
        code === codes.dot ||
        asciiAlphanumeric(code)) &&
      size++ < constants.autolinkSchemeSizeMax
    ) {
      effects.consume(code);
      return schemeInsideOrEmailAtext;
    }

    size = 0;
    return emailAtext(code);
  }

  /**
   * After protocol, in URL.
   *
   * ```markdown
   * > | a<https://example.com>b
   *             ^
   * ```
   */
  function urlInside(code: Code): State | undefined {
    if (code === codes.greaterThan) {
      effects.exit(types.autolinkProtocol);
      effects.enter(types.autolinkMarker);
      effects.consume(code);
      effects.exit(types.autolinkMarker);
      effects.exit(types.autolink);
      return ok;
    }

    // ASCII control, space, or `<`.
    if (
      code === codes.eof ||
      code === codes.space ||
      code === codes.lessThan ||
      asciiControl(code)
    ) {
      return nok(code);
    }

    effects.consume(code);
    return urlInside;
  }

  /**
   * In email atext.
   *
   * ```markdown
   * > | a<user.name@example.com>b
   *              ^
   * ```
   */
  function emailAtext(code: Code): State | undefined {
    if (code === codes.atSign) {
      effects.consume(code);
      return emailAtSignOrDot;
    }

    if (asciiAtext(code)) {
      effects.consume(code);
      return emailAtext;
    }

    return nok(code);
  }

  /**
   * In label, after at-sign or dot.
   *
   * ```markdown
   * > | a<user.name@example.com>b
   *                 ^       ^
   * ```
   */
  function emailAtSignOrDot(code: Code): State | undefined {
    return asciiAlphanumeric(code) ? emailLabel(code) : nok(code);
  }

  /**
   * In label, where `.` and `>` are allowed.
   *
   * ```markdown
   * > | a<user.name@example.com>b
   *                   ^
   * ```
   */
  function emailLabel(code: Code): State | undefined {
    if (code === codes.dot) {
      effects.consume(code);
      size = 0;
      return emailAtSignOrDot;
    }

    if (code === codes.greaterThan) {
      // Exit, then change the token type.
      effects.exit(types.autolinkProtocol).type = types.autolinkEmail;
      effects.enter(types.autolinkMarker);
      effects.consume(code);
      effects.exit(types.autolinkMarker);
      effects.exit(types.autolink);
      return ok;
    }

    return emailValue(code);
  }

  /**
   * In label, where `.` and `>` are *not* allowed.
   *
   * Though, this is also used in `emailLabel` to parse other values.
   *
   * ```markdown
   * > | a<user.name@ex-ample.com>b
   *                    ^
   * ```
   */
  function emailValue(code: Code): State | undefined {
    // ASCII alphanumeric or `-`.
    if (
      (code === codes.dash || asciiAlphanumeric(code)) &&
      size++ < constants.autolinkDomainSizeMax
    ) {
      const next = code === codes.dash ? emailValue : emailLabel;
      effects.consume(code);
      return next;
    }

    return nok(code);
  }
}

export const text = {
  [codes.lessThan]: autolink,
};
