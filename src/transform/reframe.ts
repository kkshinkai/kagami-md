/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Fragment, NodeRange, Slice, type Node } from 'prosemirror-model';
import { liftTarget, ReplaceAroundStep, Transform } from 'prosemirror-transform';
import { setAttributes } from './frames.js';
import { applyFrames } from './boundaries.js';

interface Frame {
  readonly node: Node;
  readonly first: number;
}

interface Block {
  readonly node: Node;
  readonly pos: number;
  readonly frames: readonly Frame[];
}

/**
 * Write a forest made of the same blocks in the same order. Native lift and
 * replace-around steps change their frames, retaining every block as a gap.
 * Both forests are restricted to the caller's sibling window.
 * @internal
 */
export function reframe(tr: Transform, from: number, to: number, content: Fragment): void {
  const before: Block[] = [];
  const after: Block[] = [];
  readBlocks(tr.doc.slice(from, to).content, from, [], before);
  readBlocks(content, from, [], after);
  if (before.length !== after.length || before.some((block, index) => block.node !== after[index]!.node))
    throw new RangeError('Reframing must retain the same block occurrences in order');
  const context = new ReframeContext(tr, tr.steps.length, tr.doc.resolve(from).depth, before);
  for (let index = 0; index < after.length; index++) context.place(after[index]!, index);
  for (let index = 0; index < after.length; index++) context.attributes(after[index]!, index);
}

function structural(node: Node): boolean {
  const types = node.type.schema.nodes;
  return node.type.isInGroup('list') || node.type === types.listItem || node.type === types.blockQuote ||
    node.type === types.callout || node.type === types.footnoteDefinition;
}

function readBlocks(content: Fragment, start: number, frames: readonly Frame[], blocks: Block[]): void {
  content.forEach((node, offset) => {
    const pos = start + offset;
    if (structural(node))
      readBlocks(node.content, pos + 1, [...frames, { node, first: blocks.length }], blocks);
    else blocks.push({ node, pos, frames });
  });
}

/** The original occurrences and native mapping shared by one forest replacement. */
class ReframeContext {
  constructor(readonly tr: Transform, readonly start: number, readonly depth: number,
              readonly before: readonly Block[]) {}

  point(index: number): number {
    const block = this.before[index]!;
    return this.tr.mapping.slice(this.start).map(block.pos + Number(!block.node.isLeaf), 1);
  }

  common(frames: readonly Frame[], index: number, subjectDepth: number): number {
    const at = this.tr.doc.resolve(this.point(index));
    let common = 0;
    for (; common < frames.length && this.depth + common + 1 < subjectDepth; common++) {
      const frame = frames[common]!;
      const depth = this.depth + common + 1;
      if (at.node(depth).type !== frame.node.type) break;
      if (frame.first < index) {
        const first = this.tr.doc.resolve(this.point(frame.first));
        if (first.before(depth) !== at.before(depth)) break;
      } else {
        let first = true;
        for (let d = depth; d < subjectDepth; d++) if (at.index(d)) first = false;
        if (!first) break;
      }
    }
    return common;
  }

  place(block: Block, index: number): void {
    const frames = [...block.frames];
    let at = this.tr.doc.resolve(this.point(index));
    let subjectDepth = at.depth + Number(block.node.isLeaf);
    if (this.common(frames, index, subjectDepth) === frames.length &&
      subjectDepth === this.depth + frames.length + 1) return;
    /** Carry a retained frame with its first block; place its later blocks separately. */
    let joined = 0;
    while (frames.length && subjectDepth > this.depth + 1) {
      const frame = frames.at(-1)!;
      const parent = at.node(subjectDepth - 1);
      const same = frame.node.type === parent.type;
      if (!same && !(frame.node.type.isInGroup('list') && parent.type.isInGroup('list'))) break;
      if (at.index(subjectDepth - 1)) {
        if (!parent.type.isInGroup('list')) break;
        applyFrames(this.tr, new Transform(this.tr.doc).split(at.before(subjectDepth), 1));
        at = this.tr.doc.resolve(this.point(index));
      }
      if (!same) {
        this.tr.setNodeMarkup(at.before(subjectDepth - 1), frame.node.type, frame.node.attrs);
        at = this.tr.doc.resolve(this.point(index));
      }
      if (frame.first < index) joined++;
      subjectDepth--;
      frames.pop();
    }
    const common = this.common(frames, index, subjectDepth);
    let base = this.depth + common;
    const subject = subjectDepth > at.depth ? at.nodeAfter! : at.node(subjectDepth);
    while (base > this.depth &&
      !at.node(base).canReplaceWith(at.node(base).childCount, at.node(base).childCount, subject.type)) base--;
    const carried = at.depth + Number(block.node.isLeaf) - subjectDepth;
    while (subjectDepth - 1 > base) {
      const from = at.before(subjectDepth);
      let to = from + (subjectDepth > at.depth ? block.node.nodeSize : at.node(subjectDepth).nodeSize);
      let range = new NodeRange(this.tr.doc.resolve(from), this.tr.doc.resolve(to), subjectDepth - 1);
      let target = liftTarget(range);
      if (target === null) {
        /** A required title or label cannot be duplicated; lift its following blocks together. */
        to = at.end(subjectDepth - 1);
        range = new NodeRange(this.tr.doc.resolve(from), this.tr.doc.resolve(to), subjectDepth - 1);
        target = liftTarget(range);
      }
      if (target === null || target < this.depth) throw new RangeError('The window cannot release this block');
      applyFrames(this.tr, new Transform(this.tr.doc).lift(range, target));
      if (target < base) base = target;
      at = this.tr.doc.resolve(this.point(index));
      subjectDepth = at.depth + Number(block.node.isLeaf) - carried;
    }
    const missing = frames.slice(base - this.depth);
    let shared = 0;
    while (shared < missing.length && missing[shared]!.first < index) shared++;
    let slice = Fragment.empty;
    for (let i = missing.length - 1; i >= 0; i--) slice = Fragment.from(missing[i]!.node.copy(slice));
    const from = at.before(subjectDepth);
    const to = from + (subjectDepth > at.depth ? block.node.nodeSize : at.node(subjectDepth).nodeSize);
    if (missing.length) applyFrames(this.tr, new Transform(this.tr.doc).step(
      new ReplaceAroundStep(from - shared, to, from, to,
        new Slice(slice, shared, 0), missing.length - shared, true)));
    if (joined) {
      const current = this.tr.doc.resolve(this.point(index));
      const subject = current.depth + Number(block.node.isLeaf) - carried;
      this.tr.join(current.before(subject), joined);
    }
  }

  attributes(block: Block, index: number): void {
    const at = this.tr.doc.resolve(this.point(index));
    for (let i = 0; i < block.frames.length; i++) {
      const frame = block.frames[i]!;
      if (frame.first !== index) continue;
      const depth = this.depth + i + 1;
      setAttributes(this.tr, at.before(depth), frame.node.attrs);
    }
  }
}
