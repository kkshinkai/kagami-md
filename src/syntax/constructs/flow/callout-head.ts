/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-FileCopyrightText: Titus Wormer <tituswormer@gmail.com>
 * SPDX-License-Identifier: MPL-2.0 AND MIT
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Derived from micromark, https://github.com/micromark/micromark. */

/**
 * The head of a callout, `[!NOTE] Title`: its declaration and its title, on the first line of
 * a block quote's content. Kagami's own, after Obsidian's callouts. Written on the model of
 * `heading-atx.ts`: the title is text of one line, as a heading's is. It opens only where the
 * document says the line is the first of a quote's content, as GFM's `tasklistCheck` opens only
 * where `subtokenize` says the text is the first content of a list item.
 *
 * The declaration that is read while a field is typed, with an option, is
 * `../text/inline-source-callout-declaration.ts`.
 */
import type { Code, Construct, Effects, Event, State, Token, TokenizeContext } from '../../types/index.js';
import { assert } from '../../kernel/assert.js';
import { factorySpace } from '../../kernel/factories/space/index.js';
import {
  asciiAlpha,
  markdownLineEndingOrSpace,
  markdownLineEnding,
  markdownSpace,
} from '../../kernel/utils/character/index.js';
import { splice } from '../../kernel/utils/chunked/index.js';
import { codes, constants, types } from '../../kernel/utils/symbol/index.js';
import { calloutTypes, type CalloutType } from '../text/inline-source-callout-declaration.js';

export const calloutHead: Construct = {
  name: 'calloutHead',
  resolve: resolveCalloutHead,
  tokenize: tokenizeCalloutHead,
};

function resolveCalloutHead(events: Array<Event>, context: TokenizeContext): Array<Event> {
  let contentEnd = events.length - 2;
  let contentStart = 9;
  let content: Token;
  let text: Token;

  // Whitespace after the declaration, part of the opening.
  if (contentStart < contentEnd && events[contentStart][1].type === types.whitespace) {
    contentStart += 2;
  }

  // Suffix whitespace, part of the closing.
  if (contentEnd > contentStart && events[contentEnd][1].type === types.whitespace) {
    contentEnd -= 2;
  }

  if (contentEnd > contentStart) {
    content = {
      type: 'calloutTitle',
      start: events[contentStart][1].start,
      end: events[contentEnd][1].end,
    };
    text = {
      type: types.chunkText,
      start: events[contentStart][1].start,
      end: events[contentEnd][1].end,
      contentType: constants.contentTypeText,
    };

    splice(events, contentStart, contentEnd - contentStart + 1, [
      ['enter', content, context],
      ['enter', text, context],
      ['exit', text, context],
      ['exit', content, context],
    ]);
  }

  return events;
}

function tokenizeCalloutHead(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
  const self = this;
  let buffer: string;

  return start;

  /**
   * Start of the head of a callout.
   *
   * ```markdown
   * > | > [!NOTE] a
   *       ^
   * ```
   */
  function start(code: Code): State | undefined {
    assert(code === codes.leftSquareBracket, 'expected `[`');

    // Exit if not on the first line of the content of a block quote.
    if (!self._calloutFirstContentOfBlockQuote) {
      return nok(code);
    }

    effects.enter('calloutHead');
    effects.enter('calloutDeclaration');
    effects.enter('calloutDeclarationMarker');
    effects.consume(code);
    return exclamationMark;
  }

  /**
   * After `[`, at `!`.
   *
   * ```markdown
   * > | > [!NOTE] a
   *        ^
   * ```
   */
  function exclamationMark(code: Code): State | undefined {
    if (code === codes.exclamationMark) {
      effects.consume(code);
      effects.exit('calloutDeclarationMarker');
      return typeStart;
    }

    return nok(code);
  }

  /**
   * After `[!`, at the type.
   *
   * ```markdown
   * > | > [!NOTE] a
   *         ^
   * ```
   */
  function typeStart(code: Code): State | undefined {
    if (asciiAlpha(code)) {
      assert(code !== null); // Always the case.
      effects.enter('calloutDeclarationType');
      effects.consume(code);
      buffer = String.fromCharCode(code);
      return type;
    }

    return nok(code);
  }

  /**
   * In the type.
   *
   * ```markdown
   * > | > [!NOTE] a
   *          ^^^
   * ```
   */
  function type(code: Code): State | undefined {
    if (asciiAlpha(code)) {
      assert(code !== null); // Always the case.
      effects.consume(code);
      buffer += String.fromCharCode(code);
      return type;
    }

    if (
      code === codes.rightSquareBracket &&
      calloutTypes.includes(buffer.toLowerCase() as CalloutType)
    ) {
      effects.exit('calloutDeclarationType');
      effects.enter('calloutDeclarationMarker');
      effects.consume(code);
      effects.exit('calloutDeclarationMarker');
      effects.exit('calloutDeclaration');
      return after;
    }

    return nok(code);
  }

  /**
   * After the declaration.
   *
   * ```markdown
   * > | > [!NOTE] a
   *              ^
   * ```
   */
  function after(code: Code): State | undefined {
    if (code === codes.eof || markdownLineEndingOrSpace(code)) {
      return atBreak(code);
    }

    return nok(code);
  }

  /**
   * After something, before something else.
   *
   * ```markdown
   * > | > [!NOTE] a
   *               ^
   * ```
   */
  function atBreak(code: Code): State | undefined {
    if (code === codes.eof || markdownLineEnding(code)) {
      effects.exit('calloutHead');
      return ok(code);
    }

    if (markdownSpace(code)) {
      return factorySpace(effects, atBreak, types.whitespace)(code);
    }

    effects.enter('calloutTitle');
    return data(code);
  }

  /**
   * In the title.
   *
   * ```markdown
   * > | > [!NOTE] a
   *               ^
   * ```
   */
  function data(code: Code): State | undefined {
    if (code === codes.eof || markdownLineEndingOrSpace(code)) {
      effects.exit('calloutTitle');
      return atBreak(code);
    }

    effects.consume(code);
    return data;
  }
}

export const flow = {
  [codes.leftSquareBracket]: calloutHead,
};

declare module '../../types/index.js' {
  interface TokenTypeMap {
    calloutHead: 'calloutHead';
    calloutDeclaration: 'calloutDeclaration';
    calloutDeclarationMarker: 'calloutDeclarationMarker';
    calloutDeclarationType: 'calloutDeclarationType';
    calloutTitle: 'calloutTitle';
  }
}
