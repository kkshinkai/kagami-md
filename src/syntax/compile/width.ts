/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// How wide a text is drawn, for reading an author's alignment
// (private-docs/design/syntax/alignment.md). A pure question about characters: no term of
// Markdown is in it.
//
// Kagami does not know the font. A character's width is taken from Unicode's East Asian Width
// (`kernel/utils/east-asian-width`, pinned at the dialect's Unicode version): Wide and
// Fullwidth count 2, combining marks and invisible format characters 0, emoji 2, the rest 1.
// Where the width may be drawn otherwise, the character is counted as uncertain, and the
// reading of an alignment allows for it: an Ambiguous character, and an emoji that is not Wide,
// which a font draws in one column or two.

import { isAmbiguous, isWide } from '../kernel/utils/east-asian-width/index.js';

/**
 * How wide a text is drawn, and how many of its characters might be drawn
 * otherwise.
 */
export interface Width {
  /**
   * Columns.
   */
  width: number;
  /**
   * Characters whose width is uncertain.
   */
  uncertain: number;
}

/**
 * Nonspacing and enclosing marks, and format characters.
 */
const zeroWidth = /[\p{Mn}\p{Me}\p{Cf}]/u;

/**
 * Emoji.
 */
const emoji = /\p{Extended_Pictographic}/u;

/**
 * How wide a text is drawn.
 *
 * @param text
 *   Text.
 * @returns
 *   Width.
 */
export function measureWidth(text: string): Width {
  let width = 0;
  let uncertain = 0;
  let index = 0;

  while (index < text.length) {
    const code = text.codePointAt(index)!;
    const character = String.fromCodePoint(code);
    index += character.length;

    if (code < 0x80) {
      width++;
    } else if (zeroWidth.test(character)) {
      // Drawn on the character before it, or not at all.
    } else if (isWide(code)) {
      width += 2;
    } else if (emoji.test(character)) {
      width += 2;
      uncertain++;
    } else if (isAmbiguous(code)) {
      width++;
      uncertain++;
    } else {
      width++;
    }
  }

  return { width, uncertain };
}
