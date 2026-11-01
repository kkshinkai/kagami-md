/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  FencedCodeBlockSyntax,
  HTMLBlockSyntax,
  LiteralBlockSyntax,
  MathBlockSyntax,
  RawFrontMatterSyntax,
} from '../syntax/block.js';
import type { Token } from '../types/index.js';

import type { CompileContext } from './types.js';
import { assert } from '../kernel/assert.js';

/** A block whose content is compiled from literal tokens. */
type Literal = LiteralBlockSyntax | RawFrontMatterSyntax;

/** The current literal's content boundaries and last unassigned line ending. */
interface LiteralState {
  start: number;
  end: number;
  empty: boolean;
  opening: boolean;
  ending: Token | undefined;
}

declare module './types.js' {
  interface CompileData {
    /** The active literal leaf; its last ending waits for content or the closing boundary. */
    literal?: LiteralState | undefined;
  }
}

/** Begin a literal at its token, or after its opening fence. */
export function beginLiteral(context: CompileContext, token: Token, fenced: boolean): undefined {
  assert(!context.data.literal, 'expected no open literal');
  const start = fenced ? token.end.offset : token.start.offset;
  context.data.literal = { start, end: start, empty: true, opening: fenced, ending: undefined };
}

/** Append a recognized content token, including any preceding interior ending. */
export function literalValue(context: CompileContext, node: Literal, token: Token): undefined {
  const state = context.data.literal;
  assert(state, 'expected an open literal');
  if (state.ending) append(context, node, state.ending, '\n');
  state.ending = undefined;
  append(context, node, token, context.sliceSerialize(token));
}

/** Hold an ending until the following content or closing boundary determines its role. */
export function literalEnding(context: CompileContext, node: Literal, token: Token): undefined {
  const state = context.data.literal;
  assert(state, 'expected an open literal');
  if (state.opening) {
    state.start = token.end.offset;
    state.end = token.end.offset;
    state.opening = false;
  } else {
    if (state.ending) append(context, node, state.ending, '\n');
    state.ending = token;
  }
}

/** Close the content envelope after the block's final range is known. */
export function endLiteral(context: CompileContext, node: Literal, token: Token): undefined {
  const state = context.data.literal;
  assert(state, 'expected an open literal');
  // Kagami: a container can cut a flow token off before a final blank row.
  // The line ownership pass proves that row from its ending or prefixes;
  // stopping before another block does not itself create a content line.
  let cut = false;
  if (node instanceof FencedCodeBlockSyntax)
    cut = token._literalFinalBlankLine === true && node.spelling.fence.closingFence === null;
  else if (node instanceof MathBlockSyntax)
    cut = token._literalFinalBlankLine === true && node.spelling.closingFence === null;
  else if (node instanceof HTMLBlockSyntax) cut = token.end.offset !== context.source.length;
  if (state.ending && cut) append(context, node, state.ending, '\n');
  node.leading = state.start - node.start;
  node.trailing = node.end - state.end;
  context.data.literal = undefined;
}

function append(context: CompileContext, node: Literal, token: Token, value: string): undefined {
  const state = context.data.literal;
  assert(state, 'expected an open literal');
  if (state.empty) {
    state.start = token.start.offset;
    state.empty = false;
  }
  state.end = token.end.offset;
  node.content += value;
}
