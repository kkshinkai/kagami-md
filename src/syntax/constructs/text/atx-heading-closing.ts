/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The closing sequence of an ATX heading, in the text of the heading's field: a run of `#`
 * after whitespace, or opening the text, that only whitespace follows to the end of the input.
 * Kagami's own. The flow construct for the heading finds the same sequence when it reads the
 * document; this finds it in a field read on its own.
 *
 * The whitespace before the sequence is taken off the data before it as a token of its own
 * (`resolveToATXHeadingClosing`), which the editor reads as text. Whitespace that opens the
 * text is all text for the editor; otherwise only its last character stands before the
 * sequence, as a heading of only spaces after its edge mark is read
 * (private-docs/deviations/zwsp-edge-mark.md).
 */
import type { Code, Construct, ConstructRecord, Effects, Event, State, TokenizeContext } from '../../types/index.js';
import { assert } from '../../kernel/assert.js';
import { markdownSpace } from '../../kernel/utils/character/index.js';
import { codes, types } from '../../kernel/utils/symbol/index.js';
import { whitespaceAtEnd } from '../shared/whitespace-at-end.js';

export const atxHeadingClosing: Construct = {
  name: 'atxHeadingClosing',
  resolveTo: resolveToATXHeadingClosing,
  tokenize: tokenizeATXHeadingClosing,
};

export const text: ConstructRecord = {
  [codes.numberSign]: atxHeadingClosing,
};

function resolveToATXHeadingClosing(events: Array<Event>, context: TokenizeContext): Array<Event> {
  let index = events.length;

  while (index--) {
    if (events[index][0] === 'enter' && events[index][1].type === 'atxHeadingClosing') {
      break;
    }
  }

  if (index < 2 || events[index - 1][1].type !== types.data) {
    return events;
  }

  const data = events[index - 1][1];
  let whitespace = whitespaceAtEnd(data, 'atxHeadingClosingWhitespaceBefore', context);

  // ZWSP edge mark: leading whitespace is text except for the last character
  // before the closing sequence; the editor keeps all of it as text.
  if (
    context.parser.target !== 'editor' &&
    whitespace &&
    index === 2 &&
    whitespace.start.offset === data.start.offset
  ) {
    whitespace = whitespaceAtEnd(data, 'atxHeadingClosingWhitespaceBefore', context, 1);
  }

  if (whitespace) {
    data.end = { ...whitespace.start };
    events.splice(index, 0, ['enter', whitespace, context], ['exit', whitespace, context]);

    if (data.start.offset === data.end.offset) {
      events.splice(index - 2, 2);
    }
  }

  return events;
}

function tokenizeATXHeadingClosing(
  this: TokenizeContext,
  effects: Effects,
  ok: State,
  nok: State
): State {
  const self = this;

  return start;

  /**
   * Start of a closing sequence.
   *
   * ```markdown
   * > | a ##
   *       ^
   * > | ##
   *     ^
   * ```
   */
  function start(code: Code): State | undefined {
    assert(code === codes.numberSign, 'expected `#`');

    // A sequence follows whitespace, or opens the text.
    if (self.previous !== codes.eof && !markdownSpace(self.previous)) {
      return nok(code);
    }

    effects.enter('atxHeadingClosing');
    return sequenceStart(code);
  }

  /**
   * At `#`.
   *
   * ```markdown
   * > | a ##
   *       ^
   * ```
   */
  function sequenceStart(code: Code): State | undefined {
    if (code === codes.numberSign) {
      effects.enter('atxHeadingClosingSequence');
      return sequence(code);
    }

    return nok(code);
  }

  /**
   * In the sequence.
   *
   * ```markdown
   * > | a ##
   *       ^^
   * ```
   */
  function sequence(code: Code): State | undefined {
    if (code === codes.numberSign) {
      effects.consume(code);
      return sequence;
    }

    effects.exit('atxHeadingClosingSequence');

    if (markdownSpace(code)) {
      effects.enter('atxHeadingClosingWhitespace');
      return whitespaceAfter(code);
    }

    return end(code);
  }

  /**
   * In whitespace after the sequence.
   *
   * ```markdown
   * > | a ##
   *         ^
   * ```
   */
  function whitespaceAfter(code: Code): State | undefined {
    if (markdownSpace(code)) {
      effects.consume(code);
      return whitespaceAfter;
    }

    effects.exit('atxHeadingClosingWhitespace');
    return end(code);
  }

  /**
   * At the end of the input.
   *
   * ```markdown
   * > | a ##
   *         ^
   * ```
   */
  function end(code: Code): State | undefined {
    if (code === codes.eof) {
      effects.exit('atxHeadingClosing');
      return ok(code);
    }

    return nok(code);
  }
}
