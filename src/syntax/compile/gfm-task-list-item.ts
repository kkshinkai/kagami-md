/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-FileCopyrightText: Titus Wormer <tituswormer@gmail.com>
 * SPDX-License-Identifier: MPL-2.0 AND MIT
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Derived from mdast-util-gfm-task-list-item, https://github.com/syntax-tree/mdast-util-gfm-task-list-item. */

import { ListItemSyntax } from '../syntax/block.js';
import type { Token } from '../types/index.js';
import type { CompileContext, Extension } from './types.js';
import { assert } from '../kernel/assert.js';

/**
 * Create an extension to enable GFM task list items.
 *
 * A check before the text of a paragraph is the item’s: the paragraph begins
 * with its first piece, as every paragraph does.
 *
 * @returns
 *   Extension to enable GFM task list items.
 */
export function gfmTaskListItemFromMarkdown(): Extension {
  return {
    exit: {
      taskListCheckValueChecked: exitCheck,
      taskListCheckValueUnchecked: exitCheck,
    },
  };
}

function exitCheck(this: CompileContext, token: Token): undefined {
  // We’re always in a paragraph, in a list item.
  const node = this.stack[this.stack.length - 2];
  assert(node && node instanceof ListItemSyntax);
  node.checked = token.type === 'taskListCheckValueChecked';
}
