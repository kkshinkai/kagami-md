/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Fragment, type Attrs, type Node, type NodeType, type ResolvedPos } from 'prosemirror-model';
import { canJoin, type Transform } from 'prosemirror-transform';
import { inferYAMLScalar } from '../parse/scalar.js';
import { neighborBlankLines } from './boundaries.js';
import { combine, joined } from './classes.js';
import type { Shape } from './transform.js';

/** Join compatible nodes and divide their spelling at the surviving boundary. */
export function joinAt(tr: Transform, pos: number): void {
  const at = tr.doc.resolve(pos);
  const before = at.nodeBefore;
  const after = at.nodeAfter;
  if (!before || !after || before.type !== after.type || !canJoin(tr.doc, pos))
    throw new RangeError('Cannot join these blocks');
  const start = pos - before.nodeSize;
  tr.join(pos);
  let spelling = joined(before.type, before.attrs.spelling, after.attrs.spelling);
  if (before.type.isInGroup('list')) spelling = {
    ...(spelling as object | null),
    tight: before.attrs.spelling?.tight !== false && after.attrs.spelling?.tight !== false,
  };
  setAttributes(tr, start, { ...before.attrs, spelling });
  keepListNumbers(tr, start);
}

/** Updating attributes leaves every text endpoint intact, including its outward affinity. */
export function setAttributes(tr: Transform, position: number, attrs: Attrs): void {
  const node = tr.doc.nodeAt(position);
  if (!node) throw new RangeError('No block for attributes');
  for (const name in attrs) {
    if (JSON.stringify(node.attrs[name]) !== JSON.stringify(attrs[name]))
      tr.setNodeAttribute(position, name, attrs[name]);
  }
}

/** Adjust recorded spelling only where a change of meaning requires it. */
export function changedSpelling(type: NodeType, meaning: Attrs, value: unknown, content?: Fragment): unknown {
  const types = type.schema.nodes;
  if (type === types.yamlScalar && meaning.tag === 'string' && content &&
      inferYAMLScalar(content.textBetween(0, content.size)) !== 'string') {
    return { ...(value as object | null), style: 'doubleQuoted' };
  }
  if (!value || typeof value !== 'object') return null;
  const spelling = value as Record<string, unknown>;
  if (type === types.callout && typeof meaning.calloutType === 'string' &&
      (typeof spelling.declaration !== 'string' ||
      spelling.declaration.toLowerCase() !== `[!${meaning.calloutType}]`)) {
    return { ...spelling, declaration: `[!${meaning.calloutType.toUpperCase()}]` };
  }
  if (type === types.linkReferenceDefinition && meaning.title != null && spelling.whitespaceBeforeTitle === '') {
    return { ...spelling, whitespaceBeforeTitle: ' ' };
  }
  if (type === types.codeBlock && spelling.fence === null && (meaning.language || meaning.meta)) {
    return {
      ...spelling,
      fence: { fence: '```', whitespaceAfterFence: '', closingFence: '```', spacesBeforeClosingFence: 0 }
    };
  }
  return spelling;
}

function bullet(pattern: string | undefined): string {
  switch (pattern) {
    case 'asterisk': return '*';
    case 'plusSign': return '+';
    default: return '-';
  }
}

/** Supply the destination list's marker and preserve the number when requested. */
export function itemSpelling(neighbor: Node | null, parent: Node, index: number, value: unknown,
                             keepNumber = false, originalMarker?: string): unknown {
  const base = combine(parent.type.schema.nodes.listItem, keepNumber ? neighbor?.attrs.spelling : value,
    value, keepNumber ? ['front'] : ['front', 'ordinary', 'back']) as Record<string, unknown> | null;
  const old = typeof base?.marker === 'string' ? base.marker : '-';
  const pattern = parent.attrs.spelling?.pattern;
  let marker = neighbor?.attrs.spelling?.marker ?? bullet(pattern);
  if (parent.type === parent.type.schema.nodes.orderedList) {
    const original = originalMarker ?? old;
    const previous = parent.maybeChild(index - 1)?.attrs.spelling?.marker;
    let number = parent.attrs.startNumber;
    if (keepNumber && /^\d+[.)]$/.test(original)) number = Number.parseInt(original, 10);
    else if (previous) number = Number.parseInt(previous, 10) + 1;
    if (!Number.isFinite(number)) number = parent.attrs.startNumber + index;
    marker = number + (pattern === 'decimalRightParenthesis' ? ')' : '.');
  }
  return { ...base, marker, continuationIndent: typeof base?.continuationIndent === 'number'
    ? base.continuationIndent + marker.length - old.length : null };
}

/** Movement keeps every record except the marker required by its destination shell. */
export function movedItem(item: Node, parent: Node, index: number): Node {
  const old = item.attrs.spelling?.marker as string | undefined;
  const pattern = parent.attrs.spelling?.pattern;
  let marker = bullet(pattern);
  if (parent.type === parent.type.schema.nodes.orderedList) {
    const number = old ? Number.parseInt(old, 10) : NaN;
    marker = String(Number.isFinite(number) ? number : parent.attrs.startNumber + index)
      + (pattern === 'decimalRightParenthesis' ? ')' : '.');
  }
  if (old === marker) return item;
  const spelling = { ...item.attrs.spelling, marker };
  if (typeof spelling.continuationIndent === 'number')
    spelling.continuationIndent += marker.length - (old?.length ?? 1);
  return item.type.create({ ...item.attrs, spelling }, item.content, item.marks);
}

/** Only recorded spacing supplies the habit at other list boundaries. */
export function looseList(list: Node, arriving?: Node): boolean {
  for (let index = 0; index < list.childCount; index++) {
    const item = list.child(index);
    if (item === arriving) continue;
    if (index && blankBoundary(list.child(index - 1), item)) return true;
    for (let child = 1; child < item.childCount; child++) if (blankBoundary(item.child(child - 1), item.child(child)))
      return true;
  }
  return false;
}

function blankBoundary(before: Node, after: Node): boolean {
  return (before.attrs.spelling?.trailingBlankLines ?? 0) + (after.attrs.spelling?.leadingBlankLines ?? 0) > 0;
}

function listBoundary(at: ResolvedPos, below: number): number | null {
  for (let depth = Math.min(at.depth, below - 2); depth >= 0; depth--) {
    const parent = at.node(depth);
    const index = at.index(depth);
    const start = depth < at.depth ? at.before(depth + 1) : at.pos - at.textOffset;
    for (let pair = index - 1; pair <= index; pair++) {
      if (pair < 0 || pair + 1 >= parent.childCount) continue;
      const left = parent.child(pair);
      const right = parent.child(pair + 1);
      if (!left.type.isInGroup('list') || left.type !== right.type) continue;
      const fallback = left.type === left.type.schema.nodes.bulletList ? 'dash' : 'decimalDot';
      if ((left.attrs.spelling?.pattern ?? fallback) !== (right.attrs.spelling?.pattern ?? fallback)) continue;
      const boundary = start + (pair === index ? left.nodeSize : 0);
      if (canJoin(at.doc, boundary)) return boundary;
    }
  }
  return null;
}

/** Repair only touched list boundaries. Unlike marker shells and adjacent quotes stay distinct. */
export function mergeAdjacent(tr: Transform, position: number, below = Infinity, refreshNumbers = true): void {
  let point = Math.max(0, Math.min(position, tr.doc.content.size));
  for (;;) {
    const at = tr.doc.resolve(point);
    const boundary = listBoundary(at, below);
    if (boundary === null) {
      if (refreshNumbers) refreshListNumbers(tr, at);
      return;
    }
    const start = tr.steps.length;
    joinAt(tr, boundary);
    point = tr.mapping.slice(start).map(point, 1);
  }
}

function refreshListNumbers(tr: Transform, at: ResolvedPos): void {
  // A lift can split an ordered carrier without passing through split().
  // Its fragments take their first surviving item's number.
  for (let depth = at.depth; depth >= 0; depth--) {
    if (depth) keepListNumbers(tr, at.before(depth));
    const start = depth === at.depth ? at.pos : at.before(depth + 1);
    const before = at.node(depth).maybeChild(at.index(depth) - 1);
    if (before) keepListNumbers(tr, start - before.nodeSize);
    keepListNumbers(tr, start);
  }
}

/** Construct arriving items or lists before their native replacement is applied. */
export function adoptContent(content: Fragment, from: ResolvedPos, to: ResolvedPos = from): Fragment {
  if (from.parent.type.isInGroup('list')) {
    const neighbor = from.nodeBefore ?? to.nodeAfter;
    if (!neighbor) return content;
    const count = neighborBlankLines(from.parent, from.index(), to.index());
    return Fragment.fromArray(content.content.map((item, index) => {
      if (item.type !== item.type.schema.nodes.listItem) return item;
      const spelling = itemSpelling(neighbor, from.parent, from.index() + index, item.attrs.spelling, true,
        item.attrs.spelling?.marker) as object;
      return item.type.create({ ...item.attrs, spelling: {
        ...spelling,
        leadingBlankLines: index
          ? 0 : Math.max(0, count - (from.nodeBefore?.attrs.spelling?.trailingBlankLines ?? count)),
        trailingBlankLines: index === content.childCount - 1
          ? Math.max(0, count - (to.nodeAfter?.attrs.spelling?.leadingBlankLines ?? 0)) : count,
      } }, item.content, item.marks);
    }));
  }
  const nodes = [...content.content];
  for (let index = 0; index < nodes.length; index++) {
    if (nodes[index]!.type.isInGroup('list'))
      nodes[index] = adoptList(nodes[index]!, index ? nodes[index - 1]! : from.nodeBefore,
        index + 1 < nodes.length ? nodes[index + 1]! : to.nodeAfter);
  }
  return Fragment.fromArray(nodes);
}

function adoptList(node: Node, before: Node | null, after: Node | null): Node {
  const previous = before?.type === node.type ? before : null;
  const following = after?.type === node.type ? after : null;
  const neighbor = previous ?? following;
  if (!neighbor) return node;
  const template = previous ? neighbor.lastChild : neighbor.firstChild;
  const count = neighborBlankLines(neighbor, previous ? neighbor.childCount : 0);
  const parent = node.type.create({ ...node.attrs, spelling: {
    ...node.attrs.spelling, pattern: neighbor.attrs.spelling?.pattern, tight: neighbor.attrs.spelling?.tight,
  } }, node.content, node.marks);
  return parent.copy(Fragment.fromArray(node.content.content.map((item, index) => {
    const marker = item.attrs.spelling?.marker
      ?? (node.type === node.type.schema.nodes.orderedList ? String(node.attrs.startNumber + index) + '.' : undefined);
    const frame = itemSpelling(template, parent, index, item.attrs.spelling, true, marker) as object;
    return item.type.create({ ...item.attrs, spelling: {
      ...frame,
      leadingBlankLines: !index && previous
        ? Math.max(0, count - (previous.lastChild?.attrs.spelling?.trailingBlankLines ?? count)) : 0,
      trailingBlankLines: index === node.childCount - 1 && following
        ? Math.max(0, count - (following.firstChild?.attrs.spelling?.leadingBlankLines ?? 0)) : count,
    } }, item.content, item.marks);
  })));
}

/** Keep authored item numbers when an operation makes a sequential list irregular. */
export function keepListNumbers(tr: Transform, position: number): void {
  const list = tr.doc.nodeAt(position);
  if (list?.type !== tr.doc.type.schema.nodes.orderedList) return;
  const numbers = list.content.content.map((item, index) => {
    const marker = item.attrs.spelling?.marker;
    const number = typeof marker === 'string' ? Number.parseInt(marker, 10) : NaN;
    return Number.isFinite(number) ? number : list.attrs.startNumber + index;
  });
  const startNumber = numbers[0] ?? list.attrs.startNumber;
  let numbering: 'sequential' | 'constant' | null = null;
  if (numbers.every((number, index) => number === startNumber + index)) numbering = 'sequential';
  else if (numbers.every(number => number === startNumber)) numbering = 'constant';
  setAttributes(tr, position, { startNumber, spelling: { ...list.attrs.spelling, numbering } });
}

/** Retain the replaced field's outer blank lines on the fields produced by a reading. */
export function keepOuterFrames(shapes: readonly Shape[], node: Node, authored: Map<Shape, Node>): void {
  for (let index = 0; index < shapes.length; index++) {
    const shape = shapes[index]!;
    if (shape.kind === 'children') {
      // A container's frame still follows reshape's existing shared-framing
      // rules. Only its textblocks need the precomputed content below it.
      authored.delete(shape);
      continue;
    }
    if (!shape.read) continue;
    const reading = authored.get(shape)!;
    if (!reading.attrs.spelling) continue;
    const spelling = { ...reading.attrs.spelling };
    for (const [boundary, keep] of [['leadingBlankLines', index === 0],
      ['trailingBlankLines', index === shapes.length - 1]] as const) {
      if (!keep) continue;
      if (node.attrs.spelling?.[boundary] === undefined) delete spelling[boundary];
      else spelling[boundary] = node.attrs.spelling[boundary];
    }
    authored.set(shape, reading.type.create({ ...reading.attrs, spelling }, reading.content));
  }
}

/** Whether adjacent list shells use one marker and can share a frame. @internal */
export function compatibleLists(left: Node, right: Node): boolean {
  const fallback = left.type === left.type.schema.nodes.bulletList ? 'dash' : 'decimalDot';
  return left.type === right.type &&
    (left.attrs.spelling?.pattern ?? fallback) === (right.attrs.spelling?.pattern ?? fallback);
}

/** The item's number as written under its shell's numbering mode. @internal */
export function listNumber(list: Node, index: number): number {
  switch (list.attrs.spelling?.numbering) {
    case 'constant': return list.attrs.startNumber;
    case null: return Number.parseInt(list.child(index).attrs.spelling.marker, 10);
    default: return list.attrs.startNumber + index;
  }
}

/** Rebuild a list from retained items and the original boundaries of its first and last lines. @internal */
export function listShell(shell: Node, children: readonly Node[], first: ResolvedPos, last: ResolvedPos,
                          numbers: readonly number[] | null): Node {
  let items = children;
  const attrs = { ...shell.attrs };
  let spelling = shell.attrs.spelling;
  if (shell.type === shell.type.schema.nodes.orderedList) {
    attrs.startNumber = numbers ? numbers[0]! : listNumber(first.parent, first.index());
    if (numbers) {
      const numbering = numbers.every((number, index) => number === numbers[0]! + index) ? 'sequential' : null;
      spelling = { ...spelling, numbering };
      items = children.map((item, index) => numberedItem(item, numbers[index]!, shell));
    }
  }
  if (first.index() > 0) spelling = {
    ...spelling, leadingBlankLines: first.nodeAfter!.attrs.spelling?.leadingBlankLines ?? 0,
  };
  if (items.at(-1) !== shell.lastChild) {
    let trailing = last.nodeAfter!.attrs.spelling?.trailingBlankLines;
    if (trailing === undefined && last.parent.type.isInGroup('list'))
      trailing = Number(last.parent.attrs.spelling?.tight === false);
    if (trailing !== undefined) spelling = { ...spelling, trailingBlankLines: trailing };
  }
  const result = shell.type.create({ ...attrs, spelling }, Fragment.fromArray([...items]), shell.marks);
  if (!shell.sameMarkup(result)) return result;
  const unchanged = shell.childCount === items.length && items.every((item, index) => item === shell.child(index));
  return unchanged ? shell : result;
}

/** Number records also serve later splits, so they follow a new numbering mode. */
function numberedItem(item: Node, number: number, shell: Node): Node {
  const old = item.attrs.spelling?.marker;
  const marker = String(number) + (shell.attrs.spelling?.pattern === 'decimalRightParenthesis' ? ')' : '.');
  if (old === marker) return item;
  const spelling = { ...item.attrs.spelling, marker };
  if (typeof spelling.continuationIndent === 'number' && old)
    spelling.continuationIndent += marker.length - old.length;
  return item.type.create({ ...item.attrs, spelling }, item.content, item.marks);
}
