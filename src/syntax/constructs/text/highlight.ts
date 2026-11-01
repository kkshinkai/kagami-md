/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-FileCopyrightText: Titus Wormer <tituswormer@gmail.com>
 * SPDX-License-Identifier: MPL-2.0 AND MIT
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Derived from micromark-extension-gfm-strikethrough, https://github.com/micromark/micromark-extension-gfm-strikethrough. */

/**
 * Highlight, `==a==`. Kagami's own, written on the model of GFM's strikethrough: a sequence
 * is exactly two `=`, it opens when no whitespace follows it and closes when no whitespace
 * precedes it, so CJK and intraword content are admitted; the resolver pairs sequences in the
 * same inline scope. A longer run of `=` stays text.
 */
import type {
  Code,
  Construct,
  ConstructRecord,
  Effects,
  Event,
  State,
  Token,
  TokenizeContext
} from '../../types/index.js';
import { assert } from '../../kernel/assert.js';
import { splice } from '../../kernel/utils/chunked/index.js';
import { markdownLineEndingOrSpace, unicodeWhitespace } from '../../kernel/utils/character/index.js';
import { resolveAll } from '../../kernel/utils/resolve-all/index.js';
import { codes, types } from '../../kernel/utils/symbol/index.js';

const highlight: Construct = {
  name: 'highlight',
  tokenize: tokenizeHighlight,
  resolveAll: resolveAllHighlight,
};

export const text: ConstructRecord = { [codes.equalsTo]: highlight };
export const insideSpan = { null: [highlight] };
export const attentionMarkers = { null: [codes.equalsTo] };

/**
 * Take events and resolve highlight.
 *
 * @param events
 *   Events.
 * @param context
 *   Context.
 * @returns
 *   Events.
 */
function resolveAllHighlight(events: Array<Event>, context: TokenizeContext): Array<Event> {
  let index = -1;

  // Walk through all events.
  while (++index < events.length) {
    // Find a token that can close.
    if (
      events[index][0] === 'enter' &&
      events[index][1].type === 'highlightSequenceTemporary' &&
      events[index][1]._close
    ) {
      let open = index;

      // Now walk back to find an opener.
      while (open--) {
        // Find a token that can open the closer.
        if (
          events[open][0] === 'exit' &&
          events[open][1].type === 'highlightSequenceTemporary' &&
          events[open][1]._open
        ) {
          events[index][1].type = 'highlightSequence';
          events[open][1].type = 'highlightSequence';

          const highlight: Token = {
            type: 'highlight',
            start: Object.assign({}, events[open][1].start),
            end: Object.assign({}, events[index][1].end),
          };

          const text: Token = {
            type: 'highlightText',
            start: Object.assign({}, events[open][1].end),
            end: Object.assign({}, events[index][1].start),
          };

          // Opening.
          const nextEvents: Array<Event> = [
            ['enter', highlight, context],
            ['enter', events[open][1], context],
            ['exit', events[open][1], context],
            ['enter', text, context],
          ];

          const insideSpan = context.parser.constructs.insideSpan.null;

          if (insideSpan) {
            // Between.
            splice(
              nextEvents,
              nextEvents.length,
              0,
              resolveAll(insideSpan, events.slice(open + 1, index), context)
            );
          }

          // Closing.
          splice(nextEvents, nextEvents.length, 0, [
            ['exit', text, context],
            ['enter', events[index][1], context],
            ['exit', events[index][1], context],
            ['exit', highlight, context],
          ]);

          splice(events, open - 1, index - open + 3, nextEvents);

          index = open + nextEvents.length - 2;
          break;
        }
      }
    }
  }

  index = -1;

  while (++index < events.length) {
    if (events[index][1].type === 'highlightSequenceTemporary') {
      events[index][1].type = types.data;
    }
  }

  return events;
}

function tokenizeHighlight(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
  const previous = this.previous;
  const events = this.events;
  let size = 0;

  return start;

  /**
   * Start of a sequence.
   *
   * ```markdown
   * > | ==a==
   *     ^
   * ```
   */
  function start(code: Code): State | undefined {
    assert(code === codes.equalsTo, 'expected `=`');

    if (
      previous === codes.equalsTo &&
      events[events.length - 1][1].type !== types.characterEscape
    ) {
      return nok(code);
    }

    effects.enter('highlightSequenceTemporary');
    return more(code);
  }

  /**
   * In the sequence.
   *
   * ```markdown
   * > | ==a==
   *     ^^
   * ```
   */
  function more(code: Code): State | undefined {
    if (code === codes.equalsTo) {
      // If this is the third marker, exit.
      if (size > 1) return nok(code);
      effects.consume(code);
      size++;
      return more;
    }

    if (size < 2) return nok(code);
    const token = effects.exit('highlightSequenceTemporary');
    token._open = !whitespace(code);
    token._close = !whitespace(previous);
    return ok(code);
  }
}

/**
 * Whether a code is whitespace, or the edge of the text.
 *
 * @param code
 *   Code.
 * @returns
 *   Whether it is.
 */
function whitespace(code: Code): boolean {
  return (
    code === codes.eof ||
    markdownLineEndingOrSpace(code) ||
    (code <= 0xff_ff && unicodeWhitespace(code))
  );
}

declare module '../../types/index.js' {
  interface TokenTypeMap {
    highlight: 'highlight';
    highlightText: 'highlightText';
    highlightSequence: 'highlightSequence';
    highlightSequenceTemporary: 'highlightSequenceTemporary';
  }
}
