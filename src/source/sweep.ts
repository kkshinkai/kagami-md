/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Node } from 'prosemirror-model';
import type { Mapping, Step } from 'prosemirror-transform';
import { blanks } from '../unparse/frames.js';
import { influence } from '../unparse/influences.js';
import { unparse } from '../unparse/unparse.js';
import type { DisambiguationContext, Opening } from '../unparse/unparsed.js';
import { changedRanges, type Change } from '../state/changes.js';
import { boundaryText, frameCount, lineCount } from './frame.js';
import { RetainedBlock, RetainedDoc, RetainedList } from './retained.js';
import { Sequence } from './sequence.js';
import type { FileProperties, Source } from './source.js';

type Unit = RetainedBlock | RetainedList;

/** A source's retained document after a sweep. */
interface Swept {
  readonly tree: RetainedDoc;
  /** Whether any part's text differs from the part it replaced. */
  readonly textChanged: boolean;
}

/**
 * Bring a source up to a settled edit (private-docs/design/influences.md). The units the steps
 * changed are found from their ranges and written; a unit beside them is looked at only where an
 * influence's trigger occurs, and kept unless that influence reaches it. Every other unit is
 * shared, by slicing the old sequence, without being looked at.
 */
export function sweep(source: Source, doc: Node, steps: readonly Step[], mapping: Mapping): Swept {
  return new SweepContext(source.properties, source, doc, mapping, changedRanges(steps, mapping)).document();
}

export namespace sweep {
  /** Write a document that has no file, once, unit by unit, through the same functions. */
  export function write(doc: Node, properties: FileProperties): Swept {
    return new SweepContext(properties, null, doc, null, []).document();
  }
}

/** A child of the new parent inside a run, with the old unit standing at its mapped occurrence. */
interface Entry<T extends Unit> {
  readonly node: Node;
  /** The old unit whose start maps to this child's start. Its boundary text is kept. */
  readonly old: T | null;
  /** Its index among the old units of its level, or -1. */
  readonly before: number;
  /** Whether `old` holds this very node, untouched. */
  readonly kept: boolean;
  /** For a list that is not kept, its items' level. */
  readonly items: Level<RetainedBlock> | null;
}

/** Old units `from` to `to`, replaced by the children starting at `index`. */
interface Run<T extends Unit> {
  readonly from: number;
  readonly to: number;
  readonly index: number;
  readonly entries: readonly Entry<T>[];
}

/** One level: the old units, the new parent and the runs between them. */
interface Level<T extends Unit> {
  readonly old: Sequence<T>;
  readonly parent: Node;
  readonly runs: readonly Run<T>[];
}

/** One edit's coordinates. Discarded after the sweep. */
class SweepContext {
  textChanged = false;
  /** The front matter fences among the lines written by this sweep (I5). */
  readonly fences = new Set<Opening.FrontMatterFence>();
  readonly inverse: Mapping | null;

  constructor(readonly properties: FileProperties, readonly before: Source | null, readonly doc: Node,
    readonly mapping: Mapping | null, readonly changes: readonly Change[]) {
    this.inverse = mapping && mapping.invert();
  }

  document(): Swept {
    const before = this.before;
    const old = before?.tree.units ?? Sequence.of<Unit>([]);
    const runs = before ? this.runs(old, this.doc, 0, 0, this.changes) : [this.fresh(this.doc)];
    const startChanged = !before || frameCount(before.doc, 'start') !== frameCount(this.doc, 'start');
    const endChanged = !before || frameCount(before.doc, 'end') !== frameCount(this.doc, 'end');
    let leading = before?.tree.leading ?? '';
    let trailing = before?.tree.trailing ?? '';
    if (startChanged) leading = boundaryText(leading, frameCount(this.doc, 'start'));
    if (endChanged) trailing = boundaryText(trailing, frameCount(this.doc, 'end'));
    // Influences by position and count: the file's start, the only unit, the file's end.
    const count = this.doc.childCount;
    const seeds = new Set<number>();
    if (startChanged) seeds.add(0);
    if (endChanged) seeds.add(count - 1);
    if (before && before.doc.childCount !== count && Math.min(before.doc.childCount, count) <= 2) {
      seeds.add(0);
      seeds.add(1);
    }
    const root = new RootUnits(this, trailing);
    const level = new LevelSweep({ old, parent: this.doc, runs }, root, seeds,
      startChanged, endChanged || trailing !== before?.tree.trailing);
    let units = level.sweep();
    const first = units.get(0);
    // I5: the first unit opens front matter that a later line closes. A unit new to the start of
    // the file is not known to be free of such a line, so it is never left so. Written again, a
    // thematic break takes another spelling; a text that has none is moved off the start by a
    // blank line of the document's own.
    if (!leading && first instanceof RetainedBlock && first.opening?.frontMatter &&
      (!before || first !== before.tree.units.get(0) || before.tree.leading ||
        influence.frontMatter(first, this.fences))) {
      units = root.rewriteFirst(units);
      if (units.get(0).opening?.frontMatter) leading = '\n';
    }
    if (leading && !leading.endsWith('\n') && firstBody(units.get(0)))
      leading = '\n'.repeat(frameCount(this.doc, 'start'));
    if (leading !== before?.tree.leading || trailing !== before?.tree.trailing) this.textChanged = true;
    const tree = before && units === before.tree.units && leading === before.tree.leading &&
      trailing === before.tree.trailing ? before.tree : new RetainedDoc(leading, units, trailing);
    return { tree, textChanged: this.textChanged };
  }

  /**
   * The runs at one level, in order. Each change is widened to whole units on both sides; where
   * a new child reaches past the old units' mapped end, or another change begins before the run
   * ends, the run takes it in. Outside the runs, old and new units correspond one to one.
   *
   * @param oldBase Where the level's content starts in the document before the edit.
   * @param newBase Where it starts after.
   */
  runs<T extends Unit>(old: Sequence<T>, parent: Node, oldBase: number, newBase: number,
    changes: readonly Change[]): Run<T>[] {
    const runs: Run<T>[] = [];
    let shift = 0;
    for (let c = 0; c < changes.length;) {
      const change = changes[c++]!;
      let to = change.to - oldBase;
      let end = change.end - newBase;
      const first = unitAt(old, change.from - oldBase);
      let last = unitAfter(old, to);
      const index = first.index + shift;
      const start = change.start - newBase - (change.from - oldBase - first.position);
      let next = index;
      let position = start;
      for (;;) {
        // Past the last change taken in, old and new positions differ by a constant, up to the
        // next change: one that begins before the run ends on either side is taken in first.
        const following = changes[c];
        if (following && (following.from - oldBase < last.position || following.start - newBase < position ||
          last.index === old.count)) {
          to = Math.max(to, following.to - oldBase);
          end = Math.max(end, following.end - newBase);
          c++;
        } else if (last.index === old.count) {
          // Nothing old follows the run, so nothing new does either.
          while (next < parent.childCount) position += parent.child(next++).nodeSize;
          break;
        } else {
          const newEnd = end + last.position - to;
          while (position < newEnd) position += parent.child(next++).nodeSize;
          if (position === newEnd) break;
          to = last.position + position - newEnd;
          end = position;
        }
        last = unitAfter(old, to);
      }
      const entries: Entry<T>[] = [];
      let k = first.index;
      let at = first.position;
      for (let i = index, offset = start; i < next; i++) {
        const node = parent.child(i);
        while (k < last.index && this.mapping!.map(oldBase + at, 1) < newBase + offset) at += old.get(k++).size;
        const found = k < last.index && this.mapping!.map(oldBase + at, 1) === newBase + offset;
        entries.push(this.entry(node, found ? old.get(k) : null, found ? k : -1, oldBase + at, newBase + offset));
        offset += node.nodeSize;
      }
      if (entries.length !== last.index - first.index) this.textChanged = true;
      runs.push({ from: first.index, to: last.index, index, entries });
      shift += entries.length - (last.index - first.index);
    }
    return runs;
  }

  private entry<T extends Unit>(node: Node, old: T | null, before: number, oldPosition: number,
    position: number): Entry<T> {
    const kept = old !== null && old.node === node && this.survives(oldPosition, old.size, position, node.nodeSize);
    if (kept || !node.type.isInGroup('list')) return { node, old, before, kept, items: null };
    if (old instanceof RetainedList && this.survives(oldPosition, old.size, position, node.nodeSize) &&
      this.inside(oldPosition, old.size, position, node.nodeSize)) {
      const inner = this.changes.filter(change => change.from < oldPosition + old.size && change.to > oldPosition);
      return { node, old, before, kept, items: { old: old.items, parent: node,
        runs: this.runs(old.items, node, oldPosition + 1, position + 1, inner) } };
    }
    // The list's shell changed: its items are matched one by one, each with the old item at its
    // mapped occurrence, wherever that stood.
    const entries: Entry<RetainedBlock>[] = [];
    node.forEach((child, offset) => entries.push(this.item(node, child, position + 1 + offset)));
    return { node, old, before, kept, items: { old: Sequence.of([]), parent: node,
      runs: [{ from: 0, to: 0, index: 0, entries }] } };
  }

  /** The old item at a new item's mapped occurrence. Under another spelling of its list it is written again (I7). */
  private item(list: Node, node: Node, position: number): Entry<RetainedBlock> {
    const units = this.before!.tree.units;
    const at = this.inverse!.map(position, 1);
    const root = at < units.size ? units.atEditor(at) : null;
    const inner = root ? at - root.editor - 1 : -1;
    if (!(root?.unit instanceof RetainedList) || inner < 0 || inner >= root.unit.items.size)
      return { node, old: null, before: -1, kept: false, items: null };
    const found = root.unit.items.atEditor(inner);
    const oldPosition = root.editor + 1 + found.editor;
    const kept = found.unit.node === node && this.survives(oldPosition, node.nodeSize, position, node.nodeSize) &&
      !influence.respelled(root.unit.node, list, node);
    return { node, old: oldPosition === at ? found.unit : null, before: found.index, kept, items: null };
  }

  /** A document without a file: one run of new children. */
  private fresh(parent: Node): Run<Unit> {
    const entries: Entry<Unit>[] = [];
    parent.forEach(node => entries.push({ node, old: null, before: -1, kept: false, items: node.type.isInGroup('list')
      ? { old: Sequence.of([]), parent: node, runs: [this.fresh(node) as Run<RetainedBlock>] } : null }));
    return { from: 0, to: 0, index: 0, entries };
  }

  /** Whether an old node's range maps exactly onto a new one, neither edge deleted. */
  private survives(oldPosition: number, oldSize: number, position: number, size: number): boolean {
    const start = this.mapping!.mapResult(oldPosition, 1);
    const end = this.mapping!.mapResult(oldPosition + oldSize, -1);
    return !start.deleted && !end.deleted && start.pos === position && end.pos === position + size;
  }

  /** Whether every change that reaches a list lies inside its items, on both sides of the edit. */
  private inside(oldPosition: number, oldSize: number, position: number, size: number): boolean {
    return this.changes.every(change => change.to <= oldPosition || change.from >= oldPosition + oldSize ||
      change.from > oldPosition && change.to < oldPosition + oldSize &&
        change.start > position && change.end < position + size);
  }

  write(node: Node, old: RetainedBlock | null, context: DisambiguationContext): RetainedBlock {
    const written = unparse(node, context);
    if (old?.body !== written.body) {
      this.textChanged = true;
      influence.fences(written.body, this.fences);
    }
    return new RetainedBlock(node, old?.leading ?? '', written.body, old?.trailing ?? '', written.opening,
      written.closing);
  }

  frame(block: RetainedBlock, leading: string, trailing: string): RetainedBlock {
    const framed = block.withFrame(leading, trailing);
    if (framed !== block) this.textChanged = true;
    return framed;
  }

  frameList(list: RetainedList, leading: string, items: Sequence<RetainedBlock>, trailing: string): RetainedList {
    if (leading === list.leading && items === list.items && trailing === list.trailing) return list;
    if (leading !== list.leading || trailing !== list.trailing) this.textChanged = true;
    return new RetainedList(list.node, leading, items, trailing);
  }
}

/** What a level's units need from the sweep. */
interface Units<T extends Unit> {
  /**
   * The unit at `index` as it now stands: kept, written, or rebuilt.
   *
   * @param edge Whether what follows the unit may have changed.
   */
  examine(index: number, entry: Entry<T>, left: T | null, edge: boolean): T;
  /** I1: the unit at `index`, written again because a unit now follows it. */
  close(index: number, unit: T, left: T | null): T;
  /** Two neighbors with the blank lines between them written. */
  between(left: T, right: T): [T, T];
  /** The first unit, with nothing before it in its level. */
  first(unit: T): T;
  /** The last unit, with nothing after it in its level. */
  last(unit: T): T;
}

/**
 * One level's units in order: a run's children are examined, and so is the unit before each
 * run, any seeded unit, and the unit after any unit that was written. A unit examined whose
 * inputs did not change is kept, and the units after it are not examined. Every other stretch is
 * sliced from the old sequence whole. A boundary is written again only where a unit beside it was
 * written or is new to that place.
 */
class LevelSweep<T extends Unit> {
  private out = Sequence.of<T>([]);
  /** The last unit placed, kept out of `out` while the boundary after it may change. */
  private held: T | null = null;
  /** Whether the boundary after the last unit placed must be written again. */
  private open = false;
  private changed = false;

  constructor(readonly level: Level<T>, readonly units: Units<T>, readonly seeds: ReadonlySet<number>,
    readonly startChanged: boolean, readonly endChanged: boolean) {}

  sweep(): Sequence<T> {
    const { old, parent, runs } = this.level;
    let shift = 0;
    let look = false;
    let index = 0;
    for (let r = 0; r <= runs.length; r++) {
      const run = runs[r];
      const stop = run ? run.index : parent.childCount;
      while (index < stop) {
        const edge = this.seeds.has(index) || !!run && index === stop - 1;
        if (look || edge) {
          const before = index - shift;
          const unit = old.get(before);
          look = this.examine(index++, { node: unit.node, old: unit, before, kept: true, items: null }, false, edge);
        } else {
          const end = this.nextSeed(index, run ? stop - 1 : stop);
          this.stretch(index - shift, end - shift);
          index = end;
        }
      }
      if (!run) break;
      this.changed = true;
      for (const entry of run.entries) look = this.examine(index++, entry, true, true);
      // Units removed with nothing in their place: the unit after them has a new left neighbor.
      if (!run.entries.length) look = this.open = true;
      shift += run.entries.length - (run.to - run.from);
    }
    const last = this.held ?? (this.open || this.endChanged ? this.takeBack() : null);
    if (last) this.append(this.open || this.endChanged ? this.reframed(last, this.units.last(last)) : last);
    return this.changed ? this.out : old;
  }

  private examine(index: number, entry: Entry<T>, inRun: boolean, edge: boolean): boolean {
    let left = this.held ?? (this.out.count ? this.out.get(this.out.count - 1) : null);
    // I1: a unit new after a fence left open closes it.
    if (left && !entry.kept && influence.openFence(left)) left = this.replaceLeft(index - 1, left);
    const value = this.units.examine(index, entry, left, edge);
    const written = value !== entry.old;
    if (written) this.changed = true;
    this.put(value, inRun || written);
    return written;
  }

  /** The last placed unit, written again where it stands. */
  private replaceLeft(index: number, left: T): T {
    if (!this.held) this.takeBack();
    else this.held = null;
    const before = this.held ?? (this.out.count ? this.out.get(this.out.count - 1) : null);
    const closed = this.units.close(index, left, before);
    this.changed = true;
    this.held = closed;
    this.open = true;
    return closed;
  }

  /** Place a unit after the last, writing the boundary between them where either side asks. */
  private put(value: T, touched: boolean): void {
    const left = this.held ?? (this.out.count && (touched || this.open) ? this.takeBack() : null);
    if (left) {
      if (touched || this.open) {
        const [framedLeft, framedRight] = this.units.between(left, value);
        value = this.reframed(value, framedRight);
        this.append(this.reframed(left, framedLeft));
      } else this.append(left);
    } else if (!this.out.count && (touched || this.open || this.startChanged))
      value = this.reframed(value, this.units.first(value));
    this.held = value;
    this.open = touched;
  }

  private reframed(unit: T, framed: T): T {
    if (framed !== unit) this.changed = true;
    return framed;
  }

  /** Old units `from` to `to`, untouched and unexamined: shared whole, but for a first that a boundary needs. */
  private stretch(from: number, to: number): void {
    const old = this.level.old;
    if (from < to && (this.open || !this.held && !this.out.count && this.startChanged))
      this.put(old.get(from++), false);
    if (from >= to) return;
    if (this.held) this.append(this.held);
    this.held = null;
    this.out = this.out.append(old.slice(from, to));
  }

  /** The last placed unit, taken back to write the boundary after it. */
  private takeBack(): T {
    const count = this.out.count;
    const unit = this.out.get(count - 1);
    this.out = this.out.slice(0, count - 1);
    return unit;
  }

  private append(unit: T): void {
    this.out = this.out.append(Sequence.of([unit]));
  }

  private nextSeed(from: number, to: number): number {
    for (const seed of this.seeds) if (seed >= from && seed < to) to = seed;
    return to;
  }
}

/** The top-level units, framed by the document's own blank lines. */
class RootUnits implements Units<Unit> {
  constructor(readonly sweep: SweepContext, readonly trailing: string) {}

  examine(index: number, entry: Entry<Unit>, left: Unit | null, edge: boolean): Unit {
    if (entry.node.type.isInGroup('list')) return this.list(index, entry, left, edge);
    const old = entry.old instanceof RetainedBlock ? entry.old : null;
    if (entry.kept && !this.reached(index, old!, left)) return old!;
    return this.sweep.write(entry.node, old, this.place(index, left));
  }

  close(index: number, unit: Unit, left: Unit | null): Unit {
    return this.sweep.write(unit.node, unit as RetainedBlock, this.place(index, left));
  }

  /** I5: the first unit, a thematic break, written again at the start of the file. */
  rewriteFirst(units: Sequence<Unit>): Sequence<Unit> {
    const first = units.get(0) as RetainedBlock;
    const written = this.first(this.sweep.write(first.node, first, this.place(0, null)));
    if (units.count === 1) return Sequence.of([this.last(written)]);
    const [left, right] = this.between(written, units.get(1));
    return units.replace(0, 2, Sequence.of([left, right]));
  }

  /** Whether an influence whose trigger occurs here reaches a kept unit: I2, I4, I8, I9. */
  private reached(index: number, unit: RetainedBlock, left: Unit | null): boolean {
    const doc = this.sweep.doc;
    return !!left && influence.continued(left, unit, null) || influence.emptyExposed(unit, doc, index) ||
      index === doc.childCount - 1 && influence.fenceAtEnd(unit, this.terminated(index));
  }

  /** Where a top-level unit is written. */
  private place(index: number, left: Unit | null): DisambiguationContext {
    const doc = this.sweep.doc;
    return {
      column: 0, laterColumn: 0, preceding: left?.closing ?? null,
      followed: index + 1 < doc.childCount, terminated: this.terminated(index),
      parent: doc, index, loose: true,
    };
  }

  /** Whether a line ending follows the unit's last line in the file. */
  private terminated(index: number): boolean {
    const doc = this.sweep.doc;
    return index + 1 < doc.childCount || blanks(doc, 'end') > 0 || this.sweep.properties.endsWithLineEnding;
  }

  /**
   * A list's items: its runs, its first item, its last when what follows the list may have
   * changed, and any item an influence reaches.
   */
  private list(index: number, entry: Entry<Unit>, left: Unit | null, edge: boolean): Unit {
    const old = entry.old instanceof RetainedList ? entry.old : null;
    const level = entry.items ?? { old: old!.items, parent: entry.node, runs: [] };
    const seeds = new Set([0]);
    if (edge) seeds.add(entry.node.childCount - 1);
    const items = new LevelSweep(level, new ItemUnits(this.sweep, index, entry.node, left), seeds, false, false)
      .sweep();
    if (entry.kept && items === old!.items) return old!;
    return new RetainedList(entry.node, old?.leading ?? '', items, old?.trailing ?? '');
  }

  between(left: Unit, right: Unit): [Unit, Unit] {
    const count = unparse.separator(left, right, null);
    const before = Math.min(blanks(right.node, 'leadingBlankLines'), count);
    return [this.end(left, count - before, true), this.start(right, before)];
  }

  first(unit: Unit): Unit { return this.start(unit, 0); }
  last(unit: Unit): Unit { return this.end(unit, 0, false); }

  private start(unit: Unit, lines: number): Unit {
    if (unit instanceof RetainedBlock) return this.sweep.frame(unit, boundaryText(unit.leading, lines), unit.trailing);
    return this.sweep.frameList(unit, boundaryText(unit.leading, lines + blanks(unit.node, 'start')), unit.items,
      unit.trailing);
  }

  /** A unit's end: the blank lines it owns after its last line, and that line's ending. */
  private end(unit: Unit, lines: number, followed: boolean): Unit {
    const properties = this.sweep.properties;
    if (unit instanceof RetainedBlock) {
      const ending = unit.body.length > 0 &&
        (followed || lines > 0 || this.trailing.length > 0 || properties.endsWithLineEnding);
      return this.sweep.frame(unit, unit.leading, boundaryText(unit.trailing, lines + Number(ending)));
    }
    const trailing = boundaryText(unit.trailing, lines + blanks(unit.node, 'end'));
    const ending = followed || trailing.length > 0 || this.trailing.length > 0 || properties.endsWithLineEnding;
    const last = unit.items.get(unit.items.count - 1);
    const lastLines = Math.max(0, lineCount(last.trailing) - 1) + Number(ending && last.body.length > 0);
    const framed = this.sweep.frame(last, last.leading, boundaryText(last.trailing, lastLines));
    const items = framed === last ? unit.items
      : unit.items.replace(unit.items.count - 1, unit.items.count, Sequence.of([framed]));
    return this.sweep.frameList(unit, unit.leading, items, trailing);
  }
}

/** The items of one top-level list. Its own blank lines are the root level's. */
class ItemUnits implements Units<RetainedBlock> {
  constructor(readonly sweep: SweepContext, readonly element: number, readonly list: Node,
    readonly left: Unit | null) {}

  examine(index: number, entry: Entry<RetainedBlock>, left: RetainedBlock | null): RetainedBlock {
    if (entry.kept && !this.reached(index, entry, left)) return entry.old!;
    return this.sweep.write(entry.node, entry.old, this.place(index, left));
  }

  close(index: number, unit: RetainedBlock, left: RetainedBlock | null): RetainedBlock {
    return this.sweep.write(unit.node, unit, this.place(index, left));
  }

  /** Whether an influence whose trigger occurs here reaches a kept item: I2, I3, I6, I9. */
  private reached(index: number, entry: Entry<RetainedBlock>, left: RetainedBlock | null): boolean {
    const unit = entry.old!;
    const neighbor = left ?? this.left;
    return !!neighbor && influence.continued(neighbor, unit, left ? this.list : null) ||
      influence.repatterned(this.list, unit, index, neighbor?.closing ?? null) ||
      influence.renumbered(this.list, entry.node, entry.before, index) ||
      index === this.list.childCount - 1 && this.element === this.sweep.doc.childCount - 1 &&
        influence.fenceAtEnd(unit, this.terminated(index));
  }

  /** Where an item of the list is written. */
  private place(index: number, left: RetainedBlock | null): DisambiguationContext {
    const followed = index + 1 < this.list.childCount || this.element + 1 < this.sweep.doc.childCount;
    return {
      column: 0, laterColumn: 0, preceding: (left ?? this.left)?.closing ?? null,
      followed, terminated: followed || this.terminated(index),
      parent: this.list, index, loose: this.list.attrs.spelling?.tight === false,
    };
  }

  /** Whether a line ending follows the item's last line in the file. */
  private terminated(index: number): boolean {
    const { doc, properties } = this.sweep;
    return index + 1 < this.list.childCount || this.element + 1 < doc.childCount || blanks(this.list, 'end') > 0 ||
      blanks(doc, 'end') > 0 || properties.endsWithLineEnding;
  }

  between(left: RetainedBlock, right: RetainedBlock): [RetainedBlock, RetainedBlock] {
    const count = unparse.separator(left, right, this.list);
    const before = Math.min(blanks(right.node, 'leadingBlankLines'), count);
    return [
      this.sweep.frame(left, left.leading, boundaryText(left.trailing, count - before + Number(left.body.length > 0))),
      this.sweep.frame(right, boundaryText(right.leading, before), right.trailing),
    ];
  }

  first(unit: RetainedBlock): RetainedBlock {
    return this.sweep.frame(unit, boundaryText(unit.leading, 0), unit.trailing);
  }

  /** The last item owns only its last line's ending; the blank lines after it are the list's. */
  last(unit: RetainedBlock): RetainedBlock {
    const { doc, properties } = this.sweep;
    const ending = this.element + 1 < doc.childCount || blanks(this.list, 'end') > 0 || blanks(doc, 'end') > 0 ||
      properties.endsWithLineEnding;
    return this.sweep.frame(unit, unit.leading, boundaryText(unit.trailing, Number(ending && unit.body.length > 0)));
  }
}

/** The unit holding a position, or the end: its index and start. */
function unitAt(units: Sequence<Unit>, position: number): { index: number; position: number } {
  if (position >= units.size) return { index: units.count, position: units.size };
  const found = units.atEditor(Math.max(0, position));
  return { index: found.index, position: found.editor };
}

/** The first unit boundary at or after a position: its index and position. */
function unitAfter(units: Sequence<Unit>, position: number): { index: number; position: number } {
  if (position >= units.size) return { index: units.count, position: units.size };
  if (position <= 0) return { index: 0, position: 0 };
  const found = units.atEditor(position);
  return found.editor === position ? { index: found.index, position }
    : { index: found.index + 1, position: found.editor + found.unit.size };
}

function firstBody(unit: Unit): boolean {
  return (unit instanceof RetainedBlock ? unit.body : unit.items.get(0).body).length > 0;
}
