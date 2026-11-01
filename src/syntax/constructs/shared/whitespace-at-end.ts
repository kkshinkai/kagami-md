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
 * The spaces and tabs at the end of a data token, as a token of their own. Kagami's own,
 * taken from `resolveAllLineSuffixes` in `kernel/initialize/text.ts`, which takes trailing
 * whitespace off data in the same way. The constructs whose whitespace before them is already
 * data when they start resolve it off with this: the size of an image, and the closing
 * sequence of an ATX heading in its field.
 */
import type { Token, TokenizeContext, TokenType } from '../../types/index.js';
import { codes } from '../../kernel/utils/symbol/index.js';

/**
 * Make a token of `type` for the spaces and tabs at the end of `data`, no more than `most` of
 * them. `data` is not changed.
 *
 * @param data
 *   Data token.
 * @param type
 *   Type of the token to make.
 * @param context
 *   Context.
 * @param most
 *   How many characters to take at most (default: all).
 * @returns
 *   Token, or nothing when `data` does not end with whitespace.
 */
export function whitespaceAtEnd(
  data: Token,
  type: TokenType,
  context: TokenizeContext,
  most = Infinity
): Token | undefined {
  const chunks = context.sliceStream(data);
  let index = chunks.length;
  let bufferIndex = -1;
  let size = 0;

  while (index--) {
    const chunk = chunks[index];

    if (typeof chunk === 'string') {
      bufferIndex = chunk.length;

      while (size < most && chunk.charCodeAt(bufferIndex - 1) === codes.space) {
        size++;
        bufferIndex--;
      }

      if (bufferIndex) break;
      bufferIndex = -1;
    }
    // Number
    else if (chunk === codes.horizontalTab && size < most) {
      size++;
    } else if (chunk === codes.virtualSpace) {
      // Empty
    } else {
      // Replacement character, or enough, exit.
      index++;
      break;
    }
  }

  if (!size) return undefined;

  return {
    type,
    start: {
      _bufferIndex: index ? bufferIndex : data.start._bufferIndex + bufferIndex,
      _index: data.start._index + index,
      line: data.end.line,
      column: data.end.column - size,
      offset: data.end.offset - size,
    },
    end: { ...data.end },
  };
}
