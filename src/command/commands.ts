/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { NodeSelection, Selection, TextSelection, type Command as PMCommand } from 'prosemirror-state';
import { CellSelection } from 'prosemirror-tables';
import { BlockSelection } from '../state/selection.js';
import { deleteSelectedFrontmatterBoolean } from '../schema/frontmatter.js';
import { toggleMark } from '../schema/format.js';
import { applyTransaction, cursorContext, liftOut, ownsTextblock, splitAt } from '../schema/textblockcontext.js';
import { lineBreakText } from '../schema/linebreak.js';
import { guardCellBoundary } from '../table/table.js';
import { insert, remove } from '../transform/transform.js';

/** Expand partial text to both endpoint fields as a forward selection. Once those
 * boundaries are selected, or for any other selection type, select the complete
 * document as blocks. An empty field already has both boundaries selected, and
 * a complete document block selection consumes the command without dispatching. */
export const selectAll: PMCommand = (state, dispatch) => {
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
export const toggleStrong: PMCommand = toggleMark('bold');
/** Toggle emphasis in the selected source. */
export const toggleEmphasis: PMCommand = toggleMark('italic');
/** Toggle strikethrough in the selected source. */
export const toggleStrikethrough: PMCommand = toggleMark('strike');
/** Toggle highlighting in the selected source. */
export const toggleHighlight: PMCommand = toggleMark('highlight');

/** Remove the selected content and place a text caret at its mapped start. */
export const deleteSelection: PMCommand = (state, dispatch) => {
  const { selection } = state;
  if (selection instanceof CellSelection) return guardCellBoundary(1)(state, dispatch);
  const booleanTr = deleteSelectedFrontmatterBoolean(state, 1);
  if (booleanTr) {
    dispatch?.(booleanTr);
    return true;
  }
  if (selection.empty) return false;
  if (dispatch) {
    const tr = state.tr;
    if (selection instanceof BlockSelection) {
      selection.replace(tr);
    } else {
      const seam = remove(tr, selection.from, selection.to);
      tr.setSelection(Selection.near(tr.doc.resolve(seam)));
    }
    dispatch(tr.scrollIntoView());
  }
  return true;
};

/** Open a paragraph after a selected block. */
export const createParagraphNear: PMCommand = (state, dispatch) => {
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
export const exitCode: PMCommand = (state, dispatch) => {
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
export const insertSourceLineBreak: PMCommand = (state, dispatch) => {
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
export const splitSelection: PMCommand = (state, dispatch) => {
  const { selection } = state;
  if (!(selection instanceof TextSelection) || selection.empty) return false;
  const tr = state.tr;
  const pos = remove(tr, selection.from, selection.to);
  const seam = tr.doc.resolve(pos);
  if (!splitAt(tr, seam, 1)) return false;
  dispatch?.(tr.scrollIntoView());
  return true;
};

/** Leave a quote when Enter is pressed in one of its empty direct textblocks. */
export const liftEmptyBlock: PMCommand = (state, dispatch) => {
  const context = cursorContext(state);
  if (!context || context.textblock.content.size || !ownsTextblock(context, context.blockquote)) return false;
  return applyTransaction(state, dispatch, liftOut(state, context, context.blockquote));
};

/** Split the paragraph or heading at the caret. List heads split with their item instead. */
export const splitTextblock: PMCommand = (state, dispatch) => {
  const context = cursorContext(state);
  if (!context || ownsTextblock(context, context.listItem) && context.$from.index(context.listItem) === 0) return false;
  const tr = state.tr;
  if (!splitAt(tr, context.$from, 1)) return false;
  return applyTransaction(state, dispatch, tr);
};
