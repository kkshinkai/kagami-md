/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Node } from 'prosemirror-model';
import { Plugin, PluginKey, type EditorState, type TextSelection } from 'prosemirror-state';
import { Decoration } from 'prosemirror-view';
import { CAPSULE_START, reveal, type SourcePresentation } from '../editor/reveal.js';
import type { Revealing } from '../state/normalization.js';

/** Present code spans as source capsules with native text editing. */
export function codeSpan(): Plugin[] {
  return [codeSpan.presentation()];
}

export namespace codeSpan {
  /** Mark the start of every code span. */
  export function presentation(): Plugin<SourcePresentation> {
    return new Plugin({
      key: presentationKey,
      state: reveal.state(draw),
      props: { decorations(state) { return presentationKey.getState(state)?.decorations ?? null; } },
    });
  }
}

const presentationKey = new PluginKey<SourcePresentation>('code-span-presentation');

/** The first piece of each occurrence holds its opening backticks: it is the capsule's start. */
function draw(node: Node, position: number, _state: EditorState, _selection: TextSelection | null,
  _visible: Revealing): Decoration[] {
  const decorations: Decoration[] = [];
  const { codeSpan } = node.type.schema.marks;
  // Occurrences are numbered within a textblock, whose pieces are visited together.
  let block: Node | null = null;
  const seen = new Set<number>();
  node.descendants((piece, offset, parent) => {
    const mark = codeSpan!.isInSet(piece.marks);
    if (!mark) return true;
    if (parent !== block) {
      block = parent;
      seen.clear();
    }
    if (seen.has(mark.attrs.occurrence)) return false;
    seen.add(mark.attrs.occurrence);
    const from = position + 1 + offset;
    decorations.push(Decoration.inline(from, from + piece.nodeSize, { class: CAPSULE_START }));
    return false;
  });
  return decorations;
}
