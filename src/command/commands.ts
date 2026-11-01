/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { redo as redoHistory, undo as undoHistory } from 'prosemirror-history';
import { NodeSelection, Selection, TextSelection, type Command } from 'prosemirror-state';
import { CellSelection } from 'prosemirror-tables';
import * as command from './command.js';
import type { KagamiMD } from '../editor/editor.js';
import { BlockSelection } from '../state/selection.js';
import { toggleMark } from '../schema/format.js';
import { applyTransaction, cursorContext, liftOut, ownsTextblock, splitAt } from '../schema/textblockcontext.js';
import { lineBreakText } from '../schema/linebreak.js';
import { insert, remove } from '../transform/transform.js';

/** Takes back the last change. Returns `false` when there is none. */
export const undo: command.Command.Pure = ({ state }) => state.runCommand(undoHistory);

/** Makes again the change that was last taken back. Returns `false` when there is none. */
export const redo: command.Command.Pure = ({ state }) => state.runCommand(redoHistory);

/** Copies the selection, as the key does. Returns `false` when nothing is selected. */
export const copy: command.Command = editor => clipboard(editor, 'copy');

/** Cuts the selection, as the key does. Returns `false` when nothing is selected. */
export const cut: command.Command = editor => clipboard(editor, 'cut');

function clipboard(editor: KagamiMD, operation: 'copy' | 'cut'): boolean {
  const view = editor.view;
  if (!view || view.state.selection.empty || operation === 'cut' && !view.editable) return false;
  view.focus();
  return view.dom.ownerDocument.execCommand(operation);
}

/** Expand partial text to both endpoint fields as a forward selection. Once those
 * boundaries are selected, or for any other selection type, select the complete
 * document as blocks. An empty field already has both boundaries selected, and
 * a complete document block selection consumes the command without dispatching. */
export const selectAll: Command = (state, dispatch) => {
  const { doc, selection } = state;
  if (selection instanceof BlockSelection && selection.from === 0 && selection.to === doc.content.size) return true;
  const wholeBlocks = !(selection instanceof TextSelection) ||
    selection.$from.parentOffset === 0 && selection.$to.parentOffset === selection.$to.parent.content.size;
  if (dispatch) {
    const tr = state.tr;
    if (wholeBlocks) tr.setSelection(BlockSelection.create(doc, 0, doc.content.size));
    else tr.setSelection(TextSelection.create(doc, selection.$from.start(), selection.$to.end())).scrollIntoView();
    dispatch(tr);
  }
  return true;
};

/** Toggle strong emphasis in the selected source. */
export const toggleStrong: Command = toggleMark('bold');
/** Toggle emphasis in the selected source. */
export const toggleEmphasis: Command = toggleMark('italic');
/** Toggle strikethrough in the selected source. */
export const toggleStrikethrough: Command = toggleMark('strike');
/** Toggle highlighting in the selected source. */
export const toggleHighlight: Command = toggleMark('highlight');

/** Remove the selected content and place a text caret at its mapped start. */
export const deleteSelection: Command = (state, dispatch) => {
  const { selection } = state;
  if (selection.empty) return false;
  if (dispatch) {
    const tr = state.tr;
    remove(tr, selection.from, selection.to);
    if (!(selection instanceof CellSelection)) {
      tr.setSelection(Selection.near(tr.doc.resolve(tr.mapping.map(selection.from, -1))));
    }
    dispatch(tr.scrollIntoView());
  }
  return true;
};

/** Open a paragraph after a selected block. */
export const createParagraphNear: Command = (state, dispatch) => {
  const { selection } = state;
  if (!(selection instanceof NodeSelection) || selection.node.isInline) return false;
  if (dispatch) {
    const tr = state.tr;
    insert(tr, selection.to, tr.doc.type.schema.nodes.paragraph, {});
    dispatch(tr.setSelection(TextSelection.create(tr.doc, selection.to + 1)).scrollIntoView());
  }
  return true;
};

/** Leave a literal textblock by opening a paragraph after it. */
export const exitCode: Command = (state, dispatch) => {
  const { $from, $to } = state.selection;
  if (!$from.parent.type.spec.code || !$from.sameParent($to)) return false;
  if (dispatch) {
    const tr = state.tr;
    const pos = $from.after();
    insert(tr, pos, tr.doc.type.schema.nodes.paragraph, {});
    dispatch(tr.setSelection(TextSelection.create(tr.doc, pos + 1)).scrollIntoView());
  }
  return true;
};

/**
 * Shift-Enter replaces a text selection inside one textblock with a line ending, or, in a block
 * that holds one line, with the text of a line break tag. The fields read the text again after
 * the change, as they do after typing. Code blocks and selections across blocks are left to
 * their own keymaps.
 */
export const insertSourceLineBreak: Command = (state, dispatch) => {
  if (!(state.selection instanceof TextSelection)) return false;
  const { $from, $to } = state.selection;
  if (!$from.sameParent($to) || !$from.parent.type.isInGroup('field')) return false;
  if (dispatch) {
    const text = lineBreakText($from.parent);
    dispatch(state.tr.insertText(text).scrollIntoView());
  }
  return true;
};

/** Replace selected text with the boundary between two textblocks. */
export const splitSelection: Command = (state, dispatch) => {
  const { selection } = state;
  if (!(selection instanceof TextSelection) || selection.empty) return false;
  const tr = state.tr;
  remove(tr, selection.from, selection.to);
  if (!splitAt(tr, tr.selection.$from, 1)) return false;
  dispatch?.(tr.scrollIntoView());
  return true;
};

/** Leave a quote when Enter is pressed in one of its empty direct textblocks. */
export const liftEmptyBlock: Command = (state, dispatch) => {
  const context = cursorContext(state);
  if (!context || context.textblock.content.size || !ownsTextblock(context, context.blockquote)) return false;
  return applyTransaction(state, dispatch, liftOut(state, context, context.blockquote));
};

/** Split the paragraph or heading at the caret. List heads split with their item instead. */
export const splitTextblock: Command = (state, dispatch) => {
  const context = cursorContext(state);
  if (!context || ownsTextblock(context, context.listItem) && context.$from.index(context.listItem) === 0) return false;
  const tr = state.tr;
  if (!splitAt(tr, context.$from, 1)) return false;
  return applyTransaction(state, dispatch, tr);
};
