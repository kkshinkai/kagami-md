/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Node } from 'prosemirror-model';
import type { Closing, Opening } from '../unparse/unparsed.js';
import { Sequence } from './sequence.js';

/**
 * A unit of writing: its node, its present source in three parts, and the facts its text exposes
 * to its neighbors. Nothing of the place it was written in is kept: an influence is decided from
 * exposures (private-docs/design/influences.md). Immutable. It records lengths, never a position.
 */
export class RetainedBlock {
  readonly length: number;

  constructor(
    readonly node: Node,
    readonly leading: string,
    readonly body: string,
    readonly trailing: string,
    readonly opening: Opening | null,
    readonly closing: Closing,
  ) {
    this.length = leading.length + body.length + trailing.length;
    Object.freeze(this);
  }

  get size(): number { return this.node.nodeSize; }

  /** Keep the body when only the boundary changes. */
  withFrame(leading: string, trailing: string): RetainedBlock {
    return leading === this.leading && trailing === this.trailing ? this :
      new RetainedBlock(this.node, leading, this.body, trailing, this.opening, this.closing);
  }

  /** Append just the intersecting characters. */
  appendText(from: number, to: number, parts: string[]): void {
    appendPart(this.leading, 0, from, to, parts);
    appendPart(this.body, this.leading.length, from, to, parts);
    appendPart(this.trailing, this.leading.length + this.body.length, from, to, parts);
  }
}

/** A top-level list: the blank lines it owns, and its items. */
export class RetainedList {
  readonly length: number;
  /** Its first item's. */
  readonly opening: Opening | null;
  /** Its last item's. */
  readonly closing: Closing;

  constructor(
    readonly node: Node,
    readonly leading: string,
    readonly items: Sequence<RetainedBlock>,
    readonly trailing: string,
  ) {
    this.length = leading.length + items.length + trailing.length;
    this.opening = items.get(0).opening;
    this.closing = items.get(items.count - 1).closing;
    Object.freeze(this);
  }

  get size(): number { return this.node.nodeSize; }

  withItems(items: Sequence<RetainedBlock>): RetainedList {
    return items === this.items ? this : new RetainedList(this.node, this.leading, items, this.trailing);
  }

  /** Append only intersecting framing and items. */
  appendText(from: number, to: number, parts: string[]): void {
    appendPart(this.leading, 0, from, to, parts);
    const start = this.leading.length;
    const end = start + this.items.length;
    if (from < end && to > start)
      this.items.appendText(Math.max(0, from - start), Math.min(this.items.length, to - start), parts);
    appendPart(this.trailing, end, from, to, parts);
  }
}

/**
 * The file as the document's units: the blank lines the document owns before and after them,
 * and the units in order. Reading it is concatenation; it decides nothing.
 */
export class RetainedDoc {
  readonly length: number;

  constructor(
    readonly leading: string,
    readonly units: Sequence<RetainedBlock | RetainedList>,
    readonly trailing: string,
  ) {
    this.length = leading.length + units.length + trailing.length;
    Object.freeze(this);
  }

  /** Its size in the editor: the document's content size. */
  get size(): number { return this.units.size; }

  text(): string {
    const parts = [this.leading];
    this.units.appendText(0, this.units.length, parts);
    parts.push(this.trailing);
    return parts.join('');
  }
}

function appendPart(text: string, start: number, from: number, to: number, parts: string[]): void {
  if (from < start + text.length && to > start) parts.push(text.slice(Math.max(0, from - start), to - start));
}
