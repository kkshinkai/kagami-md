/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Node } from 'prosemirror-model';
import type { Transaction } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import { changedRanges } from '../state/changes.js';

/** Draw a document's top-level blocks into one persistent decoration set. */
export function decorateBlocks(doc: Node, draw: decorateBlocks.Draw): DecorationSet {
  const decorations: Decoration[] = [];
  doc.forEach((block, position) => decorations.push(...draw(block, position, DecorationSet.empty)));
  return DecorationSet.create(doc, decorations);
}

export namespace decorateBlocks {
  export interface Range {
    readonly from: number;
    readonly to: number;
  }

  /** Positions are absolute; previous decorations have already followed the transaction. */
  export type Draw = (block: Node, position: number, previous: DecorationSet) => readonly Decoration[];

  /**
   * Map the painting, then draw again the blocks the edit changed and those the feature's
   * requested ranges reach. The changed blocks are found from the edit's ranges; no other block
   * is visited.
   */
  export function update(
    value: DecorationSet,
    tr: Transaction,
    draw: Draw,
    refresh: readonly Range[] = [],
    onRemove?: (block: Node) => void,
  ): DecorationSet {
    if (!tr.docChanged && !refresh.length) return value;
    const changed = tr.docChanged ? changedRanges(tr.steps, tr.mapping) : [];
    const previous = value.map(tr.mapping, tr.doc);
    const drawn = new Map<number, Node>();
    for (const change of changed) blocksBetween(tr.doc, change.start, change.end, drawn);
    // A requested range also reaches the block that starts where it ends.
    for (const range of refresh) blocksBetween(tr.doc, range.from, Math.min(range.to + 1, tr.doc.content.size), drawn);
    if (onRemove) {
      const after = new Set(drawn.values());
      const before = new Map<number, Node>();
      for (const change of changed) blocksBetween(tr.before, change.from, change.to, before);
      for (const block of before.values()) if (!after.has(block)) onRemove(block);
    }
    const removed: Decoration[] = [];
    const added: Decoration[] = [];
    for (const [position, block] of drawn) {
      const end = position + block.nodeSize;
      for (const decoration of previous.find(position, end)) {
        if (decoration.from >= position && decoration.from < end) removed.push(decoration);
      }
      added.push(...draw(block, position, previous));
    }
    return previous.remove(removed).add(tr.doc, added);
  }
}

/** The top-level blocks a range overlaps, by their positions. */
function blocksBetween(doc: Node, from: number, to: number, into: Map<number, Node>): void {
  doc.nodesBetween(from, to, (block, position) => {
    into.set(position, block);
    return false;
  });
}
