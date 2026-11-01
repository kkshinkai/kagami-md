/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ZWSP edge mark: A candidate at the start of the text of a paragraph, a heading or a table
 * cell, after a task check and its whitespace. Kagami's own
 * (private-docs/deviations/zwsp-edge-mark.md). Whether a candidate is the mark is decided from
 * the whole text of its field, by the compiler; this runs after blocks have been recognized, so
 * it changes no block decision.
 */
import type { Code, Construct, ConstructRecord, Effects, State, TokenizeContext } from '../../types/index.js';
import { assert } from '../../kernel/assert.js';
import { codes, types } from '../../kernel/utils/symbol/index.js';

/**
 * ZWSP edge mark: The character, U+200B ZERO WIDTH SPACE.
 */
export const edgeMarkCode = 0x20_0b;

export const edgeMarkCandidate: Construct = {
  name: 'edgeMarkCandidate',
  tokenize: tokenizeEdgeMarkCandidate,
};

export const text: ConstructRecord = { [edgeMarkCode]: edgeMarkCandidate };

function tokenizeEdgeMarkCandidate(
  this: TokenizeContext,
  effects: Effects,
  ok: State,
  nok: State
): State {
  const self = this;

  return start;

  /**
   * ZWSP edge mark: At the candidate, `Z` standing for the character.
   *
   * ```markdown
   * > | Z  abc
   *     ^
   * ```
   */
  function start(code: Code): State | undefined {
    assert(code === edgeMarkCode, 'expected a zero-width space');

    // Exit if in the title of a callout, which has no mark, or if there’s
    // stuff before, but for a task check and its whitespace.
    if (self._calloutTitle || !(self.previous === codes.eof || afterCheck(self))) {
      return nok(code);
    }

    effects.enter('edgeMarkCandidate');
    effects.consume(code);
    effects.exit('edgeMarkCandidate');
    return ok;
  }
}

/**
 * ZWSP edge mark: Whether the text so far is a task check and its whitespace: the check’s
 * token and what follows it identify the place, without reading the brackets again.
 *
 * @param context
 *   Context.
 * @returns
 *   Whether it is.
 */
function afterCheck(context: TokenizeContext): boolean {
  const events = context.events;
  let index = events.length;

  while (
    index > 0 &&
    (events[index - 1]![1].type === types.whitespace ||
      events[index - 1]![1].type === types.lineEnding ||
      events[index - 1]![1].type === types.linePrefix)
  ) {
    index--;
  }

  return (
    index > 0 &&
    events[index - 1]![0] === 'exit' &&
    events[index - 1]![1].type === 'taskListCheck' &&
    events[0]![1] === events[index - 1]![1]
  );
}
