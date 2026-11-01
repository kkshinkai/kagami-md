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
import { codes, types } from '../../kernel/utils/symbol/index.js';
import { labelEnd } from './label-end.js';

export const labelStartLink: Construct = {
  name: 'labelStartLink',
  resolveAll: labelEnd.resolveAll,
  tokenize: tokenizeLabelStartLink,
};

function tokenizeLabelStartLink(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
  const self = this;

  return start;

  /**
   * Start of label (link) start.
   *
   * ```markdown
   * > | a [b] c
   *       ^
   * ```
   */
  function start(code: Code): State | undefined {
    assert(code === codes.leftSquareBracket, 'expected `[`');
    effects.enter(types.labelLink);
    effects.enter(types.labelMarker);
    effects.consume(code);
    effects.exit(types.labelMarker);
    effects.exit(types.labelLink);
    return after;
  }

  function after(code: Code): State | undefined {
    // To do: this isn’t needed in `micromark-extension-gfm-footnote`,
    // remove.
    // Hidden footnotes hook.
    /* c8 ignore next 3 */
    return code === codes.caret &&
      '_hiddenFootnoteSupport' in self.parser.constructs
      ? nok(code)
      : ok(code);
  }
}

export const text = {
  [codes.leftSquareBracket]: labelStartLink,
};
