/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Fragment, Slice } from 'prosemirror-model';
import { TextSelection } from 'prosemirror-state';
import { CellSelection, handlePaste, isInTable } from 'prosemirror-tables';
import type { EditorView } from 'prosemirror-view';
import { history } from '../state/history.js';
import { replace } from '../transform/transform.js';
import { paste } from '../editor/paste.js';

/** Paste a native rectangle, or read ordinary content as the receiving GFM cell's text. */
export function tablePaste(view: EditorView, event: ClipboardEvent, slice: Slice): boolean {
  const { state } = view;
  if (!isInTable(state)) return false;
  if (!slice.content.size)
    slice = paste.text(event.clipboardData?.getData('text/plain') ?? '', state.selection.$from);
  if (!slice.content.size) return true;

  if (slice.content.content.every(node => node.type.spec.tableRole))
    return handlePaste(view, event, slice);

  const content = paste.cell(slice, state.selection.$from);
  if (!content.size) return true;
  if (state.selection instanceof CellSelection) {
    const { tableCell, tableParagraph } = state.schema.nodes;
    const cell = tableCell.create(null, tableParagraph.create(null, content));
    return handlePaste(view, event, new Slice(Fragment.from(cell), 0, 0));
  }

  const tr = state.tr;
  const end = state.selection.to;
  replace(tr, state.selection.from, end, new Slice(content, 0, 0));
  tr.setSelection(TextSelection.near(tr.doc.resolve(tr.mapping.map(end, 1)), -1));
  view.dispatch(history.isolate(tr).setMeta('paste', true).setMeta('uiEvent', 'paste').scrollIntoView());
  return true;
}
