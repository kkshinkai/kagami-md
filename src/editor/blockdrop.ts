/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Fragment, Slice, type Node, type NodeType } from 'prosemirror-model';
import { isolateHistory } from '../state/history.js';
import { type EditorState, type Transaction } from 'prosemirror-state';
import { insert, split, replace, remove, carrier } from '../transform/transform.js';
import { unparseSlice, type unparse } from '../unparse/unparse.js';
import { adaptToYAMLTarget, isYAMLTransferNode, yamlEntriesToCodeBlock } from '../unparse/yamltransfer.js';
import { Source } from '../source/index.js';
import { getParser } from '../state/parser.js';
import type { Parser } from '../syntax/index.js';
import { schema } from '../types/schema.js';
import {
  BlockSelection,
  isBlockRange,
  selectableBlocks,
  selectedBlocks,
  rootBlockSequences,
  commonBlockRange,
  blockStorageRange,
  type BlockRange,
  type SelectableBlock,
} from '../state/selection.js';

/** Candidate drop slot resolved against a document's selectable block tree. */
export interface DropIntent {
  readonly parent: SelectableBlock | null;
  readonly parentPos: number;
  readonly index: number;
  readonly boundary: number;
}

/** Whether `payload` consists solely of list items eligible to join `parent` without a wrapper list. */
function canDirectListTarget(parent: Node, payload: readonly SelectableBlock[]): boolean {
  if (!parent.type.isInGroup('list')) return false;
  if (!payload.every(block => block.node.type === schema.nodes.listItem)) return false;
  return !(
    parent.type === schema.nodes.orderedList &&
    payload.some(block => block.node.attrs.checked !== null)
  );
}

/** Create default placeholder nodes for `types`, or `null` if empty or any type fails to fill. */
function fillAllTypes(types: readonly NodeType[]): Fragment | null {
  if (types.length === 0) return null;
  const nodes: Node[] = [];
  for (const type of types) {
    const filled = type.createAndFill();
    if (!filled) return null;
    nodes.push(filled);
  }
  return Fragment.fromArray(nodes);
}

/** Moving across the YAML boundary converts YAML entries to a `yaml` codeBlock in the body,
 * parses `yaml` codeBlocks back into structured YAML entries, and encodes other Markdown blocks
 * as scalar string entries inside a YAML collection. */
function yamlDropPayload(
  doc: Node,
  payload: readonly SelectableBlock[],
  targetParent: Node,
  options: unparse.Options,
  parser: Parser,
): Fragment {
  const documentSchema = doc.type.schema;
  const { yamlMapping, yamlSequence } = documentSchema.nodes;
  if (targetParent.type === yamlMapping || targetParent.type === yamlSequence) {
    const target = targetParent.type === yamlSequence ? 'sequence' : 'mapping';
    const nodes: Node[] = [];
    for (const block of payload) {
      const adapted = adaptToYAMLTarget([block.node], target, documentSchema, {
        parser,
        blockText: node => unparseSlice(new Slice(Fragment.from(node), 0, 0), doc.resolve(block.from), options),
      });
      nodes.push(...adapted.nodes);
    }
    return Fragment.fromArray(nodes);
  }
  return encodeDroppedBodyBlocks(doc, payload);
}

/** Append one body block into `nodes`, grouping contiguous standalone `listItem`s under their original list shell. */
function appendBodyBlock(
  doc: Node,
  block: SelectableBlock,
  directList: boolean,
  nodes: Node[],
  shellPos: number | null,
): number | null {
  if (block.node.type !== schema.nodes.listItem || directList) {
    nodes.push(block.node);
    return null;
  }
  const original = doc.resolve(block.from);
  const previous = nodes.at(-1);
  if (shellPos === original.before() && previous) {
    nodes[nodes.length - 1] = previous.copy(previous.content.append(Fragment.from(block.node)));
  } else {
    nodes.push(carrier(original.parent, Fragment.from(block.node), original));
  }
  return original.before();
}

/** Convert contiguous YAML entry runs in `payload` into `yaml` code blocks while keeping body blocks wrapped in shells. */
function encodeDroppedBodyBlocks(doc: Node, payload: readonly SelectableBlock[]): Fragment {
  const documentSchema = doc.type.schema;
  const { yamlSequence } = documentSchema.nodes;
  const nodes: Node[] = [];
  let shellPos: number | null = null;
  for (let index = 0; index < payload.length;) {
    const first = payload[index]!;
    if (!isYAMLTransferNode(first.node)) {
      shellPos = appendBodyBlock(doc, first, false, nodes, shellPos);
      index++;
      continue;
    }
    shellPos = null;
    // Group maximal same-collection runs (`mapping` vs `sequence`) so adjacent properties serialize into one code block.
    const fromSequence = doc.resolve(first.from).parent.type === yamlSequence;
    const entries: Node[] = [first.node];
    let end = index + 1;
    while (end < payload.length) {
      const next = payload[end]!;
      const nextIsYAML = isYAMLTransferNode(next.node);
      if (!nextIsYAML || (doc.resolve(next.from).parent.type === yamlSequence) !== fromSequence) break;
      entries.push(next.node);
      end++;
    }
    const code = yamlEntriesToCodeBlock(entries, documentSchema, fromSequence ? 'sequence' : 'mapping');
    if (code) nodes.push(code);
    index = end;
  }
  return Fragment.fromArray(nodes);
}

/** Drag targets are logical block siblings. The only extra frames required to realize a
 * Markdown target are a selected item's existing shell and a split at a list boundary. */
export function blockDropIntents(doc: Node, source: BlockRange): DropIntent[] {
  if (!isBlockRange(doc, source.from, source.to)) return [];
  return new DropTargets(doc, source).read();
}

/** Precomputed block frontier and lightweight schema probes reused across every candidate drop slot. */
class DropTargets {
  private readonly payload: SelectableBlock[];
  private readonly blocks: SelectableBlock[];
  private readonly hasYAMLPayload: boolean;
  private readonly directItemProbe: Fragment | null;
  private readonly siblingProbe: Fragment | null;
  private readonly yamlMappingProbe: Fragment;
  private readonly yamlSequenceProbe: Fragment;
  private readonly yamlToBodyProbe: Fragment | null;
  private readonly result: DropIntent[] = [];

  constructor(
    private readonly doc: Node,
    private readonly source: BlockRange,
  ) {
    this.payload = selectedBlocks(doc, source);
    this.blocks = selectableBlocks(doc);
    this.hasYAMLPayload = this.payload.some(block => isYAMLTransferNode(block.node));
    const { codeBlock, listItem, yamlPair, yamlScalar } = doc.type.schema.nodes;
    const siblingTypes = this.payload.map(block =>
      block.node.type === listItem ? doc.resolve(block.from).parent.type : block.node.type,
    );
    const allListItems = this.payload.length > 0 && this.payload.every(block => block.node.type === listItem);
    this.directItemProbe = allListItems ? fillAllTypes(this.payload.map(block => block.node.type)) : null;
    this.siblingProbe = fillAllTypes(siblingTypes);
    const emptyPair = yamlPair.createAndFill();
    this.yamlMappingProbe = emptyPair ? Fragment.from(emptyPair) : Fragment.empty;
    this.yamlSequenceProbe = Fragment.from(yamlScalar.create());
    if (this.hasYAMLPayload) {
      const bodyProbeNodes: Node[] = [];
      for (let index = 0; index < this.payload.length; index++) {
        const type = isYAMLTransferNode(this.payload[index]!.node) ? codeBlock : siblingTypes[index]!;
        const filled = type.createAndFill();
        if (filled) bodyProbeNodes.push(filled);
      }
      this.yamlToBodyProbe = bodyProbeNodes.length > 0 ? Fragment.fromArray(bodyProbeNodes) : null;
    } else {
      this.yamlToBodyProbe = null;
    }
  }

  /** Return all valid drop slots across root sequences and non-selected nested container sequences. */
  read(): DropIntent[] {
    if (this.payload.length === 0) return [];
    const roots = this.blocks.filter(block => !block.parent);
    let indexOffset = 0;
    for (const sequence of rootBlockSequences(this.doc)) {
      const children = roots.filter(block => block.from >= sequence.from && block.to <= sequence.to);
      this.add(null, children, sequence.from, indexOffset);
      indexOffset += children.length;
    }
    for (const block of this.blocks) {
      if (block.from >= this.source.from && block.to <= this.source.to) continue;
      if (block.sequence) this.add(block, block.children, block.sequence.from);
    }
    return this.result;
  }

  /** Select the precomputed schema probe that tests fit into `targetParent` without measuring text values. */
  private probeFor(targetParent: Node, directItems: boolean): Fragment | null {
    if (directItems) return this.directItemProbe;
    const { yamlMapping, yamlSequence } = targetParent.type.schema.nodes;
    if (targetParent.type === yamlMapping) return this.yamlMappingProbe;
    if (targetParent.type === yamlSequence) return this.yamlSequenceProbe;
    return this.hasYAMLPayload ? this.yamlToBodyProbe : this.siblingProbe;
  }

  /** Append every child boundary in `children` whose owning target accepts the dragged payload probe. */
  private add(
    parent: SelectableBlock | null,
    children: readonly SelectableBlock[],
    start: number,
    indexOffset = 0,
  ): void {
    for (let index = 0; index <= children.length; index++) {
      const boundary = children[index]?.from ?? children.at(-1)?.to ?? start;
      const at = this.doc.resolve(boundary);
      const directItems = canDirectListTarget(at.parent, this.payload);
      const target = at.parent.type.isInGroup('list') && !directItems ? this.doc.resolve(at.before()) : at;
      const probe = this.probeFor(target.parent, directItems);
      if (
        !probe ||
        probe.childCount === 0 ||
        !target.parent.canReplace(target.index(), target.index(), probe)
      ) {
        continue;
      }
      this.result.push({ parent, parentPos: parent?.from ?? -1, index: indexOffset + index, boundary });
    }
  }
}

/** A logical sibling of an item stands outside its physical list carrier. */
function outsideList(tr: Transaction, boundary: number): number {
  const at = tr.doc.resolve(boundary);
  if (!at.parent.type.isInGroup('list')) return boundary;
  if (!at.parentOffset) return at.before();
  if (at.parentOffset === at.parent.content.size) return at.after();
  split(tr, boundary, 1);
  return boundary + 1;
}

/** Step a boundary pointing outside a list into an immediately adjacent compatible list when dropping items. */
function snapIntoAdjacentList(doc: Node, boundary: number, blocks: readonly SelectableBlock[]): number {
  const allItems = blocks.every(block => block.node.type === schema.nodes.listItem);
  const at = doc.resolve(boundary);
  if (!allItems || at.parent.type.isInGroup('list')) return boundary;
  const kind = doc.resolve(blocks[0]!.from).parent.type;
  if (at.nodeBefore?.type === kind && at.nodeBefore.type.isInGroup('list')) return boundary - 1;
  if (at.nodeAfter?.type === kind && at.nodeAfter.type.isInGroup('list')) return boundary + 1;
  return boundary;
}

/** Materialize the moved blocks for Markdown containers, grouping contiguous standalone list items in carriers. */
function buildDroppedFragment(
  state: EditorState,
  blocks: readonly SelectableBlock[],
  targetParent: Node,
  directList: boolean,
): Fragment {
  if (targetParent.type.isInGroup('yamlCollection') || blocks.some(block => isYAMLTransferNode(block.node))) {
    return yamlDropPayload(state.doc, blocks, targetParent, Source.get(state).options, getParser(state));
  }
  const nodes: Node[] = [];
  let shellPos: number | null = null;
  for (const block of blocks) {
    shellPos = appendBodyBlock(state.doc, block, directList, nodes, shellPos);
  }
  return Fragment.fromArray(nodes);
}

/** Isolate the storage edges of a partially selected list so tail spelling stays with the removed slice. */
function splitPartialListEdges(
  tr: Transaction,
  range: BlockRange,
  target: number,
): { readonly range: BlockRange; readonly target: number } {
  let { from, to } = range;
  const finish = tr.doc.resolve(to);
  if (finish.parent.type.isInGroup('list') && finish.index() < finish.parent.childCount) {
    const step = tr.steps.length;
    split(tr, to, 1);
    target = tr.mapping.slice(step).map(target, -1);
  }
  const beginning = tr.doc.resolve(from);
  if (beginning.parent.type.isInGroup('list') && beginning.index() > 0) {
    const step = tr.steps.length;
    split(tr, from, 1);
    target = tr.mapping.slice(step).map(target, -1);
    // Splitting at `from` inserts a 2-token `</list><list>` seam before `from`, shifting the range right.
    from += 2;
    to += 2;
  }
  return { range: { from, to }, target };
}

/** Keep leading paragraph carriers on task items whose head would become empty or non-paragraph during a move. */
function preserveTaskItemCarriers(
  tr: Transaction,
  range: BlockRange,
  target: number,
  firstInserted: Node | null,
): { readonly range: BlockRange; readonly target: number } {
  let { from, to } = range;
  const destination = tr.doc.resolve(target);
  if (
    destination.parent.type === schema.nodes.listItem &&
    destination.parent.attrs.checked !== null &&
    destination.index() === 0 &&
    firstInserted?.type !== schema.nodes.paragraph
  ) {
    const step = tr.steps.length;
    // Task items retain `checked` only when child 0 is a paragraph; seed an empty paragraph before non-paragraph drops.
    insert(tr, target, tr.doc.type.schema.nodes.paragraph, {});
    target += 2;
    from = tr.mapping.slice(step).map(from, 1);
    to = tr.mapping.slice(step).map(to, -1);
  }
  const origin = tr.doc.resolve(from);
  if (
    origin.parent.type === schema.nodes.listItem &&
    origin.parent.attrs.checked !== null &&
    origin.parentOffset === 0 &&
    to === origin.end()
  ) {
    const step = tr.steps.length;
    insert(tr, from, tr.doc.type.schema.nodes.paragraph, {});
    target = tr.mapping.slice(step).map(target, -1);
    from += 2;
    to += 2;
  }
  return { range: { from, to }, target };
}

/** Map the inserted byte range across post-insert steps into a complete `BlockSelection`. */
function selectInsertedBlockRange(tr: Transaction, beforeInsertStep: number, fallbackPos: number): BlockSelection {
  let start = fallbackPos;
  let end = fallbackPos;
  tr.mapping.maps[beforeInsertStep]!.forEach((_from, _to, newFrom, newTo) => {
    start = newFrom;
    end = newTo;
  });
  const afterInsert = tr.mapping.slice(beforeInsertStep + 1);
  const inserted = selectedBlocks(tr.doc, { from: afterInsert.map(start, 1), to: afterInsert.map(end, -1) });
  const first = inserted[0];
  const last = inserted.at(-1);
  if (!first || !last) throw new RangeError('The drop did not insert selectable blocks');
  const range = commonBlockRange(tr.doc, first, last);
  return BlockSelection.create(tr.doc, range.from, range.to);
}

/** Delete the dragged range and insert its slice at the mapped target, as
 * prosemirror-view's drop does. The selection comes from the insertion's range. */
export function moveBlocks(state: EditorState, source: BlockRange, intent: DropIntent): Transaction | null {
  if (intent.boundary >= source.from && intent.boundary <= source.to) return null;
  const current = blockDropIntents(state.doc, source).find(
    candidate =>
      candidate.parentPos === intent.parentPos &&
      candidate.index === intent.index &&
      candidate.boundary === intent.boundary,
  );
  if (!current) return null;
  const blocks = selectedBlocks(state.doc, source);
  if (!blocks.length) return null;
  const tr = isolateHistory(state.tr);
  let target = snapIntoAdjacentList(state.doc, intent.boundary, blocks);
  const at = tr.doc.resolve(target);
  const direct = canDirectListTarget(at.parent, blocks);
  const parent = !direct && at.parent.type.isInGroup('list') ? tr.doc.resolve(at.before()).parent : at.parent;
  const content = buildDroppedFragment(state, blocks, parent, direct);
  const splitState = splitPartialListEdges(tr, source, target);
  const preserved = preserveTaskItemCarriers(tr, splitState.range, splitState.target, content.firstChild ?? null);
  const storage = blockStorageRange(tr.doc, preserved.range);
  const beforeDelete = tr.steps.length;
  remove(tr, storage.from, storage.to);
  target = tr.mapping.slice(beforeDelete).map(preserved.target);
  if (!direct) target = outsideList(tr, target);
  const beforeInsert = tr.steps.length;
  const beforeDoc = tr.doc;
  replace(tr, target, target, new Slice(content, 0, 0));
  if (tr.doc.eq(beforeDoc)) return null;
  tr.setSelection(selectInsertedBlockRange(tr, beforeInsert, target));
  return tr.setMeta('uiEvent', 'drop');
}
