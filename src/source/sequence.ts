/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Something a sequence can measure, and whose source text it can give. */
interface Measured {
  readonly length: number;
  readonly size: number;
  appendText(from: number, to: number, parts: string[]): void;
}

const branch = 32;

/** An immutable B-tree measured by unit count, source length and editor size. */
export abstract class Sequence<T extends Measured> {
  abstract readonly count: number;
  abstract readonly length: number;
  abstract readonly size: number;

  /** The unit at an index. */
  abstract get(index: number): T;
  /** The unit holding a source offset, with its start in both coordinates. */
  atSource(offset: number): Sequence.Found<T> {
    check(offset, this.length);
    return this.find(offset, false);
  }
  /** The unit holding an editor position, with its start in both coordinates. */
  atEditor(position: number): Sequence.Found<T> {
    check(position, this.size);
    return this.find(position, true);
  }
  /** Replace a range, sharing every subtree outside the two cut paths. */
  replace(from: number, to: number, units: Sequence<T>): Sequence<T> {
    checkRange(from, to, this.count);
    if (from === to && !units.count) return this;
    const parts: Sequence<T>[] = [];
    this.decompose(0, from, parts);
    if (units.count) parts.push(units);
    this.decompose(to, this.count, parts);
    return SequenceNode.from(parts);
  }
  /** Slice by unit index, sharing whole subtrees. */
  slice(from: number, to: number): Sequence<T> {
    checkRange(from, to, this.count);
    if (!from && to === this.count) return this;
    const parts: Sequence<T>[] = [];
    this.decompose(from, to, parts);
    return SequenceNode.from(parts);
  }
  /** Join two sequences, balancing only the joining paths. */
  append(other: Sequence<T>): Sequence<T> {
    if (!this.count) return other;
    if (!other.count) return this;
    return SequenceNode.from([this, other]);
  }
  /** Append only intersecting source text, without joining it. */
  abstract appendText(from: number, to: number, parts: string[]): void;

  /** @internal */
  abstract find(position: number, editor: boolean): Sequence.Found<T>;
  /** @internal */
  abstract decompose(from: number, to: number, parts: Sequence<T>[]): void;

  static of<T extends Measured>(units: readonly T[]): Sequence<T> {
    if (units.length <= branch) return new SequenceLeaf(units.slice());
    const leaves: Sequence<T>[] = [];
    for (let i = 0; i < units.length; i += branch) leaves.push(new SequenceLeaf(units.slice(i, i + branch)));
    return SequenceNode.from(leaves);
  }
}

export namespace Sequence {
  export interface Found<T> {
    readonly index: number;
    readonly unit: T;
    readonly source: number;
    readonly editor: number;
  }
}

/** A bounded array of units. */
class SequenceLeaf<T extends Measured> extends Sequence<T> {
  readonly length: number;
  readonly size: number;

  constructor(readonly units: readonly T[]) {
    super();
    Object.freeze(units);
    let length = 0;
    let size = 0;
    for (const unit of units) {
      length += unit.length;
      size += unit.size;
    }
    this.length = length;
    this.size = size;
  }
  get count(): number { return this.units.length; }
  get(index: number): T {
    check(index, this.count - 1);
    return this.units[index]!;
  }
  find(position: number, editor: boolean): Sequence.Found<T> {
    if (!this.count) throw new RangeError('An empty sequence has no unit');
    let source = 0;
    let offset = 0;
    for (let index = 0; index < this.count; index++) {
      const unit = this.units[index]!;
      if (position < (editor ? offset + unit.size : source + unit.length) || index === this.count - 1)
        return { index, unit, source, editor: offset };
      source += unit.length;
      offset += unit.size;
    }
    throw new RangeError('Outside sequence');
  }
  decompose(from: number, to: number, parts: Sequence<T>[]): void {
    if (from >= to) return;
    parts.push(from === 0 && to === this.count ? this : new SequenceLeaf(this.units.slice(from, to)));
  }
  appendText(from: number, to: number, parts: string[]): void {
    checkRange(from, to, this.length);
    let offset = 0;
    for (const unit of this.units) {
      const end = offset + unit.length;
      if (from < end && to > offset)
        unit.appendText(Math.max(0, from - offset), Math.min(unit.length, to - offset), parts);
      offset = end;
      if (offset >= to) break;
    }
  }
}

/** Branches carry the sums of their bounded children, as CodeMirror's Text does. */
class SequenceNode<T extends Measured> extends Sequence<T> {
  readonly count: number;
  readonly length: number;
  readonly size: number;

  constructor(readonly children: readonly Sequence<T>[]) {
    super();
    Object.freeze(children);
    let count = 0;
    let length = 0;
    let size = 0;
    for (const child of children) {
      count += child.count;
      length += child.length;
      size += child.size;
    }
    this.count = count;
    this.length = length;
    this.size = size;
  }
  get(index: number): T {
    check(index, this.count - 1);
    for (const child of this.children) {
      if (index < child.count) return child.get(index);
      index -= child.count;
    }
    throw new RangeError('Outside sequence');
  }
  find(position: number, editor: boolean): Sequence.Found<T> {
    let index = 0;
    let source = 0;
    let offset = 0;
    for (let i = 0; i < this.children.length; i++) {
      const child = this.children[i]!;
      const end = editor ? offset + child.size : source + child.length;
      if (position < end || i === this.children.length - 1) {
        const found = child.find(position - (editor ? offset : source), editor);
        return { index: index + found.index, unit: found.unit,
          source: source + found.source, editor: offset + found.editor };
      }
      index += child.count;
      source += child.length;
      offset += child.size;
    }
    throw new RangeError('Outside sequence');
  }
  decompose(from: number, to: number, parts: Sequence<T>[]): void {
    if (from >= to) return;
    if (!from && to === this.count) {
      parts.push(this);
      return;
    }
    let offset = 0;
    for (const child of this.children) {
      const end = offset + child.count;
      if (from < end && to > offset)
        child.decompose(Math.max(0, from - offset), Math.min(child.count, to - offset), parts);
      offset = end;
      if (offset >= to) break;
    }
  }
  appendText(from: number, to: number, parts: string[]): void {
    checkRange(from, to, this.length);
    let offset = 0;
    for (const child of this.children) {
      const end = offset + child.length;
      if (from < end && to > offset)
        child.appendText(Math.max(0, from - offset), Math.min(child.length, to - offset), parts);
      offset = end;
      if (offset >= to) break;
    }
  }
  static from<T extends Measured>(children: readonly Sequence<T>[]): Sequence<T> {
    if (children.length === 1) return children[0]!;
    let count = 0;
    for (const child of children) count += child.count;
    if (count <= branch) {
      const units: T[] = [];
      for (const child of children) for (let i = 0; i < child.count; i++) units.push(child.get(i));
      return new SequenceLeaf(units);
    }
    const builder = new BranchBuilder<T>(Math.max(branch, Math.floor(count / branch)));
    for (const child of children) builder.add(child);
    builder.flush();
    return builder.children.length === 1 ? builder.children[0]! : new SequenceNode(builder.children);
  }
}

/** Group subtrees by weight, opening only those too large for the next level. */
class BranchBuilder<T extends Measured> {
  readonly children: Sequence<T>[] = [];
  private pending: Sequence<T>[] = [];
  private count = 0;

  constructor(readonly target: number) {}

  add(child: Sequence<T>): void {
    if (!child.count) return;
    if (child.count > this.target * 2 && child instanceof SequenceNode) {
      for (const part of child.children) this.add(part);
    } else if (child.count > this.target / 2 && (!this.count || this.count > this.target / 2)) {
      this.flush();
      this.children.push(child);
    } else {
      if (this.count + child.count > this.target) this.flush();
      this.pending.push(child);
      this.count += child.count;
    }
  }
  flush(): void {
    if (!this.count) return;
    this.children.push(SequenceNode.from(this.pending));
    this.pending = [];
    this.count = 0;
  }
}

function check(value: number, end: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > end) throw new RangeError('Outside sequence');
}
function checkRange(from: number, to: number, end: number): void {
  check(from, end);
  check(to, end);
  if (from > to) throw new RangeError('Reversed sequence range');
}
