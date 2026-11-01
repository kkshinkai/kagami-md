/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  ATXClosingSequenceSyntax,
  CalloutDeclarationSyntax,
  DelimiterTokenSyntax,
  LinkTitleStartSyntax,
  TaskMarkerSyntax,
  TextTokenSyntax,
  TriviaTokenSyntax,
} from '../syntax/inline.js';
import type { Token } from '../types/index.js';

import type { CompileContext, Extension } from './types.js';
import type { CalloutType } from '../constructs/text/inline-source-callout-declaration.js';
import { assert } from '../kernel/assert.js';

/**
 * Create an extension to read what a field’s place lets the parser read, as
 * nodes of its content: a task marker, a callout’s declaration and an ATX
 * heading’s closing sequence in a field of inline content, and the start of a
 * title in a destination. See
 * private-docs/design/syntax/for-the-editor.md.
 *
 * Kagami’s own. Each is made as `emoji.ts` makes an emoji: entered with the
 * token around it, its parts set by the tokens of its parts.
 *
 * @returns
 *   Extension.
 */
export function phrasingFromMarkdown(): Extension {
  return {
    enter: {
      atxHeadingClosing: enterClosingSequence,
      inlineSourceCalloutDeclaration: enterCalloutDeclaration,
      inlineSourceLinkDefinitionTitleCandidate: enterTitleStart,
      inlineSourceTaskMarker: enterTaskMarker,
    },
    exit: {
      atxHeadingClosing: exit,
      atxHeadingClosingSequence: exitClosingSequence,
      atxHeadingClosingWhitespace: exitClosingWhitespace,
      atxHeadingClosingWhitespaceBefore: exitWhitespaceBeforeClosingSequence,
      inlineSourceCalloutDeclaration: exit,
      inlineSourceCalloutDeclarationMarker: exitCalloutDeclarationMarker,
      inlineSourceCalloutDeclarationType: exitCalloutDeclarationType,
      inlineSourceCalloutDeclarationWhitespace: exitCalloutDeclarationWhitespace,
      inlineSourceLinkDefinitionTitleCandidate: exit,
      inlineSourceLinkDefinitionTitleDelimiter: exitTitleDelimiter,
      inlineSourceLinkDefinitionTitleWhitespace: exitTitleWhitespace,
      inlineSourceTaskMarker: exit,
      inlineSourceTaskMarkerBoundary: exitTaskMarkerBoundary,
      inlineSourceTaskMarkerChecked: exitTaskMarkerMark,
      inlineSourceTaskMarkerUnchecked: exitTaskMarkerMark,
      inlineSourceTaskMarkerWhitespace: exitTaskMarkerWhitespace,
    },
  };
}

function enterTaskMarker(this: CompileContext, token: Token): undefined {
  const taskMarker = new TaskMarkerSyntax();
  taskMarker.checked = false;
  this.enter(taskMarker, token);
}

function exitTaskMarkerBoundary(this: CompileContext, token: Token): undefined {
  const node = this.stack[this.stack.length - 1];
  assert(node && node instanceof TaskMarkerSyntax, 'expected a task marker');

  if (node.openingBracket) {
    node.closingBracket = new DelimiterTokenSyntax(
      'closingBracket',
      token.start.offset,
      token.end.offset
    );
  } else {
    node.openingBracket = new DelimiterTokenSyntax(
      'openingBracket',
      token.start.offset,
      token.end.offset
    );
  }
}

function exitTaskMarkerMark(this: CompileContext, token: Token): undefined {
  const node = this.stack[this.stack.length - 1];
  assert(node && node instanceof TaskMarkerSyntax, 'expected a task marker');
  node.mark = new DelimiterTokenSyntax('taskCheck', token.start.offset, token.end.offset);
  node.checked = token.type === 'inlineSourceTaskMarkerChecked';
}

function exitTaskMarkerWhitespace(this: CompileContext, token: Token): undefined {
  const node = this.stack[this.stack.length - 1];
  assert(node && node instanceof TaskMarkerSyntax, 'expected a task marker');
  node.separators.push(
    new TriviaTokenSyntax('taskMarkerWhitespace', token.start.offset, token.end.offset)
  );
}

function enterCalloutDeclaration(this: CompileContext, token: Token): undefined {
  this.enter(new CalloutDeclarationSyntax(), token);
}

function exitCalloutDeclarationMarker(this: CompileContext, token: Token): undefined {
  const node = this.stack[this.stack.length - 1];
  assert(node && node instanceof CalloutDeclarationSyntax, 'expected a declaration');

  if (node.opening) {
    node.closing = new DelimiterTokenSyntax(
      'calloutClosingMarker',
      token.start.offset,
      token.end.offset
    );
  } else {
    node.opening = new DelimiterTokenSyntax(
      'calloutOpeningMarker',
      token.start.offset,
      token.end.offset
    );
  }
}

function exitCalloutDeclarationType(this: CompileContext, token: Token): undefined {
  const node = this.stack[this.stack.length - 1];
  assert(node && node instanceof CalloutDeclarationSyntax, 'expected a declaration');
  node.typeName = new DelimiterTokenSyntax(
    'calloutTypeName',
    token.start.offset,
    token.end.offset
  );
  node.calloutType = this.sliceSerialize(token).toLowerCase() as CalloutType;
}

function exitCalloutDeclarationWhitespace(this: CompileContext, token: Token): undefined {
  const node = this.stack[this.stack.length - 1];
  assert(node && node instanceof CalloutDeclarationSyntax, 'expected a declaration');
  node.separators.push(
    new TriviaTokenSyntax('calloutDeclarationWhitespace', token.start.offset, token.end.offset)
  );
}

/** The whitespace before a closing sequence is the heading’s text. */
function exitWhitespaceBeforeClosingSequence(this: CompileContext, token: Token): undefined {
  this.enter(new TextTokenSyntax('text', 0, 0), token);
  this.exit(token);
}

/** The closing sequence holds the whitespace after it as trivia. */
function enterClosingSequence(this: CompileContext, token: Token): undefined {
  this.enter(new ATXClosingSequenceSyntax(), token);
}

function exitClosingSequence(this: CompileContext, token: Token): undefined {
  const node = this.stack[this.stack.length - 1];
  assert(node && node instanceof ATXClosingSequenceSyntax, 'expected a closing sequence');
  node.sequence = new DelimiterTokenSyntax(
    'atxClosingSequenceMarker',
    token.start.offset,
    token.end.offset
  );
}

function exitClosingWhitespace(this: CompileContext, token: Token): undefined {
  const node = this.stack[this.stack.length - 1];
  assert(node && node instanceof ATXClosingSequenceSyntax, 'expected a closing sequence');
  node.separators.push(
    new TriviaTokenSyntax('trailingWhitespace', token.start.offset, token.end.offset)
  );
}

function enterTitleStart(this: CompileContext, token: Token): undefined {
  const linkTitleStart = new LinkTitleStartSyntax();
  linkTitleStart.whitespace = new TriviaTokenSyntax(
    'titleStartWhitespace',
    token.start.offset,
    token.start.offset
  );
  this.enter(linkTitleStart, token);
}

function exitTitleWhitespace(this: CompileContext, token: Token): undefined {
  const node = this.stack[this.stack.length - 1];
  assert(node && node instanceof LinkTitleStartSyntax, 'expected the start of a title');
  node.whitespace = new TriviaTokenSyntax(
    'titleStartWhitespace',
    token.start.offset,
    token.end.offset
  );
}

function exitTitleDelimiter(this: CompileContext, token: Token): undefined {
  const node = this.stack[this.stack.length - 1];
  assert(node && node instanceof LinkTitleStartSyntax, 'expected the start of a title');
  node.delimiter = new DelimiterTokenSyntax(
    'titleDelimiter',
    token.start.offset,
    token.end.offset
  );
}

function exit(this: CompileContext, token: Token): undefined {
  this.exit(token);
}
