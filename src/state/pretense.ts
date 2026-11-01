/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { pendingMarks } from '../types/schema.js';
import { repairPhrasing, type TextRepair } from '../syntax/index.js';
import type { Node } from 'prosemirror-model';
import type { Transaction } from 'prosemirror-state';
import { fieldSource } from '../parse/field.js';
import { phrasing, type correction } from './correction.js';

/** Put pretense repairs into the text when an edited writing unit exposes imported lazy lines. */
export function pretense(tr: Transaction, fields: correction.Fields): void {
  const context = new RepairContext(fields.updates);
  for (const position of fields.paragraphs(tr)) context.paragraph(tr.doc.nodeAt(position)!, position);
  for (const repair of context.repairs.sort((a, b) => b.start - a.start))
    tr.insertText(repair.insert, repair.start, repair.end);
}

/** Repairs share the fields already read by corrections in this transaction batch. */
class RepairContext {
  readonly completed = new Set<Node>();
  readonly repairs: TextRepair[] = [];

  constructor(updates: readonly phrasing.Update[]) {
    for (const update of updates) for (const field of update.completed) this.completed.add(field);
  }

  paragraph(node: Node, position: number): void {
    if (this.completed.has(node)) return;
    // Pending's marked source is being authored, not an imported lazy line.
    // Saving it does not settle it or insert an escape (Pending, statement 4).
    const pending: PendingRange[] = [];
    node.forEach((child, offset) => {
      if (child.marks.some(mark => pendingMarks.has(mark.type)))
        pending.push({ from: offset, to: offset + child.nodeSize });
    });
    const repairs = repairPhrasing(fieldSource(node), 'paragraph', { escapeBlocks: true });
    for (const repair of repairs) {
      if (pending.some(range => repair.start >= range.from && repair.start < range.to)) continue;
      this.repairs.push({ start: position + 1 + repair.start, end: position + 1 + repair.end, insert: repair.insert });
    }
  }
}

/** A source interval whose reading still waits for the author to finish it. */
interface PendingRange {
  readonly from: number;
  readonly to: number;
}
