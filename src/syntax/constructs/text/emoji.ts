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
 * A known gemoji shortcode, `:smile:`. Kagami's own. Written on the model of
 * `characterReference`: a marker, a value checked against a table when it closes, a marker.
 * An unknown name consumes nothing, so prose colons keep the normal inline grammar.
 */
import { nameToEmoji } from 'gemoji';
import type { Code, Construct, ConstructRecord, Effects, State, TokenizeContext } from '../../types/index.js';
import { assert } from '../../kernel/assert.js';
import { asciiAlphanumeric } from '../../kernel/utils/character/index.js';
import { codes } from '../../kernel/utils/symbol/index.js';

const emojiShortcode: Construct = { name: 'emojiShortcode', tokenize: tokenizeEmojiShortcode };
export const text: ConstructRecord = { [codes.colon]: emojiShortcode };

/** The emoji a known shortcode name stands for, or undefined. */
export function emojiForName(name: string): string | undefined {
  return Object.hasOwn(nameToEmoji, name) ? nameToEmoji[name] : undefined;
}

/**
 * The emoji for a whole shortcode, colons included. For the editor as it stands, which reads it
 * from the source; it goes with the projection.
 */
export function emojiForShortcode(source: string): string | undefined {
  return emojiForName(source.slice(1, -1));
}

function tokenizeEmojiShortcode(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
  const self = this;
  let size = 0;

  return start;

  /**
   * Start of emoji shortcode.
   *
   * ```markdown
   * > | a :smile: b
   *       ^
   * ```
   */
  function start(code: Code): State | undefined {
    assert(code === codes.colon, 'expected `:`');
    effects.enter('emojiShortcode');
    effects.enter('emojiShortcodeMarker');
    effects.consume(code);
    effects.exit('emojiShortcodeMarker');
    effects.enter('emojiShortcodeName');
    return value;
  }

  /**
   * In name, before `:`. The characters are those of the gemoji alias table: ASCII
   * alphanumerics, `_`, `+` and `-`, which covers `+1` and `-1`.
   *
   * ```markdown
   * > | a :smile: b
   *        ^^^^^
   * ```
   */
  function value(code: Code): State | undefined {
    if (code === codes.colon && size) {
      const token = effects.exit('emojiShortcodeName');

      if (!emojiForName(self.sliceSerialize(token))) {
        return nok(code);
      }

      effects.enter('emojiShortcodeMarker');
      effects.consume(code);
      effects.exit('emojiShortcodeMarker');
      effects.exit('emojiShortcode');
      return ok;
    }

    if (
      asciiAlphanumeric(code) ||
      code === codes.underscore ||
      code === codes.plusSign ||
      code === codes.dash
    ) {
      size++;
      effects.consume(code);
      return value;
    }

    return nok(code);
  }
}

declare module '../../types/index.js' {
  interface TokenTypeMap {
    emojiShortcode: 'emojiShortcode';
    emojiShortcodeMarker: 'emojiShortcodeMarker';
    emojiShortcodeName: 'emojiShortcodeName';
  }
}
