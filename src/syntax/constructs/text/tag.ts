/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A tag, `#a`, `#a/b`, or a paired tag closed by `#`, `#a b#`, whose name may hold spaces.
 * Kagami's own. The paired tag is tried first; it takes spaces only when a closing `#` follows,
 * so an unfinished pair cannot swallow the rest of a paragraph, and the bare tag is tried
 * after it. A tag starts at a word boundary, so a fragment in a URL or an identifier is no
 * tag. A name holds Unicode letters, numbers and combining marks, `_` and `-` (the dialect's
 * `tagName`); `/` separates segments that are not empty.
 */
import type {
  Code,
  Construct,
  ConstructRecord,
  Effects,
  State,
  TokenizeContext,
  Tokenizer
} from '../../types/index.js';
import { assert } from '../../kernel/assert.js';
import { markdownLineEndingOrSpace } from '../../kernel/utils/character/index.js';
import {
  contains,
  punctuation,
  tagName,
  whitespace as whitespaceRanges,
} from '../../kernel/utils/character/dialect.js';
import { previousCodePoint } from '../../kernel/utils/cjk/index.js';
import { codes } from '../../kernel/utils/symbol/index.js';

const pairedTag: Construct = { name: 'pairedTag', tokenize: createTokenizer(true) };
const bareTag: Construct = { name: 'bareTag', tokenize: createTokenizer(false) };
const surrogatePair: Construct = { partial: true, tokenize: tokenizeSurrogatePair };

export const text: ConstructRecord = { [codes.numberSign]: [pairedTag, bareTag] };

/**
 * Create a tokenizer of a tag.
 *
 * @param paired
 *   Whether the tag is closed by `#`.
 * @returns
 *   Tokenizer.
 */
function createTokenizer(paired: boolean): Tokenizer {
  return tokenizeTag;

  function tokenizeTag(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
    const previous = previousCodePoint(this);
    let named = false;
    let separated = false;

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
        named = true;
        separated = false;
        return name;
      }

      if (code === codes.slash && named && !separated) {
        effects.consume(code);
        separated = true;
        return name;
      }

      if (paired && code === codes.space && named && !separated) {
        effects.consume(code);
        separated = true;
        return spaces;
      }

      return end(code);
    }

    /**
     * In spaces in the name of a paired tag.
     *
     * ```markdown
     * > | #a  b#
     *        ^
     * ```
     */
    function spaces(code: Code): State | undefined {
      if (code === codes.space) {
        effects.consume(code);
        return spaces;
      }

      return name(code);
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
      effects.consume(code);
      named = true;
      separated = false;
      return name;
    }

    /**
     * After the name.
     *
     * ```markdown
     * > | a #b c
     *         ^
     * > | #a b#
     *          ^
     * ```
     */
    function end(code: Code): State | undefined {
      if (!named || separated || (paired && code !== codes.numberSign)) {
        return nok(code);
      }

      effects.exit('tagName');

      if (paired) {
        effects.enter('tagMarker');
        effects.consume(code);
        effects.exit('tagMarker');
        effects.exit('tag');
        return ok;
      }

      effects.exit('tag');
      return ok(code);
    }
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
