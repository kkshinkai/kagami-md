/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { NodeRange, type Node, type NodeType, type ResolvedPos } from 'prosemirror-model';
import { TextSelection, type EditorState, type Transaction } from 'prosemirror-state';
import { canSplit } from 'prosemirror-transform';

import { mapTextSelection } from '../state/selection.js';
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
 * A plain text join is legal only for equal block kinds and semantic attributes. Source records
 * and the blank-line boundary being removed do not distinguish content types; heading level,
 * marker form and every other syntax attribute still do. Code blocks have their own line rules.
 */
export function canJoinTextblocks(previous: Node, current: Node): boolean {
  if (!previous.isTextblock || !current.isTextblock || previous.type !== current.type || previous.type.spec.code)
    return false;
  const { nodes } = previous.type.schema;
  if (previous.type === nodes.heading) {
    return previous.attrs.level === current.attrs.level && previous.attrs.form === current.attrs.form;
  }
  return previous.type === nodes.paragraph;
}

/** Split a paragraph or heading, giving its empty outer half the default paragraph type. */
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
      convert(tr, mapping.map($pos.before(), 1), tr.doc.type.schema.nodes.paragraph, {});
    if ($pos.parentOffset === node.content.size) convert(tr, right - 1, tr.doc.type.schema.nodes.paragraph, {});
  }
  tr.setSelection(TextSelection.create(tr.doc, right));
  return true;
}

export function joinBeside(state: EditorState, context: TextblockContext, direction: -1 | 1): Transaction | null {
  const start = context.$from.before();
  const boundary = direction < 0 ? start : start + context.textblock.nodeSize;
  const $boundary = state.doc.resolve(boundary);
  const beside = direction < 0 ? $boundary.nodeBefore : $boundary.nodeAfter;
  if (!beside) return null;
  const tr = state.tr;
  let caret: number;
  if (canJoinTextblocks(context.textblock, beside)) {
    join(tr, boundary);
    caret = tr.mapping.map(boundary - 1, -1);
  } else if (direction < 0 && isList(beside)) {
    let last = beside.lastChild?.lastChild;
    let target = boundary - 2;
    while (last && isList(last)) {
      last = last.lastChild?.lastChild;
      target -= 2;
    }
    if (!last || !canJoinTextblocks(last, context.textblock)) return null;
    // The preceding list's last item owns the joined paragraph and the command moves only
    // this block. Its incoming spelling is chosen by structure, not by the key handler.
    mapTextSelection(tr, () => move(tr, start, target));
    caret = target - 1;
    join(tr, target);
  } else if (beside.isTextblock && beside.content.size === 0) {
    const from = direction < 0 ? boundary - beside.nodeSize : boundary;
    remove(tr, from, from + beside.nodeSize);
    return tr;
  } else {
    return null;
  }
  return tr.setSelection(TextSelection.create(tr.doc, caret));
}

export function removeEmpty(state: EditorState, context: TextblockContext, direction: -1 | 1): Transaction | null {
  if (context.textblock.content.size || context.textblock.type !== state.schema.nodes.paragraph) return null;
  const start = context.$from.before();
  const end = start + context.textblock.nodeSize;
  const $boundary = state.doc.resolve(direction < 0 ? start : end);
  const beside = direction < 0 ? $boundary.nodeBefore : $boundary.nodeAfter;
  if (!beside) return null;
  const tr = state.tr;
  remove(tr, start, end);
  return tr.setSelection(TextSelection.near(tr.doc.resolve(tr.mapping.map(start)), direction));
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
