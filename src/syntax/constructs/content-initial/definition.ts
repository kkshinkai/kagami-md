/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-FileCopyrightText: Titus Wormer <tituswormer@gmail.com>
 * SPDX-License-Identifier: MPL-2.0 AND MIT
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Derived from micromark, https://github.com/micromark/micromark. */

import type { Code, Construct, Effects, State, TokenizeContext } from '../../types/index.js';
import { assert } from '../../kernel/assert.js';
import { factoryDestination } from '../../kernel/factories/destination/index.js';
import { factoryLabel } from '../../kernel/factories/label/index.js';
import { factorySpace } from '../../kernel/factories/space/index.js';
import { factoryTitle } from '../../kernel/factories/title/index.js';
import { factoryWhitespace } from '../../kernel/factories/whitespace/index.js';
import {
  markdownLineEndingOrSpace,
  markdownLineEnding,
  markdownSpace,
} from '../../kernel/utils/character/index.js';
import { normalizeIdentifier } from '../../kernel/utils/normalize-identifier/index.js';
import { codes, types } from '../../kernel/utils/symbol/index.js';

export const definition: Construct = { name: 'definition', tokenize: tokenizeDefinition };

const titleBefore: Construct = { partial: true, tokenize: tokenizeTitleBefore };

function tokenizeDefinition(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
  const self = this;
  let identifier: string;

  return start;

  /**
   * At start of a definition.
   *
   * ```markdown
   * > | [a]: b "c"
   *     ^
   * ```
   */
  function start(code: Code): State | undefined {
    // Do not interrupt paragraphs (but do follow definitions).
    // To do: do `interrupt` the way `markdown-rs` does.
    // To do: parse whitespace the way `markdown-rs` does.
    effects.enter(types.definition);
    return before(code);
  }

  /**
   * After optional whitespace, at `[`.
   *
   * ```markdown
   * > | [a]: b "c"
   *     ^
   * ```
   */
  function before(code: Code): State | undefined {
    // To do: parse whitespace the way `markdown-rs` does.
    assert(code === codes.leftSquareBracket, 'expected `[`');
    return factoryLabel.call(
      self,
      effects,
      labelAfter,
      // Note: we don’t need to reset the way `markdown-rs` does.
      nok,
      types.definitionLabel,
      types.definitionLabelMarker,
      types.definitionLabelString
    )(code);
  }

  /**
   * After label.
   *
   * ```markdown
   * > | [a]: b "c"
   *        ^
   * ```
   */
  function labelAfter(code: Code): State | undefined {
    identifier = normalizeIdentifier(
      self.sliceSerialize(self.events[self.events.length - 1][1]).slice(1, -1)
    );

    if (code === codes.colon) {
      effects.enter(types.definitionMarker);
      effects.consume(code);
      effects.exit(types.definitionMarker);
      return markerAfter;
    }

    return nok(code);
  }

  /**
   * After marker.
   *
   * ```markdown
   * > | [a]: b "c"
   *         ^
   * ```
   */
  function markerAfter(code: Code): State | undefined {
    // Note: whitespace is optional.
    return markdownLineEndingOrSpace(code)
      ? factoryWhitespace(effects, destinationBefore)(code)
      : destinationBefore(code);
  }

  /**
   * Before destination.
   *
   * ```markdown
   * > | [a]: b "c"
   *          ^
   * ```
   */
  function destinationBefore(code: Code): State | undefined {
    return factoryDestination(
      effects,
      destinationAfter,
      // Note: we don’t need to reset the way `markdown-rs` does.
      nok,
      types.definitionDestination,
      types.definitionDestinationLiteral,
      types.definitionDestinationLiteralMarker,
      types.definitionDestinationRaw,
      types.definitionDestinationString
    )(code);
  }

  /**
   * After destination.
   *
   * ```markdown
   * > | [a]: b "c"
   *           ^
   * ```
   */
  function destinationAfter(code: Code): State | undefined {
    return effects.attempt(titleBefore, after, after)(code);
  }

  /**
   * After definition.
   *
   * ```markdown
   * > | [a]: b
   *           ^
   * > | [a]: b "c"
   *               ^
   * ```
   */
  function after(code: Code): State | undefined {
    return markdownSpace(code)
      ? factorySpace(effects, afterWhitespace, types.whitespace)(code)
      : afterWhitespace(code);
  }

  /**
   * After definition, after optional whitespace.
   *
   * ```markdown
   * > | [a]: b
   *           ^
   * > | [a]: b "c"
   *               ^
   * ```
   */
  function afterWhitespace(code: Code): State | undefined {
    if (code === codes.eof || markdownLineEnding(code)) {
      effects.exit(types.definition);

      // Note: we don’t care about uniqueness.
      // It’s likely that that doesn’t happen very frequently.
      // It is more likely that it wastes precious time.
      self.parser.defined.push(identifier);

      // To do: `markdown-rs` interrupt.
      // // You’d be interrupting.
      // tokenizer.interrupt = true
      return ok(code);
    }

    return nok(code);
  }
}

function tokenizeTitleBefore(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
  return titleBefore;

  /**
   * After destination, at whitespace.
   *
   * ```markdown
   * > | [a]: b
   *           ^
   * > | [a]: b "c"
   *           ^
   * ```
   */
  function titleBefore(code: Code): State | undefined {
    return markdownLineEndingOrSpace(code)
      ? factoryWhitespace(effects, beforeMarker)(code)
      : nok(code);
  }

  /**
   * At title.
   *
   * ```markdown
   *   | [a]: b
   * > | "c"
   *     ^
   * ```
   */
  function beforeMarker(code: Code): State | undefined {
    return factoryTitle(
      effects,
      titleAfter,
      nok,
      types.definitionTitle,
      types.definitionTitleMarker,
      types.definitionTitleString
    )(code);
  }

  /**
   * After title.
   *
   * ```markdown
   * > | [a]: b "c"
   *               ^
   * ```
   */
  function titleAfter(code: Code): State | undefined {
    return markdownSpace(code)
      ? factorySpace(
          effects,
          titleAfterOptionalWhitespace,
          types.whitespace
        )(code)
      : titleAfterOptionalWhitespace(code);
  }

  /**
   * After title, after optional whitespace.
   *
   * ```markdown
   * > | [a]: b "c"
   *               ^
   * ```
   */
  function titleAfterOptionalWhitespace(code: Code): State | undefined {
    return code === codes.eof || markdownLineEnding(code) ? ok(code) : nok(code);
  }
}

export const contentInitial = {
  [codes.leftSquareBracket]: definition,
};
