/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ZWSP edge mark: Whether all the text a tokenizer has read is spaces and tabs. Kagami's own.
 * In a field read on its own, typed spaces do not stop a task check or a callout declaration
 * (private-docs/deviations/zwsp-edge-mark.md), so the conditional constructs start after them.
 * The spaces stay text. Chunks are looked at as `resolveAllLineSuffixes` looks at them: a tab
 * is a code of its own, and a string holds no tab.
 */
import type { TokenizeContext } from '../../types/index.js';
import { codes, types } from '../../kernel/utils/symbol/index.js';

/**
 * ZWSP edge mark: Whether everything before the current character is spaces and tabs.
 *
 * @param context
 *   Context of the tokenizer of a field's text.
 * @returns
 *   Whether it is.
 */
export function atFieldStart(context: TokenizeContext): boolean {
  let index = -1;

  while (++index < context.events.length) {
    const event = context.events[index]!;

    if (event[0] === 'enter') {
      if (event[1].type !== types.data) {
        return false;
      }

      const chunks = context.sliceStream(event[1]);
      let chunkIndex = -1;

      while (++chunkIndex < chunks.length) {
        const chunk = chunks[chunkIndex]!;

        if (typeof chunk === 'string') {
          let bufferIndex = -1;

          while (++bufferIndex < chunk.length) {
            if (chunk.charCodeAt(bufferIndex) !== codes.space) {
              return false;
            }
          }
        } else if (chunk !== codes.horizontalTab && chunk !== codes.virtualSpace) {
          return false;
        }
      }
    }
  }

  return true;
}
