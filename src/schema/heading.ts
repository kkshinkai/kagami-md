/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { keymap as headingKeys } from 'prosemirror-keymap';
import { TextSelection, type Command, type Plugin } from 'prosemirror-state';
import { convert } from '../transform/transform.js';

/** Heading-level shortcuts and the command that removes a heading frame. */
export function heading(): Plugin[] { return [heading.keymap()]; }

export namespace heading {
  /** The six ATX heading levels have the same numbered shortcuts. */
  export function keymap(): Plugin {
    return headingKeys({
      'Mod-1': setLevel(1), 'Mod-2': setLevel(2), 'Mod-3': setLevel(3),
      'Mod-4': setLevel(4), 'Mod-5': setLevel(5), 'Mod-6': setLevel(6),
    });
  }

  /** Backspace at the start of a heading makes it a paragraph. */
  export const toParagraph: Command = (state, dispatch) => {
    const cursor = state.selection instanceof TextSelection ? state.selection.$cursor : null;
    if (!cursor || cursor.parentOffset || cursor.parent.type !== state.schema.nodes.heading) return false;
    if (dispatch) {
      const tr = state.tr;
      convert(tr, cursor.before(), state.schema.nodes.paragraph, {});
      dispatch(tr);
    }
    return true;
  };

  /** Set selected paragraphs and headings to an ATX heading of this level. */
  export function setLevel(level: 1 | 2 | 3 | 4 | 5 | 6): Command {
    return (state, dispatch) => {
      const tr = state.tr;
      const { paragraph, heading } = state.schema.nodes;
      state.doc.nodesBetween(state.selection.from, state.selection.to, (node, pos) => {
        if (node.type !== paragraph && node.type !== heading) return;
        if (node.type !== heading || node.attrs.level !== level || node.attrs.form !== 'atx') {
          convert(tr, tr.mapping.map(pos), heading, { level, form: 'atx' });
        }
        return false;
      });
      if (!tr.docChanged) return false;
      dispatch?.(tr.scrollIntoView());
      return true;
    };
  }
}
