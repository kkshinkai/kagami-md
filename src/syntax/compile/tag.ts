/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { DelimiterTokenSyntax, TagSyntax, TextTokenSyntax } from '../syntax/inline.js';
import type { Token } from '../types/index.js';
import type { CompileContext, Extension } from './types.js';
import { assert } from '../kernel/assert.js';

/**
 * Create an extension to enable tags, `#a` and `#a/b`, Kagami’s own.
 *
 * @returns
 *   Extension.
 */
export function tagFromMarkdown(): Extension {
  return {
    enter: { tag: enterTag },
    exit: {
      tag: exitTag,
      tagMarker: exitTagMarker,
      tagName: exitTagName,
    },
  };
}

function enterTag(this: CompileContext, token: Token): undefined {
  this.enter(new TagSyntax(), token);
}

function exitTagMarker(this: CompileContext, token: Token): undefined {
  const node = this.stack[this.stack.length - 1];
  assert(node && node instanceof TagSyntax);
  node.openingNumberSign = new DelimiterTokenSyntax(
    'openingNumberSign',
    token.start.offset,
    token.end.offset
  );
}

function exitTagName(this: CompileContext, token: Token): undefined {
  const node = this.stack[this.stack.length - 1];
  assert(node && node instanceof TagSyntax);
  node.name = new TextTokenSyntax('tagName', token.start.offset, token.end.offset);
}

function exitTag(this: CompileContext, token: Token): undefined {
  this.exit(token);
}
