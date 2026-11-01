/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Code, Construct, Effects, InitialConstruct, State } from '../../types/index.js';
import { factoryClosingFence } from '../shared/closing-fence.js';
import { factorySpace } from '../../kernel/factories/space/index.js';
import { markdownLineEnding } from '../../kernel/utils/character/index.js';
import { codes, constants, types } from '../../kernel/utils/symbol/index.js';

/** Read each field line using the code and math readers' closing fence states. */
export function closingFences(marker: '`' | '~' | '$'): InitialConstruct {
  const code = marker.charCodeAt(0);
  const minimum = marker === '$' ? 2 : constants.codeFencedSequenceSizeMin;
  const sequenceType = marker === '$' ? 'mathFlowFenceSequence' : types.codeFencedFenceSequence;
  const closingFence: Construct = { partial: true, tokenize: tokenizeClosingFence };

  return { tokenize: initializeClosingFences };

  function tokenizeClosingFence(effects: Effects, ok: State, nok: State): State {
    return factorySpace(
      effects,
      factoryClosingFence(effects, ok, nok, code, minimum, sequenceType),
      types.linePrefix,
      constants.tabSize,
    );
  }

  function initializeClosingFences(effects: Effects): State {
    return lineStart;

    /**
     * At the start of each line, including lines after a closing fence.
     *
     * ```markdown
     * > | ~~~
     *     ^
     * > | ~~~~
     *     ^
     * ```
     */
    function lineStart(code: Code): State | undefined {
      if (code === codes.eof) {
        effects.consume(code);
        return;
      }

      return effects.attempt(closingFence, atLineEnding, contentStart)(code);
    }

    /**
     * At a line that is not a closing fence.
     *
     * ```markdown
     * > | ~~~js
     *     ^
     * ```
     */
    function contentStart(code: Code): State | undefined {
      if (markdownLineEnding(code)) {
        return atLineEnding(code);
      }

      effects.enter(types.data);
      return content(code);
    }

    /**
     * In a line that is not a closing fence.
     *
     * ```markdown
     * > | ~~~js
     *        ^
     * ```
     */
    function content(code: Code): State | undefined {
      if (code === codes.eof || markdownLineEnding(code)) {
        effects.exit(types.data);
        return atLineEnding(code);
      }

      effects.consume(code);
      return content;
    }

    /**
     * At the end of a line, whether or not it was a closing fence.
     *
     * ```markdown
     * > | ~~~
     *        ^
     * ```
     */
    function atLineEnding(code: Code): State | undefined {
      if (code === codes.eof) {
        effects.consume(code);
        return;
      }

      effects.enter(types.lineEnding);
      effects.consume(code);
      effects.exit(types.lineEnding);
      return lineStart;
    }
  }
}
