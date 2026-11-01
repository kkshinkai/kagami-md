/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Code, Construct, Effects, InitialConstruct, State, TokenizeContext } from '../../types/index.js';
import { paragraphInterruptions } from '../bundle.js';
import { table } from '../flow/gfm-table.js';
import { factorySpace } from '../../kernel/factories/space/index.js';
import { markdownLineEnding, markdownSpace } from '../../kernel/utils/character/index.js';
import { codes, constants, types } from '../../kernel/utils/symbol/index.js';

/** Ask the block recognizers about each line while keeping it in paragraph context. */
export const paragraphReactions: InitialConstruct = { tokenize: initializeParagraphReactions };

function initializeParagraphReactions(this: TokenizeContext, effects: Effects): State {
  const self = this;
  const tableHead: Construct = { partial: true, tokenize: tokenizeTableHead };
  let delimiterLine = 0;
  let lineType: 'data' | 'paragraphReaction' = types.data;

  return lineStart;

  /**
   * At a paragraph line, before its indentation.
   *
   * ```markdown
   *   | text
   * > |   # heading
   *     ^
   * ```
   */
  function lineStart(code: Code): State | undefined {
    self.containerState = {};
    lineType = types.data;
    return factorySpace(effects, prefixed, types.linePrefix, constants.tabSize)(code);
  }

  /**
   * After up to three columns of indentation, as in the content continuation check.
   *
   * ```markdown
   *   | text
   * > |   # heading
   *       ^
   * ```
   */
  function prefixed(code: Code): State | undefined {
    const line = self.now().line;
    // Four columns keep this line in the paragraph. A delimiter already found by the
    // preceding head is protected too, so it cannot become another table's head.
    if (markdownSpace(code)) {
      return dataStart(code);
    }

    if (delimiterLine === line) {
      return reacted(code);
    }

    if (line === 1) {
      return checkTable(code);
    }

    return effects.interrupt(
      self.parser.constructs.document,
      reacted,
      effects.interrupt(paragraphInterruptions, reacted, checkTable)
    )(code);
  }

  /**
   * Before a line recognized as a block opening or a table delimiter.
   *
   * ```markdown
   *   | text
   * > | # heading
   *     ^
   * ```
   */
  function reacted(code: Code): State | undefined {
    lineType = 'paragraphReaction';
    return dataStart(code);
  }

  /**
   * Before a possible table head. A table's answer belongs to its delimiter line.
   *
   * ```markdown
   * > | a | b
   *     ^
   *   | - | -
   * ```
   */
  function checkTable(code: Code): State | undefined {
    return effects.interrupt(tableHead, dataStart, dataStart)(code);
  }

  function tokenizeTableHead(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
    const self = this;
    // Call the reader's recognizer directly: its success still has the delimiter's
    // position, before the outer check rewinds. No table resolver or tree is needed.
    return table.tokenize.call(self, effects, delimiter, nok);

    /**
     * At the end of the table delimiter, before the outer check rewinds.
     *
     * ```markdown
     *   | a | b
     * > | - | -
     *          ^
     * ```
     */
    function delimiter(code: Code): State | undefined {
      delimiterLine = self.now().line;
      return ok(code);
    }
  }

  /**
   * Consume each line as paragraph data after asking its recognizers. A recognized
   * fence or HTML opening cannot take later lines out of paragraph context.
   *
   * ```markdown
   *   | text
   * > | ```
   *     ^
   *   | ***
   * ```
   */
  function dataStart(code: Code): State | undefined {
    if (code === codes.eof) {
      effects.consume(code);
      return;
    }

    if (markdownLineEnding(code)) {
      effects.enter(types.lineEnding);
      effects.consume(code);
      effects.exit(types.lineEnding);
      return lineStart;
    }

    effects.enter(lineType);
    return data(code);
  }

  /**
   * In a paragraph line, after its possible block opening has been checked.
   *
   * ```markdown
   * > | text
   *       ^
   * ```
   */
  function data(code: Code): State | undefined {
    if (code === codes.eof || markdownLineEnding(code)) {
      effects.exit(lineType);
      return dataStart(code);
    }

    effects.consume(code);
    return data;
  }
}

declare module '../../types/index.js' {
  interface TokenTypeMap {
    paragraphReaction: 'paragraphReaction';
  }
}
