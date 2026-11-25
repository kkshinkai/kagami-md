/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Fragment, Slice, type Node, type ResolvedPos, type Schema } from 'prosemirror-model';
import { Selection, TextSelection, type SelectionBookmark, type Transaction } from 'prosemirror-state';
import type { Mappable } from 'prosemirror-transform';
import { insert, remove, replace, type PositionMapping, type Shape } from '../transform/transform.js';
import { schema } from '../types/schema.js';
import { adaptToYAMLTarget, isYAMLCodeBlock, isYAMLTransferNode } from '../unparse/yamltransfer.js';
import { meaning } from './meaning.js';
import { defaultParser } from './parser.js';

/** An interval of complete blocks in the document. */
export interface BlockRange {
  readonly from: number;
  readonly to: number;
}

/** A block and the selectable children it owns. */
export interface SelectableBlock extends BlockRange {
  readonly node: Node;
  readonly parent: SelectableBlock | null;
  readonly depth: number;
  readonly children: SelectableBlock[];
  readonly sequence: BlockRange | null;
}

/** Keep text selection endpoints on their authored text while a structural operation runs. */
export function mapTextSelection(tr: Transaction, apply: (keep?: Shape.Range) => PositionMapping): void {
  const selection = tr.selection;
  const start = tr.steps.length;
  const map = apply(selection instanceof TextSelection ? { from: selection.from, to: selection.to } : undefined);
  if (tr.steps.length > start && selection instanceof TextSelection) {
    tr.setSelection(TextSelection.between(tr.doc.resolve(map(selection.anchor)), tr.doc.resolve(map(selection.head))));
  }
}

/** A directed interval of complete interaction siblings, including open transparent list edges. */
export class BlockSelection extends Selection {
  readonly anchorBlock: BlockRange;

  constructor($anchor: ResolvedPos, $head: ResolvedPos, anchorBlock?: BlockRange) {
    super($anchor, $head);
    const doc = $anchor.doc;
    if (!isBlockRange(doc, this.from, this.to)) throw new RangeError('Invalid block selection');
    if (anchorBlock &&
        (!isBlockRange(doc, anchorBlock.from, anchorBlock.to) || anchorBlock.from < this.from ||
        anchorBlock.to > this.to)) {
      throw new RangeError('Invalid block anchor');
    }
    const blocks = selectedBlocks(doc, this);
    const first = (this.anchor < this.head ? blocks[0] : blocks.at(-1))!;
    // Strip parent/children pointers from `SelectableBlock` inputs so selection state serializes as plain JSON.
    this.anchorBlock = anchorBlock ? { from: anchorBlock.from, to: anchorBlock.to } : { from: first.from, to: first.to };
  }

  override eq(other: Selection): boolean {
    return other instanceof BlockSelection && other.anchor === this.anchor && other.head === this.head &&
      other.anchorBlock.from === this.anchorBlock.from && other.anchorBlock.to === this.anchorBlock.to;
  }

  override map(doc: Node, mapping: Mappable): Selection {
    return this.getBookmark().map(mapping).resolve(doc);
  }

  /** Shift-click keeps the initial block anchor, even when a cross-depth range expands to an
   * ancestor. Extending back toward it must shrink the range instead of unioning the old range.
   * This anchor belongs to the native selection/bookmark, not an out-of-band pointer store. */
  extend(block: BlockRange): BlockSelection {
    return BlockSelection.between(this.$from.doc, this.anchorBlock, block);
  }

  override content(): Slice {
    // Open ancestors describe editing context to the native clipboard fitter. The existing
    // Markdown clipboard serializer removes shared open wrappers for plain-text export.
    return this.$from.doc.slice(this.from, this.to, true);
  }

  override replace(tr: Transaction, content = Slice.empty): void {
    const range = blockStorageRange(tr.doc, this);
    if (!content.size) {
      const seam = remove(tr, range.from, range.to);
      tr.setSelection(Selection.near(tr.doc.resolve(seam)));
      return;
    }
    let target = replacementTargetRange(tr.doc, this, content);
    const first = tr.doc.firstChild;
    // Removing a leading `frontMatter` shell first lets blocks insert at offset 0 (since `frontMatter? block+`
    // rejects body blocks before `frontMatter`), while preserving trailing body content when only part is replaced.
    if (target.from === 0 && first?.type.isInGroup('frontMatter') && target.to >= first.nodeSize) {
      const beforeDocSize = tr.doc.content.size;
      remove(tr, 0, first.nodeSize);
      const remainingTo = Math.max(0, tr.doc.content.size - (beforeDocSize - target.to));
      target = { from: 0, to: remainingTo };
    }
    if (content.openStart > 0 || content.openEnd > 0) {
      const start = tr.steps.length;
      replace(tr, target.from, target.to, content);
      tr.setSelection(Selection.near(tr.doc.resolve(tr.mapping.slice(start).map(target.to, -1)), -1));
      return;
    }
    const inline = content.content.content.every(node => node.isInline);
    const insertParent = tr.doc.resolve(target.from).parent;
    const beforeSize = tr.doc.content.size;
    const caretAfter = insertReplacementContent(tr, target.from, insertParent, content, inline);
    const size = tr.doc.content.size - beforeSize;
    if (target.to > target.from) {
      remove(tr, target.from + size, target.to + size);
    }
    if (caretAfter !== null) {
      tr.setSelection(TextSelection.create(tr.doc, Math.min(caretAfter, tr.doc.content.size)));
    } else {
      const endPos = Math.max(0, Math.min(tr.doc.content.size, target.from + size - 1));
      tr.setSelection(Selection.near(tr.doc.resolve(endPos), -1));
    }
  }

  override replaceWith(tr: Transaction, node: Node): void {
    this.replace(tr, new Slice(Fragment.from(node), 0, 0));
  }
  override getBookmark(): SelectionBookmark {
    return new BlockBookmark(this.anchor, this.head, this.anchorBlock);
  }
  override toJSON(): BlockSelection.JSON {
    return { type: 'block', anchor: this.anchor, head: this.head, anchorBlock: this.anchorBlock };
  }

  static fromJSON(doc: Node, value: BlockSelection.JSON): BlockSelection {
    return BlockSelection.create(doc, value.anchor, value.head, value.anchorBlock);
  }

  static between(doc: Node, anchorBlock: BlockRange, headBlock: BlockRange): BlockSelection {
    const { from, to } = commonBlockRange(doc, anchorBlock, headBlock);
    const forward = headBlock.from >= anchorBlock.from;
    return BlockSelection.create(doc, forward ? from : to, forward ? to : from, anchorBlock);
  }

  static create(doc: Node, anchor: number, head: number, anchorBlock?: BlockRange): BlockSelection {
    if (!isBlockRange(doc, Math.min(anchor, head), Math.max(anchor, head)))
      throw new RangeError('Invalid block selection');
    return new BlockSelection(doc.resolve(anchor), doc.resolve(head), anchorBlock);
  }
}

/**
 * Choose whether replacing `selection` writes inside its YAML container or expands across
 * removable outer shells (`blockStorageRange`). Open slices inside `yamlFrontMatter` and closed
 * inline/YAML slices inside a `yamlCollection` stay within the collection so replacing all entries
 * does not destroy the enclosing frontmatter shell, whereas body blocks replace it.
 */
function replacementTargetRange(doc: Node, selection: BlockSelection, content: Slice): BlockRange {
  const storageRange = blockStorageRange(doc, selection);
  const { $from, $to } = selection;
  if (content.openStart > 0 || content.openEnd > 0) {
    const inYAMLSubtree =
      $from.depth >= 2 && $to.pos <= $from.end(1) && $from.node(1).type === schema.nodes.yamlFrontMatter;
    return inYAMLSubtree ? { from: selection.from, to: selection.to } : storageRange;
  }
  const inYAMLCollection = $from.parent.type.isInGroup('yamlCollection') && $to.parent === $from.parent;
  if (!inYAMLCollection) return storageRange;
  const nodes = content.content.content;
  const inline = nodes.every(node => node.isInline);
  const yamlCompatible = nodes.every(node => isYAMLTransferNode(node) || isYAMLCodeBlock(node));
  if (inline || yamlCompatible) return { from: selection.from, to: selection.to };
  return storageRange;
}

/** Insert `content` at `targetFrom` inside `insertParent`, returning the caret position inside a created YAML scalar or `null`. */
function insertReplacementContent(
  tr: Transaction,
  targetFrom: number,
  insertParent: Node,
  content: Slice,
  inline: boolean,
): number | null {
  const trSchema = tr.doc.type.schema;
  const { yamlMapping, yamlPair, yamlScalar, yamlSequence } = trSchema.nodes;
  if (inline) {
    if (insertParent.type === yamlMapping) {
      const key = yamlScalar.create({ tag: 'string' }, content.content);
      const value = yamlScalar.create({ tag: 'string' });
      insert(tr, targetFrom, yamlPair, {}, Fragment.fromArray([key, value]));
      const found = Selection.findFrom(tr.doc.resolve(targetFrom), 1, true);
      return found ? found.$from.end() : null;
    }
    if (insertParent.type === yamlSequence) {
      insert(tr, targetFrom, yamlScalar, { tag: 'string' }, content.content);
      const found = Selection.findFrom(tr.doc.resolve(targetFrom), 1, true);
      return found ? found.$from.end() : null;
    }
    if (insertParent.type.isInGroup('list')) {
      const paragraph = trSchema.nodes.paragraph.create(null, paragraphInlineContent(content.content, trSchema));
      insert(tr, targetFrom, trSchema.nodes.listItem, { checked: null }, Fragment.from(paragraph));
      return targetFrom + 2 + paragraph.content.size;
    }
    insert(tr, targetFrom, trSchema.nodes.paragraph, {}, paragraphInlineContent(content.content, trSchema));
    return null;
  }
  const beforeSize = tr.doc.content.size;
  for (const node of content.content.content) {
    const pos = targetFrom + (tr.doc.content.size - beforeSize);
    insertReplacementNode(tr, pos, insertParent, node, trSchema);
  }
  return null;
}

/** Insert one block node at `pos`, adapting foreign blocks when `insertParent` is a YAML collection or list. */
function insertReplacementNode(
  tr: Transaction,
  pos: number,
  insertParent: Node,
  node: Node,
  trSchema: Schema,
): void {
  const { listItem, yamlMapping, yamlPair, yamlSequence } = trSchema.nodes;
  if (insertParent.type === yamlMapping || insertParent.type === yamlSequence) {
    // Already compatible YAML entries keep their own explicit tag and quote spelling instead of copying neighbor frames.
    const compatible =
      (insertParent.type === yamlMapping && node.type === yamlPair) ||
      (insertParent.type === yamlSequence && node.type.isInGroup('yamlNode'));
    if (compatible) {
      replace(tr, pos, pos, new Slice(Fragment.from(node), 0, 0));
      return;
    }
    const target = insertParent.type === yamlSequence ? 'sequence' : 'mapping';
    const adapted = adaptToYAMLTarget([node], target, trSchema, { parser: defaultParser });
    if (adapted.nodes.length > 0) {
      replace(tr, pos, pos, new Slice(Fragment.fromArray(adapted.nodes), 0, 0));
    }
    return;
  }
  if (insertParent.type.isInGroup('list')) {
    if (node.type === listItem) {
      insert(tr, pos, listItem, meaning(node), node.content);
    } else if (node.type.isInGroup('list')) {
      let current = pos;
      for (const child of node.content.content) {
        insert(tr, current, child.type, meaning(child), child.content);
        current += tr.doc.nodeAt(current)?.nodeSize ?? child.nodeSize;
      }
    } else if (listItem.validContent(Fragment.from(node))) {
      insert(tr, pos, listItem, { checked: null }, Fragment.from(node));
    }
    return;
  }
  insert(tr, pos, node.type, meaning(node), node.content);
}

export namespace BlockSelection {
  /** The directed range and its original block anchor, as stored in history or JSON. */
  export interface JSON {
    readonly type?: 'block';
    readonly anchor: number;
    readonly head: number;
    readonly anchorBlock?: BlockRange;
  }
}

BlockSelection.prototype.visible = false;
Selection.jsonID('block', BlockSelection);

/** Mappable bookmark preserving a block selection's endpoints and initial anchor block. */
class BlockBookmark implements SelectionBookmark {
  constructor(readonly anchor: number, readonly head: number, readonly anchorBlock: BlockRange) {}

  map(mapping: Mappable): BlockBookmark {
    const forward = this.anchor < this.head;
    // Exclude insertion at either outside edge. Preserve direction for Shift extension and Undo.
    return new BlockBookmark(mapping.map(this.anchor, forward ? 1 : -1), mapping.map(this.head, forward ? -1 : 1),
      { from: mapping.map(this.anchorBlock.from, 1), to: mapping.map(this.anchorBlock.to, -1) });
  }

  resolve(doc: Node): Selection {
    if (isBlockRange(doc, Math.min(this.anchor, this.head), Math.max(this.anchor, this.head))) {
      return BlockSelection.create(doc, this.anchor, this.head,
        isBlockRange(doc, this.anchorBlock.from, this.anchorBlock.to) ? this.anchorBlock : undefined);
    }
    // Deletion/reclassification may remove the entire interval. Its bookmark then resolves to
    // a legal native selection instead of resurrecting a block range inside unrelated content.
    return Selection.near(doc.resolve(Math.max(0, Math.min(this.head, doc.content.size))));
  }
}

/** Only complete document blocks and list items can be independently selected. A definition's
 * fields, Callout title and GFM rows/cells are parts of their owner, even though PM calls them
 * block nodes too. Keep this distinction at the model boundary, not in pointer exceptions. */
function isSelectable(node: Node, sequenceMember: boolean): boolean {
  const type = node.type;
  return sequenceMember || !type.isInGroup('list') && (type.isInGroup('block') || type === schema.nodes.listItem ||
    type === schema.nodes.rawFrontMatter || type === schema.nodes.yamlPair);
}

/** Position span of child blocks owned by `node` between `[from, to]`, or `null` for leaf blocks. */
function childSequenceRange(node: Node, from: number, to: number): BlockRange | null {
  if (node.type === schema.nodes.yamlPair) {
    const value = node.child(1);
    if (!value.type.isInGroup('yamlCollection')) return null;
    const valueFrom = from + 1 + node.child(0).nodeSize;
    return { from: valueFrom + 1, to: valueFrom + value.nodeSize - 1 };
  }
  if (node.type.isInGroup('yamlCollection')) {
    return { from: from + 1, to: to - 1 };
  }
  if (node.type.isInGroup('container')) {
    let start = from + 1;
    for (let index = 0; index < node.childCount; index++) {
      const child = node.child(index);
      if (child.type.isInGroup('block')) break;
      start += child.nodeSize;
    }
    return { from: start, to: to - 1 };
  }
  return null;
}

/** List and frontmatter shells contribute neither an owner nor a depth: their entries join
 * the enclosing interaction sequence in source order. Fixed
 * fields remain part of their owner; first paragraphs retain their own Markdown identity. */
export function selectableBlocks(doc: Node, range?: BlockRange): SelectableBlock[] {
  return range ? new BlockTree(doc, range.from, range.to).blocks : new BlockTree(doc).blocks;
}

/** Flattened and parent-linked interaction tree over all selectable blocks intersecting `[from, to]`. */
class BlockTree {
  readonly blocks: SelectableBlock[] = [];
  constructor(doc: Node, from = 0, to = doc.content.size) {
    doc.forEach((node, offset) => {
      if (offset + node.nodeSize <= from || offset >= to) return;
      this.read(node, offset, null, false);
    });
  }

  read(node: Node, from: number, parent: SelectableBlock | null, sequenceMember: boolean): void {
    const type = node.type;
    if (type.isInGroup('list') ||
        !sequenceMember &&
        (type === schema.nodes.yamlFrontMatter || type === schema.nodes.yamlMapping ||
        type === schema.nodes.yamlSequence)) {
      this.children(node, from, parent);
    } else if (isSelectable(node, sequenceMember)) {
      const to = from + node.nodeSize;
      const sequence = childSequenceRange(node, from, to);
      const block: SelectableBlock = {
        node, from, to, parent, depth: parent ? parent.depth + 1 : 0, children: [], sequence,
      };
      this.blocks.push(block);
      parent?.children.push(block);
      if (sequence || (type === schema.nodes.yamlPair && node.child(0).type.isInGroup('yamlCollection'))) {
        this.children(node, from, block);
      }
    }
  }

  children(node: Node, from: number, parent: SelectableBlock | null): void {
    node.forEach((child, offset) => this.read(child, from + offset + 1, parent,
      node.type === schema.nodes.yamlSequence));
  }

  frontier(range: BlockRange): SelectableBlock[] {
    return this.blocks.filter(block => block.from >= range.from && block.to <= range.to &&
      (!block.parent || block.parent.from < range.from || block.parent.to > range.to));
  }

  common(first: BlockRange, last: BlockRange): BlockRange {
    const members = [...this.frontier(first), ...this.frontier(last)];
    let start = members.reduce((a, b) => a.from < b.from ? a : b);
    let end = members.reduce((a, b) => a.to > b.to ? a : b);
    while (start.parent !== end.parent) {
      if (start.depth >= end.depth) start = start.parent!;
      else end = end.parent!;
    }
    return { from: start.from, to: end.to };
  }
}

/** Root properties and body blocks have no interaction parent, but occupy different native
 * child sequences. Their adjacent end/start boundaries must not be folded together: a drop
 * adopts the mapping's member shape or the body's Markdown shape at those separate points. These
 * storage ranges introduce no selectable owner, handle, highlight or indentation level. */
export function rootBlockSequences(doc: Node): BlockRange[] {
  const first = doc.firstChild;
  if (first?.type !== schema.nodes.yamlFrontMatter) {
    return [{ from: 0, to: doc.content.size }];
  }
  let innerStart = 0;
  let shell: Node = first;
  while (shell.childCount === 1 && !isSelectable(shell.firstChild!, false)) {
    innerStart += 1;
    shell = shell.firstChild!;
  }
  innerStart += 1;
  return [
    { from: innerStart, to: innerStart + shell.content.size },
    { from: first.nodeSize, to: doc.content.size },
  ];
}

/** Native selection intervals can cross transparent list boundaries. Their visible
 * frontier consists only of maximal interaction blocks; a carrier never gets its own selection
 * decoration, handle or drag identity. This also covers ranges crossing different list shells. */
export function selectedBlocks(doc: Node, range: BlockRange): SelectableBlock[] {
  return new BlockTree(doc, range.from, range.to).frontier(range);
}

/** Resolve arbitrary text/field positions through the same ownership tree used by handles and
 * brushing. `end` is exclusive, so an endpoint at the next block's start never selects it. */
export function blockAtPosition(blocks: readonly SelectableBlock[], pos: number,
  end = false): SelectableBlock | undefined {
  let found: SelectableBlock | undefined;
  for (const block of blocks) {
    if ((end ? block.from < pos && pos <= block.to : block.from <= pos && pos < block.to) &&
      (!found || block.depth > found.depth)) found = block;
  }
  return found;
}

/** Replace literal newlines in inline text nodes with `lineEnding` nodes for body paragraph insertion. */
function paragraphInlineContent(content: Fragment, trSchema: Schema): Fragment {
  const nodes: Node[] = [];
  content.forEach(node => {
    if (!node.isText || !node.text?.includes('\n')) {
      nodes.push(node);
      return;
    }
    const parts = node.text.split('\n');
    for (let index = 0; index < parts.length; index++) {
      if (index > 0) nodes.push(trSchema.nodes.lineEnding.create());
      if (parts[index]) nodes.push(trSchema.text(parts[index]!, node.marks));
    }
  });
  return Fragment.fromArray(nodes);
}

/** Expand endpoints to their lowest common interaction parent. A nested child-to-uncle range
 * owns the containing item, but crossing from the last item to a root paragraph does not own
 * earlier items merely because Markdown stores them in the same UL. Physical endpoints may
 * therefore cross transparent carrier boundaries while retaining complete semantic blocks. */
export function commonBlockRange(doc: Node, first: BlockRange, last: BlockRange): BlockRange {
  const from = Math.min(first.from, last.from);
  const to = Math.max(first.to, last.to);
  return new BlockTree(doc, from, to).common(first, last);
}

/** Whether a container is a transparent list or frontmatter shell removed when all children leave. */
function isRemovableShell($pos: ResolvedPos): boolean {
  const parent = $pos.parent;
  if (parent.type.isInGroup('list')) return true;
  if ($pos.depth === 1 && parent.type === schema.nodes.yamlFrontMatter) return true;
  return $pos.depth === 2 && parent.type === schema.nodes.yamlMapping &&
    $pos.node(1).type === schema.nodes.yamlFrontMatter;
}

/** Native replacement must include a carrier's tokens exactly when all its items are selected.
 * Otherwise fitting a cross-carrier range can leave an empty required LI at the source. This
 * expands storage edges only, never the visible selection or its payload. A partially selected
 * UL/OL keeps its remaining items, and an actual container's edges are never expanded here. */
export function blockStorageRange(doc: Node, range: BlockRange): BlockRange {
  let { from, to } = range;
  for (;;) {
    const at = doc.resolve(from);
    if (!isRemovableShell(at) || at.parentOffset !== 0 || to < at.end()) break;
    from = at.before();
    if (to === at.end()) to = at.after();
  }
  for (;;) {
    const at = doc.resolve(to);
    if (!isRemovableShell(at) || at.parentOffset !== at.parent.content.size || from > at.start()) break;
    to = at.after();
  }
  return { from, to };
}

/** Resolve selection ownership before measuring a handle or starting its action. A range
 * can contain a block without that block being one of its operation units: the paragraph
 * inside a selected list item is the common example. Only an exact frontier member may
 * represent the group. An ancestor, descendant or unrelated handle keeps its own identity.
 * Text endpoints may need promotion to complete siblings, but that promotion never transfers
 * the resulting group's authority to the handles of those siblings' descendants. */
export function blockRangeForHandle(doc: Node, selection: Selection, owner: BlockRange): BlockRange {
  if (selection.empty) return { from: owner.from, to: owner.to };
  const tree = new BlockTree(doc);
  let range: BlockRange | null = selection;
  if (!isBlockRange(doc, selection.from, selection.to)) {
    const start = blockAtPosition(tree.blocks, selection.from);
    const end = blockAtPosition(tree.blocks, selection.to, true);
    range = start && end ? tree.common(start, end) : null;
  }
  return range && tree.frontier(range).some(block => block.from === owner.from && block.to === owner.to)
    ? { from: range.from, to: range.to } : { from: owner.from, to: owner.to };
}

/** This predicate is also the contract for bookmarks restored after history/reconciliation.
 * Positions alone are insufficient: a mapped boundary can end up inside a text or fixed field. */
export function isBlockRange(doc: Node, from: number, to: number): boolean {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from >= to || to > doc.content.size) return false;
  // Whole-document selection includes the transparent frontmatter shell and the body.
  // Partial ranges still require complete siblings in one interaction sequence.
  if (from === 0 && to === doc.content.size) return true;
  const left = doc.resolve(from);
  const right = doc.resolve(to);
  if (left.textOffset || right.textOffset) return false;
  if (left.sameParent(right)) {
    for (let index = left.index(); index < right.index(); index++) {
      const node = left.parent.child(index);
      if (!isSelectable(node, left.parent.type === schema.nodes.yamlSequence) && !node.type.isInGroup('list'))
        return false;
    }
    return left.index() < right.index();
  }
  const members = selectedBlocks(doc, { from, to });
  if (!members.length || members.some(block => block.parent !== members[0]!.parent)) return false;
  // Only list opening/closing tokens may lie between the physical interval and its frontier.
  // A partial item/quote/field must never masquerade as a whole-block selection.
  let start = from;
  let end = members.at(-1)!.to;
  while (start < members[0]!.from && doc.nodeAt(start)?.type.isInGroup('list')) start++;
  while (end < to) {
    const at = doc.resolve(end);
    if (!at.parent.type.isInGroup('list') || at.parentOffset !== at.parent.content.size) return false;
    end = at.after();
  }
  return start === members[0]!.from && end === to;
}
