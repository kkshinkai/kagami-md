/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-FileCopyrightText: Titus Wormer <tituswormer@gmail.com>
 * SPDX-License-Identifier: MPL-2.0 AND MIT
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Derived from micromark-extension-gfm-task-list-item, https://github.com/micromark/micromark-extension-gfm-task-list-item. */

import type { Code, Effects, State, TokenizeContext } from '../../types/index.js';
import { assert } from '../../kernel/assert.js';
import { factorySpace } from '../../kernel/factories/space/index.js';
import {
  markdownLineEnding,
  markdownLineEndingOrSpace,
  markdownSpace,
} from '../../kernel/utils/character/index.js';
import { codes, types } from '../../kernel/utils/symbol/index.js';

const tasklistCheck = { name: 'tasklistCheck', tokenize: tokenizeTasklistCheck };

export const text = { [codes.leftSquareBracket]: tasklistCheck };

function tokenizeTasklistCheck(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
  const self = this;

  return open;

  /**
   * At start of task list item check.
   *
   * ```markdown
   * > | * [x] y.
   *       ^
   * ```
   */
  function open(code: Code): State | undefined {
    assert(code === codes.leftSquareBracket, 'expected `[`');

    if (
      // Exit if there’s stuff before.
      self.previous !== codes.eof ||
      // Exit if not in the first content that is the first child of a list
      // item.
      !self._gfmTasklistFirstContentOfListItem ||
      // Kagami: a first paragraph cannot lazily continue an empty item.
      // The shared flow may include it after the item's container closed.
      self.parser.lazy[self.now().line]
    ) {
      return nok(code);
    }

    effects.enter('taskListCheck');
    effects.enter('taskListCheckMarker');
    effects.consume(code);
    effects.exit('taskListCheckMarker');
    return inside;
  }

  /**
   * In task list item check.
   *
   * ```markdown
   * > | * [x] y.
   *        ^
   * ```
   */
  function inside(code: Code): State | undefined {
    // Currently we match how GH works in files.
    // To match how GH works in comments, use `markdownSpace` (`[\t ]`) instead
    // of `markdownLineEndingOrSpace` (`[\t\n\r ]`).
    if (markdownLineEndingOrSpace(code)) {
      effects.enter('taskListCheckValueUnchecked');
      effects.consume(code);
      effects.exit('taskListCheckValueUnchecked');
      // Kagami: continuation indentation inside the check belongs to its framing,
      // not to the paragraph that begins after the complete check.
      if (markdownLineEnding(code)) return factorySpace(effects, close, 'taskListCheckLinePrefix');
      return close;
    }

    if (code === codes.uppercaseX || code === codes.lowercaseX) {
      effects.enter('taskListCheckValueChecked');
      effects.consume(code);
      effects.exit('taskListCheckValueChecked');
      return close;
    }

    return nok(code);
  }

  /**
   * At close of task list item check.
   *
   * ```markdown
   * > | * [x] y.
   *         ^
   * ```
   */
  function close(code: Code): State | undefined {
    if (code === codes.rightSquareBracket) {
      effects.enter('taskListCheckMarker');
      effects.consume(code);
      effects.exit('taskListCheckMarker');
      effects.exit('taskListCheck');
      return after;
    }

    return nok(code);
  }

  function after(code: Code): State | undefined {
    // EOL in paragraph means there must be something else after it.
    if (markdownLineEnding(code)) {
      return ok(code);
    }

    // Space or tab?
    // Check what comes after.
    if (markdownSpace(code)) {
      return effects.check({ tokenize: spaceThenNonSpace }, whitespace, nok)(code);
    }

    // EOF, or non-whitespace, both wrong.
    return nok(code);
  }

  // Kagami: name the separator after the check instead of merging it into data.
  // Same factory and accepted language as the lookahead. (proposed, 2026-10-07)
  function whitespace(code: Code): State | undefined {
    return factorySpace(effects, ok, types.whitespace)(code);
  }
}

declare module '../../types/index.js' {
  interface TokenTypeMap {
    taskListCheckLinePrefix: 'taskListCheckLinePrefix';
  }
}

function spaceThenNonSpace(this: TokenizeContext, effects: Effects, ok: State, _nok: State): State {
  return factorySpace(effects, after, types.whitespace);

  /**
   * After whitespace, after task list item check.
   *
   * ```markdown
   * > | * [x] y.
   *           ^
   * ```
   */
  function after(code: Code): State | undefined {
    // Upstream: EOF means there was nothing, so bad.
    // Kagami: EOF is good. A check followed only by whitespace is an empty task item, which GFM
    // cannot write. See private-docs/deviations/empty-task-item.md.
    // EOL means there’s content after it, so good.
    // Impossible to have more spaces.
    // Anything else is good.
    return ok(code);
  }
}
