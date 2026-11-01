/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-FileCopyrightText: Titus Wormer <tituswormer@gmail.com>
 * SPDX-License-Identifier: MPL-2.0 AND MIT
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Derived from micromark, https://github.com/micromark/micromark. */

import type { Code, Effects, Event, InitialConstruct, Resolver, State, TokenizeContext } from '../../types/index.js';
import { assert } from '../assert.js';
import { codes, constants, types } from '../utils/symbol/index.js';

export const resolver = { resolveAll: createResolver() };
export const string = initializeFactory('string');
export const text = initializeFactory('text');

/**
 * @param field
 *   Field.
 * @returns
 *   Construct.
 */
function initializeFactory(field: 'string' | 'text'): InitialConstruct {
  return {
    resolveAll: createResolver(field === 'text' ? resolveAllLineSuffixes : undefined),
    tokenize: initializeText,
  };

  function initializeText(this: TokenizeContext, effects: Effects): State {
    const self = this;
    const constructs = this.parser.constructs[field];
    const text = effects.attempt(constructs, start, notText);

    return start;

    function start(code: Code): State | undefined {
      return atBreak(code) ? text(code) : notText(code);
    }

    function notText(code: Code): State | undefined {
      if (code === codes.eof) {
        effects.consume(code);
        return;
      }

      effects.enter(types.data);
      effects.consume(code);
      return data;
    }

    function data(code: Code): State | undefined {
      if (atBreak(code)) {
        effects.exit(types.data);
        return text(code);
      }

      // Data.
      effects.consume(code);
      return data;
    }

    /**
     * @param code
     *   Code.
     * @returns
     *   Whether the code is a break.
     */
    function atBreak(code: Code): boolean {
      if (code === codes.eof) {
        return true;
      }

      const list = constructs[code];
      let index = -1;

      if (list) {
        // Always populated by defaults.
        assert(Array.isArray(list), 'expected `disable.null` to be populated');

        while (++index < list.length) {
          const item = list[index];
          if (!item.previous || item.previous.call(self, self.previous)) {
            return true;
          }
        }
      }

      return false;
    }
  }
}

/**
 * @param extraResolver
 *   Resolver.
 * @returns
 *   Resolver.
 */
function createResolver(extraResolver?: Resolver | undefined): Resolver {
  return resolveAllText;

  function resolveAllText(events: Array<Event>, context: TokenizeContext): Array<Event> {
    let index = -1;
    let enter: number | undefined;

    // A rather boring computation (to merge adjacent `data` events) which
    // improves mm performance by 29%.
    while (++index <= events.length) {
      if (enter === undefined) {
        if (events[index] && events[index][1].type === types.data) {
          enter = index;
          index++;
        }
      } else if (!events[index] || events[index][1].type !== types.data) {
        // Don’t do anything if there is one data token.
        if (index !== enter + 2) {
          events[enter][1].end = events[index - 1][1].end;
          events.splice(enter + 2, index - enter - 2);
          index = enter + 2;
        }

        enter = undefined;
      }
    }

    return extraResolver ? extraResolver(events, context) : events;
  }
}

/**
 * A rather ugly set of instructions which again looks at chunks in the input
 * stream.
 * The reason to do this here is that it is *much* faster to parse in reverse.
 * And that we can’t hook into `null` to split the line suffix before an EOF.
 * To do: figure out if we can make this into a clean utility, or even in core.
 * As it will be useful for GFMs literal autolink extension (and maybe even
 * tables?)
 */
function resolveAllLineSuffixes(events: Array<Event>, context: TokenizeContext): Array<Event> {
  let eventIndex = 0; // Skip first.

  while (++eventIndex <= events.length) {
    if (
      (eventIndex === events.length ||
        events[eventIndex][1].type === types.lineEnding) &&
      events[eventIndex - 1][1].type === types.data
    ) {
      const data = events[eventIndex - 1][1];
      const chunks = context.sliceStream(data);
      let index = chunks.length;
      let bufferIndex = -1;
      let size = 0;
      let tabs: boolean | undefined;

      while (index--) {
        const chunk = chunks[index];

        if (typeof chunk === 'string') {
          bufferIndex = chunk.length;

          while (chunk.charCodeAt(bufferIndex - 1) === codes.space) {
            size++;
            bufferIndex--;
          }

          if (bufferIndex) break;
          bufferIndex = -1;
        }
        // Number
        else if (chunk === codes.horizontalTab) {
          tabs = true;
          size++;
        } else if (chunk === codes.virtualSpace) {
          // Empty
        } else {
          // Replacement character, exit.
          index++;
          break;
        }
      }

      // Allow final trailing whitespace.
      if (context._contentTypeTextTrailing && eventIndex === events.length) {
        size = 0;
      }

      if (size) {
        const token = {
          type:
            eventIndex === events.length || tabs || size < constants.hardBreakPrefixSizeMin
              ? types.lineSuffix
              : types.hardBreakTrailing,
          start: {
            _bufferIndex: index ? bufferIndex : data.start._bufferIndex + bufferIndex,
            _index: data.start._index + index,
            line: data.end.line,
            column: data.end.column - size,
            offset: data.end.offset - size,
          },
          end: { ...data.end },
        };

        data.end = { ...token.start };

        if (data.start.offset === data.end.offset) {
          Object.assign(data, token);
        } else {
          events.splice(
            eventIndex,
            0,
            ['enter', token, context],
            ['exit', token, context]
          );
          eventIndex += 2;
        }
      }

      eventIndex++;
    }
  }

  return events;
}
