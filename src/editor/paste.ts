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
import { NodeSelection, Selection, TextSelection, type EditorState, type Transaction } from 'prosemirror-state';
import { BlockSelection } from '../state/selection.js';
import { Source } from '../source/index.js';
import { getParser } from '../state/parser.js';
import {
  hasClipboardSlice, isInsideCarriedField, readCarriedTree,
} from '../types/annotations.js';
import { alignment, type Alignment } from '../types/schema.js';
import { defaultUnparseOptions, unparseSlice } from '../unparse/unparse.js';
import {
  adaptToYAMLTarget, classifyYAMLSlice, isYAMLCodeBlock, peelOpenWrapperSlice, yamlSliceToBody,
  type YAMLAdaptOptions, type YAMLSlice, type YAMLTarget,
} from '../unparse/yamltransfer.js';
import { fieldSource } from '../parse/field.js';
import { insert, join, remove, replace, split, update, wrap } from '../transform/transform.js';
import { isolateHistory } from '../state/history.js';

/** Insert a clipboard slice, preserving the destination's structural ownership. */
export function paste(state: EditorState, content: Slice, html = '', plainText?: string): Transaction | null {
  if (isSelectionInYAMLFrontMatter(state)) return pasteIntoYAML(state, content, plainText);
  const { slice, itemHead } = new PasteContext(state).read(content, html);
  if (!slice.size) return null;
  const transaction = isolateHistory(state.tr);
  if (itemHead) insertItems(transaction, slice.content);
  else if (slice.content.content.every(node => node.isInline)) insertInline(transaction, slice);
  else if (slice.openStart || slice.openEnd) replaceSelection(transaction, slice);
  else insertBlocks(transaction, slice.content);
  return finishPaste(transaction);
}

/** Whether `state.selection` falls wholly inside the leading `yamlFrontMatter` subtree. */
function isSelectionInYAMLFrontMatter(state: EditorState): boolean {
  const first = state.doc.firstChild;
  return (
    first?.type === state.schema.nodes.yamlFrontMatter &&
    state.selection.from > 0 &&
    state.selection.to <= first.nodeSize
  );
}

/** Mark a paste transaction with ProseMirror paste metadata and scroll the caret into view. */
function finishPaste(tr: Transaction): Transaction {
  return tr.setMeta('paste', true).setMeta('uiEvent', 'paste').scrollIntoView();
}

/** Classify a pasted slice for YAML containers and close open edges after peeling outer wrappers. */
function closedYAMLSlice(content: Slice): { readonly classified: YAMLSlice; readonly closed: Slice } {
  const classified = classifyYAMLSlice(content);
  const closed = classified.kind === 'entries'
    ? new Slice(classified.entries, 0, 0)
    : closeSlice(peelOpenWrapperSlice(content), 0, 0);
  return { classified, closed };
}

/** Build `adaptToYAMLTarget` options bound to the active parser and unparser around `state.selection.$from`. */
function yamlPasteAdaptOptions(state: EditorState): YAMLAdaptOptions {
  const options = Source.get(state).options;
  const contextPos = state.selection.$from;
  return {
    parser: getParser(state),
    blockText: sourceNode => unparseSlice(new Slice(Fragment.from(sourceNode), 0, 0), contextPos, options),
  };
}

/** Handle clipboard pastes targeting a YAML front matter node across scalar, boolean, and block selections. */
function pasteIntoYAML(state: EditorState, content: Slice, plainText?: string): Transaction | null {
  const { selection } = state;
  const { yamlScalar } = state.schema.nodes;
  if (
    selection instanceof TextSelection &&
    selection.$from.sameParent(selection.$to) &&
    selection.$from.parent.type === yamlScalar
  ) {
    return pasteIntoYAMLScalar(state, selection, content, plainText);
  }
  const { closed } = closedYAMLSlice(content);
  if (closed.size === 0) return null;
  const adaptOptions = yamlPasteAdaptOptions(state);
  if (
    selection instanceof NodeSelection &&
    selection.node.type === yamlScalar &&
    selection.node.attrs.tag === 'boolean'
  ) {
    return pasteIntoBooleanScalar(state, selection, closed.content.content, adaptOptions);
  }
  if (selection instanceof BlockSelection) {
    return pasteIntoYAMLBlockSelection(state, selection, closed.content.content, adaptOptions);
  }
  return null;
}

/** Paste structured YAML into an empty placeholder scalar, or normalized plain text into any active YAML scalar. */
function pasteIntoYAMLScalar(
  state: EditorState,
  selection: TextSelection,
  content: Slice,
  plainText?: string,
): Transaction | null {
  const placeholder = emptyYAMLPlaceholder(selection);
  if (placeholder !== null) {
    const { classified, closed } = closedYAMLSlice(content);
    if (
      classified.kind === 'entries' ||
      (closed.size > 0 && closed.content.content.every(isYAMLCodeBlock))
    ) {
      if (placeholder.kind === 'value') {
        const adapted = adaptToYAMLTarget(
          closed.content.content,
          'value',
          state.schema,
          yamlPasteAdaptOptions(state),
        );
        const valueNode = adapted.kind === 'value'
          ? adapted.node
          : (adapted.nodes.length > 0 ? state.schema.nodes.yamlMapping.create(null, adapted.nodes) : null);
        if (!valueNode) return null;
        const transaction = isolateHistory(state.tr);
        replace(transaction, placeholder.from, placeholder.to, new Slice(Fragment.from(valueNode), 0, 0));
        transaction.setSelection(Selection.near(transaction.doc.resolve(placeholder.from), 1));
        return finishPaste(transaction);
      }
      const adapted = adaptToYAMLTarget(
        closed.content.content,
        placeholder.target,
        state.schema,
        yamlPasteAdaptOptions(state),
      );
      if (adapted.nodes.length === 0) return null;
      const transaction = isolateHistory(state.tr);
      BlockSelection.create(state.doc, placeholder.from, placeholder.to)
        .replace(transaction, new Slice(Fragment.fromArray(adapted.nodes), 0, 0));
      return finishPaste(transaction);
    }
  }
  const raw = plainText
    ? plainText.replace(/\r\n?/g, '\n')
    : content.content.textBetween(0, content.content.size, '\n');
  const text = raw.replace(/\u0000/g, '\uFFFD');
  if (!text && selection.empty) return null;
  return finishPaste(isolateHistory(state.tr).insertText(text));
}

/** Replace an atomic boolean YAML scalar with an adapted value or entry sequence, updating its owning slot. */
function pasteIntoBooleanScalar(
  state: EditorState,
  selection: NodeSelection,
  nodes: readonly Node[],
  adaptOptions: YAMLAdaptOptions,
): Transaction {
  const { yamlMapping, yamlPair, yamlSequence } = state.schema.nodes;
  const parent = selection.$from.parent;
  const isPairKey = parent.type === yamlPair && selection.$from.index() === 0;
  let target: YAMLTarget = 'mapping';
  if (parent.type === yamlPair) target = 'value';
  else if (parent.type === yamlSequence) target = 'sequence';
  const adapted = adaptToYAMLTarget(nodes, target, state.schema, adaptOptions);
  const transaction = isolateHistory(state.tr);
  switch (adapted.kind) {
    case 'value':
      replace(transaction, selection.from, selection.to, new Slice(Fragment.from(adapted.node), 0, 0));
      transaction.setSelection(Selection.near(transaction.doc.resolve(selection.from), 1));
      break;
    case 'entries': {
      // Pasting onto a pair key (`false: KEEP`) keeps the unselected pair value intact instead of dropping the pair.
      if (isPairKey) {
        const keyNode = yamlMapping.create({ flow: true }, adapted.nodes);
        replace(transaction, selection.from, selection.to, new Slice(Fragment.from(keyNode), 0, 0));
        transaction.setSelection(Selection.near(transaction.doc.resolve(selection.from), 1));
        break;
      }
      const range = parent.type === yamlPair
        ? { from: selection.$from.before(), to: selection.$from.after() }
        : { from: selection.from, to: selection.to };
      BlockSelection.create(state.doc, range.from, range.to)
        .replace(transaction, new Slice(Fragment.fromArray(adapted.nodes), 0, 0));
      break;
    }
  }
  return finishPaste(transaction);
}

/** Adapt clipboard blocks or YAML entries to replace a `BlockSelection` inside YAML front matter. */
function pasteIntoYAMLBlockSelection(
  state: EditorState,
  selection: BlockSelection,
  nodes: readonly Node[],
  adaptOptions: YAMLAdaptOptions,
): Transaction {
  const target: YAMLTarget = selection.$from.parent.type === state.schema.nodes.yamlSequence
    ? 'sequence'
    : 'mapping';
  const adapted = adaptToYAMLTarget(nodes, target, state.schema, adaptOptions);
  const transaction = isolateHistory(state.tr);
  selection.replace(transaction, new Slice(Fragment.fromArray(adapted.nodes), 0, 0));
  return finishPaste(transaction);
}

type EmptyYAMLPlaceholder =
  | { readonly kind: 'collection'; readonly from: number; readonly to: number; readonly target: 'mapping' | 'sequence' }
  | { readonly kind: 'value'; readonly from: number; readonly to: number };

/** Target replacement range when the caret sits inside an empty YAML pair, sequence scalar, or named pair value. */
function emptyYAMLPlaceholder(selection: Selection): EmptyYAMLPlaceholder | null {
  if (!(selection instanceof TextSelection) || !selection.empty) return null;
  const { $from } = selection;
  const { yamlPair, yamlScalar, yamlSequence } = $from.doc.type.schema.nodes;
  if ($from.parent.type !== yamlScalar || $from.parent.content.size > 0 || $from.depth < 2) return null;
  const owner = $from.node(-1);
  if (owner.type === yamlPair &&
      owner.child(0).content.size === 0 && owner.child(1).content.size === 0 &&
      $from.depth >= 3) {
    return { kind: 'collection', from: $from.before(-1), to: $from.after(-1), target: 'mapping' };
  }
  if (owner.type === yamlPair && $from.index(-1) === 1 && $from.depth >= 3) {
    return { kind: 'value', from: $from.before(), to: $from.after() };
  }
  if (owner.type === yamlSequence) {
    return { kind: 'collection', from: $from.before(), to: $from.after(), target: 'sequence' };
  }
  return null;
}

/** Decoded clipboard slice and whether insertion targets a list item's first line. */
interface Insertion {
  readonly slice: Slice;
  readonly itemHead: boolean;
}

/** Resolve the insertion's ownership before changing its destination. */
class PasteContext {
  constructor(readonly state: EditorState) {}

  /** Decode body clipboard data, honoring carried inline fields, table fragments, and item heads. */
  read(slice: Slice, html: string): Insertion {
    const yaml = yamlSliceToBody(slice, this.state.selection.from === 0);
    slice = yaml.slice;
    if (yaml.converted && !slice.content.size) return { slice: Slice.empty, itemHead: false };
    if ((!yaml.converted && !html) || slice.content.firstChild?.isInline) return { slice, itemHead: false };
    const dom = html ? new globalThis.DOMParser().parseFromString(html, 'text/html').body : null;
    if (dom) {
      const carried = readCarriedTree(dom, this.state.schema);
      if (carried && isInsideCarriedField(carried.fragment, carried.carrier)) {
        let field = slice.content.childCount === 1 ? slice.content.firstChild : null;
        while (field && !field.isTextblock && field.childCount === 1) field = field.firstChild;
        if (field?.isTextblock) return { slice: new Slice(field.content, 0, 0), itemHead: false };
      }
      const matrix = this.matrix(slice.content, dom);
      if (matrix) return matrix;
      if (hasClipboardSlice(dom)) return { slice, itemHead: false };
    }
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

  /** Reconstruct a table node and column alignments when pasted content holds only table rows or cells. */
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
export function closeSlice(slice: Slice, openStart: number, openEnd: number): Slice {
  if (openStart < slice.openStart)
    slice = new Slice(closeRange(slice.content, -1, openStart, slice.openStart, 0, slice.openEnd), openStart,
      slice.openEnd);
  if (openEnd < slice.openEnd)
    slice = new Slice(closeRange(slice.content, 1, openEnd, slice.openEnd, 0, 0), slice.openStart, openEnd);
  return slice;
}

/** Recursively fill required children on one side of a fragment from outer depth `to` down to `from`. */
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

/** Insert an inline clipboard slice as literal text into the active selection or block replacement. */
function insertInline(transaction: Transaction, slice: Slice): void {
  const selection = transaction.selection;
  const schema = transaction.doc.type.schema;
  if (selection instanceof BlockSelection) {
    const text = slice.content.textBetween(0, slice.content.size, '', '\n');
    selection.replace(transaction, text ? new Slice(Fragment.from(schema.text(text)), 0, 0) : Slice.empty);
    return;
  }
  if (!selection.empty) {
    const pos = remove(transaction, selection.from, selection.to);
    if (selection instanceof TextSelection) {
      const seam = Selection.near(transaction.doc.resolve(pos));
      transaction.setSelection(seam);
    }
  }
  transaction.insertText(slice.content.textBetween(0, slice.content.size, '', '\n'));
}

/** Replace the transaction's selection with `slice` and place the caret near the trailing seam. */
function replaceSelection(transaction: Transaction, slice: Slice): void {
  const after = replace(transaction, transaction.selection.from, transaction.selection.to, slice);
  transaction.setSelection(Selection.near(transaction.doc.resolve(after), -1));
}

/** Insert block `content`, wrapping any retained footnote continuation paragraph into a pasted trailing list. */
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

/** Whether the first or last child of `item` is an ordinary untasked `paragraph` able to join inline text. */
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
  // Splitting at depth 2 inserts `</paragraph></listItem><listItem><paragraph>` (2 tokens) before the suffix item.
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
  // `end` opens the suffix `listItem` (+1) and its first block (+1), landing at its start.
  transaction.setSelection(followingField ? TextSelection.create(transaction.doc, end + 2) : caret);
  if (!right && !followingField) remove(transaction, end, end + suffix.nodeSize);
  else if (joinRight) {
    // Join the adjacent `listItem` shells at `end`, then merge the trailing seam paragraphs at `end - 1`.
    join(transaction, end);
    join(transaction, end - 1);
  }
  if (!left) remove(transaction, start, boundary);
  else if (joinLeft) {
    join(transaction, boundary);
    join(transaction, boundary - 1);
  }
}

/** Unwrap a single single-line field wrapped only by list/quote containers for mid-paragraph inline pasting. */
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

/** Plain MIME text is already source. Only its line endings are normalized. */
export function plainTextSlice(value: string, context: ResolvedPos): Slice {
  const normalized = value.replace(/\r\n?/g, '\n');
  if (!normalized) return Slice.empty;
  return new Slice(Fragment.from(context.doc.type.schema.text(normalized)), 0, 0);
}

/** Read ordinary clipboard blocks as a single cell's inline content. Each field
 * keeps its content and starts on a new line; a leaf block contributes its source. */
export function cellPasteContent(slice: Slice, context: ResolvedPos): Fragment {
  const reader = new CellReader(context);
  slice.content.forEach(node => reader.read(node));
  return Fragment.fromArray(reader.content);
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
      // A leaf block has no edge mark and is never left out, so the options do not reach it.
      const text = unparseSlice(new Slice(Fragment.from(node), 0, 0), this.context, defaultUnparseOptions);
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
