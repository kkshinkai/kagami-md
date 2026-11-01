/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-FileCopyrightText: Titus Wormer <tituswormer@gmail.com>
 * SPDX-License-Identifier: MPL-2.0 AND MIT
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Derived from micromark, https://github.com/micromark/micromark. */

import type { Code, Construct, Effects, Event, State, Token, TokenizeContext } from '../../types/index.js';
import { assert } from '../../kernel/assert.js';
import { factorySpace } from '../../kernel/factories/space/index.js';
import { markdownLineEnding } from '../../kernel/utils/character/index.js';
import { codes, types } from '../../kernel/utils/symbol/index.js';
import { tablePipeEscape } from '../shared/table-pipe-escape.js';

export const codeText: Construct = {
  name: 'codeText',
  previous,
  resolve: resolveCodeText,
  tokenize: tokenizeCodeText,
};

// To do: next major: don’t resolve, like `markdown-rs`.
function resolveCodeText(events: Array<Event>): Array<Event> {
  let tailExitIndex = events.length - 4;
  let headEnterIndex = 3;
  let index: number;
  let enter: number | undefined;

  // Kagami: continuation indentation is outside the content, including at its end.
  if (events[tailExitIndex][1].type === types.linePrefix) tailExitIndex -= 2;

  // If we start and end with an EOL or a space.
  if (
    (events[headEnterIndex][1].type === types.lineEnding ||
      events[headEnterIndex][1].type === 'space') &&
    (events[tailExitIndex][1].type === types.lineEnding ||
      events[tailExitIndex][1].type === 'space')
  ) {
    index = headEnterIndex;

    // And we have data.
    while (++index < tailExitIndex) {
      if (events[index][1].type === types.codeTextData) {
        // Then we have padding.
        events[headEnterIndex][1].type = types.codeTextPadding;
        events[tailExitIndex][1].type = types.codeTextPadding;
        headEnterIndex += 2;
        tailExitIndex -= 2;
        break;
      }
    }
  }

  // Merge adjacent spaces and data.
  index = headEnterIndex - 1;
  tailExitIndex++;

  while (++index <= tailExitIndex) {
    if (enter === undefined) {
      if (index !== tailExitIndex && !bounds(events[index][1].type)) {
        enter = index;
      }
    } else if (index === tailExitIndex || bounds(events[index][1].type)) {
      events[enter][1].type = types.codeTextData;

      if (index !== enter + 2) {
        events[enter][1].end = events[index - 1][1].end;
        events.splice(enter + 2, index - enter - 2);
        tailExitIndex -= index - enter - 2;
        index = enter + 2;
      }

      enter = undefined;
    }
  }

  return events;
}

/** Line layout and a table's backslash stay separate from code data (Kagami). */
function bounds(type: string): boolean {
  return type === types.lineEnding || type === types.linePrefix || type === 'codeTextTableEscape';
}

function previous(this: TokenizeContext, code: Code): boolean {
  // If there is a previous code, there will always be a tail.
  return (
    code !== codes.graveAccent ||
    this.events[this.events.length - 1][1].type === types.characterEscape
  );
}

function tokenizeCodeText(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
  const self = this;
  let sizeOpen = 0;
  let size: number;
  let token: Token;
  // Kagami: backslashes just before, in a table cell, to tell the table's from the code's.
  let backslashes = 0;

  return start;

  /**
   * Start of code (text).
   *
   * ```markdown
   * > | `a`
   *     ^
   * > | \`a`
   *      ^
   * ```
   */
  function start(code: Code): State | undefined {
    assert(code === codes.graveAccent, 'expected `` ` ``');
    assert(previous.call(self, self.previous), 'expected correct previous');
    effects.enter(types.codeText);
    effects.enter(types.codeTextSequence);
    return sequenceOpen(code);
  }

  /**
   * In opening sequence.
   *
   * ```markdown
   * > | `a`
   *     ^
   * ```
   */
  function sequenceOpen(code: Code): State | undefined {
    if (code === codes.graveAccent) {
      effects.consume(code);
      sizeOpen++;
      return sequenceOpen;
    }

    effects.exit(types.codeTextSequence);
    return between(code);
  }

  /**
   * Between something and something else.
   *
   * ```markdown
   * > | `a`
   *      ^^
   * ```
   */
  function between(code: Code): State | undefined {
    // EOF.
    if (code === codes.eof) {
      return nok(code);
    }

    // To do: next major: don’t do spaces in resolve, but when compiling,
    // like `markdown-rs`.
    // Tabs don’t work, and virtual spaces don’t make sense.
    if (code === codes.space) {
      effects.enter('space');
      effects.consume(code);
      effects.exit('space');
      return between;
    }

    // Closing fence? Could also be data.
    if (code === codes.graveAccent) {
      token = effects.enter(types.codeTextSequence);
      size = 0;
      return sequenceClose(code);
    }

    if (markdownLineEnding(code)) {
      effects.enter(types.lineEnding);
      effects.consume(code);
      effects.exit(types.lineEnding);
      // Kagami: paragraph continuation indentation is layout, also inside code.
      return factorySpace(effects, between, types.linePrefix);
    }

    // Kagami: in a table cell, a backslash before a pipe is the table's.
    if (self._gfmTableCell && code === codes.backslash) {
      return effects.check(tablePipeEscape, tableEscape, dataStart)(code);
    }

    return dataStart(code);
  }

  /**
   * Start of data.
   *
   * ```markdown
   * > | `a`
   *      ^
   * ```
   */
  function dataStart(code: Code): State | undefined {
    effects.enter(types.codeTextData);
    return data(code);
  }

  /**
   * In data.
   *
   * ```markdown
   * > | `a`
   *      ^
   * ```
   */
  function data(code: Code): State | undefined {
    if (
      code === codes.eof ||
      code === codes.space ||
      code === codes.graveAccent ||
      markdownLineEnding(code)
    ) {
      effects.exit(types.codeTextData);
      return between(code);
    }

    // Kagami: in a table cell, the last backslash of an odd run before a pipe is the table's.
    if (self._gfmTableCell && code === codes.backslash && backslashes % 2 === 0) {
      return effects.check(tablePipeEscape, dataEnd, dataInside)(code);
    }

    return dataInside(code);
  }

  /**
   * In data, at a character of it.
   *
   * ```markdown
   * > | `a`
   *      ^
   * ```
   */
  function dataInside(code: Code): State | undefined {
    backslashes = code === codes.backslash ? backslashes + 1 : 0;
    effects.consume(code);
    return data;
  }

  /**
   * At a backslash that is the table's, in data.
   *
   * ```markdown
   * > | | `a\|b` |
   *          ^
   * ```
   */
  function dataEnd(code: Code): State | undefined {
    effects.exit(types.codeTextData);
    return tableEscape(code);
  }

  /**
   * At a backslash that is the table's: it is no character of the code.
   *
   * ```markdown
   * > | | `a\|b` |
   *          ^
   * ```
   */
  function tableEscape(code: Code): State | undefined {
    effects.enter('codeTextTableEscape');
    effects.consume(code);
    effects.exit('codeTextTableEscape');
    backslashes = 0;
    return between;
  }

  /**
   * In closing sequence.
   *
   * ```markdown
   * > | `a`
   *       ^
   * ```
   */
  function sequenceClose(code: Code): State | undefined {
    // More.
    if (code === codes.graveAccent) {
      effects.consume(code);
      size++;
      return sequenceClose;
    }

    // Done!
    if (size === sizeOpen) {
      effects.exit(types.codeTextSequence);
      effects.exit(types.codeText);
      return ok(code);
    }

    // More or less accents: mark as data.
    token.type = types.codeTextData;
    return data(code);
  }
}

export const text = {
  [codes.graveAccent]: codeText,
};

declare module '../../types/index.js' {
  interface TokenTypeMap {
    codeTextTableEscape: 'codeTextTableEscape';
  }
}
