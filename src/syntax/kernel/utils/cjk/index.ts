/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-FileCopyrightText: Titus Wormer <tituswormer@gmail.com>
 * SPDX-FileCopyrightText: Tatsunori Uchino <tats.u@live.jp>
 * SPDX-License-Identifier: MPL-2.0 AND MIT
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Derived from micromark, https://github.com/micromark/micromark.
 * Derived from markdown-cjk-friendly, https://github.com/tats-u/markdown-cjk-friendly. */

/**
 * Kagami: the classes of characters that decide whether a delimiter run can
 * open or close, after the rules of `markdown-cjk-friendly`
 * (`micromark-extension-cjk-friendly-util`: `classifyCharacter.ts`,
 * `categoryUtil.ts`, `codeUtil.ts`). The resolvers that match runs, the
 * offsets and what owns the grammar stay micromark’s. See
 * `src/syntax/data/cjk-provenance.md`.
 */
import type { Code, TokenizeContext } from '../../../types/index.js';
import { markdownLineEndingOrSpace } from '../character/index.js';
import { attentionPunctuation, contains, whitespace } from '../character/dialect.js';
import { codes } from '../symbol/index.js';
import { cjkRanges } from './ranges.js';

/**
 * The classes, as bits: a character may be CJK and punctuation at once.
 */
const classes = {
  /**
   * Unicode whitespace, or the edge of the text.
   */
  space: 1,
  /**
   * Unicode punctuation.
   */
  punctuation: 2,
  /**
   * A CJK character.
   */
  cjk: 4,
  /**
   * An ideographic variation selector.
   */
  ivs: 8,
  /**
   * A non-emoji general-use variation selector, U+FE00 to U+FE0E.
   */
  variation: 16,
} as const;

/**
 * Whether a code point is a CJK character.
 *
 * @param code
 *   Code point.
 * @returns
 *   Whether it is.
 */
export function isCJK(code: number): boolean {
  return contains(cjkRanges, code);
}

/**
 * Classify a code point for attention.
 *
 * @param code
 *   Code point.
 * @returns
 *   Its classes.
 */
export function classifyAttentionCharacter(code: Code): number {
  if (code === codes.eof || markdownLineEndingOrSpace(code) || contains(whitespace, code)) {
    return classes.space;
  }

  if (code >= 0xfe_00 && code <= 0xfe_0e) {
    return classes.variation;
  }

  if (code >= 0xe_01_00 && code <= 0xe_01_ef) {
    return classes.ivs;
  }

  return (
    (isCJK(code) ? classes.cjk : 0) |
    (contains(attentionPunctuation, code) ? classes.punctuation : 0)
  );
}

/**
 * Whether classes are whitespace or punctuation.
 *
 * @param group
 *   Classes.
 * @returns
 *   Whether they are.
 */
export function isSpaceOrPunctuation(group: number): boolean {
  return Boolean(group & (classes.space | classes.punctuation));
}

/**
 * Whether a run between characters of these classes can open and close.
 *
 * @param before
 *   Classes of the character before the run.
 * @param after
 *   Classes of the character after it.
 * @returns
 *   Whether it can open, and whether it can close.
 */
export function attentionSides(before: number, after: number): AttentionSides {
  const beforePunctuation = (before & (classes.cjk | classes.punctuation)) === classes.punctuation;
  const afterPunctuation = (after & (classes.cjk | classes.punctuation)) === classes.punctuation;
  const beforeBoundary = Boolean(before & classes.space) || beforePunctuation;
  const afterBoundary = Boolean(after & classes.space) || afterPunctuation;

  return {
    open:
      !afterBoundary ||
      (afterPunctuation && (beforeBoundary || Boolean(before & (classes.cjk | classes.ivs)))),
    close:
      !beforeBoundary ||
      (beforePunctuation && (afterBoundary || Boolean(after & classes.cjk))),
  };
}

/** Whether an attention run can open and close. */
export interface AttentionSides {
  open: boolean;
  close: boolean;
}

/**
 * The code point before the current character. The tokenizer consumes
 * UTF-16 units and the rules are on code points: ordinary text uses
 * `previous`; only a low surrogate reads the units before it, without moving
 * any offset.
 *
 * @param context
 *   Context.
 * @returns
 *   Code point.
 */
export function previousCodePoint(context: TokenizeContext): Code {
  const code = context.previous;

  if (code === codes.eof || code < 0xdc_00 || code > 0xdf_ff) {
    return code;
  }

  const point = context.now();

  if (point._bufferIndex < 2) {
    return code;
  }

  const value = context.sliceSerialize({
    start: { ...point, _bufferIndex: point._bufferIndex - 2 },
    end: point,
  });
  const result = value.codePointAt(0);
  return result === undefined ? code : result;
}

/**
 * The code point at the current character, `code`: a high surrogate reads the
 * unit after it.
 *
 * @param context
 *   Context.
 * @param code
 *   Current code.
 * @returns
 *   Code point.
 */
export function nextCodePoint(context: TokenizeContext, code: Code): Code {
  if (code === codes.eof || code < 0xd8_00 || code > 0xdb_ff) {
    return code;
  }

  const point = context.now();
  const value = context.sliceSerialize({
    start: point,
    end: { ...point, _bufferIndex: point._bufferIndex + 2 },
  });
  const result = value.codePointAt(0);
  return result === undefined ? code : result;
}

/**
 * Classify the character before a run for attention. A variation selector
 * takes the classes of the character it follows: it is a CJK punctuation
 * after a quotation mark VS2 makes fullwidth.
 *
 * @param context
 *   Context.
 * @returns
 *   Classes.
 */
export function classifyBeforeAttention(context: TokenizeContext): number {
  const previous = previousCodePoint(context);
  const group = classifyAttentionCharacter(previous);

  if (group !== classes.variation) {
    return group;
  }

  const point = context.now();

  if (point._bufferIndex < 2) {
    return group;
  }

  const prefix = context.sliceSerialize({
    start: { ...point, _bufferIndex: Math.max(0, point._bufferIndex - 3) },
    end: { ...point, _bufferIndex: point._bufferIndex - 1 },
  });
  const characters = Array.from(prefix);
  const base =
    characters.length > 0 ? characters[characters.length - 1]!.codePointAt(0)! : null;
  const primary = classifyAttentionCharacter(base);

  if (base === null || primary & classes.space) {
    return group;
  }

  // VS2 selects the fullwidth form of these otherwise ambiguous quotation
  // marks.
  if (
    previous === 0xfe_01 &&
    (base === 0x20_18 || base === 0x20_19 || base === 0x20_1c || base === 0x20_1d)
  ) {
    return classes.cjk | classes.punctuation;
  }

  return primary & ~classes.ivs;
}
