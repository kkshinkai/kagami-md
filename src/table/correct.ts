/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Node } from 'prosemirror-model';
import { Plugin, type EditorState, type Transaction } from 'prosemirror-state';
import { convert } from '../transform/transform.js';
import { changedRanges } from '../state/changes.js';

/** Keep the first row as the table header after native grid edits. */
export function tableCorrection(): Plugin {
  return new Plugin({
    appendTransaction(transactions, previous, state) {
      if (previous.doc === state.doc) return null;
      const correction = new HeaderCorrection(state);
      const visited = new Set<number>();
      for (const change of changedRanges.of(transactions)) state.doc.nodesBetween(change.start, change.end,
        (node, position) => {
          // Two ranges can reach one table; it is corrected once.
          if (node.type === state.schema.nodes.table && visited.has(position)) return false;
          visited.add(position);
          return correction.visit(node, position);
        });
      return correction.transaction;
    },
  });
}

/** Native grid edits can insert, delete or move the first row. GFM has exactly one header. */
class HeaderCorrection {
  transaction: Transaction | null = null;

  constructor(readonly state: EditorState) {}

  visit(node: Node, position: number): boolean {
    if (node.type !== this.state.schema.nodes.table) return !node.isTextblock;
    node.forEach((row, rowOffset, index) => {
      const type = index === 0 ? this.state.schema.nodes.tableHeader : this.state.schema.nodes.tableCell;
      row.forEach((cell, cellOffset) => {
        if (cell.type === type) return;
        if (!this.transaction) this.transaction = this.state.tr;
        convert(this.transaction, position + rowOffset + cellOffset + 2, type, {});
      });
    });
    return false;
  }
}
