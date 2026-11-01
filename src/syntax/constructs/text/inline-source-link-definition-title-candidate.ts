/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The start of a title at the end of a link definition's destination field read on its own:
 * whitespace, optionally an opening title delimiter, and then the end of the input. Kagami's own.
 * It tells the editor that the user has begun a title, and with which delimiter, if they typed
 * one.
 */
import type { Code, Construct, ConstructRecord, Effects, State, TokenizeContext } from '../../types/index.js';
import { markdownSpace } from '../../kernel/utils/character/index.js';
import { codes } from '../../kernel/utils/symbol/index.js';

export const inlineSourceLinkDefinitionTitleCandidate: Construct = {
  name: 'inlineSourceLinkDefinitionTitleCandidate',
  tokenize: tokenizeLinkDefinitionTitleCandidate,
};

export const text: ConstructRecord = {
  [codes.horizontalTab]: inlineSourceLinkDefinitionTitleCandidate,
  [codes.space]: inlineSourceLinkDefinitionTitleCandidate,
};

function tokenizeLinkDefinitionTitleCandidate(
  this: TokenizeContext,
  effects: Effects,
  ok: State,
  nok: State
): State {
  return start;

  /**
   * Start of the candidate, at whitespace.
   *
   * ```markdown
   * > | /url "
   *         ^
   * ```
   */
  function start(code: Code): State | undefined {
    // Kagami: Pending opens a title only after destination whitespace.
    if (markdownSpace(code)) {
      effects.enter('inlineSourceLinkDefinitionTitleCandidate');
      effects.enter('inlineSourceLinkDefinitionTitleWhitespace');
      return whitespace(code);
    }

    return nok(code);
  }

  /**
   * In whitespace.
   *
   * ```markdown
   * > | /url "
   *         ^
   * ```
   */
  function whitespace(code: Code): State | undefined {
    if (markdownSpace(code)) {
      effects.consume(code);
      return whitespace;
    }

    effects.exit('inlineSourceLinkDefinitionTitleWhitespace');
    return code === codes.eof ? end(code) : delimiter(code);
  }

  /**
   * At a delimiter.
   *
   * ```markdown
   * > | /url "
   *          ^
   * ```
   */
  function delimiter(code: Code): State | undefined {
    if (
      code === codes.quotationMark ||
      code === codes.apostrophe ||
      code === codes.leftParenthesis
    ) {
      effects.enter('inlineSourceLinkDefinitionTitleDelimiter');
      effects.consume(code);
      effects.exit('inlineSourceLinkDefinitionTitleDelimiter');
      return end;
    }

    return nok(code);
  }

  /**
   * At the end of the input.
   *
   * ```markdown
   * > | /url "
   *           ^
   * ```
   */
  function end(code: Code): State | undefined {
    if (code === codes.eof) {
      effects.exit('inlineSourceLinkDefinitionTitleCandidate');
      return ok(code);
    }

    return nok(code);
  }
}
