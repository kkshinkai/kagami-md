/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Code, Construct, Effects, InitialConstruct, State } from '../../types/index.js';
import { factoryTitle } from '../../kernel/factories/title/index.js';
import { factorySpace } from '../../kernel/factories/space/index.js';
import { markdownLineEnding, markdownSpace } from '../../kernel/utils/character/index.js';
import { codes, types } from '../../kernel/utils/symbol/index.js';

/** A definition title may finish its first line, or stay open for later source. */
export const titleOpening: Construct = { partial: true, tokenize: tokenizeTitleOpening };

/** Record whether a field opens a definition title without consuming the check. */
export const linkTitleStart: InitialConstruct = { tokenize: initializeLinkTitleStart };

function tokenizeTitleOpening(effects: Effects, ok: State, nok: State): State {
  return factoryTitle(
    effects,
    after,
    nok,
    types.definitionTitle,
    types.definitionTitleMarker,
    types.definitionTitleString,
    ok,
  );

  /**
   * After a complete title, before optional trailing whitespace.
   *
   * ```markdown
   * > | "a"␠
   *        ^
   * ```
   */
  function after(code: Code): State | undefined {
    return markdownSpace(code)
      ? factorySpace(effects, end, types.whitespace)(code)
      : end(code);
  }

  /**
   * After a complete title and its optional trailing whitespace.
   *
   * ```markdown
   * > | "a"
   *        ^
   * ```
   */
  function end(code: Code): State | undefined {
    return code === codes.eof || markdownLineEnding(code) ? ok(code) : nok(code);
  }
}

function initializeLinkTitleStart(effects: Effects): State {
  return effects.check(titleOpening, matched, unmatched);

  /**
   * Before a field that can start a title, after the lookahead has rewound.
   *
   * ```markdown
   * > | "a"
   *     ^
   * ```
   */
  function matched(code: Code): State | undefined {
    effects.enter(types.data, { _startsLinkTitle: true });
    return data(code);
  }

  /**
   * Before a field that cannot start a title.
   *
   * ```markdown
   * > | a
   *     ^
   * ```
   */
  function unmatched(code: Code): State | undefined {
    effects.enter(types.data, { _startsLinkTitle: false });
    return data(code);
  }

  /**
   * Consume the field after recording the title recognizer's answer.
   *
   * ```markdown
   * > | "a"
   *      ^
   * ```
   */
  function data(code: Code): State | undefined {
    if (code === codes.eof) {
      effects.exit(types.data);
      effects.consume(code);
      return;
    }

    effects.consume(code);
    return data;
  }
}
