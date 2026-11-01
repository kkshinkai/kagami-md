/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-FileCopyrightText: Titus Wormer <tituswormer@gmail.com>
 * SPDX-License-Identifier: MPL-2.0 AND MIT
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Derived from mdast-util-math, https://github.com/syntax-tree/mdast-util-math. */

import { DelimiterTokenSyntax, InlineMathSyntax, TriviaTokenSyntax } from '../syntax/inline.js';
import { MathBlockSyntax } from '../syntax/block.js';
import type { Token } from '../types/index.js';
import type { CompileContext, Extension } from './types.js';
import { assert } from '../kernel/assert.js';
import { blockSpelling } from './spelling.js';

/**
 * Create an extension to enable math, Kagami’s `$$` blocks and `$` text.
 *
 * A block of math is read as fenced code is: its fences, its meta, and its
 * content.
 *
 * @returns
 *   Extension.
 */
export function mathFromMarkdown(): Extension {
  return {
    enter: {
      mathFlow: enterMathFlow,
      mathFlowFenceMeta: enterMathFlowMeta,
      mathText: enterMathText,
      mathTextData: enterMathData,
    },
    exit: {
      mathFlow: exitMathFlow,
      mathFlowFence: exitMathFlowFence,
      mathFlowFenceMeta: exitMathFlowMeta,
      mathFlowFenceSequence: exitMathFlowFenceSequence,
      mathFlowValue: exitMathFlowValue,
      mathText: exitMathText,
      mathTextData: exitMathData,
      mathTextPadding: exitMathTextPadding,
      mathTextSequence: exitMathTextSequence,
    },
  };
}

function enterMathFlow(this: CompileContext, token: Token): undefined {
  const mathBlock = new MathBlockSyntax();
  mathBlock.spelling = {
    ...blockSpelling(token),
    fence: '',
    whitespaceAfterFence: '',
    closingFence: null,
    spacesBeforeClosingFence: 0,
    meta: null,
  };
  this.enter(mathBlock, token);
}

function enterMathFlowMeta(this: CompileContext, token: Token): undefined {
  this.config.enter.codeFencedFenceMeta!.call(this, token);
}

function exitMathFlowMeta(this: CompileContext, token: Token): undefined {
  this.resume();
  const node = this.stack[this.stack.length - 1];
  assert(node instanceof MathBlockSyntax);
  // Kagami: the meta is kept as written.
  node.spelling.meta = this.sliceSerialize(token);
}

function exitMathFlowFence(this: CompileContext, token: Token): undefined {
  this.config.exit.codeFencedFence!.call(this, token);
}

function exitMathFlowFenceSequence(this: CompileContext, token: Token): undefined {
  this.config.exit.codeFencedFenceSequence!.call(this, token);
}

function exitMathFlowValue(this: CompileContext, token: Token): undefined {
  this.config.exit.codeFlowValue!.call(this, token);
}

function exitMathFlow(this: CompileContext, token: Token): undefined {
  this.config.exit.codeFenced!.call(this, token);
}

function enterMathText(this: CompileContext, token: Token): undefined {
  this.enter(new InlineMathSyntax(), token);
}

function exitMathTextSequence(this: CompileContext, token: Token): undefined {
  const node = this.stack[this.stack.length - 1];
  assert(node instanceof InlineMathSyntax);

  if (token.start.offset === node.start) {
    node.openingDollars = new DelimiterTokenSyntax(
      'dollarString',
      token.start.offset,
      token.end.offset
    );
  } else {
    node.closingDollars = new DelimiterTokenSyntax(
      'dollarString',
      token.start.offset,
      token.end.offset
    );
  }
}

function exitMathText(this: CompileContext, token: Token): undefined {
  this.exit(token);
}

function exitMathTextPadding(this: CompileContext, token: Token): undefined {
  const node = this.stack[this.stack.length - 1];
  assert(node, 'expected node on stack');
  assert(node instanceof InlineMathSyntax, 'expected inline math on stack');
  const range = { start: token.start.offset, end: token.end.offset };

  node.children.push(
    token.start.line !== token.end.line
      ? new TriviaTokenSyntax('lineEnding', range.start, range.end)
      : new TriviaTokenSyntax('inlineMathPadding', range.start, range.end)
  );
}

function enterMathData(this: CompileContext, token: Token): undefined {
  this.config.enter.data!.call(this, token);
}

function exitMathData(this: CompileContext, token: Token): undefined {
  this.config.exit.data!.call(this, token);
  const node = this.stack[this.stack.length - 1];
  assert(node instanceof InlineMathSyntax);
  node.math += this.sliceSerialize(token);
}
