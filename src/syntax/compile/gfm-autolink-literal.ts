/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-FileCopyrightText: Titus Wormer <tituswormer@gmail.com>
 * SPDX-License-Identifier: MPL-2.0 AND MIT
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Derived from mdast-util-gfm-autolink-literal, https://github.com/syntax-tree/mdast-util-gfm-autolink-literal. */

import { LiteralAutolinkSyntax } from '../syntax/inline.js';
import type { Token } from '../types/index.js';
import type { CompileContext, Extension } from './types.js';
import { assert } from '../kernel/assert.js';

/**
 * Create an extension to enable GFM autolink literals.
 *
 * @returns
 *   Extension to enable GFM autolink literals.
 */
export function gfmAutolinkLiteralFromMarkdown(): Extension {
  return {
    enter: {
      literalAutolink: enterLiteralAutolink,
    },
    exit: {
      literalAutolink: exitLiteralAutolink,
      literalAutolinkEmail: exitLiteralAutolinkEmail,
      literalAutolinkHTTP: exitLiteralAutolinkHTTP,
      literalAutolinkWWW: exitLiteralAutolinkWWW,
    },
  };
}

function enterLiteralAutolink(this: CompileContext, token: Token): undefined {
  const literalAutolink = new LiteralAutolinkSyntax();
  this.enter(literalAutolink, token);
}

function exitLiteralAutolinkHTTP(this: CompileContext, token: Token): undefined {
  const node = this.stack[this.stack.length - 1];
  assert(node && node instanceof LiteralAutolinkSyntax);
  node.destination = this.sliceSerialize(token);
}

function exitLiteralAutolinkWWW(this: CompileContext, token: Token): undefined {
  const node = this.stack[this.stack.length - 1];
  assert(node && node instanceof LiteralAutolinkSyntax);
  node.destination = 'http://' + this.sliceSerialize(token);
}

function exitLiteralAutolinkEmail(this: CompileContext, token: Token): undefined {
  const node = this.stack[this.stack.length - 1];
  assert(node && node instanceof LiteralAutolinkSyntax);
  node.destination = 'mailto:' + this.sliceSerialize(token);
}

function exitLiteralAutolink(this: CompileContext, token: Token): undefined {
  this.exit(token);
}
