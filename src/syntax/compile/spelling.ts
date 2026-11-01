/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { type BlockSpelling, type ContainerBlockSpelling } from '../syntax/block.js';
import type { Token, TokenizeContext } from '../types/index.js';

import type { CompileContext } from './types.js';
import { codes, constants } from '../kernel/utils/symbol/index.js';

/**
 * The characters of `token` as written, for a record of spelling.
 *
 * A tab the token shares with another is recorded as the spaces of the
 * columns the token takes of it (private-docs/design/syntax/tabs.md); a tab of
 * its own stays a tab.
 * Columns at the start of a token, of a tab before it, serialize as spaces
 * already; a token that ends inside a tab takes fewer columns than its
 * characters would from where it starts.
 *
 * @param context
 *   Context.
 * @param token
 *   Token.
 * @returns
 *   Spelling.
 */
export function written(context: CompileContext, token: Token): string {
  const value = context.sliceSerialize(token);
  const expanded = context.sliceSerialize(token, true);
  let column = token.start.column;
  if (value.includes('\t')) {
    column += context.tabColumns(token.start);
  }
  let size = 0;
  let index = 0;

  while (index < value.length) {
    const code = value.codePointAt(index)!;
    const width = code === codes.ht ? constants.tabSize - ((column - 1) % constants.tabSize) : 1;
    index += code > 0xff_ff ? 2 : 1;
    column += width;
    size += width;
  }

  return expanded.length < size ? expanded : value;
}

/**
 * How many columns a token of whitespace takes, the columns of its tabs
 * counted.
 *
 * @param context
 *   Context.
 * @param token
 *   Token.
 * @returns
 *   Columns.
 */
export function columns(context: CompileContext | TokenizeContext, token: Token): number {
  return context.sliceSerialize(token, true).length;
}

/**
 * What every block records of the lines around it, as the lines were
 * prepared.
 *
 * @param token
 *   Token of the block.
 * @returns
 *   Spelling.
 */
export function blockSpelling(token: Token): BlockSpelling {
  return {
    leadingBlankLines: token._leadingBlankLines || 0,
    trailingBlankLines: token._trailingBlankLines || 0,
    spacesBeforeBlock: token._spacesBeforeBlock || 0,
  };
}

/**
 * What every container block records.
 *
 * @param token
 *   Token of the container.
 * @returns
 *   Spelling.
 */
export function containerSpelling(token: Token): ContainerBlockSpelling {
  return {
    ...blockSpelling(token),
    start: token._startBlankLines || 0,
    end: token._endBlankLines || 0,
  };
}
