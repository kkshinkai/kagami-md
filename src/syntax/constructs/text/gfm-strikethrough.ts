/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-FileCopyrightText: Titus Wormer <tituswormer@gmail.com>
 * SPDX-FileCopyrightText: Tatsunori Uchino <tats.u@live.jp>
 * SPDX-License-Identifier: MPL-2.0 AND MIT
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Derived from micromark-extension-gfm-strikethrough, https://github.com/micromark/micromark-extension-gfm-strikethrough.
 * Derived from markdown-cjk-friendly, https://github.com/tats-u/markdown-cjk-friendly. */

import type { Code, Effects, Event, State, Token, TokenizeContext } from '../../types/index.js';
import { assert } from '../../kernel/assert.js';
import { splice } from '../../kernel/utils/chunked/index.js';
import {
  attentionSides, classifyBeforeAttention, classifyAttentionCharacter, nextCodePoint,
} from '../../kernel/utils/cjk/index.js';
import { resolveAll } from '../../kernel/utils/resolve-all/index.js';
import { classifyCharacter } from '../../kernel/utils/classify-character/index.js';
import { codes, constants, types } from '../../kernel/utils/symbol/index.js';

const single = true;
const tokenizer = {
  name: 'strikethrough',
  tokenize: tokenizeStrikethrough,
  resolveAll: resolveAllStrikethrough,
};

export const text = { [codes.tilde]: tokenizer };
export const insideSpan = { null: [tokenizer] };
export const attentionMarkers = { null: [codes.tilde] };

/**
 * Take events and resolve strikethrough.
 */
function resolveAllStrikethrough(events: Array<Event>, context: TokenizeContext): Array<Event> {
  let index = -1;

  // Walk through all events.
  while (++index < events.length) {
    // Find a token that can close.
    if (
      events[index][0] === 'enter' &&
      events[index][1].type === 'strikethroughSequenceTemporary' &&
      events[index][1]._close
    ) {
      let open = index;

      // Now walk back to find an opener.
      while (open--) {
        // Find a token that can open the closer.
        if (
          events[open][0] === 'exit' &&
          events[open][1].type === 'strikethroughSequenceTemporary' &&
          events[open][1]._open &&
          // If the sizes are the same:
          events[index][1].end.offset - events[index][1].start.offset ===
            events[open][1].end.offset - events[open][1].start.offset
        ) {
          events[index][1].type = 'strikethroughSequence';
          events[open][1].type = 'strikethroughSequence';

          const strikethrough: Token = {
            type: 'strikethrough',
            start: Object.assign({}, events[open][1].start),
            end: Object.assign({}, events[index][1].end),
          };

          const text: Token = {
            type: 'strikethroughText',
            start: Object.assign({}, events[open][1].end),
            end: Object.assign({}, events[index][1].start),
          };

          // Opening.
          const nextEvents: Array<Event> = [
            ['enter', strikethrough, context],
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
            ['exit', strikethrough, context],
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
    if (events[index][1].type === 'strikethroughSequenceTemporary') {
      events[index][1].type = types.data;
    }
  }

  return events;
}

function tokenizeStrikethrough(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
  const previous = this.previous;
  const before = classifyBeforeAttention(this);
  const context = this;
  const events = this.events;
  let size = 0;

  return start;

  function start(code: Code): State | undefined {
    assert(code === codes.tilde, 'expected `~`');

    if (
      previous === codes.tilde &&
      events[events.length - 1][1].type !== types.characterEscape
    ) {
      return nok(code);
    }

    effects.enter('strikethroughSequenceTemporary');
    return more(code);
  }

  function more(code: Code): State | undefined {
    if (code === codes.tilde) {
      // If this is the third marker, exit.
      if (size > 1) return nok(code);
      effects.consume(code);
      size++;
      return more;
    }

    if (size < 2 && !single) return nok(code);
    const token = effects.exit('strikethroughSequenceTemporary');
    if (!context.parser.cjkFriendly) {
      const before = classifyCharacter(previous);
      const after = classifyCharacter(code);
      token._open =
        !after || (after === constants.attentionSideAfter && Boolean(before));
      token._close =
        !before || (before === constants.attentionSideAfter && Boolean(after));
      return ok(code);
    }
    const sides = attentionSides(before, classifyAttentionCharacter(nextCodePoint(context, code)));
    token._open = sides.open;
    token._close = sides.close;
    return ok(code);
  }
}
