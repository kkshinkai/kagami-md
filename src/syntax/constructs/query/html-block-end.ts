/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Code, Effects, HTMLFlowCondition, InitialConstruct, State, TokenizeContext } from '../../types/index.js';
import { blankLine } from '../../kernel/blank-line.js';
import { factoryHTMLEnd } from '../../kernel/factories/html-end/index.js';
import { markdownLineEnding } from '../../kernel/utils/character/index.js';
import { codes, constants, types } from '../../kernel/utils/symbol/index.js';

/** Read a block field under its already known HTML start condition. */
export function htmlBlockEnd(condition: HTMLFlowCondition): InitialConstruct {
  return { tokenize: initializeHTMLBlockEnd };

  function initializeHTMLBlockEnd(this: TokenizeContext, effects: Effects): State {
    return lineStart;

    /**
     * Before a line, checking the blank-line end condition of kinds 6 and 7.
     *
     * ```markdown
     *   | <div>
     * > |
     *     ^
     * ```
     */
    function lineStart(code: Code): State | undefined {
      if (code === codes.eof) {
        effects.consume(code);
        return;
      }

      if (condition === constants.htmlBasic || condition === constants.htmlComplete) {
        return effects.check(blankLine, blankLineFound, lineData)(code);
      }

      return lineData(code);
    }

    /**
     * Before HTML data, at the start of a nonterminal line.
     *
     * ```markdown
     * > | <script>data</script>
     *     ^
     * ```
     */
    function lineData(code: Code): State | undefined {
      effects.enter(types.data);
      return factoryHTMLEnd(effects, matchedLine, lineBoundary, condition)(code);
    }

    /**
     * At eol/eof, with no terminal sequence on this line.
     *
     * ```markdown
     * > | <script>x
     *              ^
     * ```
     */
    function lineBoundary(code: Code): State | undefined {
      if (code === codes.eof) {
        effects.exit(types.data);
        effects.consume(code);
        return;
      }

      effects.consume(code);
      effects.exit(types.data);
      return lineStart;
    }

    /**
     * A physical blank line ends kinds 6 and 7; EOF alone did not enter here.
     *
     * ```markdown
     *   | <div>
     * > |
     *     ^
     * ```
     */
    function blankLineFound(code: Code): State | undefined {
      effects.enter(types.data);
      return matchedLine(code);
    }

    /**
     * In the rest of the terminal line, after its ending sequence.
     *
     * ```markdown
     * > | <script>x</script>tail
     *                       ^
     * ```
     */
    function matchedLine(code: Code): State | undefined {
      if (code === codes.eof || markdownLineEnding(code)) {
        if (code !== codes.eof) {
          effects.consume(code);
        }

        const token = effects.exit(types.data);
        token.type = 'htmlBlockEnd';

        return code === codes.eof ? end(code) : after;
      }

      effects.consume(code);
      return matchedLine;
    }

    /**
     * After the first terminal line, before the remainder.
     *
     * ```markdown
     *   | <script>x</script>
     * > | tail
     *     ^
     * ```
     */
    function after(code: Code): State | undefined {
      if (code === codes.eof) {
        return end(code);
      }

      effects.enter(types.data);
      return remainder(code);
    }

    /**
     * In the remainder, which cannot change the first terminal line.
     *
     * ```markdown
     *   | <script>x</script>
     * > | tail
     *       ^
     * ```
     */
    function remainder(code: Code): State | undefined {
      if (code === codes.eof) {
        effects.exit(types.data);
        return end(code);
      }

      effects.consume(code);
      return remainder;
    }

    /**
     * At EOF after the terminal line or the remainder.
     *
     * ```markdown
     * > | <script>x</script>
     *                       ^
     * ```
     */
    function end(code: Code): State | undefined {
      effects.consume(code);
      return;
    }
  }
}

declare module '../../types/index.js' {
  interface TokenTypeMap {
    htmlBlockEnd: 'htmlBlockEnd';
  }
}
