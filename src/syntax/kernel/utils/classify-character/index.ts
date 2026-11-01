/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-FileCopyrightText: Titus Wormer <tituswormer@gmail.com>
 * SPDX-License-Identifier: MPL-2.0 AND MIT
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Derived from micromark, https://github.com/micromark/micromark. */

import type { Code } from '../../../types/index.js';
import {
  markdownLineEndingOrSpace,
  unicodePunctuation,
  unicodeWhitespace,
} from '../character/index.js';
import { codes, constants } from '../symbol/index.js';

/** Whitespace (1), punctuation (2), or an ordinary character (undefined). */
export type CharacterGroup = 1 | 2 | undefined;

/**
 * Classify whether a code represents whitespace, punctuation, or something
 * else.
 *
 * Used for attention (emphasis, strong), whose sequences can open or close
 * based on the class of surrounding characters.
 *
 * > 👉 **Note**: eof (`null`) is seen as whitespace.
 *
 * @param code
 *   Code.
 * @returns
 *   Group.
 */
export function classifyCharacter(code: Code): CharacterGroup {
  if (
    code === codes.eof ||
    markdownLineEndingOrSpace(code) ||
    unicodeWhitespace(code)
  ) {
    return constants.characterGroupWhitespace;
  }

  if (unicodePunctuation(code)) {
    return constants.characterGroupPunctuation;
  }
}
