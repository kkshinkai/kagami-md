/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Fragment, Slice, type Node, type ResolvedPos } from 'prosemirror-model';
import { ReplaceAroundStep, ReplaceStep, type StepMap, type Transform } from 'prosemirror-transform';
import { adoptContent } from './frames.js';

/** A missing record is resolved where the block stands, before it moves. */
export function defaultBlankLines(at: ResolvedPos, following = at.index()): number {
  const parent = at.parent;
  if (parent.type.isInGroup('list')) return neighborBlankLines(parent, at.index(), following);
  if (parent.type !== at.doc.type.schema.nodes.listItem) return 1;
  return Number(at.depth > 1 && at.node(at.depth - 1).attrs.spelling?.tight === false);
}

/** Inherit the sum at a neighboring item boundary, not one item's front. */
export function neighborBlankLines(list: Node, index: number, following = index): number {
  let before = following;
  let after = following + 1;
  if (index > 1) {
    before = index - 2;
    after = index - 1;
  } else if (index === 1) {
    before = 0;
    after = following;
  }
  const left = list.maybeChild(before);
  const right = list.maybeChild(after);
  if (left && right) {
    const leading = right.attrs.spelling?.leadingBlankLines;
    const trailing = left.attrs.spelling?.trailingBlankLines;
    if (leading !== undefined || trailing !== undefined) return (leading ?? 0) + (trailing ?? 0);
  }
  return Number(list.attrs.spelling?.tight === false);
}

/** A new carrier takes the outer boundaries of the content it wraps. */
export function carrier(node: Node, content: Fragment, first: ResolvedPos): Node {
  const spelling = {
    ...node.attrs.spelling,
    leadingBlankLines: first.nodeAfter?.attrs.spelling?.leadingBlankLines,
    trailingBlankLines: content.lastChild?.attrs.spelling?.trailingBlankLines,
    ...(node.attrs.spelling?.start === undefined ? {} : { start: 0 }),
  };
  if (spelling.leadingBlankLines === undefined) delete spelling.leadingBlankLines;
  if (spelling.trailingBlankLines === undefined) delete spelling.trailingBlankLines;
  return node.type.create({ ...node.attrs, spelling }, content, node.marks);
}

/** Give each native replacement frame the boundaries of the content it carries. */
export function applyFrames(tr: Transform, plan: Transform, imported = false,
  moved: ReadonlySet<Node> = new Set()): void {
  for (const step of plan.steps) {
    if (!(step instanceof ReplaceStep || step instanceof ReplaceAroundStep))
      throw new RangeError('A structural frame must be made by a native replacement');
    const context = new FrameContext(tr.doc, step, imported, moved);
    const slice = new Slice(context.build(step.slice.content, 0), step.slice.openStart, step.slice.openEnd);
    tr.step(step instanceof ReplaceAroundStep
      ? new ReplaceAroundStep(step.from, step.to, step.gapFrom, step.gapTo, slice, step.insert, !imported)
      : new ReplaceStep(step.from, step.to, slice, !imported));
  }
}

type Boundary = 'leadingBlankLines' | 'trailingBlankLines';

/** The source document and native map shared while constructing a replacement slice. */
class FrameContext {
  readonly after: Node;
  readonly inverse: StepMap;

  constructor(readonly before: Node, readonly step: ReplaceStep | ReplaceAroundStep,
              readonly imported: boolean, readonly moved: ReadonlySet<Node>) {
    const result = step.apply(before);
    if (!result.doc) throw new RangeError('Cannot construct these structural frames');
    this.after = result.doc;
    this.inverse = step.getMap().invert();
  }

  retained(node: Node, position: number, side: Boundary): number | undefined {
    if (node.isInline) return undefined;
    const opening = side === 'leadingBlankLines';
    const direction = opening ? 1 : -1;
    const edge = position + (opening ? 0 : node.nodeSize);
    const outside = this.inverse.mapResult(edge, direction);
    const inside = this.inverse.mapResult(edge + direction, -direction);
    if (!outside.deleted && !inside.deleted && inside.pos === outside.pos + direction) {
      const original = opening ? this.before.nodeAt(outside.pos) : this.before.resolve(outside.pos).nodeBefore;
      if (original?.type === node.type) return original.attrs.spelling?.[side];
    }
    if (node.isTextblock) return undefined;
    const child = opening ? node.firstChild : node.lastChild;
    return child
      ? this.retained(child, opening ? position + 1 : position + node.nodeSize - child.nodeSize - 1, side) : undefined;
  }

  node(node: Node, relative: number): Node {
    const { step, imported } = this;
    let position = step.from + relative - step.slice.openStart;
    if (step instanceof ReplaceAroundStep && relative >= step.slice.openStart + step.insert)
      position += step.gapTo - step.gapFrom;
    const content = this.build(node.content, relative + 1);
    // Frames open to the left continue an existing node. Every opening
    // token inside the inserted slice creates a frame with its own boundaries.
    if (position < step.from || this.moved.has(node) || !('spelling' in node.attrs) ||
        imported && !node.type.isInGroup('block') && node.type !== node.type.schema.nodes.listItem)
      return node.copy(content);
    const actual = this.after.nodeAt(position);
    if (!actual) throw new RangeError('The structural frame has no resulting node');
    const { firstChild: first, lastChild: last } = actual;
    const leading = first && !actual.isTextblock ? this.retained(first, position + 1, 'leadingBlankLines') : undefined;
    const trailing = last && !actual.isTextblock
      ? this.retained(last, position + actual.nodeSize - last.nodeSize - 1, 'trailingBlankLines') : undefined;
    const spelling = {
      ...node.attrs.spelling,
      leadingBlankLines: imported ? node.attrs.spelling?.leadingBlankLines : leading,
      trailingBlankLines: imported ? node.attrs.spelling?.trailingBlankLines : trailing,
      ...(!imported && node.attrs.spelling?.start !== undefined ? { start: 0 } : {}),
    };
    // Native DOM nodes have no recorded boundaries. Absence must survive step JSON;
    // an own property with value undefined does not.
    if (spelling.leadingBlankLines === undefined) delete spelling.leadingBlankLines;
    if (spelling.trailingBlankLines === undefined) delete spelling.trailingBlankLines;
    return node.type.create({ ...node.attrs, spelling }, content, node.marks);
  }

  build(content: Fragment, offset: number): Fragment {
    const nodes: Node[] = [];
    content.forEach((node, relative) => nodes.push(this.node(node, offset + relative)));
    const result = Fragment.fromArray(nodes);
    const position = this.step.from + offset - this.step.slice.openStart;
    const end = position + content.size;
    if (!this.imported || !nodes.length || position < this.step.from || end > this.after.content.size) return result;
    const from = this.after.resolve(position);
    const to = this.after.resolve(end);
    return from.sameParent(to) && !from.textOffset && !to.textOffset ? adoptContent(result, from, to) : result;
  }
}
