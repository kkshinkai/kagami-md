/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Fragment, Slice, type Node, type ResolvedPos } from 'prosemirror-model';
import { schema } from '../types/schema.js';
import { unparse } from './unparse.js';

/** Write a cell selection as a standalone table. Deeper open slices belong to the
 * ordinary text serializer; the first selected row supplies the required GFM header. */
export function tableText(slice: Slice, from: ResolvedPos, options: unparse.Options): string | null {
  if (slice.openStart > 1 || slice.openEnd > 1) return null;
  const first = slice.content.firstChild;
  if (!first) return null;
  if (first.type === schema.nodes.table) return write(first, from, options);
  if (!slice.content.content.every(node => node.type === schema.nodes.tableRow)) return null;

  let alignments: Array<'left' | 'center' | 'right' | null> = Array(first.childCount).fill(null);
  for (let depth = from.depth; depth >= 0; depth--) {
    const parent = from.node(depth);
    if (parent.type !== schema.nodes.table) continue;
    parent.forEach(row => row.forEach((cell, _offset, column) => {
      if (cell === first.firstChild) alignments = parent.attrs.alignments.slice(column, column + first.childCount);
    }));
    break;
  }
  return write(first.type.schema.nodes.table.create({ alignments }, slice.content), from, options);
}

function write(table: Node, from: ResolvedPos, options: unparse.Options): string {
  return unparse.slice(new Slice(Fragment.from(table), 0, 0), from, options);
}
