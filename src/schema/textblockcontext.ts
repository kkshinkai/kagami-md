/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { NodeRange, type Node, type NodeType, type ResolvedPos } from 'prosemirror-model';
import { TextSelection, type EditorState, type Transaction } from 'prosemirror-state';
import { canSplit } from 'prosemirror-transform';

import { fieldSource } from '../parse/field.js';
import { convert, join, lift, move, remove, split } from '../transform/transform.js';

/**
 * Where the caret is, for the structural keys: its textblock and the depths of the textblock's
 * nearest owners in `$from`. Each operation reads the nodes, positions and indexes it needs from
 * `$from` at those depths. Nested owners can coexist; each operation chooses which ownership edge
 * it may edit.
 */
export interface TextblockContext {
  $from: ResolvedPos;
  textblock: Node;
  selectionOffset: number;
  isAtStart: boolean;
  isAtEnd: boolean;
  listItem?: number;
  blockquote?: number;
  linkDefinition?: number;
  footnoteDefinition?: number;
}

export namespace TextblockContext {
  /** The context of a text selection in a textblock, or null for any other selection. */
  export function read(state: EditorState): TextblockContext | null {
    const { selection, schema } = state;
    if (!(selection instanceof TextSelection) || !selection.$from.parent.isTextblock) return null;
    const { $from } = selection;
    const textblock = $from.parent;
    const selectionOffset = $from.parentOffset;
    const length = textblock.type.isInGroup('field') ? fieldSource(textblock).length : textblock.textContent.length;
    return {
      $from,
      textblock,
      selectionOffset,
      isAtStart: selection.empty && selectionOffset === 0,
      isAtEnd: selection.empty && selectionOffset === length,
      listItem: parentDepth($from, schema.nodes.listItem!),
      blockquote: parentDepth($from, schema.nodes.blockQuote!),
      linkDefinition: parentDepth($from, schema.nodes.linkReferenceDefinition!),
      footnoteDefinition: parentDepth($from, schema.nodes.footnoteDefinition!),
    };
  }
}

function parentDepth($pos: ResolvedPos, type: NodeType): number | undefined {
  for (let depth = $pos.depth - 1; depth > 0; depth--) {
    if ($pos.node(depth).type === type) return depth;
  }
  return undefined;
}

/** Whether the caret's textblock is a direct child of the owner at a depth. */
export function ownsTextblock(context: TextblockContext, depth: number | undefined): depth is number {
  return depth !== undefined && context.$from.depth === depth + 1;
}

/**
 * A resolved transaction as a command: it applies when there is one. One that changes neither the
 * document nor the selection still handles the key, and is not dispatched.
 */
export function applyTransaction(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
  tr: Transaction | null
): boolean {
  if (!tr) return false;
  if (dispatch && (tr.docChanged || !tr.selection.eq(state.selection))) dispatch(tr.scrollIntoView());
  return true;
}

/** Whether a node provides a list's marker frame. */
export function isList(node: Node): boolean {
  return node.type.isInGroup('list');
}

/**
 * Whether `current` can join onto the end of `previous`. A paragraph joins onto a paragraph or
 * a heading, reversing a heading split; two headings join only when their level and form match.
 */
export function canJoinTextblocks(previous: Node, current: Node): boolean {
  const { nodes } = previous.type.schema;
  if (previous.type === nodes.paragraph) return current.type === nodes.paragraph;
  if (previous.type !== nodes.heading) return false;
  if (current.type === nodes.paragraph) return true;
  return current.type === nodes.heading &&
    previous.attrs.level === current.attrs.level &&
    previous.attrs.form === current.attrs.form;
}

/**
 * Split a paragraph or heading. A heading stays with its text's start, and the other half is a
 * paragraph: before the heading when the split is at the start of its text, after it otherwise.
 */
export function splitAt(tr: Transaction, $pos: ResolvedPos, depth: number): boolean {
  const node = $pos.parent;
  const { nodes } = tr.doc.type.schema;
  if ((node.type !== nodes.paragraph && node.type !== nodes.heading) || !canSplit(tr.doc, $pos.pos, depth))
    return false;
  const step = tr.mapping.maps.length;
  split(tr, $pos.pos, depth);
  const mapping = tr.mapping.slice(step);
  const right = mapping.map($pos.pos, 1);
  if (node.type === nodes.heading) {
    if ($pos.parentOffset === 0 && node.content.size > 0)
      convert(tr, mapping.map($pos.before(), 1), nodes.paragraph, {});
    else convert(tr, right - 1, nodes.paragraph, {});
  }
  tr.setSelection(TextSelection.create(tr.doc, right));
  return true;
}

/** Nearest ancestor cut before `$pos`, stopping at an isolating boundary. */
export function cutBefore($pos: ResolvedPos): ResolvedPos | null {
  if ($pos.parent.type.spec.isolating) return null;
  for (let depth = $pos.depth - 1; depth >= 0; depth--) {
    if ($pos.index(depth) > 0) return $pos.doc.resolve($pos.before(depth + 1));
    if ($pos.node(depth).type.spec.isolating) break;
  }
  return null;
}

/** Nearest ancestor cut after `$pos`, stopping at an isolating boundary. */
export function cutAfter($pos: ResolvedPos): ResolvedPos | null {
  if ($pos.parent.type.spec.isolating) return null;
  for (let depth = $pos.depth - 1; depth >= 0; depth--) {
    const parent = $pos.node(depth);
    if ($pos.index(depth) + 1 < parent.childCount) return $pos.doc.resolve($pos.after(depth + 1));
    if (parent.type.spec.isolating) break;
  }
  return null;
}

interface CutLeaf {
  readonly node: Node;
  readonly pos: number;
  readonly wrappers: number;
}

function isContainer(node: Node): boolean {
  return node.type.isInGroup('container') || isList(node);
}

function lastBlock(node: Node, end: number): CutLeaf {
  let current = node;
  let pos = end;
  let wrappers = 0;
  while (isContainer(current) && current.lastChild) {
    if (!isList(current)) wrappers++;
    current = current.lastChild;
    pos--;
  }
  return { node: current, pos: pos - current.nodeSize, wrappers };
}

function firstBlock(node: Node, start: number): CutLeaf {
  const { listItem } = node.type.schema.nodes;
  let current = node;
  let pos = start;
  let wrappers = 0;
  while (isContainer(current) && current.firstChild) {
    if (current.type === listItem && isList(current.firstChild)) break;
    if (!isList(current)) wrappers++;
    current = current.firstChild;
    pos++;
  }
  return { node: current, pos, wrappers };
}

function joinLeaves(tr: Transaction, last: CutLeaf, first: CutLeaf): Transaction {
  let lastInner = last.pos + last.node.nodeSize - 1;
  let firstInner = first.pos + 1;
  for (let count = 0; count < first.wrappers; count++) {
    const $first = tr.doc.resolve(firstInner);
    const parentDepth = $first.depth - 1;
    const range = new NodeRange(
      tr.doc.resolve($first.before($first.depth)),
      tr.doc.resolve($first.after($first.depth)),
      parentDepth,
    );
    const step = tr.steps.length;
    lift(tr, range);
    const mapping = tr.mapping.slice(step);
    lastInner = mapping.map(lastInner, -1);
    firstInner = mapping.map(firstInner, 1);
  }
  const $last = tr.doc.resolve(lastInner);
  const $first = tr.doc.resolve(firstInner);
  if ($last.after() !== $first.before()) {
    const moved = move(tr, $first.before(), $last.after());
    lastInner = moved(lastInner);
  }
  const $target = tr.doc.resolve(lastInner);
  const step = tr.steps.length;
  join(tr, $target.after());
  const caret = tr.mapping.slice(step).map($target.pos, -1);
  return tr.setSelection(TextSelection.create(tr.doc, caret));
}

/** Eliminate or step across the cut beside the caret's textblock. */
export function joinAcross(state: EditorState, context: TextblockContext, direction: -1 | 1): Transaction | null {
  const $cut = direction < 0 ? cutBefore(context.$from) : cutAfter(context.$from);
  if (!$cut) return null;
  const before = $cut.nodeBefore!;
  const after = $cut.nodeAfter!;
  const { nodes } = state.schema;
  if (canJoinTextblocks(before, after) && before.content.size > 0 && after.content.size > 0) {
    const tr = state.tr;
    const step = tr.steps.length;
    join(tr, $cut.pos);
    const caret = tr.mapping.slice(step).map($cut.pos - 1, -1);
    return tr.setSelection(TextSelection.create(tr.doc, caret));
  }
  if (context.textblock.type === nodes.paragraph && context.textblock.content.size === 0) {
    const start = context.$from.before();
    const tr = state.tr;
    remove(tr, start, start + context.textblock.nodeSize);
    return tr.setSelection(TextSelection.near(tr.doc.resolve(tr.mapping.map(start)), direction));
  }
  const neighbor = direction < 0 ? before : after;
  if (neighbor.type === nodes.paragraph && neighbor.content.size === 0) {
    const from = direction < 0 ? $cut.pos - neighbor.nodeSize : $cut.pos;
    const tr = state.tr;
    remove(tr, from, from + neighbor.nodeSize);
    return tr.setSelection(TextSelection.create(tr.doc, tr.mapping.map(context.$from.pos)));
  }
  const last = lastBlock(before, $cut.pos);
  const first = firstBlock(after, $cut.pos);
  if (context.textblock.type === nodes.paragraph) {
    if (direction < 0 && last.node.type === nodes.linkReferenceDefinition) {
      const field = last.node.lastChild!;
      const offset = Math.min(fieldSource(field).length, field.content.size);
      const end = last.pos + last.node.nodeSize - field.nodeSize + offset;
      return state.tr.setSelection(TextSelection.create(state.doc, end));
    }
    if (direction > 0 && first.node.type === nodes.linkReferenceDefinition) {
      return state.tr.setSelection(TextSelection.create(state.doc, first.pos + 2));
    }
  }
  if (!canJoinTextblocks(last.node, first.node)) return null;
  return joinLeaves(state.tr, last, first);
}

export function cursorContext(state: EditorState): TextblockContext | null {
  return state.selection.empty ? TextblockContext.read(state) : null;
}

/** The caret's empty paragraph leaves the owner at a depth, below the owner's other blocks. */
export function liftOut(state: EditorState, context: TextblockContext, depth: number): Transaction {
  const pos = context.$from.before();
  const tr = state.tr;
  lift(tr, new NodeRange(tr.doc.resolve(pos), tr.doc.resolve(pos + context.textblock.nodeSize), depth));
  return tr;
}
