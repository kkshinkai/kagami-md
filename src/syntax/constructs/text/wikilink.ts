/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A wiki link, `[[target]]` or `[[target|alias]]`, and an embed, `![[target|alias]]`. Kagami's
 * own, after Obsidian's.
 *
 * A wiki link has no escapes: a backslash is a character of its target or alias. In a table
 * cell, the last backslash of an odd run before a pipe is the table's, as GFM reads it; the
 * pipe after it is the wiki link's. A target or an alias holds no `[`, no `]` and no line ending; the first `|`
 * separates them. A wiki link has content: the target holds more than whitespace, or there is
 * an alias. An embed's alias may end with a size (`image-size.ts`).
 *
 * It is tried before a link label, for `[[`, and its brackets are never a link's.
 */
import type { Code, Construct, ConstructRecord, Effects, State, TokenizeContext } from '../../types/index.js';
import { markdownLineEnding, markdownSpace } from '../../kernel/utils/character/index.js';
import { codes } from '../../kernel/utils/symbol/index.js';
import { tablePipeEscape } from '../shared/table-pipe-escape.js';
import { imageSizeInAlias } from './image-size.js';

const wikilink: Construct = {
  name: 'wikilink',
  tokenize: tokenizeWikilink,
};

export const text: ConstructRecord = {
  [codes.exclamationMark]: wikilink,
  [codes.leftSquareBracket]: wikilink,
};

function tokenizeWikilink(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
  const self = this;
  let embed = false;
  let alias = false;
  let data = false;
  let part = false;
  let value = false;
  // Kagami: backslashes just before, in a table cell, to tell the table's from
  // the wiki link's.
  let backslashes = 0;

  return start;

  /**
   * Start of a wiki link or an embed.
   *
   * ```markdown
   * > | [[a|b]]
   *     ^
   * > | ![[a|b]]
   *     ^
   * ```
   */
  function start(code: Code): State | undefined {
    effects.enter('wikilink');

    // Kagami: the `!` of an embed is a token of its own, so that what reads
    // the events knows an embed without looking at the character.
    if (code === codes.exclamationMark) {
      embed = true;
      effects.enter('wikilinkEmbedMarker');
      effects.consume(code);
      effects.exit('wikilinkEmbedMarker');
      return open;
    }

    return open(code);
  }

  /**
   * At the first `[`.
   *
   * ```markdown
   * > | [[a|b]]
   *     ^
   * ```
   */
  function open(code: Code): State | undefined {
    if (code === codes.leftSquareBracket) {
      effects.enter('wikilinkMarker');
      effects.consume(code);
      return openSecond;
    }

    return nok(code);
  }

  /**
   * At the second `[`.
   *
   * ```markdown
   * > | [[a|b]]
   *      ^
   * ```
   */
  function openSecond(code: Code): State | undefined {
    if (code === codes.leftSquareBracket) {
      effects.consume(code);
      effects.exit('wikilinkMarker');
      effects.enter('wikilinkData');
      return partStart;
    }

    return nok(code);
  }

  /**
   * At the start of the target or the alias.
   *
   * ```markdown
   * > | [[a|b]]
   *       ^ ^
   * ```
   */
  function partStart(code: Code): State | undefined {
    // A size that is the whole alias of an embed.
    if (embed && alias && code === codes.equalsTo) {
      partOpen();
      return effects.attempt(imageSizeInAlias, end, inside)(code);
    }

    return inside(code);
  }

  /**
   * In the target or the alias.
   *
   * ```markdown
   * > | [[a|b]]
   *       ^ ^
   * ```
   */
  function inside(code: Code): State | undefined {
    if (
      code === codes.eof ||
      code === codes.leftSquareBracket ||
      markdownLineEnding(code)
    ) {
      return nok(code);
    }

    if (code === codes.rightSquareBracket) {
      return end(code);
    }

    if (code === codes.verticalBar && !alias) {
      valueClose();
      partClose();
      effects.enter('wikilinkAliasMarker');
      effects.consume(code);
      effects.exit('wikilinkAliasMarker');
      backslashes = 0;
      alias = true;
      data = true;
      return partStart;
    }

    partOpen();

    // A size at the end of the alias of an embed, after whitespace.
    if (embed && alias && markdownSpace(code)) {
      valueClose();
      return effects.attempt(imageSizeInAlias, end, valueStart)(code);
    }

    // Kagami: in a table cell, the last backslash of an odd run before a pipe
    // is the table’s.
    if (self._gfmTableCell && code === codes.backslash && backslashes % 2 === 0) {
      return effects.check(tablePipeEscape, tableEscape, valueStart)(code);
    }

    return valueStart(code);
  }

  /**
   * At a character of the target or the alias.
   *
   * ```markdown
   * > | [[a|b]]
   *       ^ ^
   * ```
   */
  function valueStart(code: Code): State | undefined {
    if (!value) {
      effects.enter('wikilinkValue');
      value = true;
    }

    if (!markdownSpace(code)) {
      data = true;
    }

    backslashes = code === codes.backslash ? backslashes + 1 : 0;
    effects.consume(code);
    return inside;
  }

  /**
   * At the backslash before a pipe in a table cell.
   *
   * ```markdown
   * > | | [[a\|b]] |
   *           ^
   * ```
   */
  function tableEscape(code: Code): State | undefined {
    valueClose();
    effects.enter('wikilinkTableEscape');
    effects.consume(code);
    effects.exit('wikilinkTableEscape');
    backslashes = 0;
    return inside;
  }

  /**
   * At the first `]`.
   *
   * ```markdown
   * > | [[a|b]]
   *           ^
   * ```
   */
  function end(code: Code): State | undefined {
    if (code === codes.rightSquareBracket && data) {
      valueClose();
      partClose();
      effects.exit('wikilinkData');
      effects.enter('wikilinkMarker');
      effects.consume(code);
      return endSecond;
    }

    return nok(code);
  }

  /**
   * At the second `]`.
   *
   * ```markdown
   * > | [[a|b]]
   *            ^
   * ```
   */
  function endSecond(code: Code): State | undefined {
    if (code === codes.rightSquareBracket) {
      effects.consume(code);
      effects.exit('wikilinkMarker');
      effects.exit('wikilink');
      return ok;
    }

    return nok(code);
  }

  /**
   * Open the target or the alias, if it is not open.
   */
  function partOpen(): undefined {
    if (!part) {
      effects.enter(alias ? 'wikilinkAlias' : 'wikilinkTarget');
      part = true;
    }
  }

  /**
   * Close the target or the alias, if it is open.
   */
  function partClose(): undefined {
    if (part) {
      effects.exit(alias ? 'wikilinkAlias' : 'wikilinkTarget');
      part = false;
    }
  }

  /**
   * Close a run of characters, if one is open.
   */
  function valueClose(): undefined {
    if (value) {
      effects.exit('wikilinkValue');
      value = false;
    }
  }
}

declare module '../../types/index.js' {
  interface TokenTypeMap {
    wikilink: 'wikilink';
    wikilinkMarker: 'wikilinkMarker';
    wikilinkEmbedMarker: 'wikilinkEmbedMarker';
    wikilinkData: 'wikilinkData';
    wikilinkTarget: 'wikilinkTarget';
    wikilinkAlias: 'wikilinkAlias';
    wikilinkAliasMarker: 'wikilinkAliasMarker';
    wikilinkValue: 'wikilinkValue';
    wikilinkTableEscape: 'wikilinkTableEscape';
  }
}
