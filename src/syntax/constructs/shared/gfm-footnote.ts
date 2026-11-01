/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-FileCopyrightText: Titus Wormer <tituswormer@gmail.com>
 * SPDX-License-Identifier: MPL-2.0 AND MIT
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Derived from micromark-extension-gfm-footnote, https://github.com/micromark/micromark-extension-gfm-footnote. */

import type { Code, ConstructRecord, Effects, Event, State, Token, TokenizeContext } from '../../types/index.js';
import { assert } from '../../kernel/assert.js';
import { blankLine } from '../../kernel/blank-line.js';
import { factorySpace } from '../../kernel/factories/space/index.js';
import { markdownLineEndingOrSpace } from '../../kernel/utils/character/index.js';
import { normalizeIdentifier } from '../../kernel/utils/normalize-identifier/index.js';
import { codes, constants, types } from '../../kernel/utils/symbol/index.js';

const indent = { tokenize: tokenizeIndent, partial: true };

// To do: micromark should support a `_hiddenGfmFootnoteSupport`, which only
// affects label start (image).
// That will let us drop `tokenizePotentialGFMFootnote*`.
// It currently has a `_hiddenFootnoteSupport`, which affects that and more.
// That can be removed when `micromark-extension-footnote` is archived.

export const document: ConstructRecord = {
  [codes.leftSquareBracket]: {
    name: 'gfmFootnoteDefinition',
    tokenize: tokenizeDefinitionStart,
    continuation: { tokenize: tokenizeDefinitionContinuation },
    exit: gfmFootnoteDefinitionEnd,
  },
};

export const text: ConstructRecord = {
  [codes.leftSquareBracket]: {
    name: 'gfmFootnoteCall',
    tokenize: tokenizeGFMFootnoteCall,
  },
  [codes.rightSquareBracket]: {
    name: 'gfmPotentialFootnoteCall',
    add: 'after',
    tokenize: tokenizePotentialGFMFootnoteCall,
    resolveTo: resolveToPotentialGFMFootnoteCall,
  },
};

// To do: remove after micromark update.
function tokenizePotentialGFMFootnoteCall(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
  const self = this;
  let index = self.events.length;
  const defined = self.parser.gfmFootnotes || (self.parser.gfmFootnotes = []);
  let labelStart: Token;

  // Find an opening.
  while (index--) {
    const token = self.events[index][1];

    if (token.type === types.labelImage) {
      labelStart = token;
      break;
    }

    // Exit if we’ve walked far enough.
    if (
      token.type === 'gfmFootnoteCall' ||
      token.type === types.labelLink ||
      token.type === types.label ||
      token.type === types.image ||
      token.type === types.link
    ) {
      break;
    }
  }

  return start;

  function start(code: Code): State | undefined {
    assert(code === codes.rightSquareBracket, 'expected `]`');

    if (!labelStart || !labelStart._balanced) {
      return nok(code);
    }

    const id = normalizeIdentifier(
      self.sliceSerialize({ start: labelStart.end, end: self.now() })
    );

    if (id.codePointAt(0) === codes.caret) {
      self.parser.references.push({ kind: 'footnotes', label: id.slice(1).toLowerCase(), offset: self.now().offset });
    }
    // Kagami: a failed image label can refer to an external footnote.
    if (
      id.codePointAt(0) !== codes.caret ||
      !(defined.includes(id.slice(1)) ||
        Boolean(self.parser.bindings && self.parser.bindings.footnote(id.slice(1).toLowerCase())))
    ) {
      return nok(code);
    }

    effects.enter('gfmFootnoteCallLabelMarker');
    effects.consume(code);
    effects.exit('gfmFootnoteCallLabelMarker');
    return ok(code);
  }
}

// To do: remove after micromark update.
function resolveToPotentialGFMFootnoteCall(events: Array<Event>, context: TokenizeContext): Array<Event> {
  let index = events.length;
  let labelStart: Token | undefined;

  // Find an opening.
  while (index--) {
    if (
      events[index][1].type === types.labelImage &&
      events[index][0] === 'enter'
    ) {
      labelStart = events[index][1];
      break;
    }
  }

  assert(labelStart, 'expected `labelStart` to resolve');

  // Change the `labelImageMarker` to a `data`.
  events[index + 1][1].type = types.data;
  events[index + 3][1].type = 'gfmFootnoteCallLabelMarker';

  // The whole (without `!`):
  const call: Token = {
    type: 'gfmFootnoteCall',
    start: Object.assign({}, events[index + 3][1].start),
    end: Object.assign({}, events[events.length - 1][1].end),
  };
  // The `^` marker
  const marker: Token = {
    type: 'gfmFootnoteCallMarker',
    start: Object.assign({}, events[index + 3][1].end),
    end: Object.assign({}, events[index + 3][1].end),
  };
  // Increment the end 1 character.
  marker.end.column++;
  marker.end.offset++;
  marker.end._bufferIndex++;
  const string: Token = {
    type: 'gfmFootnoteCallString',
    start: Object.assign({}, marker.end),
    end: Object.assign({}, events[events.length - 1][1].start),
  };
  const chunk: Token = {
    type: types.chunkString,
    contentType: 'string',
    start: Object.assign({}, string.start),
    end: Object.assign({}, string.end),
  };

  const replacement: Array<Event> = [
    // Take the `labelImageMarker` (now `data`, the `!`)
    events[index + 1],
    events[index + 2],
    ['enter', call, context],
    // The `[`
    events[index + 3],
    events[index + 4],
    // The `^`.
    ['enter', marker, context],
    ['exit', marker, context],
    // Everything in between.
    ['enter', string, context],
    ['enter', chunk, context],
    ['exit', chunk, context],
    ['exit', string, context],
    // The ending (`]`, properly parsed and labelled).
    events[events.length - 2],
    events[events.length - 1],
    ['exit', call, context],
  ];

  events.splice(index, events.length - index + 1, ...replacement);

  return events;
}

function tokenizeGFMFootnoteCall(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
  const self = this;
  const defined = self.parser.gfmFootnotes || (self.parser.gfmFootnotes = []);
  let size = 0;
  let data: boolean;

  // Note: the implementation of `markdown-rs` is different, because it houses
  // core *and* extensions in one project.
  // Therefore, it can include footnote logic inside `label-end`.
  // We can’t do that, but luckily, we can parse footnotes in a simpler way than
  // needed for labels.
  return start;

  /**
   * Start of footnote label.
   *
   * ```markdown
   * > | a [^b] c
   *       ^
   * ```
   */
  function start(code: Code): State | undefined {
    assert(code === codes.leftSquareBracket, 'expected `[`');
    effects.enter('gfmFootnoteCall');
    effects.enter('gfmFootnoteCallLabelMarker');
    effects.consume(code);
    effects.exit('gfmFootnoteCallLabelMarker');
    return callStart;
  }

  /**
   * After `[`, at `^`.
   *
   * ```markdown
   * > | a [^b] c
   *        ^
   * ```
   */
  function callStart(code: Code): State | undefined {
    if (code !== codes.caret) return nok(code);

    effects.enter('gfmFootnoteCallMarker');
    effects.consume(code);
    effects.exit('gfmFootnoteCallMarker');
    effects.enter('gfmFootnoteCallString');
    effects.enter('chunkString').contentType = 'string';
    return callData;
  }

  /**
   * In label.
   *
   * ```markdown
   * > | a [^b] c
   *         ^
   * ```
   */
  function callData(code: Code): State | undefined {
    if (
      // Too long.
      size > constants.linkReferenceSizeMax ||
      // Closing brace with nothing.
      (code === codes.rightSquareBracket && !data) ||
      // Space or tab is not supported by GFM for some reason.
      // `\n` and `[` not being supported makes sense.
      code === codes.eof ||
      code === codes.leftSquareBracket ||
      markdownLineEndingOrSpace(code)
    ) {
      return nok(code);
    }

    if (code === codes.rightSquareBracket) {
      effects.exit('chunkString');
      const token = effects.exit('gfmFootnoteCallString');

      // Kagami: external footnotes are looked up where the call is read.
      const identifier = normalizeIdentifier(self.sliceSerialize(token));
      self.parser.references.push({ kind: 'footnotes', label: identifier.toLowerCase(), offset: self.now().offset });
      if (!(defined.includes(identifier) ||
        Boolean(self.parser.bindings && self.parser.bindings.footnote(identifier.toLowerCase())))) {
        return nok(code);
      }

      effects.enter('gfmFootnoteCallLabelMarker');
      effects.consume(code);
      effects.exit('gfmFootnoteCallLabelMarker');
      effects.exit('gfmFootnoteCall');
      return ok;
    }

    if (!markdownLineEndingOrSpace(code)) {
      data = true;
    }

    size++;
    effects.consume(code);
    return code === codes.backslash ? callEscape : callData;
  }

  /**
   * On character after escape.
   *
   * ```markdown
   * > | a [^b\c] d
   *           ^
   * ```
   */
  function callEscape(code: Code): State | undefined {
    if (
      code === codes.leftSquareBracket ||
      code === codes.backslash ||
      code === codes.rightSquareBracket
    ) {
      effects.consume(code);
      size++;
      return callData;
    }

    return callData(code);
  }
}

function tokenizeDefinitionStart(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
  const self = this;
  const defined = self.parser.gfmFootnotes || (self.parser.gfmFootnotes = []);
  let identifier: string;
  let size = 0;
  let data: boolean | undefined;

  return start;

  /**
   * Start of GFM footnote definition.
   *
   * ```markdown
   * > | [^a]: b
   *     ^
   * ```
   */
  function start(code: Code): State | undefined {
    assert(code === codes.leftSquareBracket, 'expected `[`');
    effects.enter('gfmFootnoteDefinition')._container = true;
    effects.enter('gfmFootnoteDefinitionLabel');
    effects.enter('gfmFootnoteDefinitionLabelMarker');
    effects.consume(code);
    effects.exit('gfmFootnoteDefinitionLabelMarker');
    return labelAtMarker;
  }

  /**
   * In label, at caret.
   *
   * ```markdown
   * > | [^a]: b
   *      ^
   * ```
   */
  function labelAtMarker(code: Code): State | undefined {
    if (code === codes.caret) {
      effects.enter('gfmFootnoteDefinitionMarker');
      effects.consume(code);
      effects.exit('gfmFootnoteDefinitionMarker');
      effects.enter('gfmFootnoteDefinitionLabelString');
      effects.enter('chunkString').contentType = 'string';
      return labelInside;
    }

    return nok(code);
  }

  /**
   * In label.
   *
   * > 👉 **Note**: `cmark-gfm` prevents whitespace from occurring in footnote
   * > definition labels.
   *
   * ```markdown
   * > | [^a]: b
   *       ^
   * ```
   */
  function labelInside(code: Code): State | undefined {
    if (
      // Too long.
      size > constants.linkReferenceSizeMax ||
      // Closing brace with nothing.
      (code === codes.rightSquareBracket && !data) ||
      // Space or tab is not supported by GFM for some reason.
      // `\n` and `[` not being supported makes sense.
      code === codes.eof ||
      code === codes.leftSquareBracket ||
      markdownLineEndingOrSpace(code)
    ) {
      return nok(code);
    }

    if (code === codes.rightSquareBracket) {
      effects.exit('chunkString');
      const token = effects.exit('gfmFootnoteDefinitionLabelString');
      identifier = normalizeIdentifier(self.sliceSerialize(token));
      effects.enter('gfmFootnoteDefinitionLabelMarker');
      effects.consume(code);
      effects.exit('gfmFootnoteDefinitionLabelMarker');
      effects.exit('gfmFootnoteDefinitionLabel');
      return labelAfter;
    }

    if (!markdownLineEndingOrSpace(code)) {
      data = true;
    }

    size++;
    effects.consume(code);
    return code === codes.backslash ? labelEscape : labelInside;
  }

  /**
   * After `\`, at a special character.
   *
   * > 👉 **Note**: `cmark-gfm` currently does not support escaped brackets:
   * > <https://github.com/github/cmark-gfm/issues/240>
   *
   * ```markdown
   * > | [^a\*b]: c
   *         ^
   * ```
   */
  function labelEscape(code: Code): State | undefined {
    if (
      code === codes.leftSquareBracket ||
      code === codes.backslash ||
      code === codes.rightSquareBracket
    ) {
      effects.consume(code);
      size++;
      return labelInside;
    }

    return labelInside(code);
  }

  /**
   * After definition label.
   *
   * ```markdown
   * > | [^a]: b
   *         ^
   * ```
   */
  function labelAfter(code: Code): State | undefined {
    if (code === codes.colon) {
      effects.enter('definitionMarker');
      effects.consume(code);
      effects.exit('definitionMarker');

      if (!defined.includes(identifier)) {
        defined.push(identifier);
      }

      // Any whitespace after the marker is eaten, forming indented code
      // is not possible.
      // No space is also fine, just like a block quote marker.
      return factorySpace(
        effects,
        whitespaceAfter,
        'gfmFootnoteDefinitionWhitespace'
      );
    }

    return nok(code);
  }

  /**
   * After definition prefix.
   *
   * ```markdown
   * > | [^a]: b
   *           ^
   * ```
   */
  function whitespaceAfter(code: Code): State | undefined {
    // `markdown-rs` has a wrapping token for the prefix that is closed here.
    return ok(code);
  }
}

function tokenizeDefinitionContinuation(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
  /// Start of footnote definition continuation.
  ///
  /// ```markdown
  ///   | [^a]: b
  /// > |     c
  ///     ^
  /// ```
  //
  // Either a blank line, which is okay, or an indented thing.
  return effects.check(blankLine, ok, effects.attempt(indent, ok, nok));
}

function gfmFootnoteDefinitionEnd(this: TokenizeContext, effects: Effects): undefined {
  effects.exit('gfmFootnoteDefinition');
}

function tokenizeIndent(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
  const self = this;
  const before = self.events.length;

  return factorySpace(
    effects,
    afterPrefix,
    'gfmFootnoteDefinitionIndent',
    constants.tabSize + 1
  );

  function afterPrefix(code: Code): State | undefined {
    const tail = self.events[self.events.length - 1];
    return self.events.length > before && tail &&
      tail[1].type === 'gfmFootnoteDefinitionIndent' &&
      tail[2].sliceSerialize(tail[1], true).length === constants.tabSize
      ? ok(code)
      : nok(code);
  }
}
