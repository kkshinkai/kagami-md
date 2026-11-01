/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ATXHeadingSyntax } from '../syntax/index.js';
import { TextSelection, type Command } from 'prosemirror-state';
import { bindings } from '../state/bindings.js';
import { readBindings } from '../parse/bindings.js';
import { readField, fieldSource, hasPending } from '../parse/field.js';
import { phrasing } from '../state/correction.js';
import { compositionState } from '../state/input.js';
import { replaceParagraph } from '../state/settlement.js';
import { insert } from '../transform/transform.js';

/** Text that the reader already reads as a block, kept as text until the user has typed enough to mean it. */
export namespace pending {
  /**
   * Enter ends the wait. With the caret in a paragraph whose text the parser reads as blocks, the paragraph becomes the blocks its text reads as with nothing
   * left to wait for ([Pending](../../private-docs/rules/pending.md), "Becomes"), and the
   * caret stays on the text the user typed, now inside the block: in an empty list item, quote or
   * code block, after a heading's text. A heading made from `#` alone has no text yet, so the
   * caret goes to a new paragraph after it. While a composition is open, or when the text reads as
   * no block, Enter goes on to the next handler.
   */
  export const enter: Command = (state, dispatch, view) => {
    if (view?.composing || compositionState(state)?.isComposing) return false;
    const selection = state.selection;
    if (!(selection instanceof TextSelection)) return false;
    const node = selection.$head.parent;
    if (node.type !== state.schema.nodes.paragraph) return false;
    const text = fieldSource(node);
    const current = bindings.get(state);
    if (!hasPending(node) && !current.blockReading(selection.$head.before())) return false;
    const reading = readField(selection.$head, current, true);
    if (reading.kind !== 'blocks') return false;
    const position = selection.$head.before();
    const tr = state.tr;
    replaceParagraph(tr, position, node, text, reading.blocks);
    const first = reading.blocks[0];
    const emptyHeading = reading.blocks.length === 1 && first instanceof ATXHeadingSyntax && !first.children.length;
    const pendingHeading = node.content.content.some(piece =>
      piece.marks.some(mark => mark.type === state.schema.marks.pendingATXHeadingMarker));
    if (pendingHeading || emptyHeading) {
      const heading = tr.doc.nodeAt(position);
      if (heading?.type === state.schema.nodes.heading) {
        const after = position + heading.nodeSize;
        insert(tr, after, state.schema.nodes.paragraph, {});
        tr.setSelection(TextSelection.create(tr.doc, after + 1));
      }
    }
    const update: phrasing.Update = {
      bindings: readBindings.blocks(reading.blocks, current),
      completed: phrasing.completed(tr.doc, tr.mapping.map(position, -1), tr.mapping.map(position + node.nodeSize, 1)),
    };
    dispatch?.(tr.setMeta(phrasing.key, [update]).scrollIntoView());
    return true;
  };
}
