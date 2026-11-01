/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { bindings } from '../state/bindings.js';
import { Fragment, Slice, type Node, type NodeType } from 'prosemirror-model';
import { ReplaceAroundStep, type Transform } from 'prosemirror-transform';
import { editorSpelling, editorType } from '../parse/tree.js';
import { combine, reshaped } from './classes.js';
import { adoptContent, changedSpelling, mergeAdjacent } from './frames.js';
import type { PositionMapping, Shape } from './transform.js';

interface KeptText {
  before: Shape.Range;
  after: Shape.Range;
}
interface Frames {
  front: Node | null;
  back: Node | null;
  outerFront: Node | null;
  outerBack: Node | null;
}

/** Position correspondence before and after a forest is joined into its surroundings. */
interface Reshaped {
  readonly map: PositionMapping;
  readonly locate: PositionMapping;
}

/** Build a forest and retain a native text gap, preferring the caller's interval. */
export function reshapeBlocks(tr: Transform, from: number, to: number, shapes: readonly Shape[],
                              authored?: ReadonlyMap<Shape, Node>, keep?: Shape.Range): Reshaped {
  prepareLiterals(tr, shapes);
  const original = tr.doc.slice(from, to);
  if (original.openStart || original.openEnd) throw new RangeError('Reshape requires complete sibling blocks');
  const context = new BuildContext(tr.doc, from, to, authored);
  const replacement = adoptContent(context.forest(shapes, original.content), tr.doc.resolve(from), tr.doc.resolve(to));
  const start = tr.steps.length;
  if (original.content.eq(replacement)) {
    applyReadings(tr, from, shapes, authored);
    const mapping = tr.mapping.slice(start);
    return { map: pos => mapping.map(pos), locate: pos => mapping.map(pos) };
  }
  const gap = context.kept.length === 1 ? context.kept[0] : keep && context.kept.find(range =>
    keep.from >= from + range.before.from && keep.to <= from + range.before.to);
  if (gap) tr.step(new ReplaceAroundStep(from, to, from + gap.before.from, from + gap.before.to,
    new Slice(withoutGap(replacement, gap.after), 0, 0), gap.after.from));
  else tr.replaceWith(from, to, replacement);
  applyReadings(tr, from, shapes, authored);
  const replacementMap = tr.mapping.slice(start);
  const joining = tr.steps.length;
  for (let index = context.createdLists.length - 1; index >= 0; index--)
    mergeAdjacent(tr, context.createdLists[index]!);
  const joinMap = tr.mapping.slice(joining);
  return {
    map(position) {
      const range = context.kept.find(range => position >= from + range.before.from &&
        position <= from + range.before.to);
      return joinMap.map(range ? range.after.from + position - range.before.from : replacementMap.map(position));
    },
    locate: position => joinMap.map(position),
  };
}

function prepareLiterals(tr: Transform, shapes: readonly Shape[]): void {
  const ranges = literalRanges(shapes);
  for (let index = ranges.length - 1; index >= 0; index--) {
    const range = ranges[index]!;
    const breaks: number[] = [];
    tr.doc.nodesBetween(range.from, range.to, (node, position) => {
      if (node.type === tr.doc.type.schema.nodes.lineEnding) breaks.push(position);
    });
    for (let index = breaks.length - 1; index >= 0; index--) {
      const position = breaks[index]!;
      tr.replaceWith(position, position + 1, tr.doc.type.schema.text('\n'));
    }
    tr.removeMark(range.from, range.to);
  }
}

function literalRanges(shapes: readonly Shape[]): Shape.Range[] {
  const ranges: Shape.Range[] = [];
  for (const shape of shapes) {
    switch (shape.kind) {
      case 'children':
        ranges.push(...literalRanges(shape.children));
        break;
      case 'text':
        if (shape.type.spec.code || shape.type.spec.marks === '') {
          for (const piece of shape.text) {
            switch (piece.kind) {
              case 'range':
                ranges.push(piece);
                break;
              case 'text': break;
              default: piece satisfies never;
            }
          }
        }
        break;
    }
  }
  return ranges;
}

/** One reshape's document, source interval and authored readings. */
class BuildContext {
  readonly kept: KeptText[] = [];
  readonly createdLists: number[] = [];

  constructor(readonly document: Node, readonly from: number, readonly to: number,
              readonly authored: ReadonlyMap<Shape, Node> | undefined) {}

  forest(shapes: readonly Shape[], original: Fragment): Fragment {
    const nodes: Node[] = [];
    let offset = 0;
    for (let index = 0; index < shapes.length; index++) {
      const node = this.node(shapes[index]!, offset, {
        front: index ? null : original.firstChild, back: index === shapes.length - 1 ? original.lastChild : null,
        outerFront: null, outerBack: null,
      });
      nodes.push(node);
      offset += node.nodeSize;
    }
    for (let index = 1; index < this.kept.length; index++) {
      if (this.kept[index - 1]!.before.to > this.kept[index]!.before.from)
        throw new RangeError('Kept text must occur once and in document order');
    }
    return Fragment.fromArray(nodes);
  }

  node(shape: Shape, offset: number, frames: Frames): Node {
    const { type } = shape;
    if (type.isInline) throw new RangeError('A shape must describe a block');
    const firstRange = this.kept.length;
    const position = this.from + offset;
    if (!type.isLeaf) offset++;
    let content: Fragment;
    switch (shape.kind) {
      case 'text':
        if (!type.isTextblock) throw new RangeError('Only a textblock can hold text pieces');
        content = this.text(type, shape.text, offset);
        break;
      case 'children': {
        const children: Node[] = [];
        const inner: Frames = {
          front: null,
          back: null,
          outerFront: frames.front && frames.front.type !== type ? frames.front : frames.outerFront,
          outerBack: frames.back && frames.back.type !== type ? frames.back : frames.outerBack,
        };
        for (const child of shape.children) {
          const node = this.node(child, offset, inner);
          children.push(node);
          offset += node.nodeSize;
        }
        content = Fragment.fromArray(children);
        break;
      }
    }
    const ranges = this.kept.slice(firstRange);
    const first = this.sourceNode(type, ranges[0]?.before.from);
    const last = this.sourceNode(type, ranges.at(-1)?.before.to);
    const written = this.authored?.get(shape);
    if (!first && type.isInGroup('list')) this.createdLists.push(position);
    if (shape.read && editorType(shape.read, this.document.type.schema) !== type)
      throw new RangeError('The reading must describe the shaped node');
    const spelling = written ? written.attrs.spelling : this.spelling(shape, content, frames, first, last);
    const node = type.createChecked({ ...shape.meaning, spelling }, content);
    return written?.eq(node) ? written : node;
  }

  text(type: NodeType, pieces: readonly Shape.Piece[], offset: number): Fragment {
    let result = Fragment.empty;
    for (const piece of pieces) {
      let content: Fragment;
      switch (piece.kind) {
        case 'text':
          content = writtenText(type, piece.text);
          break;
        case 'range': {
          if (piece.from < this.from || piece.to > this.to || piece.to < piece.from)
            throw new RangeError('A kept piece must be text in the replaced blocks');
          const left = this.document.resolve(piece.from);
          const right = this.document.resolve(piece.to);
          if (!left.parent.isTextblock || !left.sameParent(right))
            throw new RangeError('A kept piece must be text in the replaced blocks');
          content = this.document.slice(piece.from, piece.to).content;
          this.kept.push({
            before: { from: piece.from - this.from, to: piece.to - this.from },
            after: { from: offset, to: offset + content.size }
          });
          break;
        }
        default: return piece satisfies never;
      }
      result = result.append(content);
      offset += content.size;
    }
    return result;
  }

  sourceNode(type: NodeType, position: number | undefined): Node | null {
    if (position !== undefined) {
      const at = this.document.resolve(this.from + position);
      for (let depth = at.depth; depth > 0; depth--) if (at.node(depth).type === type) return at.node(depth);
    }
    return null;
  }

  spelling(shape: Shape, content: Fragment, frames: Frames, first: Node | null, last: Node | null): unknown {
    const { type, read } = shape;
    // When a field becomes a container, its outer boundary belongs to the new
    // container. Copying that boundary into its first/last field as well would
    // create an extra blank line inside the new block.
    const front = first && first === frames.outerFront ? combine(type, first.attrs.spelling, null, ['ordinary'])
      : (first ?? frames.front)?.attrs.spelling;
    const back = last && last === frames.outerBack ? null : (last ?? frames.back)?.attrs.spelling;
    let spelling = read && editorSpelling(read) !== undefined ? editorSpelling(read)
      : changedSpelling(type, shape.meaning, combine(type, front, back, ['front', 'ordinary']), content);
    const start = (spelling as { start?: number } | null)?.start ?? 0;
    if (frames.front) spelling = reshaped(type, frames.front.type, frames.front.attrs.spelling, spelling);
    if (read?.type === 'callout' && frames.front?.type === type.schema.nodes.blockQuote) {
      // The first paragraph became the title, outside the body. Its following
      // boundary becomes the body's start; the retained block keeps its record.
      // The body starts after the title, so both sides contribute their blank lines.
      const body = content.childCount > 1 ? content.child(1) : null;
      spelling = { ...(spelling as object), start: body && body === frames.front.maybeChild(1)
        ? (frames.front.firstChild?.attrs.spelling?.trailingBlankLines ?? 1)
          + (body.attrs.spelling?.leadingBlankLines ?? 0) : start };
    }
    if (read && spelling && typeof spelling === 'object') {
      // Reading an owner's interior says nothing about the boundaries outside
      // the replaced range. Those still belong to its first and last frames.
      const bounded: Record<string, unknown> = { ...spelling };
      for (const [name, frame] of [['leadingBlankLines', frames.front], ['trailingBlankLines', frames.back]] as const) {
        if (!frame) continue;
        if (frame.attrs.spelling?.[name] === undefined) delete bounded[name];
        else bounded[name] = frame.attrs.spelling[name];
      }
      spelling = bounded;
    }
    return spelling;
  }
}

function writtenText(type: NodeType, text: string): Fragment {
  const schema = type.schema;
  const nodes: Node[] = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index++) {
    if (index)
      nodes.push(type.contentMatch.matchType(schema.nodes.lineEnding)
        ? schema.nodes.lineEnding.create() : schema.text('\n'));
    if (lines[index]) nodes.push(schema.text(lines[index]!));
  }
  return Fragment.fromArray(nodes);
}

function withoutGap(content: Fragment, gap: Shape.Range): Fragment {
  let frame = content;
  content.forEach((node, offset, index) => {
    if (gap.from > offset && gap.to < offset + node.nodeSize) frame = frame.replaceChild(index,
      node.replace(gap.from - offset - 1, gap.to - offset - 1, Slice.empty));
  });
  return frame;
}

function applyReadings(tr: Transform, position: number, shapes: readonly Shape[], authored: ReadonlyMap<Shape,
  Node> | undefined): void {
  if (!authored) return;
  for (const shape of shapes) {
    const node = tr.doc.nodeAt(position);
    if (!node) throw new RangeError('A reshaped node is missing');
    switch (shape.kind) {
      case 'children':
        applyReadings(tr, position + 1, shape.children, authored);
        break;
      case 'text': {
        const reading = authored.get(shape);
        if (reading) applyContent(tr, position, node, reading.content);
        if (shape.references) bindings.record(tr, position, shape.references);
        break;
      }
    }
    position += node.nodeSize;
  }
}

function applyContent(tr: Transform, position: number, node: Node, content: Fragment): void {
  if (node.content.eq(content)) return;
  // Source ranges have already transported these characters. Only their node
  // representation and marks change, so native gap identity is preserved.
  content.forEach((child, offset) => {
    if (child.type === child.type.schema.nodes.lineEnding && node.nodeAt(offset)?.type !== child.type) {
      tr.replaceWith(position + offset + 1, position + offset + 2, child.mark([]));
    }
  });
  tr.removeMark(position + 1, position + node.nodeSize - 1);
  content.forEach((child, offset) => {
    for (const mark of child.marks) tr.addMark(position + offset + 1, position + offset + child.nodeSize + 1, mark);
  });
}
