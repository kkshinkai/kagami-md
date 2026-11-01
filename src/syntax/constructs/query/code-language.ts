/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Code, Effects, InitialConstruct, State } from '../../types/index.js';
import { asciiAlphanumeric } from '../../kernel/utils/character/index.js';
import { codes, types } from '../../kernel/utils/symbol/index.js';

/** The editor's literal language name: one portable, undecoded info-string word. */
export const codeLanguage: InitialConstruct = { tokenize: initializeCodeLanguage };

function initializeCodeLanguage(effects: Effects): State {
  let valid = true;
  let size = 0;
  return start;

  /** Before the language name. */
  function start(code: Code): State | undefined {
    if (code === codes.eof) {
      effects.consume(code);
      return;
    }
    effects.enter(types.data);
    return inside(code);
  }

  /** Inside a name such as `c++`, `c#`, or `objective-c`. */
  function inside(code: Code): State | undefined {
    if (code === codes.eof) {
      const token = effects.exit(types.data);
      if (valid && size) token.type = types.codeFencedFenceInfo;
      effects.consume(code);
      return;
    }
    if (!asciiAlphanumeric(code) && code !== codes.underscore && code !== codes.dot &&
        code !== codes.plusSign && code !== codes.numberSign && code !== codes.dash) valid = false;
    size++;
    effects.consume(code);
    return inside;
  }
}
