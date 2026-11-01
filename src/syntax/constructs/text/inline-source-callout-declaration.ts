/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-FileCopyrightText: Titus Wormer <tituswormer@gmail.com>
 * SPDX-License-Identifier: MPL-2.0 AND MIT
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Derived from micromark-extension-gfm-task-list-item, https://github.com/micromark/micromark-extension-gfm-task-list-item. */

/**
 * A callout's declaration at the start of a field read on its own, `[!NOTE]`, and the
 * whitespace after it. Kagami's own, written on the model of `inline-source-task-marker.ts`:
 * unlike a check, its value is one of the known words, and the end of the input or of the line
 * may follow it. The head of a callout in a file is `../flow/callout-head.ts`.
 *
 * ZWSP edge mark: spaces and tabs before it do not stop it, and stay text
 * (private-docs/deviations/zwsp-edge-mark.md).
 */
import type { Code, Construct, ConstructRecord, Effects, State, TokenizeContext } from '../../types/index.js';
import { assert } from '../../kernel/assert.js';
import { factorySpace } from '../../kernel/factories/space/index.js';
import { asciiAlpha, markdownLineEnding, markdownSpace } from '../../kernel/utils/character/index.js';
import { codes } from '../../kernel/utils/symbol/index.js';
import { atFieldStart } from '../shared/field-start.js';

/**
 * The words a callout may be declared with, lowercase.
 */
export const calloutTypes: ReadonlyArray<CalloutType> = ['note', 'tip', 'important', 'warning', 'caution'];

/**
 * A word a callout may be declared with.
 */
export type CalloutType = 'note' | 'tip' | 'important' | 'warning' | 'caution';

export const inlineSourceCalloutDeclaration: Construct = {
  name: 'inlineSourceCalloutDeclaration',
  tokenize: tokenizeCalloutDeclaration,
};

export const text: ConstructRecord = {
  [codes.leftSquareBracket]: inlineSourceCalloutDeclaration,
};

function tokenizeCalloutDeclaration(
  this: TokenizeContext,
  effects: Effects,
  ok: State,
  nok: State
): State {
  const self = this;
  let buffer = '';

  return open;

  /**
   * At the start of a declaration.
   *
   * ```markdown
   * > | [!NOTE] a
   *     ^
   * ```
   */
  function open(code: Code): State | undefined {
    assert(code === codes.leftSquareBracket, 'expected `[`');

    // Exit if there’s stuff before, but for spaces and tabs.
    if (!atFieldStart(self)) {
      return nok(code);
    }

    effects.enter('inlineSourceCalloutDeclaration');
    effects.enter('inlineSourceCalloutDeclarationMarker');
    effects.consume(code);
    return exclamationMark;
  }

  /**
   * After `[`, at `!`.
   *
   * ```markdown
   * > | [!NOTE] a
   *      ^
   * ```
   */
  function exclamationMark(code: Code): State | undefined {
    if (code === codes.exclamationMark) {
      effects.consume(code);
      effects.exit('inlineSourceCalloutDeclarationMarker');
      effects.enter('inlineSourceCalloutDeclarationType');
      return type;
    }

    return nok(code);
  }

  /**
   * In the type.
   *
   * ```markdown
   * > | [!NOTE] a
   *       ^^^^
   * ```
   */
  function type(code: Code): State | undefined {
    if (asciiAlpha(code)) {
      assert(code !== null); // Always the case.
      buffer += String.fromCharCode(code);
      effects.consume(code);
      return type;
    }

    if (calloutTypes.includes(buffer.toLowerCase() as CalloutType)) {
      effects.exit('inlineSourceCalloutDeclarationType');
      return close(code);
    }

    return nok(code);
  }

  /**
   * At `]`.
   *
   * ```markdown
   * > | [!NOTE] a
   *           ^
   * ```
   */
  function close(code: Code): State | undefined {
    if (code === codes.rightSquareBracket) {
      effects.enter('inlineSourceCalloutDeclarationMarker');
      effects.consume(code);
      effects.exit('inlineSourceCalloutDeclarationMarker');
      return after;
    }

    return nok(code);
  }

  /**
   * After the declaration.
   *
   * ```markdown
   * > | [!NOTE] a
   *            ^
   * ```
   */
  function after(code: Code): State | undefined {
    if (markdownSpace(code)) {
      return factorySpace(effects, done, 'inlineSourceCalloutDeclarationWhitespace')(code);
    }

    if (code === codes.eof || markdownLineEnding(code)) {
      return done(code);
    }

    return nok(code);
  }

  /**
   * After the declaration and its whitespace.
   *
   * ```markdown
   * > | [!NOTE] a
   *             ^
   * ```
   */
  function done(code: Code): State | undefined {
    effects.exit('inlineSourceCalloutDeclaration');
    return ok(code);
  }
}

declare module '../../types/index.js' {
  interface TokenTypeMap {
    inlineSourceCalloutDeclaration: 'inlineSourceCalloutDeclaration';
    inlineSourceCalloutDeclarationMarker: 'inlineSourceCalloutDeclarationMarker';
    inlineSourceCalloutDeclarationType: 'inlineSourceCalloutDeclarationType';
    inlineSourceCalloutDeclarationWhitespace: 'inlineSourceCalloutDeclarationWhitespace';
  }
}
