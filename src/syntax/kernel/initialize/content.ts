/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-FileCopyrightText: Titus Wormer <tituswormer@gmail.com>
 * SPDX-License-Identifier: MPL-2.0 AND MIT
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Derived from micromark, https://github.com/micromark/micromark. */

import type { Code, Effects, InitialConstruct, State, Token, TokenizeContext } from '../../types/index.js';
import { assert } from '../assert.js';
import { factorySpace } from '../factories/space/index.js';
import { markdownLineEnding } from '../utils/character/index.js';
import { codes, constants, types } from '../utils/symbol/index.js';
import { titleOpening } from '../../constructs/query/title-opening.js';

export const content: InitialConstruct = { tokenize: initializeContent };

function initializeContent(this: TokenizeContext, effects: Effects): State {
  const contentStart = effects.attempt(
    this.parser.constructs.contentInitial,
    afterContentStartConstruct,
    paragraphStart
  );
  let previous: Token;
  let startsLinkTitle = false;

  return contentStart;

  function afterContentStartConstruct(code: Code): State | undefined {
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
    return factorySpace(effects, contentStart, types.linePrefix);
  }

  function paragraphStart(code: Code): State | undefined {
    // Kagami: retain the title-opening answer before the paragraph is consumed.
    return effects.check(titleOpening, titleInitial, paragraphInitial)(code);
  }

  function titleInitial(code: Code): State | undefined {
    startsLinkTitle = true;
    return paragraphInitial(code);
  }

  function paragraphInitial(code: Code): State | undefined {
    assert(
      code !== codes.eof && !markdownLineEnding(code),
      'expected anything other than a line ending or EOF'
    );
    effects.enter(types.paragraph, { _startsLinkTitle: startsLinkTitle });
    return lineStart(code);
  }

  function lineStart(code: Code): State | undefined {
    const token = effects.enter(types.chunkText, {
      contentType: constants.contentTypeText,
      previous,
    });

    if (previous) {
      previous.next = token;
    }

    previous = token;

    return data(code);
  }

  function data(code: Code): State | undefined {
    if (code === codes.eof) {
      effects.exit(types.chunkText);
      effects.exit(types.paragraph);
      effects.consume(code);
      return;
    }

    if (markdownLineEnding(code)) {
      effects.consume(code);
      effects.exit(types.chunkText);
      return lineStart;
    }

    // Data.
    effects.consume(code);
    return data;
  }
}
