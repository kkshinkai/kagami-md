/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-FileCopyrightText: Titus Wormer <tituswormer@gmail.com>
 * SPDX-License-Identifier: MPL-2.0 AND MIT
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Derived from micromark, https://github.com/micromark/micromark. */

import type { Chunk, Event, Token } from '../../../types/index.js';
import { assert } from '../../assert.js';
import { splice } from '../chunked/index.js';
import { codes, types } from '../symbol/index.js';
import { SpliceBuffer } from './lib/splice-buffer.js';

// Hidden API exposed for testing.
export { SpliceBuffer } from './lib/splice-buffer.js';

/**
 * Tokenize subcontent.
 *
 * @param eventsArray
 *   List of events.
 * @param deferText
 *   Keep text chunks unexpanded while phrasing chooses its representation.
 * @returns
 *   Whether subtokens were found.
 */
// eslint-disable-next-line complexity
export function subtokenize(eventsArray: Array<Event>, deferText = false): boolean {
  const jumps: Record<string, number> = {};
  let index = -1;
  let event: Event;
  let lineIndex: number | undefined;
  let otherIndex: number;
  let otherEvent: Event;
  let parameters: Array<Event>;
  let subevents: Array<Event>;
  let more: boolean | undefined;
  const events = new SpliceBuffer(eventsArray);

  while (++index < events.length) {
    while (index in jumps) {
      index = jumps[index];
    }

    event = events.get(index);

    // Add a hook for the GFM tasklist extension, which needs to know if text
    // is in the first content of a list item.
    if (
      index &&
      event[1].type === types.chunkFlow &&
      events.get(index - 1)[1].type === types.listItemPrefix
    ) {
      assert(event[1]._tokenizer, 'expected `_tokenizer` on subtokens');
      subevents = event[1]._tokenizer.events;
      otherIndex = 0;

      if (
        otherIndex < subevents.length &&
        subevents[otherIndex][1].type === types.lineEndingBlank
      ) {
        otherIndex += 2;
      }

      if (
        otherIndex < subevents.length &&
        subevents[otherIndex][1].type === types.content
      ) {
        while (++otherIndex < subevents.length) {
          if (subevents[otherIndex][1].type === types.content) {
            break;
          }

          if (subevents[otherIndex][1].type === types.chunkText) {
            subevents[otherIndex][1]._isInFirstContentOfListItem = true;
            otherIndex++;
          }
        }
      }
    }

    // Enter.
    if (event[0] === 'enter') {
      // Kagami: phrasing evaluation first decides which block events it needs.
      // Keep text chunks intact until that branch consumes their inline content.
      if (event[1].contentType && !(deferText && event[1].contentType === 'text')) {
        Object.assign(jumps, subcontent(events, index));
        index = jumps[index];
        more = true;
      }
    }
    // Exit.
    else if (event[1]._container) {
      otherIndex = index;
      lineIndex = undefined;

      while (otherIndex--) {
        otherEvent = events.get(otherIndex);

        if (
          otherEvent[1].type === types.lineEnding ||
          otherEvent[1].type === types.lineEndingBlank
        ) {
          if (otherEvent[0] === 'enter') {
            if (lineIndex) {
              events.get(lineIndex)[1].type = types.lineEndingBlank;
            }

            otherEvent[1].type = types.lineEnding;
            lineIndex = otherIndex;
          }
        } else if (
          otherEvent[1].type === types.linePrefix ||
          otherEvent[1].type === types.listItemIndent
        ) {
          // Move past.
        } else {
          break;
        }
      }

      if (lineIndex) {
        // Fix position.
        event[1].end = { ...events.get(lineIndex)[1].start };

        // Switch container exit w/ line endings.
        parameters = events.slice(lineIndex, index);
        parameters.unshift(event);
        events.splice(lineIndex, index - lineIndex + 1, parameters);
      }
    }
  }

  // The changes to the `events` buffer must be copied back into the eventsArray
  splice(eventsArray, 0, Number.POSITIVE_INFINITY, events.slice(0));
  return !more;
}

/**
 * Tokenize embedded tokens.
 *
 * @param events
 *   Events.
 * @param eventIndex
 *   Index.
 * @returns
 *   Gaps.
 */
function subcontent(events: SpliceBuffer<Event>, eventIndex: number): Record<string, number> {
  const token = events.get(eventIndex)[1];
  const context = events.get(eventIndex)[2];
  let startPosition = eventIndex - 1;
  const startPositions: Array<number> = [];
  assert(token.contentType, 'expected `contentType` on subtokens');

  let tokenizer = token._tokenizer;

  if (!tokenizer) {
    tokenizer = context.parser[token.contentType](token.start);

    // Kagami: GFM resolves cell boundaries before text subtokenization. Pass
    // that ownership into the text, so that a table’s backslash before a pipe
    // is no character of code or of a wiki link.
    if (
      token.contentType === 'text' &&
      eventIndex > 0 &&
      events.get(eventIndex - 1)[1].type === 'tableContent'
    ) {
      tokenizer._gfmTableCell = true;
    }

    // ZWSP edge mark: the title of a callout has no mark; a zero-width space
    // at its start is text.
    if (
      token.contentType === 'text' &&
      eventIndex > 0 &&
      events.get(eventIndex - 1)[1].type === 'calloutTitle'
    ) {
      tokenizer._calloutTitle = true;
    }

    if (token._contentTypeTextTrailing) {
      tokenizer._contentTypeTextTrailing = true;
    }
  }

  const childEvents = tokenizer.events;
  const jumps: Array<[number, number]> = [];
  const gaps: Record<string, number> = {};
  let stream: Array<Chunk>;
  let previous: Token | undefined;
  let index = -1;
  let current: Token | undefined = token;
  let adjust = 0;
  let start = 0;
  const breaks = [start];

  // Loop forward through the linked tokens to pass them in order to the
  // subtokenizer.
  while (current) {
    // Find the position of the event for this token.
    while (events.get(++startPosition)[1] !== current) {
      // Empty.
    }

    assert(
      !previous || current.previous === previous,
      'expected previous to match'
    );
    assert(!previous || previous.next === current, 'expected next to match');

    startPositions.push(startPosition);

    if (!current._tokenizer) {
      stream = context.sliceStream(current);

      if (!current.next) {
        stream.push(codes.eof);
      }

      if (previous) {
        tokenizer.defineSkip(current.start);
      }

      if (current._isInFirstContentOfListItem) {
        tokenizer._gfmTasklistFirstContentOfListItem = true;
      }

      tokenizer.write(stream);

      if (current._isInFirstContentOfListItem) {
        tokenizer._gfmTasklistFirstContentOfListItem = undefined;
      }
    }

    // Unravel the next token.
    previous = current;
    current = current.next;
  }

  // Now, loop back through all events (and linked tokens), to figure out which
  // parts belong where.
  current = token;

  while (++index < childEvents.length) {
    if (
      // Find a void token that includes a break.
      childEvents[index][0] === 'exit' &&
      childEvents[index - 1][0] === 'enter' &&
      childEvents[index][1].type === childEvents[index - 1][1].type &&
      childEvents[index][1].start.line !== childEvents[index][1].end.line
    ) {
      assert(current, 'expected a current token');
      start = index + 1;
      breaks.push(start);
      // Help GC.
      current._tokenizer = undefined;
      current.previous = undefined;
      current = current.next;
    }
  }

  // Help GC.
  tokenizer.events = [];

  // If there’s one more token (which is the cases for lines that end in an
  // EOF), that’s perfect: the last point we found starts it.
  // If there isn’t then make sure any remaining content is added to it.
  if (current) {
    // Help GC.
    current._tokenizer = undefined;
    current.previous = undefined;
    assert(!current.next, 'expected no next token');
  } else {
    breaks.pop();
  }

  // Now splice the events from the subtokenizer into the current events,
  // moving back to front so that splice indices aren’t affected.
  index = breaks.length;

  while (index--) {
    const slice = childEvents.slice(breaks[index], breaks[index + 1]);
    const start = startPositions.pop();
    assert(start !== undefined, 'expected a start position when splicing');
    jumps.push([start, start + slice.length - 1]);
    events.splice(start, 2, slice);
  }

  jumps.reverse();
  index = -1;

  while (++index < jumps.length) {
    gaps[adjust + jumps[index][0]] = adjust + jumps[index][1];
    adjust += jumps[index][1] - jumps[index][0] - 1;
  }

  return gaps;
}
