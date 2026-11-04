/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A tag, `#a` and `#a/b`: a `#` at a boundary followed by the longest run of name
 * characters, holding at least one character that is neither a number nor `/`. Kagami's
 * own, as [Tags](../../../../private-docs/rules/tags.md) decides. A name holds Unicode
 * letters, numbers and combining marks, `_` and `-` (the dialect's `tagName`), and `/`.
 * Nothing closes a tag; the first character outside the name ends it.
 */
import type {
  Code,
  Construct,
  ConstructRecord,
  Effects,
  State,
  TokenizeContext
} from '../../types/index.js';
import { assert } from '../../kernel/assert.js';
import { markdownLineEndingOrSpace } from '../../kernel/utils/character/index.js';
import {
  contains,
  number,
  punctuation,
  tagName,
  whitespace as whitespaceRanges,
} from '../../kernel/utils/character/dialect.js';
import { previousCodePoint } from '../../kernel/utils/cjk/index.js';
import { codes } from '../../kernel/utils/symbol/index.js';

const tag: Construct = { name: 'tag', tokenize: tokenizeTag };
const surrogatePair: Construct = { partial: true, tokenize: tokenizeSurrogatePair };

export const text: ConstructRecord = { [codes.numberSign]: [tag] };

/**
 * Tokenize a tag.
 *
 * @returns
 *   State.
 */
function tokenizeTag(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
  const previous = previousCodePoint(this);
  let valid = false;
  let high = 0;

  return start;

  /**
   * Start of a tag.
   *
   * ```markdown
   * > | a #b c
   *       ^
   * ```
   */
  function start(code: Code): State | undefined {
    assert(code === codes.numberSign, 'expected `#`');

    if (!boundary(previous)) {
      return nok(code);
    }

    effects.enter('tag');
    effects.enter('tagMarker');
    effects.consume(code);
    effects.exit('tagMarker');
    effects.enter('tagName');
    return name;
  }

  /**
   * In the name.
   *
   * ```markdown
   * > | a #b/c d
   *        ^^^
   * ```
   */
  function name(code: Code): State | undefined {
    // A character outside the basic plane is two units: both are its.
    if (code !== codes.eof && code >= 0xd8_00 && code <= 0xdb_ff) {
      return effects.check(surrogatePair, highSurrogate, end)(code);
    }

    if (code !== codes.eof && code > 0 && contains(tagName, code)) {
      effects.consume(code);
      if (!contains(number, code)) valid = true;
      return name;
    }

    if (code === codes.slash) {
      effects.consume(code);
      return name;
    }

    return end(code);
  }

  /**
   * At the high surrogate of a character of the name.
   *
   * ```markdown
   * > | #a𝒜
   *       ^
   * ```
   */
  function highSurrogate(code: Code): State | undefined {
    assert(code !== codes.eof, 'expected a surrogate');
    high = code;
    effects.consume(code);
    return lowSurrogate;
  }

  /**
   * At its low surrogate.
   *
   * ```markdown
   * > | #a𝒜
   *       ^
   * ```
   */
  function lowSurrogate(code: Code): State | undefined {
    assert(code !== codes.eof, 'expected a surrogate');
    effects.consume(code);
    if (!contains(number, String.fromCharCode(high, code).codePointAt(0)!)) valid = true;
    return name;
  }

  /**
   * After the name.
   *
   * ```markdown
   * > | a #b c
   *         ^
   * ```
   */
  function end(code: Code): State | undefined {
    if (!valid) {
      return nok(code);
    }

    effects.exit('tagName');
    effects.exit('tag');
    return ok(code);
  }
}

function tokenizeSurrogatePair(effects: Effects, ok: State, nok: State): State {
  let high: number;

  return start;

  /**
   * At the high surrogate.
   *
   * ```markdown
   * > | #a𝒜
   *       ^
   * ```
   */
  function start(code: Code): State | undefined {
    assert(code !== codes.eof, 'expected a surrogate');
    high = code;
    effects.consume(code);
    return low;
  }

  /**
   * At the low surrogate: the pair is one character of a name.
   *
   * ```markdown
   * > | #a𝒜
   *       ^
   * ```
   */
  function low(code: Code): State | undefined {
    if (
      code !== codes.eof &&
      code >= 0xdc_00 &&
      code <= 0xdf_ff &&
      contains(tagName, String.fromCharCode(high, code).codePointAt(0)!)
    ) {
      effects.consume(code);
      return ok;
    }

    return nok(code);
  }
}

/**
 * Whether a tag may start after a character: after whitespace, an opening
 * bracket or quote, or punctuation that is not ASCII. The preprocessor takes
 * one byte order mark at the start of a document; anywhere else U+FEFF is
 * content, and no boundary.
 *
 * @param code
 *   Code point before the tag.
 * @returns
 *   Whether it may.
 */
function boundary(code: Code): boolean {
  if (code === codes.byteOrderMarker) {
    return false;
  }

  return (
    code === codes.eof ||
    markdownLineEndingOrSpace(code) ||
    contains(whitespaceRanges, code) ||
    code === codes.leftParenthesis ||
    code === codes.leftSquareBracket ||
    code === codes.leftCurlyBrace ||
    code === codes.quotationMark ||
    code === codes.apostrophe ||
    (code > 0x7f && contains(punctuation, code))
  );
}

declare module '../../types/index.js' {
  interface TokenTypeMap {
    tag: 'tag';
    tagMarker: 'tagMarker';
    tagName: 'tagName';
  }
}
