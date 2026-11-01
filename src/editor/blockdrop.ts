/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { schema } from '../types/schema.js';
import { Fragment, Slice, type Node } from 'prosemirror-model';
import { history } from '../state/history.js';
import { type EditorState, type Transaction } from 'prosemirror-state';
import { insert, split, replace, remove, carrier } from '../transform/transform.js';
import { unparse } from '../unparse/unparse.js';
import { Bindings, parseBlocks } from '../syntax/index.js';
import { parse } from '../parse/parse.js';
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

export interface DropIntent {
  readonly parent: SelectableBlock | null;
  readonly parentPos: number;
  readonly index: number;
  readonly boundary: number;
}

function contentStart(parent: SelectableBlock | null): number {
  if (!parent) return 0;
  if (parent.node.type === schema.nodes.yamlPair)
    return parent.from + 2 + parent.node.child(0).nodeSize;
  return (
    parent.from +
    1 +
    ([schema.nodes.callout, schema.nodes.footnoteDefinition].includes(parent.node.type)
      ? parent.node.child(0).nodeSize
      : 0)
  );
}

/** Moving across the YAML boundary changes the value's representation. A string's
 * characters become Markdown only when it leaves YAML; a Markdown block becomes
 * one scalar string when it enters a collection. */
function yamlPayload(doc: Node, payload: readonly SelectableBlock[], parent: Node): Fragment | null {
  const yaml =
    parent.type === schema.nodes.yamlMapping || parent.type === schema.nodes.yamlSequence;
  const nodes: Node[] = [];
  const documentSchema = doc.type.schema;
  for (const block of payload) {
    let value = block.node.type === schema.nodes.yamlPair ? block.node.child(1) : block.node;
    if (yaml) {
      if (!value.type.isInGroup('yamlNode')) {
        const source = unparse.slice(new Slice(Fragment.from(value), 0, 0), doc.resolve(block.from));
        value = documentSchema.nodes.yamlScalar.create({ tag: 'string' }, source ? documentSchema.text(source) : null);
      }
      if (parent.type === schema.nodes.yamlSequence) nodes.push(value);
      else if (block.node.type === schema.nodes.yamlPair) nodes.push(block.node);
      else
        nodes.push(
          documentSchema.nodes.yamlPair.create(null,
            [documentSchema.nodes.yamlScalar.create({ tag: 'string' }), value]),
        );
    } else if (value.type.isInGroup('yamlNode')) {
      if (value.type !== schema.nodes.yamlScalar || value.attrs.tag !== 'string') return null;
      const source = value.textContent;
      const content = parse.blocks(
        parseBlocks(source, { target: 'editor' }, Bindings.none),
        source,
        documentSchema,
      );
      nodes.push(...(content.size ? content.content : [documentSchema.nodes.paragraph.create()]));
    } else nodes.push(value);
  }
  return Fragment.fromArray(nodes);
}

/** Drag targets are logical block siblings. The only extra frames required to realize a
 * Markdown target are a selected item's existing shell and a split at a list boundary. */
export function blockDropIntents(doc: Node, source: BlockRange): DropIntent[] {
  if (!isBlockRange(doc, source.from, source.to)) return [];
  return new DropTargets(doc, source).read();
}

class DropTargets {
  private readonly payload: SelectableBlock[];
  private readonly blocks: SelectableBlock[];
  private readonly result: DropIntent[] = [];

  constructor(
    private readonly doc: Node,
    private readonly source: BlockRange,
  ) {
    this.payload = selectedBlocks(doc, source);
    this.blocks = selectableBlocks(doc);
  }

  read(): DropIntent[] {
    const roots = this.blocks.filter((block) => !block.parent);
    let indexOffset = 0;
    for (const sequence of rootBlockSequences(this.doc)) {
      const children = roots.filter((block) => block.from >= sequence.from && block.to <= sequence.to);
      this.add(null, children, sequence.from, indexOffset);
      indexOffset += children.length;
    }
    for (const block of this.blocks) {
      if (block.from >= this.source.from && block.to <= this.source.to) continue;
      if (block.node.type.isInGroup('container')) this.add(block, block.children);
      else if (
        block.node.type.isInGroup('yamlCollection') ||
        (block.node.type === schema.nodes.yamlPair &&
          block.node.child(1).type.isInGroup('yamlCollection'))
      )
        this.add(block, block.children);
    }
    return this.result;
  }

  add(
    parent: SelectableBlock | null,
    children: readonly SelectableBlock[],
    start = contentStart(parent),
    indexOffset = 0,
  ) {
    for (let index = 0; index <= children.length; index++) {
      const boundary = children[index]?.from ?? children.at(-1)?.to ?? start;
      const at = this.doc.resolve(boundary);
      const directItems =
        at.parent.type.isInGroup('list') &&
        this.payload.every((block) => block.node.type === schema.nodes.listItem) &&
        !(
          at.parent.type === schema.nodes.orderedList &&
          this.payload.some((block) => block.node.attrs.checked !== null)
        );
      const target = at.parent.type.isInGroup('list') && !directItems ? this.doc.resolve(at.before()) : at;
      const types = this.payload.map((block) =>
        block.node.type === schema.nodes.listItem && !directItems
          ? this.doc.resolve(block.from).parent.type
          : block.node.type,
      );
      const crossingYAML =
        target.parent.type.isInGroup('yamlCollection') ||
        this.payload.some(
          (block) => block.node.type === schema.nodes.yamlPair || block.node.type.isInGroup('yamlNode'),
        );
      const probe = crossingYAML
        ? yamlPayload(this.doc, this.payload, target.parent)
        : Fragment.fromArray(
            types.map((type) => type.createAndFill()).filter((node): node is Node => node !== null),
          );
      if (
        !probe ||
        (!crossingYAML && probe.childCount !== types.length) ||
        !target.parent.canReplace(target.index(), target.index(), probe)
      )
        continue;
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

/** Delete the dragged range and insert its slice at the mapped target, as
 * prosemirror-view's drop does. The selection comes from the insertion's range. */
export function moveBlocks(state: EditorState, source: BlockRange, intent: DropIntent): Transaction | null {
  const current = blockDropIntents(state.doc, source).find(
    (candidate) =>
      candidate.parentPos === intent.parentPos &&
      candidate.index === intent.index &&
      candidate.boundary === intent.boundary,
  );
  if (!current || (intent.boundary >= source.from && intent.boundary <= source.to)) return null;
  const blocks = selectedBlocks(state.doc, source);
  if (!blocks.length) return null;
  const tr = history.isolate(state.tr);
  let target = intent.boundary;
  let at = tr.doc.resolve(target);
  const items = blocks.every((block) => block.node.type === schema.nodes.listItem);
  if (items && !at.parent.type.isInGroup('list')) {
    const kind = state.doc.resolve(blocks[0].from).parent.type;
    if (at.nodeBefore?.type === kind && at.nodeBefore.type.isInGroup('list')) target--;
    else if (at.nodeAfter?.type === kind && at.nodeAfter.type.isInGroup('list')) target++;
    at = tr.doc.resolve(target);
  }
  const direct =
    at.parent.type.isInGroup('list') &&
    items &&
    !(
      at.parent.type === schema.nodes.orderedList &&
      blocks.some((block) => block.node.attrs.checked !== null)
    );
  const parent = !direct && at.parent.type.isInGroup('list') ? tr.doc.resolve(at.before()).parent : at.parent;
  let content: Fragment;
  if (
    parent.type.isInGroup('yamlCollection') ||
    blocks.some(
      (block) => block.node.type === schema.nodes.yamlPair || block.node.type.isInGroup('yamlNode'),
    )
  ) {
    const converted = yamlPayload(state.doc, blocks, parent);
    if (!converted) return null;
    content = converted;
  } else {
    const nodes: Node[] = [];
    let shell: number | null = null;
    for (const block of blocks) {
      if (block.node.type !== schema.nodes.listItem || direct) {
        nodes.push(block.node);
        shell = null;
        continue;
      }
      const original = state.doc.resolve(block.from);
      const previous = nodes.at(-1);
      if (shell === original.before() && previous)
        nodes[nodes.length - 1] = previous.copy(previous.content.append(Fragment.from(block.node)));
      else nodes.push(carrier(original.parent, Fragment.from(block.node), original));
      shell = original.before();
    }
    content = Fragment.fromArray(nodes);
  }
  // Isolate the storage edges of a partial list before deleting the range.
  // Splitting assigns its back spelling to the selected end, not the leftover head.
  let from = source.from;
  let to = source.to;
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
    from += 2;
    to += 2;
  }
  // Checkboxes retain their editable head when their body enters or leaves.
  const destination = tr.doc.resolve(target);
  if (
    destination.parent.type === schema.nodes.listItem &&
    destination.parent.attrs.checked !== null &&
    destination.index() === 0 &&
    content.firstChild?.type !== schema.nodes.paragraph
  ) {
    const step = tr.steps.length;
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
  const storage = blockStorageRange(tr.doc, { from, to });
  const beforeDelete = tr.steps.length;
  remove(tr, storage.from, storage.to);
  target = tr.mapping.slice(beforeDelete).map(target);
  if (!direct) target = outsideList(tr, target);
  const beforeInsert = tr.steps.length;
  const doc = tr.doc;
  replace(tr, target, target, new Slice(content, 0, 0));
  if (tr.doc.eq(doc)) return null;
  let start = target;
  let end = target;
  tr.mapping.maps[beforeInsert].forEach((_from, _to, newFrom, newTo) => {
    start = newFrom;
    end = newTo;
  });
  const afterInsert = tr.mapping.slice(beforeInsert + 1);
  const inserted = selectedBlocks(tr.doc, { from: afterInsert.map(start, 1), to: afterInsert.map(end, -1) });
  const first = inserted[0];
  const last = inserted.at(-1);
  if (!first || !last) throw new RangeError('The drop did not insert selectable blocks');
  const range = commonBlockRange(tr.doc, first, last);
  tr.setSelection(BlockSelection.create(tr.doc, range.from, range.to));
  return tr.setMeta('uiEvent', 'drop');
}
