/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The size at the end of an image's text, `![a =20x10](b)`, or of an embed's alias,
 * `![[a|b =20x10]]`. Kagami's own.
 *
 * A size is `=` and a width, `=20`; a width, `x` and a height, `=20x10`; or `x` and a height,
 * `=x10`. Each number is a whole number of pixels, from 1 to 4294967295. Whitespace may follow
 * it before the `]`. It stands after whitespace, or is the whole of the text.
 *
 * In an image's text the size is a text construct, which opens only in the text of an image.
 * The whitespace before it is taken off the data before it when the image is made,
 * `resolveImageSize`, as `resolveAllLineSuffixes` takes trailing whitespace off data (`whitespaceAtEnd`); a size in
 * a label that makes no image is data again, as the label's markers are. In an embed's alias,
 * the wiki link attempts `imageSizeInAlias` with the whitespace before it.
 */
import type { Code, Construct, Effects, Event, State, Token, TokenizeContext } from '../../types/index.js';
import { assert } from '../../kernel/assert.js';
import { factorySpace } from '../../kernel/factories/space/index.js';
import { asciiDigit, markdownSpace } from '../../kernel/utils/character/index.js';
import { codes, types } from '../../kernel/utils/symbol/index.js';
import { whitespaceAtEnd } from '../shared/whitespace-at-end.js';

export const imageSize: Construct = {
  name: 'imageSize',
  tokenize: tokenizeImageSize,
};

export const imageSizeInAlias: Construct = {
  partial: true,
  tokenize: tokenizeImageSizeInAlias,
};

const imageSizeValue: Construct = { partial: true, tokenize: tokenizeImageSizeValue };

export const text = {
  [codes.equalsTo]: imageSize,
};

/**
 * Take the whitespace before a size at the end of an image's text off the data before it.
 *
 * @param events
 *   Events of the text of an image.
 * @param context
 *   Context.
 * @returns
 *   Events.
 */
export function resolveImageSize(events: Array<Event>, context: TokenizeContext): Array<Event> {
  let eventIndex = events.length - 1;

  if (eventIndex < 0 || events[eventIndex][1].type !== 'imageSize') {
    return events;
  }

  const group = events[eventIndex][1];

  while (events[eventIndex][1] !== group || events[eventIndex][0] !== 'enter') {
    eventIndex--;
  }

  if (!eventIndex || events[eventIndex - 1][1].type !== types.data) {
    return events;
  }

  const data = events[eventIndex - 1][1];
  const whitespace = whitespaceAtEnd(data, 'imageSizeWhitespace', context);

  if (whitespace) {
    data.end = { ...whitespace.start };
    group.start = { ...whitespace.start };
    events.splice(eventIndex + 1, 0, ['enter', whitespace, context], ['exit', whitespace, context]);

    if (data.start.offset === data.end.offset) {
      events.splice(eventIndex - 2, 2);
    }
  }

  return events;
}

function tokenizeImageSize(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
  const self = this;
  let index = self.events.length;
  let labelStart: Token | undefined;

  // Find an opening.
  while (index--) {
    if (
      (self.events[index][1].type === types.labelImage ||
        self.events[index][1].type === types.labelLink) &&
      !self.events[index][1]._balanced
    ) {
      labelStart = self.events[index][1];
      break;
    }
  }

  return start;

  /**
   * Start of a size.
   *
   * ```markdown
   * > | ![a =20x10](b)
   *         ^
   * ```
   */
  function start(code: Code): State | undefined {
    assert(code === codes.equalsTo, 'expected `=`');

    if (
      // Exit if not in the text of an image.
      !labelStart ||
      labelStart.type !== types.labelImage ||
      // Kagami: a line prefix is indentation, not whitespace of the image's
      // text. Read the last token as resolveImageSize reads preceding data.
      // A size follows text whitespace or starts the image's text.
      !(
        (markdownSpace(self.previous) &&
          self.events[self.events.length - 1][1].type !== types.linePrefix) ||
        self.events[self.events.length - 1][1] === labelStart
      )
    ) {
      return nok(code);
    }

    effects.enter('imageSize');
    return effects.attempt(imageSizeValue, after, nok)(code);
  }

  /**
   * After a size, at `]`.
   *
   * ```markdown
   * > | ![a =20x10](b)
   *               ^
   * ```
   */
  function after(code: Code): State | undefined {
    effects.exit('imageSize');
    return ok(code);
  }
}

function tokenizeImageSizeInAlias(effects: Effects, ok: State, nok: State): State {
  return start;

  /**
   * Start of a size in an alias, at the whitespace before it or at `=`.
   *
   * ```markdown
   * > | ![[a|b =20x10]]
   *           ^
   * ```
   */
  function start(code: Code): State | undefined {
    effects.enter('imageSize');

    if (markdownSpace(code)) {
      return factorySpace(effects, before, 'imageSizeWhitespace')(code);
    }

    return before(code);
  }

  /**
   * After whitespace, at `=`.
   *
   * ```markdown
   * > | ![[a|b =20x10]]
   *            ^
   * ```
   */
  function before(code: Code): State | undefined {
    if (code === codes.equalsTo) {
      return effects.attempt(imageSizeValue, after, nok)(code);
    }

    return nok(code);
  }

  /**
   * After a size, at `]`.
   *
   * ```markdown
   * > | ![[a|b =20x10]]
   *                  ^
   * ```
   */
  function after(code: Code): State | undefined {
    effects.exit('imageSize');
    return ok(code);
  }
}

function tokenizeImageSizeValue(effects: Effects, ok: State, nok: State): State {
  let value = 0;

  return start;

  /**
   * At `=`.
   *
   * ```markdown
   * > | ![a =20x10](b)
   *         ^
   * ```
   */
  function start(code: Code): State | undefined {
    assert(code === codes.equalsTo, 'expected `=`');
    effects.enter('imageSizeMarker');
    effects.consume(code);
    effects.exit('imageSizeMarker');
    return widthBefore;
  }

  /**
   * After `=`, at the width or at `x`.
   *
   * ```markdown
   * > | ![a =20x10](b)
   *          ^
   * > | ![a =x10](b)
   *          ^
   * ```
   */
  function widthBefore(code: Code): State | undefined {
    if (asciiDigit(code)) {
      effects.enter('imageSizeWidth');
      return width(code);
    }

    if (code === codes.lowercaseX) {
      return separator(code);
    }

    return nok(code);
  }

  /**
   * In the width.
   *
   * ```markdown
   * > | ![a =20x10](b)
   *          ^^
   * ```
   */
  function width(code: Code): State | undefined {
    if (asciiDigit(code)) {
      assert(code !== null); // Always the case.
      value = value * 10 + code - codes.digit0;
      if (value > 0xff_ff_ff_ff) return nok(code);
      effects.consume(code);
      return width;
    }

    if (!value) return nok(code);
    effects.exit('imageSizeWidth');
    value = 0;
    return code === codes.lowercaseX ? separator(code) : after(code);
  }

  /**
   * At `x`.
   *
   * ```markdown
   * > | ![a =20x10](b)
   *            ^
   * ```
   */
  function separator(code: Code): State | undefined {
    assert(code === codes.lowercaseX, 'expected `x`');
    effects.enter('imageSizeSeparator');
    effects.consume(code);
    effects.exit('imageSizeSeparator');
    return heightBefore;
  }

  /**
   * After `x`, at the height.
   *
   * ```markdown
   * > | ![a =20x10](b)
   *             ^
   * ```
   */
  function heightBefore(code: Code): State | undefined {
    if (asciiDigit(code)) {
      effects.enter('imageSizeHeight');
      return height(code);
    }

    return nok(code);
  }

  /**
   * In the height.
   *
   * ```markdown
   * > | ![a =20x10](b)
   *             ^^
   * ```
   */
  function height(code: Code): State | undefined {
    if (asciiDigit(code)) {
      assert(code !== null); // Always the case.
      value = value * 10 + code - codes.digit0;
      if (value > 0xff_ff_ff_ff) return nok(code);
      effects.consume(code);
      return height;
    }

    if (!value) return nok(code);
    effects.exit('imageSizeHeight');
    return after(code);
  }

  /**
   * After the size, before whitespace or `]`.
   *
   * ```markdown
   * > | ![a =20x10 ](b)
   *               ^
   * ```
   */
  function after(code: Code): State | undefined {
    if (markdownSpace(code)) {
      return factorySpace(effects, end, 'imageSizeTrailingWhitespace')(code);
    }

    return end(code);
  }

  /**
   * At `]`.
   *
   * ```markdown
   * > | ![a =20x10](b)
   *               ^
   * ```
   */
  function end(code: Code): State | undefined {
    return code === codes.rightSquareBracket ? ok(code) : nok(code);
  }
}

declare module '../../types/index.js' {
  interface TokenTypeMap {
    imageSize: 'imageSize';
    imageSizeWhitespace: 'imageSizeWhitespace';
    imageSizeMarker: 'imageSizeMarker';
    imageSizeWidth: 'imageSizeWidth';
    imageSizeSeparator: 'imageSizeSeparator';
    imageSizeHeight: 'imageSizeHeight';
    imageSizeTrailingWhitespace: 'imageSizeTrailingWhitespace';
  }
}
