/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Node } from 'prosemirror-model';
import type { RetainedBlock, RetainedList } from '../source/index.js';
import { expressesEmpty, itemPattern, numberedByIndex } from './frames.js';
import { frontMatterFence } from './markers.js';
import { schema } from '../types/schema.js';
import { blockBoundary } from './separators.js';
import type { Closing, Opening } from './unparsed.js';

/**
 * The influences that reach inside a kept unit's body (private-docs/design/influences.md), one
 * question each, answered from the units' exposures and their nodes. The sweep asks each only
 * where its trigger occurs; a unit it looks at is kept unless one of them says otherwise.
 */
export namespace influence {
  /**
   * I1. The left unit of a new pair ends in a fence left open, at the top or last in an item or a
   * footnote definition, whose continuation takes the blank lines before the pair: it must be closed.
   * A quote ends at those blank lines, so a fence in one exposes no fence.
   */
  export function openFence(left: RetainedBlock | RetainedList): boolean {
    return left.closing.leaf === 'fence';
  }

  /**
   * I2, I4. The right unit's first line stands where the left unit continues, across any blank
   * lines: it must be written again.
   *
   * @param list The list both are items of, or null when they are not items of one list.
   */
  export function continued(left: RetainedBlock | RetainedList, right: RetainedBlock | RetainedList,
    list: Node | null): boolean {
    return blockBoundary(right.node, left.closing, right.opening, list ? { sameList: true, loose: true } : null) === null;
  }

  /** I5. A kept first unit opens front matter that a written line closes. */
  export function frontMatter(first: RetainedBlock, closed: ReadonlySet<Opening.FrontMatterFence>): boolean {
    const fence = first.opening?.frontMatter;
    return !!fence && closed.has(fence);
  }

  /** I5. The front matter fences among the lines of a written body. */
  export function fences(body: string, into: Set<Opening.FrontMatterFence>): void {
    for (let start = 0; start <= body.length;) {
      const end = body.indexOf('\n', start);
      const fence = frontMatterFence(body.slice(start, end < 0 ? body.length : end));
      if (fence) into.add(fence);
      if (end < 0) break;
      start = end + 1;
    }
  }

  /**
   * I3. A kept item whose punctuation is not the one its place now gives: the list before its
   * list is open with the same punctuation, or no longer is, or the item before it changed.
   */
  export function repatterned(list: Node, item: RetainedBlock, index: number, preceding: Closing | null): boolean {
    return item.closing.openList !== itemPattern(list, index, preceding);
  }

  /** I6. An item whose marker follows its index, standing at another index than before. */
  export function renumbered(list: Node, item: Node, before: number, after: number): boolean {
    return before !== after && numberedByIndex(list, item);
  }

  /**
   * I7. The list's own spelling changed where it reaches an item: its numbering, or a tightening
   * that leaves no blank line between the item's blocks. A changed punctuation is I3's.
   */
  export function respelled(before: Node, after: Node, item: Node): boolean {
    return before.type !== after.type ||
      after.type === schema.nodes.orderedList && (before.attrs.startNumber !== after.attrs.startNumber ||
        before.attrs.spelling?.numbering !== after.attrs.spelling?.numbering) ||
      before.attrs.spelling?.tight === false && after.attrs.spelling?.tight !== false && item.childCount > 1;
  }

  /** I8. A unit written as nothing, an empty paragraph, at a place that no longer says it is empty. */
  export function emptyExposed(unit: RetainedBlock | RetainedList, parent: Node, index: number): boolean {
    return !unit.opening && !expressesEmpty(parent, index);
  }

  /**
   * I9. A fence left open at the end of the file, whose last line is empty and so needs a line
   * ending after it, where the file no longer has one.
   */
  export function fenceAtEnd(unit: RetainedBlock | RetainedList, terminated: boolean): boolean {
    return !terminated && unit.closing.leaf === 'fence' && unit.node.textContent.endsWith('\n');
  }
}
