/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Fragment, Slice, type Node, type ResolvedPos } from 'prosemirror-model';
import { Selection, TextSelection, type SelectionBookmark, type Transaction } from 'prosemirror-state';
import type { Mappable } from 'prosemirror-transform';
import { insert, remove, replace, type PositionMapping, type Shape } from '../transform/transform.js';
import { schema } from '../types/schema.js';
import { meaning } from './meaning.js';

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
    this.anchorBlock = anchorBlock ?? { from: first.from, to: first.to };
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
    const { from, to } = commonBlockRange(this.$from.doc, this.anchorBlock, block);
    const forward = block.from >= this.anchorBlock.from;
    return BlockSelection.create(this.$from.doc, forward ? from : to, forward ? to : from, this.anchorBlock);
  }

  override content(): Slice {
    // Open ancestors describe editing context to the native clipboard fitter. The existing
    // Markdown clipboard serializer removes shared open wrappers for plain-text export.
    return this.$from.doc.slice(this.from, this.to, true);
  }

  override replace(tr: Transaction, content = Slice.empty): void {
    const { from, to } = blockStorageRange(tr.doc, this);
    if (!content.size) {
      remove(tr, from, to);
      return;
    }
    if (content.openStart || content.openEnd) {
      const start = tr.steps.length;
      replace(tr, from, to, content);
      tr.setSelection(Selection.near(tr.doc.resolve(tr.mapping.slice(start).map(to, -1)), -1));
      return;
    }
    let size = 0;
    if (content.content.content.every(node => node.isInline)) {
      insert(tr, from, tr.doc.type.schema.nodes.paragraph, {}, content.content);
      size = content.content.size + 2;
    } else {
      for (const node of content.content.content) {
        insert(tr, from + size, node.type, meaning(node), node.content);
        size += node.nodeSize;
      }
    }
    remove(tr, from + size, to + size);
    tr.setSelection(Selection.near(tr.doc.resolve(from + size - 1), -1));
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

  static create(doc: Node, anchor: number, head: number, anchorBlock?: BlockRange): BlockSelection {
    if (!isBlockRange(doc, Math.min(anchor, head), Math.max(anchor, head)))
      throw new RangeError('Invalid block selection');
    return new BlockSelection(doc.resolve(anchor), doc.resolve(head), anchorBlock);
  }
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

/** List and frontmatter shells contribute neither an owner nor a depth: their entries join
 * the enclosing interaction sequence in source order. Fixed
 * fields remain part of their owner; first paragraphs retain their own Markdown identity. */
export function selectableBlocks(doc: Node): SelectableBlock[] {
  return new BlockTree(doc).blocks;
}

class BlockTree {
  readonly blocks: SelectableBlock[] = [];
  constructor(doc: Node) {
    doc.forEach((node, from) => this.read(node, from, null, false));
  }

  read(node: Node, from: number, parent: SelectableBlock | null, sequenceMember: boolean): void {
    const type = node.type;
    if (type.isInGroup('list') ||
        !sequenceMember &&
        (type === schema.nodes.yamlFrontMatter || type === schema.nodes.yamlMapping ||
        type === schema.nodes.yamlSequence)) {
      this.children(node, from, parent);
    } else if (isSelectable(node, sequenceMember)) {
      const block: SelectableBlock = {
        node, from, to: from + node.nodeSize, parent, depth: parent ? parent.depth + 1 : 0, children: []
      };
      this.blocks.push(block);
      parent?.children.push(block);
      if (type.isInGroup('container') || type.isInGroup('yamlCollection') || type === schema.nodes.yamlPair)
        this.children(node, from, block);
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
  return first?.type === schema.nodes.yamlFrontMatter
    ? [{ from: 2, to: first.nodeSize - 2 },
      { from: first.nodeSize, to: doc.content.size }] : [{ from: 0, to: doc.content.size }];
}

/** Native selection intervals can cross transparent list boundaries. Their visible
 * frontier consists only of maximal interaction blocks; a carrier never gets its own selection
 * decoration, handle or drag identity. This also covers ranges crossing different list shells. */
export function selectedBlocks(doc: Node, range: BlockRange): SelectableBlock[] {
  return new BlockTree(doc).frontier(range);
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

/** Expand endpoints to their lowest common interaction parent. A nested child-to-uncle range
 * owns the containing item, but crossing from the last item to a root paragraph does not own
 * earlier items merely because Markdown stores them in the same UL. Physical endpoints may
 * therefore cross transparent carrier boundaries while retaining complete semantic blocks. */
export function commonBlockRange(doc: Node, first: BlockRange, last: BlockRange): BlockRange {
  return new BlockTree(doc).common(first, last);
}

/** Native replacement must include a carrier's tokens exactly when all its items are selected.
 * Otherwise fitting a cross-carrier range can leave an empty required LI at the source. This
 * expands storage edges only, never the visible selection or its payload. A partially selected
 * UL/OL keeps its remaining items, and an actual container's edges are never expanded here. */
export function blockStorageRange(doc: Node, range: BlockRange): BlockRange {
  let { from, to } = range;
  for (;;) {
    const at = doc.resolve(from);
    if (!at.parent.type.isInGroup('list') || at.parentOffset !== 0 || to < at.end()) break;
    from = at.before();
  }
  for (;;) {
    const at = doc.resolve(to);
    if (!at.parent.type.isInGroup('list') || at.parentOffset !== at.parent.content.size || from > at.start()) break;
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
