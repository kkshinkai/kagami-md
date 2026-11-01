/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-FileCopyrightText: Titus Wormer <tituswormer@gmail.com>
 * SPDX-License-Identifier: MPL-2.0 AND MIT
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Derived from mdast-util-gfm-footnote, https://github.com/syntax-tree/mdast-util-gfm-footnote. */

import {
  DelimiterTokenSyntax,
  FootnoteReferenceSyntax,
  type StringSegmentSyntax,
} from '../syntax/inline.js';
import { FootnoteDefinitionSyntax, FootnoteLabelSyntax } from '../syntax/block.js';
import { Fragment } from './types.js';

import type { Token } from '../types/index.js';

import type { CompileContext, Extension } from './types.js';
import { assert } from '../kernel/assert.js';
import { normalizeIdentifier } from '../kernel/utils/normalize-identifier/index.js';
import { containerSpelling, written } from './spelling.js';
import { point } from './index.js';

function enterFootnoteCall(this: CompileContext, token: Token): undefined {
  this.enter(new FootnoteReferenceSyntax(), token);
}

function enterFootnoteDefinitionLabelString(this: CompileContext): undefined {
  this.buffer();
  this.data.inString = true;
}

function enterFootnoteDefinition(this: CompileContext, token: Token): undefined {
  const footnoteLabel = new FootnoteLabelSyntax();
  footnoteLabel.start = point(token.start);
  footnoteLabel.end = point(token.start);
  footnoteLabel.leading = 2;
  const footnoteDefinition = new FootnoteDefinitionSyntax();
  footnoteDefinition.label = footnoteLabel;
  footnoteDefinition.spelling = {
    ...containerSpelling(token),
    whitespaceAfterLabel: '',
    startsOnLabelLine: token._startsOnFirstLine !== false,
    continuationIndent: token._continuationIndent === undefined ? null : token._continuationIndent,
  };
  this.enter(footnoteDefinition, token);
}

function exitFootnoteCallString(this: CompileContext, token: Token): undefined {
  const node = this.stack[this.stack.length - 1];
  assert(node && node instanceof FootnoteReferenceSyntax);
  node.identifier = normalizeIdentifier(this.sliceSerialize(token)).toLowerCase();
}

function exitFootnoteCallLabelMarker(this: CompileContext, token: Token): undefined {
  const node = this.stack[this.stack.length - 1];
  assert(node && node instanceof FootnoteReferenceSyntax);

  if (token.start.offset === node.start) {
    node.openingBracket = new DelimiterTokenSyntax(
      'openingBracket',
      token.start.offset,
      token.end.offset
    );
  } else {
    node.closingBracket = new DelimiterTokenSyntax(
      'closingBracket',
      token.start.offset,
      token.end.offset
    );
  }
}

function exitFootnoteCallMarker(this: CompileContext, token: Token): undefined {
  const node = this.stack[this.stack.length - 1];
  assert(node && node instanceof FootnoteReferenceSyntax);
  node.caret = new DelimiterTokenSyntax('caret', token.start.offset, token.end.offset);
}

function exitFootnoteCall(this: CompileContext, token: Token): undefined {
  this.exit(token);
}

function exitFootnoteDefinitionLabelString(this: CompileContext, token: Token): undefined {
  const fragment = this.stack[this.stack.length - 1];
  assert(fragment && fragment instanceof Fragment);
  this.resume();
  const node = this.stack[this.stack.length - 1];
  assert(node && node instanceof FootnoteDefinitionSyntax);
  node.identifier = normalizeIdentifier(this.sliceSerialize(token)).toLowerCase();
  node.label.end = point(token.end);
  node.label.children = fragment.children as Array<StringSegmentSyntax>;
  this.data.inString = undefined;
}

function exitFootnoteDefinitionWhitespace(this: CompileContext, token: Token): undefined {
  const node = this.stack[this.stack.length - 1];
  assert(node && node instanceof FootnoteDefinitionSyntax);
  node.spelling.whitespaceAfterLabel = written(this, token);
  node.label.trailing += point(token.end) - node.label.end;
  node.label.end = point(token.end);
}

function exitFootnoteDefinition(this: CompileContext, token: Token): undefined {
  const node = this.stack[this.stack.length - 1];
  assert(node && node instanceof FootnoteDefinitionSyntax);
  this.exit(token);
}

/**
 * Create an extension to enable GFM footnotes.
 *
 * @returns
 *   Extension.
 */
export function gfmFootnoteFromMarkdown(): Extension {
  return {
    enter: {
      gfmFootnoteCall: enterFootnoteCall,
      gfmFootnoteDefinitionLabelString: enterFootnoteDefinitionLabelString,
      gfmFootnoteDefinition: enterFootnoteDefinition,
    },
    exit: {
      gfmFootnoteCallString: exitFootnoteCallString,
      gfmFootnoteCallLabelMarker: exitFootnoteCallLabelMarker,
      gfmFootnoteCallMarker: exitFootnoteCallMarker,
      gfmFootnoteCall: exitFootnoteCall,
      gfmFootnoteDefinitionLabelString: exitFootnoteDefinitionLabelString,
      gfmFootnoteDefinitionWhitespace: exitFootnoteDefinitionWhitespace,
      gfmFootnoteDefinition: exitFootnoteDefinition,
    },
  };
}
