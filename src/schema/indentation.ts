/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Fragment, type Node, type ResolvedPos } from 'prosemirror-model';
import { TextSelection, type EditorState, type Transaction } from 'prosemirror-state';
import { reframe } from '../transform/reframe.js';
import { compatibleLists, listNumber, listShell, movedItem } from '../transform/frames.js';
import { insert } from '../transform/transform.js';

/** The sibling run found from the selected lines, including its immediate neighbors. */
interface Window {
  readonly parent: number;
  readonly from: number;
  readonly to: number;
  readonly content: Fragment;
}

/** A quote's prefix at its original ownership level. */
interface Prefix {
  readonly node: Node;
  readonly pos: number;
  readonly level: number;
}

/** The ownership and prefixes shared by children read at one level. */
interface ReadFrame {
  readonly level: number;
  readonly parent: number;
  readonly quotes: readonly Prefix[];
  readonly ownerShell: Node | null;
}

/** One occurrence of a line; an item's first block writes its head. */
interface Line extends ReadFrame {
  readonly kind: Line.Kind;
  readonly node: Node;
  readonly pos: number;
  readonly head: Node | null;
  readonly selected: boolean;
  readonly fixed: boolean;
  readonly shell: Node | null;
  readonly index: number;
}

namespace Line {
  export type Kind = 'block' | 'item' | 'carrier' | 'quote' | 'callout' | 'footnote';
}

interface Nested {
  readonly line: Line;
  readonly asked: number;
  readonly level: number;
  readonly quotes: readonly Prefix[];
  readonly children: Nested[];
}

/** Read a selection window, ask for new levels, and write the resulting nesting. @internal */
export function indentLines(state: EditorState, change: 1 | -1): Transaction | null {
  const selected = selectedLines(state);
  if (!selected || !selected.size) return null;
  const window = findWindow(state, selected, change);
  const reader = new ReadContext(selected);
  reader.children(window.content, window.from, { level: 0, quotes: [], parent: window.parent, ownerShell: null });
  const nested = nestLines(reader.lines, change);
  if (change > 0 && !canIndent(nested)) return null;
  const tr = state.tr;
  const writer = new WriteContext(change, nested, tr);
  const content = writer.lines(nested, [], window.parent);
  if (content.eq(window.content)) return null;
  reframe(tr, tr.mapping.map(window.from, -1), tr.mapping.map(window.to, 1), content);
  return tr;
}

/** The nodes whose own lines the selection reaches. */
function selectedLines(state: EditorState): Set<number> | null {
  if (!(state.selection instanceof TextSelection)) return null;
  /** Inside a code block, Tab edits the code; it never indents the block. */
  const { $from, from, to } = state.selection;
  if ($from.parent.type === state.schema.nodes.codeBlock && $from.sameParent(state.selection.$to)) return null;
  const types = state.schema.nodes;
  const selected = new Set<number>();
  let headEnd = -1;
  let unavailable = false;
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (pos < headEnd) return false;
    if (node.type.isInGroup('frontMatter')) {
      unavailable = true;
      return false;
    }
    if (node.type.isInGroup('list')) return true;
    if (node.type === types.listItem) {
      const head = node.firstChild!;
      const carrier = head.type.isInGroup('list');
      if (carrier && from < pos && to >= textEnd(node, pos)) selected.add(pos);
      if (!carrier && from <= firstLineEnd(head, pos + 1) && to >= pos + 2) {
        selected.add(pos);
        headEnd = pos + 1 + head.nodeSize;
      }
      return true;
    }
    if (node.type === types.blockQuote) {
      if (!(from < pos && to >= textEnd(node, pos))) return true;
    } else if (node.type === types.callout || node.type === types.footnoteDefinition) {
      if (from <= pos + node.firstChild!.nodeSize && to >= pos + 2) selected.add(pos);
      headEnd = pos + 1 + node.firstChild!.nodeSize;
      return true;
    }
    selected.add(pos);
    return false;
  });
  return unavailable ? null : selected;
}

function parentDepth(at: ResolvedPos, depth: number): number {
  depth--;
  if (depth > 0 && at.node(depth).type.isInGroup('list')) depth--;
  return depth;
}

function findWindow(state: EditorState, selected: ReadonlySet<number>, change: 1 | -1): Window {
  const positions = [...selected];
  const $from = state.doc.resolve(positions[0]!);
  const $to = state.doc.resolve(positions.at(-1)!);
  let depth = Math.min($from.depth, $to.depth);
  while (depth && $from.start(depth) !== $to.start(depth)) depth--;
  if (depth && $from.node(depth).type.isInGroup('list')) depth--;
  if (change < 0 && depth) depth = parentDepth($from, depth);
  const owner = $from.node(depth);
  const start = $from.start(depth);
  let left = $from.index(depth);
  let right = $to.index(depth) + 1;
  if (left) left--;
  if (right < owner.childCount) right++;
  const firstOffset = owner.childAfter($from.pos - start).offset;
  let from = start + firstOffset;
  if (left < $from.index(depth)) from -= owner.child(left).nodeSize;
  let to = from;
  const children: Node[] = [];
  for (let index = left; index < right; index++) {
    const child = owner.child(index);
    children.push(child);
    to += child.nodeSize;
  }
  return { parent: depth ? $from.before(depth) : -1, from, to, content: Fragment.fromArray(children) };
}

/** The selection shared by the recursive walk of this window alone. */
class ReadContext {
  readonly lines: Line[] = [];
  constructor(readonly selected: ReadonlySet<number>) {}

  children(content: Fragment, pos: number, frame: ReadFrame): void {
    content.forEach((node, offset) => this.block(node, pos + offset, frame));
  }

  block(node: Node, pos: number, frame: ReadFrame, fixed = false): void {
    const types = node.type.schema.nodes;
    const line = { ...frame, node, pos, selected: this.selected.has(pos), fixed, shell: null, index: 0 };
    const inside = { level: frame.level + 1, quotes: frame.quotes, parent: pos, ownerShell: null };
    if (node.type.isInGroup('list')) {
      node.forEach((item, offset, index) => this.item(item, pos + offset + 1, frame, node, index, fixed));
    } else if (node.type === types.blockQuote) {
      if (line.selected) this.lines.push({ ...line, kind: 'quote', head: node });
      else this.children(node.content, pos + 1, {
        ...inside, quotes: [...frame.quotes, { node, pos, level: frame.level }],
      });
    } else if (node.type === types.callout || node.type === types.footnoteDefinition) {
      const head = node.firstChild!;
      const kind = node.type === types.callout ? 'callout' : 'footnote';
      this.lines.push({ ...line, kind, head });
      let offset = pos + 1 + head.nodeSize;
      for (let index = 1; index < node.childCount; index++) {
        const child = node.child(index);
        this.block(child, offset, inside, kind === 'footnote' &&
          (index === 1 || this.selected.has(pos + 1 + head.nodeSize)));
        offset += child.nodeSize;
      }
    } else {
      this.lines.push({ ...line, kind: 'block', head: node });
    }
  }

  item(node: Node, pos: number, frame: ReadFrame, shell: Node, index: number, fixed: boolean): void {
    const head = node.firstChild!;
    const carrier = head.type.isInGroup('list');
    const selected = this.selected.has(pos);
    /** The first line moves the item with its first block. Otherwise the first
     * container is read too, so its interior lines have their own levels. */
    const interior = !selected && (head.type === node.type.schema.nodes.blockQuote ||
      head.type === node.type.schema.nodes.callout || head.type === node.type.schema.nodes.footnoteDefinition);
    this.lines.push({ ...frame, kind: carrier ? 'carrier' : 'item', node, pos,
      head: carrier || interior ? null : head, selected, shell, index, fixed });
    const inside = { level: frame.level + 1, quotes: frame.quotes, parent: pos, ownerShell: shell };
    let offset = pos + 1;
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (i || carrier || interior) this.block(child, offset, inside);
      offset += child.nodeSize;
    }
  }
}

/** The end of the first line, following only the first-child path. */
function firstLineEnd(node: Node, pos: number): number {
  const types = node.type.schema.nodes;
  while (node.type === types.blockQuote || node.type === types.callout ||
    node.type === types.footnoteDefinition || node.type.isInGroup('list') || node.type === types.listItem) {
    pos++;
    node = node.firstChild!;
  }
  return pos + node.nodeSize - 1;
}

function textEnd(node: Node, pos: number): number {
  while (!node.isTextblock && node.lastChild) {
    pos += node.nodeSize - node.lastChild.nodeSize - 1;
    node = node.lastChild;
  }
  return pos + node.nodeSize - 1;
}

function containsPrefixes(outer: readonly Prefix[], inner: readonly Prefix[]): boolean {
  return outer.length <= inner.length && outer.every((prefix, index) => prefix === inner[index]);
}

/** Quote membership is assigned separately from the stack of lines that can own. */
function nestLines(lines: readonly Line[], change: 1 | -1): Nested[] {
  const roots: Nested[] = [];
  const stack: Nested[] = [];
  let previous: Nested | null = null;
  for (const line of lines) {
    const moving = line.selected && !(change < 0 && line.fixed);
    const asked = Math.max(0, line.level + (moving ? change : 0));
    let quotes = line.quotes;
    if (moving && change < 0 && quotes.at(-1)?.level === line.level - 1) quotes = quotes.slice(0, -1);
    if (moving && change > 0 && previous) {
      const prefix = previous.quotes.findIndex(quote => quote.level === asked - 1);
      if (prefix >= quotes.length && containsPrefixes(quotes, previous.quotes))
        quotes = previous.quotes.slice(0, prefix + 1);
    }
    while (stack.length && stack.at(-1)!.asked >= asked) stack.pop();
    const owner = stack.at(-1);
    if (owner && owner.quotes.length > owner.line.quotes.length &&
      containsPrefixes(owner.line.quotes, quotes) && !containsPrefixes(owner.quotes, quotes))
      quotes = [...owner.quotes, ...quotes.slice(owner.line.quotes.length)];
    while (stack.length) {
      const owner = stack.at(-1)!;
      const boundary = quotes[owner.quotes.length];
      if (containsPrefixes(owner.quotes, quotes) && (!boundary || owner.asked < boundary.level)) break;
      stack.pop();
    }
    const parent = stack.at(-1);
    const level = parent ? parent.level + 1 + quotes.length - parent.quotes.length : quotes.length;
    const nested: Nested = { line, asked, level, quotes, children: [] };
    (parent ? parent.children : roots).push(nested);
    if (line.kind !== 'block') stack.push(nested);
    previous = nested;
  }
  return pruneCarriers(roots);
}

/** Remove only carriers whose children have all left them. */
function pruneCarriers(lines: readonly Nested[]): Nested[] {
  const result: Nested[] = [];
  for (const line of lines) {
    const children = pruneCarriers(line.children);
    if (line.line.kind === 'carrier' && !children.length && line.line.node.attrs.checked === null) continue;
    result.push({ ...line, children });
  }
  return result;
}

/** An unavailable Tab leaves the selection unchanged, as the existing range cases require. */
function canIndent(lines: readonly Nested[]): boolean {
  return lines.every(line => (!line.line.selected || line.level === line.line.level + 1) && canIndent(line.children));
}

function retained(node: Node, content: Fragment): Node {
  if (node.content.childCount === content.childCount &&
      node.content.content.every((child, index) => child === content.child(index))) return node;
  return node.copy(content);
}

/** The final line supplies the closing boundary of a changed shell. */
function lastLine(nested: Nested): Line {
  const last = nested.children.at(-1);
  return last ? lastLine(last) : nested.line;
}

/** Group prefixes and shells after ownership is settled. */
class WriteContext {
  readonly surviving = new Set<number>();

  constructor(readonly change: 1 | -1, lines: readonly Nested[], readonly tr: Transaction) {
    this.remember(lines);
  }

  remember(lines: readonly Nested[]): void {
    for (const line of lines) {
      this.surviving.add(line.line.pos);
      this.remember(line.children);
    }
  }

  destination(nested: Nested, parent: number): Node | null {
    const { line } = nested;
    if (this.change < 0 && line.parent !== parent && this.surviving.has(line.parent) &&
        nested.level < line.level && line.ownerShell?.type === line.shell?.type) return line.ownerShell;
    return line.shell;
  }

  share(left: Nested, right: Nested, parent: number): boolean {
    const a = this.destination(left, parent);
    const b = this.destination(right, parent);
    return !!a && !!b && compatibleLists(a, b);
  }

  lines(lines: readonly Nested[], quotes: readonly Prefix[], parent: number): Fragment {
    const nodes: Node[] = [];
    for (let index = 0; index < lines.length;) {
      const current = lines[index]!;
      const prefix = current.quotes[quotes.length];
      let end = index + 1;
      if (prefix) {
        while (end < lines.length && lines[end]!.quotes[quotes.length] === prefix) end++;
        const content = this.lines(lines.slice(index, end), [...quotes, prefix], prefix.pos);
        nodes.push(retained(prefix.node, content));
      } else if (current.line.shell) {
        while (end < lines.length && lines[end]!.quotes.length === quotes.length &&
          this.share(current, lines[end]!, parent)) end++;
        nodes.push(this.shell(lines.slice(index, end), parent));
      } else {
        nodes.push(this.line(current));
      }
      index = end;
    }
    return Fragment.fromArray(nodes);
  }

  shell(lines: readonly Nested[], parent: number): Node {
    const first = lines[0]!;
    const shell = this.destination(first, parent)!;
    const items = lines.map((line, index) => {
      const item = this.line(line);
      return line.line.shell === shell ? item : movedItem(item, shell, index);
    });
    const changed = lines.length !== shell.childCount ||
      lines.some((line, index) => line.line.shell !== shell || line.line.index !== index);
    let numbers: number[] | null = null;
    if (shell.type === shell.type.schema.nodes.orderedList) {
      const newList = first.level > first.line.level && (first.line.parent !== parent || changed);
      const sourceList = first.line.parent === parent && lines.length < shell.childCount &&
        lines.every(line => line.line.shell === shell);
      const renumber = this.change > 0 && (newList || sourceList);
      if (renumber || changed) {
        const start = newList ? 1 : shell.attrs.startNumber;
        numbers = lines.map((line, index) => renumber ? start + index :
          listNumber(line.line.shell!, line.line.index));
      }
    }
    const doc = this.tr.before;
    return listShell(shell, items, doc.resolve(first.line.pos), doc.resolve(lastLine(lines.at(-1)!).pos), numbers);
  }

  line(nested: Nested): Node {
    const { line } = nested;
    const content = this.lines(nested.children, nested.quotes, line.pos);
    switch (line.kind) {
      case 'block': return line.node;
      case 'carrier': {
        if (content.size) return retained(line.node, content);
        const pos = this.tr.mapping.map(line.pos + 1, 1);
        insert(this.tr, pos, line.node.type.schema.nodes.paragraph, {});
        const paragraph = this.tr.doc.nodeAt(pos)!;
        return retained(line.node, Fragment.from(paragraph));
      }
      case 'quote': return retained(line.node, line.node.content.append(content));
      case 'item':
      case 'callout':
      case 'footnote': return retained(line.node, Fragment.from(line.head!).append(content));
      default: return line.kind satisfies never;
    }
  }
}
