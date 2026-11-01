/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-FileCopyrightText: Titus Wormer <tituswormer@gmail.com>
 * SPDX-License-Identifier: MPL-2.0 AND MIT
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Derived from micromark-extension-gfm-task-list-item, https://github.com/micromark/micromark-extension-gfm-task-list-item. */

/**
 * A task marker at the start of a field read on its own, `[ ]`, `[x]` or `[X]`, and the
 * whitespace after it. Kagami's own, written on the model of GFM's `tasklistCheck`. The
 * block phase decides whether a list item is a task item; this answers the editor's question
 * about a field: whether its text opens with a marker, as it does while the user types one
 * into the first paragraph of a list item.
 *
 * ZWSP edge mark: spaces and tabs before it do not stop it, and stay text
 * (private-docs/deviations/zwsp-edge-mark.md).
 */
import type { Code, Construct, ConstructRecord, Effects, State, TokenizeContext } from '../../types/index.js';
import { assert } from '../../kernel/assert.js';
import { factorySpace } from '../../kernel/factories/space/index.js';
import {
  markdownLineEnding,
  markdownLineEndingOrSpace,
  markdownSpace,
} from '../../kernel/utils/character/index.js';
import { codes, types } from '../../kernel/utils/symbol/index.js';
import { atFieldStart } from '../shared/field-start.js';

export const inlineSourceTaskMarker: Construct = {
  name: 'inlineSourceTaskMarker',
  tokenize: tokenizeTaskMarker,
};

export const text: ConstructRecord = { [codes.leftSquareBracket]: inlineSourceTaskMarker };

function tokenizeTaskMarker(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
  const self = this;

  return open;

  /**
   * At the start of a task marker.
   *
   * ```markdown
   * > | [x] y.
   *     ^
   * ```
   */
  function open(code: Code): State | undefined {
    assert(code === codes.leftSquareBracket, 'expected `[`');

    // Exit if there’s stuff before, but for spaces and tabs.
    if (!atFieldStart(self)) {
      return nok(code);
    }

    effects.enter('inlineSourceTaskMarker');
    effects.enter('inlineSourceTaskMarkerBoundary');
    effects.consume(code);
    effects.exit('inlineSourceTaskMarkerBoundary');
    return inside;
  }

  /**
   * In the marker.
   *
   * ```markdown
   * > | [x] y.
   *      ^
   * > | [ ] z.
   *      ^
   * ```
   */
  function inside(code: Code): State | undefined {
    // Currently we match line endings as unchecked, as upstream does.
    if (markdownLineEndingOrSpace(code)) {
      effects.enter('inlineSourceTaskMarkerUnchecked');
      effects.consume(code);
      effects.exit('inlineSourceTaskMarkerUnchecked');
      // Kagami: the field's continuation indentation is outside the newline check.
      if (markdownLineEnding(code)) return factorySpace(effects, close, types.linePrefix);
      return close;
    }

    if (code === codes.lowercaseX || code === codes.uppercaseX) {
      effects.enter('inlineSourceTaskMarkerChecked');
      effects.consume(code);
      effects.exit('inlineSourceTaskMarkerChecked');
      return close;
    }

    return nok(code);
  }

  /**
   * At the close of the marker.
   *
   * ```markdown
   * > | [x] y.
   *       ^
   * ```
   */
  function close(code: Code): State | undefined {
    if (code === codes.rightSquareBracket) {
      effects.enter('inlineSourceTaskMarkerBoundary');
      effects.consume(code);
      effects.exit('inlineSourceTaskMarkerBoundary');
      return after;
    }

    return nok(code);
  }

  /**
   * After the marker. A line ending may follow, as it may after GFM’s check
   * in a paragraph; the line ending stays a break of the text.
   *
   * ```markdown
   * > | [x] y.
   *        ^
   * ```
   */
  function after(code: Code): State | undefined {
    if (markdownLineEnding(code)) {
      return done(code);
    }

    if (markdownSpace(code)) {
      return factorySpace(effects, done, 'inlineSourceTaskMarkerWhitespace')(code);
    }

    return nok(code);
  }

  /**
   * After the marker and its whitespace. The end of the input after
   * whitespace is an empty task item, as GFM’s check is read here.
   *
   * ```markdown
   * > | [x] y.
   *         ^
   * ```
   */
  function done(code: Code): State | undefined {
    effects.exit('inlineSourceTaskMarker');
    return ok(code);
  }
}
