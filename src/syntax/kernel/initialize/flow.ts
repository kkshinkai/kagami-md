/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-FileCopyrightText: Titus Wormer <tituswormer@gmail.com>
 * SPDX-License-Identifier: MPL-2.0 AND MIT
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Derived from micromark, https://github.com/micromark/micromark. */

import type { Code, Effects, InitialConstruct, State, TokenizeContext } from '../../types/index.js';
import { assert } from '../assert.js';
import { blankLine } from '../blank-line.js';
import { content } from '../content.js';
import { factorySpace } from '../factories/space/index.js';
import { markdownLineEnding } from '../utils/character/index.js';
import { codes, types } from '../utils/symbol/index.js';

export const flow: InitialConstruct = { tokenize: initializeFlow };

function initializeFlow(this: TokenizeContext, effects: Effects): State {
  const self = this;
  const initial = effects.attempt(
    // Try to parse a blank line.
    blankLine,
    atBlankEnding,
    // Try to parse initial flow (essentially, only code).
    effects.attempt(
      this.parser.constructs.flowInitial,
      afterConstruct,
      factorySpace(
        effects,
        effects.attempt(
          this.parser.constructs.flow,
          afterConstruct,
          effects.attempt(content, afterConstruct)
        ),
        types.linePrefix
      )
    )
  );

  return initial;

  function atBlankEnding(code: Code): State | undefined {
    assert(
      code === codes.eof || markdownLineEnding(code),
      'expected eol or eof'
    );

    if (code === codes.eof) {
      effects.consume(code);
      return;
    }

    effects.enter(types.lineEndingBlank);
    effects.consume(code);
    effects.exit(types.lineEndingBlank);
    self.currentConstruct = undefined;
    return initial;
  }

  function afterConstruct(code: Code): State | undefined {
    assert(
      code === codes.eof || markdownLineEnding(code),
      'expected eol or eof'
    );

    if (code === codes.eof) {
      effects.consume(code);
      return;
    }

    effects.enter(types.lineEnding);
    effects.consume(code);
    effects.exit(types.lineEnding);
    self.currentConstruct = undefined;
    return initial;
  }
}
