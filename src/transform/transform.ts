/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { BlockSyntax, Syntax, ReferenceLabels } from '../syntax/index.js';
import { Fragment, NodeRange, Slice, type Attrs, type Node, type NodeType, type ResolvedPos } from 'prosemirror-model';
import { canSplit, findWrapping, liftTarget, ReplaceAroundStep, ReplaceStep, Transform } from 'prosemirror-transform';
import { inferYAMLScalar } from '../parse/scalar.js';
import { editorSpelling, editorType } from '../parse/tree.js';
import { applyFrames, carrier, defaultBlankLines } from './boundaries.js';
import { combine } from './classes.js';
import {
  adoptContent, changedSpelling, itemSpelling, joinAt, keepListNumbers, mergeAdjacent, movedItem,
  setAttributes
} from './frames.js';
import { realizeParagraph } from './realize.js';
import { removeAcrossFields } from './remove.js';
import { reshapeBlocks } from './reshape.js';

export { carrier };

/**
 * A block a command wants, made of text the document has: what `reshape` builds. Where it is
 * made from text the user typed, `read` is what a reader gave for that text, and the block takes
 * its spelling: `[!IMPORTANT]` typed before a tab keeps the tab. A block holds
 * blocks, or, if it is a textblock, a run of text, each piece of which is a range of the
 * document's text, or a string written in. Native steps determine how positions and history
 * follow the replacement.
 */
export type Shape = Shape.Children | Shape.Text;
export namespace Shape {
  /** A block containing other blocks. */
  export interface Children {
    readonly kind: 'children';
    readonly type: NodeType;
    readonly meaning: Attrs;
    readonly read?: Syntax;
    readonly children: readonly Shape[];
  }
  /** A textblock assembled from authored ranges and inserted text. */
  export interface Text {
    readonly kind: 'text';
    readonly type: NodeType;
    readonly references?: ReferenceLabels;
    readonly meaning: Attrs;
    readonly read?: Syntax;
    readonly text: readonly Piece[];
  }
  /** A retained interval of the document's text. */
  export interface Range {
    readonly from: number;
    readonly to: number;
  }
  /** One authored interval or inserted string in a textblock. */
  export type Piece = Piece.Range | Piece.Text;
  export namespace Piece {
    export interface Range extends Shape.Range {
      readonly kind: 'range';
    }
    export interface Text {
      readonly kind: 'text';
      readonly text: string;
    }
  }
}

/** Translate a retained text position through a structural change. */
export type PositionMapping = (position: number) => number;

/**
 * Split the blocks at a position: the innermost `depth` of them. The block before keeps its
 * front spelling; the block after takes its neighbor's front, as List guardianship says, and
 * the back spelling goes with the end. `9. a|b` gives `9. a` and `10. b`.
 */
export function split(tr: Transform, pos: number, depth: number): void {
  if (!Number.isInteger(depth) || depth < 1 || !canSplit(tr.doc, pos, depth))
    throw new RangeError('Cannot split these blocks');
  new SplitContext(tr, pos, depth).apply();
}

interface SplitFrame {
  position: number;
  node: Node;
  right: Attrs;
}

/** The original ancestry and native map shared by the two halves of a split. */
class SplitContext {
  readonly at: ResolvedPos;
  readonly start: number;
  readonly frames: SplitFrame[] = [];

  constructor(readonly tr: Transform, readonly pos: number, readonly depth: number) {
    this.at = tr.doc.resolve(pos);
    this.start = tr.steps.length;
    for (let level = this.at.depth - depth + 1; level <= this.at.depth; level++) {
      const node = this.at.node(level);
      const types = node.type.schema.nodes;
      const right: Record<string,
        unknown> = {
          ...node.attrs,
          spelling: combine(node.type, node.attrs.spelling, node.attrs.spelling, ['front', 'ordinary'])
        };
      if (node.type === types.orderedList) {
        const marker = this.at.node(level).maybeChild(this.at.index(level))?.attrs.spelling?.marker;
        const number = Number.parseInt(marker, 10);
        right.startNumber = Number.isFinite(number) ? number : node.attrs.startNumber + this.at.index(level);
      } else if (node.type === types.listItem) {
        right.checked = node.attrs.checked === null ? null : false;
        right.spelling = itemSpelling(node, this.at.node(level - 1), this.at.index(level - 1) + 1, right.spelling);
      }
      right.spelling = { ...(right.spelling as object), leadingBlankLines: 0,
        ...(node.attrs.spelling?.start === undefined ? {} : { start: 0 }) };
      this.frames.push({ position: this.at.before(level), node, right });
    }
  }

  apply(): void {
    const { tr, at, pos, depth, start } = this;
    tr.split(pos, depth, this.frames.map(({ node, right }) => ({ type: node.type, attrs: right })));
    for (const frame of this.frames) this.boundaries(frame);
    // Preserve the frames this operation deliberately split. Existing adjacent
    // containers above them still contract after the descendant edit.
    mergeAdjacent(tr, tr.mapping.slice(start).map(pos, 1), at.depth - depth + 1);
    if (!this.frames.some(frame => frame.node.type === tr.doc.type.schema.nodes.listItem)) return;
    const right = tr.doc.resolve(tr.mapping.slice(start).map(pos, 1));
    for (let level = right.depth; level > 0; level--) {
      if (right.node(level).type !== tr.doc.type.schema.nodes.listItem) continue;
      if (level > 1) keepListNumbers(tr, right.before(level - 1));
      return;
    }
  }

  boundaries({ position, node }: SplitFrame): void {
    const { tr, at } = this;
    const left = tr.doc.nodeAt(position)!;
    const container = !left.isTextblock && left.type !== left.type.schema.nodes.listItem;
    // Splitting a container exposes the boundary between the children it held.
    // A text split creates a new boundary and takes its surrounding default.
    const fallback = left.type.isInGroup('list') ? Number(left.attrs.spelling?.tight === false) : 1;
    const trailingBlankLines = container ? left.lastChild?.attrs.spelling?.trailingBlankLines ?? fallback
      : defaultBlankLines(at.doc.resolve(position));
    setAttributes(tr, position, { spelling: {
      ...(combine(node.type, node.attrs.spelling, null, ['front', 'ordinary']) as object), trailingBlankLines,
    } });
    if (!container) return;
    const right = tr.doc.resolve(tr.mapping.slice(this.start).map(this.pos, 1));
    const level = at.doc.resolve(position).depth + 1;
    const after = right.node(level);
    setAttributes(tr, right.before(level), { spelling: {
      ...after.attrs.spelling, leadingBlankLines: after.firstChild?.attrs.spelling?.leadingBlankLines ?? 0,
    } });
  }
}

/** Join two blocks. Existing frames divide front/back ownership; a new wrapper contributes no spelling. */
export function join(tr: Transform, pos: number): void {
  const start = tr.steps.length;
  joinAt(tr, pos);
  mergeAdjacent(tr, tr.mapping.slice(start).map(pos, -1));
}

/** Change the block at a position into another kind, keeping its content. It takes no spelling: the new kind's is
 * written its own way. */
export function convert(tr: Transform, pos: number, type: NodeType, meaning: Attrs): void {
  const node = tr.doc.nodeAt(pos);
  if (!node || !type.validContent(node.content)) throw new RangeError('Conversion must keep valid content');
  tr.setNodeMarkup(pos, type, { ...meaning, spelling: changedSpelling(type, meaning, null, node.content) });
}

/**
 * Insert a new block at a position, with the spelling of its neighbors where it has some, or,
 * where it is made from text the user typed, the spelling that text was read with (`read`, what
 * a reader gave): ` '` typed after a destination makes a title written between `'`.
 */
export function insert(tr: Transform, pos: number, type: NodeType, meaning: Attrs, content?: Fragment,
  read?: Syntax): void {
  const at = tr.doc.resolve(pos);
  let neighbor: Node | null = null;
  if (at.nodeBefore?.type === type) neighbor = at.nodeBefore;
  else if (at.nodeAfter?.type === type) neighbor = at.nodeAfter;
  let spelling = neighbor ? combine(type, neighbor.attrs.spelling, null, ['front', 'ordinary']) : null;
  if (type === type.schema.nodes.listItem) spelling = itemSpelling(neighbor, at.parent, at.index(), spelling);
  spelling = changedSpelling(type, meaning, spelling, content);
  if (read) {
    if (editorType(read, tr.doc.type.schema) !== type || editorSpelling(read) === undefined) {
      throw new RangeError('The reading must describe the inserted node');
    }
    spelling = editorSpelling(read);
  } else if (type.isInGroup('block') || type === type.schema.nodes.listItem) {
    spelling = { ...(spelling as object | null), leadingBlankLines: 0, trailingBlankLines: defaultBlankLines(at) };
  }
  const attrs = { ...meaning, spelling };
  const node = content ? type.createChecked(attrs, content) : type.createAndFill(attrs);
  if (!node) throw new RangeError(`No valid content for ${type.name}`);
  tr.insert(pos, adoptContent(Fragment.from(node), at));
}

/** Remove the blocks between two positions. */
export function remove(tr: Transform, from: number, to: number): void {
  const start = tr.steps.length;
  const left = tr.doc.resolve(from);
  const right = tr.doc.resolve(to);
  if (left.parent.isTextblock && right.parent.isTextblock && !left.sameParent(right)) removeAcrossFields(tr, from, to);
  else tr.deleteRange(from, to);
  mergeAdjacent(tr, tr.mapping.slice(start).map(from, -1));
}

/** Wrap a range of blocks in a new container with their outer boundaries. */
export function wrap(tr: Transform, range: NodeRange, type: NodeType, meaning: Attrs): void {
  const wrappers = findWrapping(range, type, { ...meaning, spelling: null });
  if (!wrappers) throw new RangeError('Cannot wrap this range');
  applyFrames(tr, new Transform(tr.doc).wrap(range, wrappers));
}

/** Lift a range of blocks out of their container. */
export function lift(tr: Transform, range: NodeRange): void {
  const target = liftTarget(range);
  if (target === null) throw new RangeError('Cannot lift this range');
  const start = tr.steps.length;
  const destination = range.$from.node(target);
  const items: { node: Node; position: number }[] = [];
  range.parent.forEach((node, offset, index) => {
    if (index >= range.startIndex && index < range.endIndex)
      items.push({ node, position: range.$from.start(range.depth) + offset });
  });
  if (items.every(({ node }) => node.type === tr.doc.type.schema.nodes.listItem) &&
      items.some(({ node }, index) => movedItem(node, destination, index) !== node)) {
    // A native lift keeps one interval. When the item's marker changes, that
    // interval is its content; its frame belongs to the moving step's slice.
    // Lift backwards so each earlier item arrives before the items already moved.
    for (let index = items.length - 1; index >= 0; index--) {
      const position = tr.mapping.slice(start).map(items[index]!.position, 1);
      liftItem(tr, position, target, destination, items.length - 1);
    }
  } else applyFrames(tr, new Transform(tr.doc).lift(range, target));
  mergeAdjacent(tr, tr.mapping.slice(start).map(range.start, 1));
  mergeAdjacent(tr, tr.mapping.slice(start).map(range.end, -1));
}

function liftItem(tr: Transform, position: number, target: number, destination: Node, index: number): void {
  const at = tr.doc.resolve(position);
  const node = at.nodeAfter;
  if (!node) throw new RangeError('The lifted item disappeared');
  const range = new NodeRange(at, tr.doc.resolve(position + node.nodeSize), at.depth);
  const native = new Transform(tr.doc).lift(range, target).steps[0];
  if (!(native instanceof ReplaceAroundStep)) throw new RangeError('A lift must retain a native gap');
  const frame = movedItem(node, destination, index).copy(Fragment.empty);
  const cut = native.insert + native.slice.openStart;
  const content = native.slice.content.cut(0, cut).append(Fragment.from(frame)).append(native.slice.content.cut(cut));
  const slice = new Slice(content, native.slice.openStart, native.slice.openEnd);
  const step = new ReplaceAroundStep(native.from, native.to, native.gapFrom + 1, native.gapTo - 1, slice,
    native.insert + 1, true);
  applyFrames(tr, new Transform(tr.doc).step(step), false, new Set([frame]));
}

/**
 * Replace a container by its blocks, and drop what it holds before them: a footnote taken back
 * is its body, without its label. The blocks keep their positions and their spelling.
 */
export function unwrap(tr: Transform, pos: number): void {
  const node = tr.doc.nodeAt(pos);
  if (!node || node.isTextblock || node.isLeaf) throw new RangeError('No container at the position');
  let from = pos + 1;
  node.forEach((child, offset) => {
    if (!child.type.isInGroup('block')) from = pos + 1 + offset + child.nodeSize;
  });
  const to = pos + node.nodeSize - 1;
  const start = tr.steps.length;
  tr.step(new ReplaceAroundStep(pos, to + 1, from, to, Slice.empty, 0));
  mergeAdjacent(tr, tr.mapping.slice(start).map(pos, 1));
  mergeAdjacent(tr, tr.mapping.slice(start).map(to + 1, -1));
}

/**
 * Move the block at a position to another. It keeps its spelling, being the same node, but in a
 * list it takes its new neighbors' front: `* b` moved into `- a` is `- b`.
 */
export function move(tr: Transform, from: number, to: number): PositionMapping {
  let node = tr.doc.nodeAt(from);
  if (!node || node.isInline) throw new RangeError('No block at the move position');
  const size = node.nodeSize;
  const end = from + size;
  if (to === from || to === end) return position => position;
  if (to > from && to < end) throw new RangeError('Cannot move a block inside itself');
  const origin = tr.doc.resolve(from);
  const destination = tr.doc.resolve(to);
  if (!destination.parent.canReplaceWith(destination.index(), destination.index(), node.type)) {
    throw new RangeError('The destination cannot hold this block');
  }
  if (node.type === node.type.schema.nodes.listItem) node = movedItem(node, destination.parent, destination.index());
  const start = tr.steps.length;
  const siblings = origin.sameParent(destination);
  let insertion: number;
  if (siblings) {
    const forward = from < to;
    const between = tr.doc.slice(forward ? end : to, forward ? to : from).content;
    const content = forward ? between.append(Fragment.from(node)) : Fragment.from(node).append(between);
    tr.step(new ReplaceStep(Math.min(from, to), Math.max(end, to), new Slice(content, 0, 0)));
    insertion = forward ? to - size : to;
  } else {
    tr.deleteRange(from, end);
    insertion = tr.mapping.slice(start).map(to);
    tr.insert(insertion, node);
  }
  if (origin.parent.type === tr.doc.type.schema.nodes.orderedList) {
    keepListNumbers(tr, tr.mapping.slice(start).map(origin.before(), 1));
  }
  const at = tr.doc.resolve(insertion);
  if (node.type === node.type.schema.nodes.listItem && at.depth) keepListNumbers(tr, at.before());
  const beforeJoin = tr.mapping.slice(start, tr.steps.length);
  const joining = tr.steps.length;
  mergeAdjacent(tr, insertion);
  const afterJoin = tr.mapping.slice(joining);
  return position => {
    let mapped = beforeJoin.map(position);
    if (position > from && position < end) mapped = insertion + position - from;
    else if (siblings && position >= Math.min(from, to) && position <= Math.max(end, to))
      mapped = position + (from < to ? -size : size);
    return afterJoin.map(mapped);
  };
}

/**
 * Change what the block at a position means, in place, and its spelling as the new meaning
 * needs: a code block given a language is fenced; a callout's type is its declaration.
 */
export function update(tr: Transform, pos: number, meaning: Attrs): void {
  const node = tr.doc.nodeAt(pos);
  if (!node) throw new RangeError('No block at the update position');
  const attrs = { ...node.attrs, ...meaning };
  attrs.spelling = changedSpelling(node.type, attrs, node.attrs.spelling);
  if (node.type === node.type.schema.nodes.yamlScalar && meaning.tag === 'string' &&
      inferYAMLScalar(node.textContent) !== 'string') {
    attrs.spelling = { ...node.attrs.spelling, style: 'doubleQuoted' };
  }
  setAttributes(tr, pos, attrs);
}

/** The shape of a block that stays as it is, at a position: its kind, its meaning and its text. */
export function keptShape(node: Node, pos: number, authored?: Map<Shape, Node>): Shape {
  const { spelling: _spelling, ...meaning } = node.attrs;
  let shape: Shape;
  if (node.isTextblock)
    shape = {
      kind: 'text', type: node.type, meaning,
      text: [{ kind: 'range', from: pos + 1, to: pos + node.nodeSize - 1 }]
    };
  else {
    const children: Shape[] = [];
    node.forEach((child, offset) => children.push(keptShape(child, pos + 1 + offset, authored)));
    shape = { kind: 'children', type: node.type, meaning, children };
  }
  authored?.set(shape, node);
  return shape;
}

/**
 * Replace the blocks between two positions by blocks made of their text, where no other
 * operation can say it: a callout made a quote, its title the first paragraph; Enter in a
 * callout's title, the rest of it a paragraph; a definition taken back into a paragraph, its
 * delimiters written in as text; two paragraphs made a table, their text between the pipes its
 * cells. Native replace-around steps retain a single gap; multi-field shapes use native
 * replacement. The blocks take the spelling the classes give them from the blocks replaced.
 * Returns the authored text position map; the caller places its selection through that map.
 */
export function reshape(tr: Transform, from: number, to: number, shapes: readonly Shape[],
  keep?: Shape.Range): PositionMapping {
  return reshapeBlocks(tr, from, to, shapes, undefined, keep).map;
}

/**
 * Replace the range between two positions by a slice, open at either end as deep as it is:
 * what is pasted, `ab|cd` and `x`, `y` giving `abx` and `ycd`. The nodes of the slice keep the
 * spelling they were read with; the blocks split and joined at its edges are split and joined
 * as `split` and `join` do.
 */
export function replace(tr: Transform, from: number, to: number, slice: Slice): void {
  new ReplaceContext(tr, from, to).apply(slice);
}

/** The original edges and the native fitting map of one replacement. */
class ReplaceContext {
  readonly before: Node;
  readonly start: number;
  constructor(readonly tr: Transform, readonly from: number, readonly to: number) {
    this.before = tr.doc;
    this.start = tr.steps.length;
  }

  apply(slice: Slice): void {
    const { tr, from, to, start } = this;
    slice = new Slice(Fragment.fromArray(slice.content.content.map(prepareScalar)), slice.openStart, slice.openEnd);
    applyFrames(tr, new Transform(tr.doc).replaceRange(from, to, slice), true);
    if (tr.steps.length === start) return;
    const mapping = tr.mapping.slice(start);
    const left = mapping.map(from, -1);
    const right = mapping.map(to, 1);
    const lists: number[] = [];
    tr.doc.nodesBetween(left, right, (node, position) => {
      if (node.type.isInGroup('list') && position >= left && position + node.nodeSize <= right) lists.push(position);
    });
    const opening: Node[] = [];
    for (let node = slice.content.firstChild; node && opening.length < slice.openStart; node = node.firstChild)
      opening.push(node);
    // The fitter owns open depths. At surviving edges the first frame owns front/ordinary
    // spelling and the last frame owns back spelling, just as for a split followed by a join.
    this.edges(this.before.resolve(from), opening);
    this.edges(this.before.resolve(to), null);
    for (let index = lists.length - 1; index >= 0; index--) mergeAdjacent(tr, lists[index]!);
  }

  edges(edge: ResolvedPos, opening: readonly Node[] | null): void {
    const { tr } = this;
    const mapping = tr.mapping.slice(this.start);
    for (let depth = 1; depth <= edge.depth; depth++) {
      const old = edge.node(depth);
      const boundary = mapping.map(opening ? edge.before(depth) : edge.after(depth), opening ? 1 : -1);
      const node = opening ? tr.doc.nodeAt(boundary) : tr.doc.resolve(boundary).nodeBefore;
      if (!node) continue;
      const position = opening ? boundary : boundary - node.nodeSize;
      if (node.type === old.type) {
        const incoming = opening?.[depth - (edge.depth - opening.length) - 1];
        const front = opening ? old.attrs.spelling : node.attrs.spelling;
        let back = old.attrs.spelling;
        if (opening) back = incoming?.type === old.type ? incoming.attrs.spelling : node.attrs.spelling;
        setAttributes(tr, position, { spelling: combine(old.type, front, back, ['front', 'ordinary']) });
      } else if (node.type.isInGroup('block') && old.type.isInGroup('block')) {
        const name = opening ? 'leadingBlankLines' : 'trailingBlankLines';
        setAttributes(tr, position, { spelling: { ...node.attrs.spelling, [name]: old.attrs.spelling?.[name] } });
      }
    }
  }
}

function prepareScalar(node: Node): Node {
  // A newly made YAML string is an explicit choice of type, including when it
  // arrives as a Markdown block moved into a collection. Give that choice its
  // quoted spelling before normalizing native changed ranges.
  if (node.type === node.type.schema.nodes.yamlScalar && node.attrs.spelling === null) {
    return node.type.create({ ...node.attrs, spelling: changedSpelling(node.type, node.attrs, null, node.content) },
      node.content, node.marks);
  }
  if (node.isLeaf || node.isTextblock) return node;
  const children = node.content.content.map(prepareScalar);
  return children.every((child, index) => child === node.child(index)) ? node : node.copy(Fragment.fromArray(children));
}

/**
 * Make the blocks between two positions what [List guardianship] and [No junk] say, after a
 * change made without the structural operations: typing, a native deletion, history. Two lists
 * made adjacent that would read as one are one, `- aa` and `- bb` once the paragraph between
 * them is gone; a `-` list and a `*` list stay two. An item written into a list takes the
 * list's frame. The caller supplies the active YAML scalar so that it is not settled.
 *
 * [List guardianship]: private-docs/rules/list-guardianship.md
 * [No junk]: private-docs/rules/no-junk.md
 */
export function normalize(tr: Transform, from: number, to: number, active?: Node): void {
  const scalar = tr.doc.nodeAt(from);
  const at = tr.doc.resolve(from);
  const nodes = tr.doc.type.schema.nodes;
  // The YAML plugin supplies exactly the scalar whose field was left. A list
  // range may include new, still active scalar fields and must not settle them.
  if (scalar?.type === nodes.yamlScalar && scalar !== active && to === from + scalar.nodeSize &&
      !(at.parent.type === nodes.yamlPair && at.index() === 0) &&
      (!scalar.attrs.spelling || scalar.attrs.spelling.style === 'plain')) {
    const tag = inferYAMLScalar(scalar.textContent);
    if (tag !== scalar.attrs.tag) update(tr, from, { tag });
  }
  const points = new Set([from, to]);
  const items: number[] = [];
  tr.doc.nodesBetween(from, to, (node, position, parent) => {
    if (node.type === nodes.table && node.attrs.alignments.length !== (node.firstChild?.childCount ?? 0)) {
      update(tr, position,
        {
          alignments: Array.from({ length: node.firstChild?.childCount ?? 0 },
            (_, column) => node.attrs.alignments[column] ?? null)
        });
    }
    if (node.type.isInGroup('list')) {
      points.add(position);
      points.add(position + node.nodeSize);
    }
    if (node.type === nodes.listItem && parent && !matchingMarker(node, parent)) items.push(position);
  });
  for (const position of items) {
    const point = tr.doc.resolve(position);
    const item = point.nodeAfter;
    if (!item) continue;
    const neighbor = point.nodeBefore ?? point.parent.maybeChild(point.index() + 1);
    setAttributes(tr, position,
      {
        spelling: itemSpelling(neighbor, point.parent, point.index(), item.attrs.spelling, true,
          item.attrs.spelling?.marker)
      });
  }
  const start = tr.steps.length;
  for (const point of [...points].sort((a, b) => b - a))
    mergeAdjacent(tr, tr.mapping.slice(start).map(point, -1), Infinity, false);
}

function matchingMarker(item: Node, list: Node): boolean {
  const pattern = list.attrs.spelling?.pattern;
  const marker = item.attrs.spelling?.marker;
  let ending = '-';
  if (list.type === list.type.schema.nodes.orderedList) ending = pattern === 'decimalRightParenthesis' ? ')' : '.';
  else {
    switch (pattern) {
      case 'asterisk':
        ending = '*';
        break;
      case 'plusSign':
        ending = '+';
        break;
    }
  }
  return typeof marker === 'string' && marker.endsWith(ending);
}

/** The outer margin a block's spelling records before its first line: what its text is read after. */
export function outerMargin(node: Node): string {
  return ' '.repeat(node.attrs.spelling?.spacesBeforeBlock ?? 0);
}

/**
 * Replace the textblock at a position by the blocks its text reads as: what Pending settles and
 * what converts at once. Their spelling is the one the text was read with, what the user typed:
 * `~~~` gives a fence of tildes, `* b` beside no list a `*` item, `[^note]:Remember` a
 * definition with no separator. The text that stays text keeps its positions.
 * `offset` counts characters of `text` before the field's own text, subtracted from retained
 * source ranges and added when mapping retained document positions into `text`.
 * Returns the authored text position map; the caller places its selection through that map.
 */
export function realize(tr: Transform, pos: number, blocks: readonly BlockSyntax[], text: string, offset = 0,
  keep?: Shape.Range): PositionMapping {
  return realizeParagraph(tr, pos, blocks, text, offset, keep);
}
