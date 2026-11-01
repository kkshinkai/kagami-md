/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  DelimiterTokenSyntax,
  type StringSegmentSyntax,
  TriviaTokenSyntax,
  WikiEmbedSyntax,
  WikilinkPartSyntax,
  WikilinkSyntax,
} from '../syntax/inline.js';
import type { Token } from '../types/index.js';

import { Fragment, type CompileContext, type Extension } from './types.js';
import { replaceCurrent } from './children.js';
import { assert } from '../kernel/assert.js';

/** Compile wiki links and embeds from their recognized parts. */
export function wikilinkFromMarkdown(): Extension {
  return {
    enter: {
      wikilink: enterWikilink,
      wikilinkAlias: enterPart,
      wikilinkTarget: enterPart,
      wikilinkValue: enterValue,
    },
    exit: {
      wikilink: exitWikilink,
      wikilinkAlias: exitAlias,
      wikilinkAliasMarker: exitAliasMarker,
      wikilinkEmbedMarker: exitEmbedMarker,
      wikilinkMarker: exitMarker,
      wikilinkTarget: exitTarget,
      wikilinkTableEscape: exitTableEscape,
      wikilinkValue: exitValue,
    },
  };
}

function current(context: CompileContext): WikilinkSyntax | WikiEmbedSyntax {
  const node = context.stack[context.stack.length - 1];
  assert(
    node instanceof WikilinkSyntax || node instanceof WikiEmbedSyntax,
    'expected wiki link or embed'
  );
  return node;
}

function enterWikilink(this: CompileContext, token: Token): undefined {
  const node = new WikilinkSyntax();
  node.target = new WikilinkPartSyntax();
  this.enter(node, token);
}

function exitWikilink(this: CompileContext, token: Token): undefined {
  const node = current(this);
  if (node instanceof WikiEmbedSyntax && node.alias && node.size) node.alias.end = node.size.start;
  this.exit(token);
}

function exitEmbedMarker(this: CompileContext, token: Token): undefined {
  const previous = current(this);
  const node = new WikiEmbedSyntax();
  node.target = previous.target;
  node.exclamationMark = new DelimiterTokenSyntax(
    'exclamationMark',
    token.start.offset,
    token.end.offset
  );
  replaceCurrent(this, node);
}

function exitMarker(this: CompileContext, token: Token): undefined {
  const node = current(this);
  if (!node.openingBrackets) {
    node.openingBrackets = new DelimiterTokenSyntax(
      'openingWikiBrackets',
      token.start.offset,
      token.end.offset
    );
    node.target.start = token.end.offset;
    node.target.end = token.end.offset;
  } else {
    node.closingBrackets = new DelimiterTokenSyntax(
      'closingWikiBrackets',
      token.start.offset,
      token.end.offset
    );
  }
}

function exitAliasMarker(this: CompileContext, token: Token): undefined {
  const node = current(this);
  node.aliasDelimiter = new DelimiterTokenSyntax(
    'wikiAliasDelimiter',
    token.start.offset,
    token.end.offset
  );
  node.alias = new WikilinkPartSyntax();
  node.alias.start = token.end.offset;
  node.alias.end = token.end.offset;
  node.displayText = '';
}

function enterPart(this: CompileContext): undefined {
  this.buffer();
  this.data.inString = true;
}

function exitTarget(this: CompileContext, token: Token): undefined {
  const fragment = this.stack[this.stack.length - 1];
  assert(fragment instanceof Fragment, 'expected buffered target');
  const value = this.resume();
  const node = current(this);
  node.target.start = token.start.offset;
  node.target.end = token.end.offset;
  node.target.children = fragment.children as Array<StringSegmentSyntax>;
  node.destination = value.trim();
  this.data.inString = undefined;
}

function exitAlias(this: CompileContext, token: Token): undefined {
  const fragment = this.stack[this.stack.length - 1];
  assert(fragment instanceof Fragment, 'expected buffered alias');
  const value = this.resume();
  const node = current(this);
  assert(node.alias, 'expected alias after its delimiter');
  node.alias.start = token.start.offset;
  node.alias.end = token.end.offset;
  node.alias.children = fragment.children as Array<StringSegmentSyntax>;
  node.displayText = value.trim();
  this.data.inString = undefined;
}

function enterValue(this: CompileContext, token: Token): undefined {
  this.config.enter.data!.call(this, token);
}

function exitValue(this: CompileContext, token: Token): undefined {
  this.config.exit.data!.call(this, token);
}

function exitTableEscape(this: CompileContext, token: Token): undefined {
  const node = this.stack[this.stack.length - 1];
  assert(node instanceof Fragment, 'expected wiki content');
  node.children.push(
    new TriviaTokenSyntax('tablePipeEscape', token.start.offset, token.end.offset)
  );
}
