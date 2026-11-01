/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-FileCopyrightText: Marijn Haverbeke <marijn@haverbeke.berlin> and others
 * SPDX-License-Identifier: MPL-2.0 AND MIT
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Derived from prosemirror-view, https://github.com/ProseMirror/prosemirror-view. */

import { Fragment, NodeRange, Slice, type Node, type NodeType, type ResolvedPos } from 'prosemirror-model';
import { Selection, TextSelection, type EditorState, type Transaction } from 'prosemirror-state';
import { readAnnotation } from '../types/annotations.js';
import { alignment, type Alignment } from '../types/schema.js';
import { unparse } from '../unparse/unparse.js';
import { fieldSource } from '../parse/field.js';
import { insert, join, remove, replace, split, update, wrap } from '../transform/transform.js';
import { history } from '../state/history.js';

/** Insert a clipboard slice, preserving the destination's structural ownership. */
export function paste(state: EditorState, content: Slice, html = ''): Transaction | null {
  const { slice, itemHead } = new PasteContext(state).read(content, html);
  if (!slice.size) return null;
  const transaction = history.isolate(state.tr);
  if (itemHead) insertItems(transaction, slice.content);
  else if (slice.content.content.every(node => node.isInline)) insertInline(transaction, slice);
  else if (slice.openStart || slice.openEnd) replaceSelection(transaction, slice);
  else insertBlocks(transaction, slice.content);
  return transaction.setMeta('paste', true).setMeta('uiEvent', 'paste').scrollIntoView();
}

interface Insertion {
  readonly slice: Slice;
  readonly itemHead: boolean;
}

/** Resolve the insertion's ownership before changing its destination. */
class PasteContext {
  constructor(readonly state: EditorState) {}

  read(slice: Slice, html: string): Insertion {
    if (!html || slice.content.firstChild?.isInline) return { slice, itemHead: false };
    const dom = new globalThis.DOMParser().parseFromString(html, 'text/html').body;
    const carried = readAnnotation.tree(dom, this.state.schema);
    if (carried && readAnnotation.insideField(carried.fragment, carried.carrier)) {
      let field = slice.content.childCount === 1 ? slice.content.firstChild : null;
      while (field && !field.isTextblock && field.childCount === 1) field = field.firstChild;
      if (field?.isTextblock) return { slice: new Slice(field.content, 0, 0), itemHead: false };
    }
    const matrix = this.matrix(slice.content, dom);
    if (matrix) return matrix;
    if (readAnnotation.hasSlice(dom)) return { slice, itemHead: false };
    const selection = this.state.selection;
    const { paragraph, heading } = this.state.schema.nodes;
    if (selection instanceof TextSelection && selection.$from.sameParent(selection.$to) &&
        selection.$from.parentOffset > 0 &&
        (selection.$from.parent.type === paragraph || selection.$from.parent.type === heading)) {
      const field = singleField(slice.content);
      if (field) return { slice: new Slice(field.content, 0, 0), itemHead: false };
    }
    if (slice.content.size && itemHead(selection)) return { slice: closeSlice(slice, 0, 0), itemHead: true };
    return {
      slice: closeSlice(slice,
        slice.content.firstChild?.type === paragraph ? Math.min(1, slice.openStart) : 0,
        slice.content.lastChild?.type === paragraph ? Math.min(1, slice.openEnd) : 0),
      itemHead: false,
    };
  }

  matrix(content: Fragment, dom: HTMLElement): Insertion | null {
    if (!content.childCount) return null;
    const rows = content.content.every(node => node.type.spec.tableRole === 'row');
    const cells = content.content.every(node => node.type.spec.tableRole === 'cell' ||
      node.type.spec.tableRole === 'header_cell');
    if (!rows && !cells) return null;
    const { table, tableRow } = this.state.schema.nodes;
    const body = rows ? content : Fragment.from(tableRow.create(null, content));
    const source = dom.querySelector('[data-kagami-table-alignments]')?.getAttribute('data-kagami-table-alignments');
    let alignments: Alignment[] = Array.from({ length: body.firstChild!.childCount }, () => null);
    if (source) {
      try {
        const values: unknown = JSON.parse(source);
        if (Array.isArray(values) && values.length === alignments.length) alignments = values.map(alignment);
      } catch {
        // Foreign clipboard metadata does not change the decoded cells.
      }
    }
    return {
      slice: new Slice(Fragment.from(table.create({ alignments }, body)), 0, 0),
      itemHead: itemHead(this.state.selection)
    };
  }
}

/**
 * Close a slice's sides to the given depths, filling each node that was open there with the
 * content its type requires, as prosemirror-view closes a pasted slice (its `closeSlice`).
 */
function closeSlice(slice: Slice, openStart: number, openEnd: number): Slice {
  if (openStart < slice.openStart)
    slice = new Slice(closeRange(slice.content, -1, openStart, slice.openStart, 0, slice.openEnd), openStart,
      slice.openEnd);
  if (openEnd < slice.openEnd)
    slice = new Slice(closeRange(slice.content, 1, openEnd, slice.openEnd, 0, 0), slice.openStart, openEnd);
  return slice;
}

function closeRange(fragment: Fragment, side: -1 | 1, from: number, to: number, depth: number,
  openEnd: number): Fragment {
  const node = side < 0 ? fragment.firstChild! : fragment.lastChild!;
  let inner = node.content;
  if (fragment.childCount > 1) openEnd = 0;
  if (depth < to - 1) inner = closeRange(inner, side, from, to, depth + 1, openEnd);
  if (depth >= from)
    inner = side < 0 ? node.contentMatchAt(0).fillBefore(inner, openEnd <= depth)!.append(inner)
      : inner.append(node.contentMatchAt(node.childCount).fillBefore(Fragment.empty, true)!);
  return fragment.replaceChild(side < 0 ? 0 : fragment.childCount - 1, node.copy(inner));
}

function insertInline(transaction: Transaction, slice: Slice): void {
  const selection = transaction.selection;
  if (selection instanceof TextSelection && !selection.$from.sameParent(selection.$to)) {
    replaceSelection(transaction, slice);
  } else {
    if (!(selection instanceof TextSelection)) remove(transaction, selection.from, selection.to);
    transaction.insertText(slice.content.textBetween(0, slice.content.size, '', '\n'));
  }
}

function replaceSelection(transaction: Transaction, slice: Slice): void {
  const end = transaction.selection.to;
  const step = transaction.steps.length;
  replace(transaction, transaction.selection.from, end, slice);
  transaction.setSelection(Selection.near(transaction.doc.resolve(transaction.mapping.slice(step).map(end, 1)), -1));
}

function insertBlocks(transaction: Transaction, content: Fragment): void {
  const selection = transaction.selection;
  const { $from, $to } = selection;
  const { paragraph, footnoteDefinition } = transaction.doc.type.schema.nodes;
  const slice = new Slice(content, 0, 0);
  if (!(selection instanceof TextSelection) || !$from.sameParent($to) ||
      $from.parent.type !== paragraph || $from.depth <= 1 || $from.parentOffset !== 0 ||
      $from.node(-1).type !== footnoteDefinition || !content.lastChild?.type.isInGroup('list')) {
    replaceSelection(transaction, slice);
    return;
  }
  // A list inserted at a footnote paragraph's opening owns that retained paragraph as its last
  // continuation. The schema has the label and body directly under the definition.
  transaction.insertText('', $from.pos, $to.pos);
  const field = transaction.selection.$from;
  const start = field.before();
  replace(transaction, start, field.parent.content.size ? start : field.after(), slice);
  const end = start + content.size;
  if (field.parent.content.size) {
    const from = transaction.doc.resolve(end);
    const to = transaction.doc.resolve(end + field.parent.nodeSize);
    const list = content.lastChild;
    const meaning = list.type === list.type.schema.nodes.orderedList ? { startNumber: list.attrs.startNumber } : {};
    wrap(transaction, new NodeRange(from, to, from.depth), list.type, meaning);
    join(transaction, end);
    join(transaction, end - 1);
  }
  transaction.setSelection(Selection.near(transaction.doc.resolve(Math.min(end, transaction.doc.content.size)), -1));
}

/** A structural paste splits an item only when both endpoints address its direct head field.
 * A continuation paragraph or a quote descendant has a different immediate owner. */
function itemHead(selection: Selection): selection is TextSelection {
  const { $from, $to } = selection;
  const { paragraph, heading, listItem } = $from.doc.type.schema.nodes;
  return selection instanceof TextSelection && $from.sameParent($to) &&
    ($from.parent.type === paragraph || $from.parent.type === heading) &&
    $from.depth >= 2 && $from.node(-1).type === listItem && $from.index(-1) === 0;
}

/** Root lists contribute items; consecutive non-list blocks contribute one item together. */
function listItems(content: Fragment, type: NodeType): Fragment {
  const items: Node[] = [];
  let blocks: Node[] = [];
  for (const node of content.content) {
    if (node.type.isInGroup('list') || node.type === type) {
      if (blocks.length) items.push(type.create(null, blocks));
      blocks = [];
      if (node.type === type) items.push(node);
      else items.push(...node.content.content);
    } else blocks.push(node);
  }
  if (blocks.length) items.push(type.create(null, blocks));
  return Fragment.fromArray(items);
}

function paragraphSeam(item: Node, side: 'first' | 'last'): boolean {
  const node = side === 'first' ? item.firstChild : item.lastChild;
  return item.attrs.checked === null && node?.type === item.type.schema.nodes.paragraph;
}

/** Split the destination once; native joins keep the retained characters and their maps. */
function insertItems(transaction: Transaction, content: Fragment): void {
  const { $from, $to } = transaction.selection;
  const item = $from.node(-1);
  const start = $from.before($from.depth - 1);
  const left = $from.parentOffset > 0;
  const right = $to.parentOffset < $to.parent.content.size || item.childCount > 1;
  const items = listItems(content, item.type);
  const first = items.firstChild;
  const last = items.lastChild;
  if (!first || !last) return;
  const paragraph = item.type.schema.nodes.paragraph;
  const joinLeft = left && item.attrs.checked === null && paragraphSeam(first, 'first') &&
    $from.parent.type === paragraph;
  const joinRight = right && item.attrs.checked === null && paragraphSeam(last, 'last') &&
    $to.parent.type === paragraph;
  transaction.insertText('', $from.pos, $to.pos);
  const position = transaction.selection.from;
  split(transaction, position, 2);
  const boundary = position + 2;
  let end = boundary;
  for (const incoming of items.content) {
    insert(transaction, end, item.type, { checked: incoming.attrs.checked }, incoming.content);
    end += incoming.nodeSize;
  }
  const suffix = transaction.doc.nodeAt(end)!;
  if (!left && item.attrs.checked !== null) update(transaction, end, { checked: item.attrs.checked });
  const caret = Selection.near(transaction.doc.resolve(end), -1);
  const followingField = !(caret instanceof TextSelection);
  transaction.setSelection(followingField ? TextSelection.create(transaction.doc, end + 2) : caret);
  if (!right && !followingField) remove(transaction, end, end + suffix.nodeSize);
  else if (joinRight) {
    join(transaction, end);
    join(transaction, end - 1);
  }
  if (!left) remove(transaction, start, boundary);
  else if (joinLeft) {
    join(transaction, boundary);
    join(transaction, boundary - 1);
  }
}

function singleField(content: Fragment): Node | null {
  if (content.childCount !== 1) return null;
  let node = content.firstChild!;
  const { listItem, blockQuote, paragraph, heading, codeBlock } = node.type.schema.nodes;
  let lists = 0;
  while (!node.isTextblock) {
    if (node.type.isInGroup('list')) {
      if (++lists > 1) return null;
    } else if (node.type === listItem) {
      if (node.attrs.checked !== null) return null;
    } else if (node.type !== blockQuote) return null;
    if (node.childCount !== 1) return null;
    node = node.firstChild!;
  }
  if (node.type !== paragraph && node.type !== heading && node.type !== codeBlock) return null;
  const source = fieldSource(node);
  return source && !/[\r\n]/.test(source) ? node : null;
}

export namespace paste {
  /** Plain MIME text is already source. Only its line endings are normalized. */
  export function text(value: string, context: ResolvedPos): Slice {
    const normalized = value.replace(/\r\n?/g, '\n');
    if (!normalized) return Slice.empty;
    return new Slice(Fragment.from(context.doc.type.schema.text(normalized)), 0, 0);
  }

  /** Read ordinary clipboard blocks as a single cell's inline content. Each field
   * keeps its content and starts on a new line; a leaf block contributes its source. */
  export function cell(slice: Slice, context: ResolvedPos): Fragment {
    const reader = new CellReader(context);
    slice.content.forEach(node => reader.read(node));
    return Fragment.fromArray(reader.content);
  }
}

/** The destination and accumulated fields of one clipboard-to-cell reading. */
class CellReader {
  readonly content: Node[] = [];
  private fields = 0;

  constructor(readonly context: ResolvedPos) {}

  read(node: Node): void {
    if (node.isInline) {
      this.content.push(node);
    } else if (node.isTextblock) {
      this.startField();
      this.content.push(...node.content.content);
    } else if (node.isLeaf) {
      const text = unparse.slice(new Slice(Fragment.from(node), 0, 0), this.context);
      if (!text) return;
      this.startField();
      this.content.push(this.context.doc.type.schema.text(text));
    } else {
      node.forEach(child => this.read(child));
    }
  }

  private startField(): void {
    if (this.fields > 0) this.content.push(this.context.doc.type.schema.nodes.lineEnding.create());
    this.fields++;
  }
}
