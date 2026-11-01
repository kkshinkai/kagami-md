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
import { factorySpace } from '../../kernel/factories/space/index.js';
import { asciiDigit, markdownSpace } from '../../kernel/utils/character/index.js';
import { codes, constants, types } from '../../kernel/utils/symbol/index.js';
import { blankLine } from '../../kernel/blank-line.js';
import { thematicBreak } from '../flow/thematic-break.js';

export const list: Construct = {
  continuation: { tokenize: tokenizeListContinuation },
  exit: tokenizeListEnd,
  name: 'list',
  tokenize: tokenizeListStart,
};

const listItemPrefixWhitespaceConstruct: Construct = {
  partial: true,
  tokenize: tokenizeListItemPrefixWhitespace,
};

const indentConstruct: Construct = { partial: true, tokenize: tokenizeIndent };

// To do: `markdown-rs` parses list items on their own and later stitches them
// together.

function tokenizeListStart(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
  const self = this;
  const tail = self.events[self.events.length - 1];
  let initialSize =
    tail && tail[1].type === types.linePrefix
      ? tail[2].sliceSerialize(tail[1], true).length
      : 0;
  let size = 0;

  return start;

  function start(code: Code): State | undefined {
    assert(self.containerState, 'expected state');
    const kind =
      self.containerState.type ||
      (code === codes.asterisk || code === codes.plusSign || code === codes.dash
        ? types.listUnordered
        : types.listOrdered);

    if (
      kind === types.listUnordered
        ? !self.containerState.marker || code === self.containerState.marker
        : asciiDigit(code)
    ) {
      if (!self.containerState.type) {
        self.containerState.type = kind;
        effects.enter(kind, { _container: true });
      }

      if (kind === types.listUnordered) {
        effects.enter(types.listItemPrefix);
        return code === codes.asterisk || code === codes.dash
          ? effects.check(thematicBreak, nok, atMarker)(code)
          : atMarker(code);
      }

      if (!self.interrupt || code === codes.digit1) {
        effects.enter(types.listItemPrefix);
        effects.enter(types.listItemValue);
        return inside(code);
      }
    }

    return nok(code);
  }

  function inside(code: Code): State | undefined {
    assert(self.containerState, 'expected state');
    if (asciiDigit(code) && ++size < constants.listItemValueSizeMax) {
      effects.consume(code);
      return inside;
    }

    if (
      (!self.interrupt || size < 2) &&
      (self.containerState.marker
        ? code === self.containerState.marker
        : code === codes.rightParenthesis || code === codes.dot)
    ) {
      effects.exit(types.listItemValue);
      return atMarker(code);
    }

    return nok(code);
  }

  function atMarker(code: Code): State | undefined {
    assert(self.containerState, 'expected state');
    assert(code !== codes.eof, 'eof (`null`) is not a marker');
    effects.enter(types.listItemMarker);
    effects.consume(code);
    // Kagami: leave which marker this is on its token, as the container state keeps it, so
    // that whoever makes a tree does not read the character again.
    effects.exit(types.listItemMarker)._listMarker = code;
    self.containerState.marker = self.containerState.marker || code;
    return effects.check(
      blankLine,
      // Can’t be empty when interrupting.
      self.interrupt ? nok : onBlank,
      effects.attempt(
        listItemPrefixWhitespaceConstruct,
        endOfPrefix,
        otherPrefix
      )
    );
  }

  function onBlank(code: Code): State | undefined {
    assert(self.containerState, 'expected state');
    self.containerState.initialBlankLine = true;
    initialSize++;
    return endOfPrefix(code);
  }

  function otherPrefix(code: Code): State | undefined {
    if (markdownSpace(code)) {
      effects.enter(types.listItemPrefixWhitespace);
      effects.consume(code);
      effects.exit(types.listItemPrefixWhitespace);
      return endOfPrefix;
    }

    return nok(code);
  }

  function endOfPrefix(code: Code): State | undefined {
    assert(self.containerState, 'expected state');
    self.containerState.size =
      initialSize +
      self.sliceSerialize(effects.exit(types.listItemPrefix), true).length;
    return ok(code);
  }
}

function tokenizeListContinuation(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
  const self = this;

  assert(self.containerState, 'expected state');
  self.containerState._closeFlow = undefined;

  return effects.check(blankLine, onBlank, notBlank);

  function onBlank(code: Code): State | undefined {
    assert(self.containerState, 'expected state');
    assert(typeof self.containerState.size === 'number', 'expected size');
    self.containerState.furtherBlankLines =
      self.containerState.furtherBlankLines ||
      self.containerState.initialBlankLine;

    // We have a blank line.
    // Still, try to consume at most the items size.
    return factorySpace(
      effects,
      ok,
      types.listItemIndent,
      self.containerState.size + 1
    )(code);
  }

  function notBlank(code: Code): State | undefined {
    assert(self.containerState, 'expected state');
    if (self.containerState.furtherBlankLines || !markdownSpace(code)) {
      self.containerState.furtherBlankLines = undefined;
      self.containerState.initialBlankLine = undefined;
      return notInCurrentItem(code);
    }

    self.containerState.furtherBlankLines = undefined;
    self.containerState.initialBlankLine = undefined;
    return effects.attempt(indentConstruct, ok, notInCurrentItem)(code);
  }

  function notInCurrentItem(code: Code): State | undefined {
    assert(self.containerState, 'expected state');
    // While we do continue, we signal that the flow should be closed.
    self.containerState._closeFlow = true;
    // As we’re closing flow, we’re no longer interrupting.
    self.interrupt = undefined;
    // Always populated by defaults.
    assert(
      self.parser.constructs.disable.null,
      'expected `disable.null` to be populated'
    );
    return factorySpace(
      effects,
      effects.attempt(list, ok, nok),
      types.linePrefix,
      self.parser.constructs.disable.null.includes('codeIndented')
        ? undefined
        : constants.tabSize
    )(code);
  }
}

function tokenizeIndent(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
  const self = this;

  assert(self.containerState, 'expected state');
  assert(typeof self.containerState.size === 'number', 'expected size');

  return factorySpace(
    effects,
    afterPrefix,
    types.listItemIndent,
    self.containerState.size + 1
  );

  function afterPrefix(code: Code): State | undefined {
    assert(self.containerState, 'expected state');
    const tail = self.events[self.events.length - 1];
    return tail &&
      tail[1].type === types.listItemIndent &&
      tail[2].sliceSerialize(tail[1], true).length === self.containerState.size
      ? ok(code)
      : nok(code);
  }
}

function tokenizeListEnd(this: TokenizeContext, effects: Effects): undefined {
  assert(this.containerState, 'expected state');
  assert(typeof this.containerState.type === 'string', 'expected type');
  effects.exit(this.containerState.type);
}

function tokenizeListItemPrefixWhitespace(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
  const self = this;

  // Always populated by defaults.
  assert(
    self.parser.constructs.disable.null,
    'expected `disable.null` to be populated'
  );

  return factorySpace(
    effects,
    afterPrefix,
    types.listItemPrefixWhitespace,
    self.parser.constructs.disable.null.includes('codeIndented')
      ? undefined
      : constants.tabSize + 1
  );

  function afterPrefix(code: Code): State | undefined {
    const tail = self.events[self.events.length - 1];

    return !markdownSpace(code) &&
      tail &&
      tail[1].type === types.listItemPrefixWhitespace
      ? ok(code)
      : nok(code);
  }
}

export const document = {
  [codes.asterisk]: list,
  [codes.plusSign]: list,
  [codes.dash]: list,
  [codes.digit0]: list,
  [codes.digit1]: list,
  [codes.digit2]: list,
  [codes.digit3]: list,
  [codes.digit4]: list,
  [codes.digit5]: list,
  [codes.digit6]: list,
  [codes.digit7]: list,
  [codes.digit8]: list,
  [codes.digit9]: list,
};
