/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  PluginKey, TextSelection, type EditorState, type Selection, type StateField,
  type Transaction
} from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';

/** Native input ownership, consumed by document corrections and the attached view. */
export interface CompositionState {
  readonly isComposing: boolean;
  readonly activeTextblockPos: number | null;
  readonly inputHistory: boolean | null;
  readonly id: number | null;
}

export type CompositionChange =
  | { readonly action: 'start'; readonly activeTextblockPos: number | null }
  | { readonly action: 'end' };

/** The view's ordered focus lifetime, consumed by settlement and presentation. */
export interface FocusState {
  readonly blurPending: boolean;
  readonly focused: boolean;
}

export const compositionKey = new PluginKey<CompositionState>('composition-session');
export const compositionCommit = new PluginKey<boolean>('composition-commit');
export const focusKey = new PluginKey<FocusState>('settled-block-finalization');

const idle: CompositionState = { isComposing: false, activeTextblockPos: null, inputHistory: null, id: null };

/** Native replacements map the owned field without reading or rewriting its text. */
export const compositionField: StateField<CompositionState> = {
  init: () => idle,
  apply(tr, previous) {
    const change = tr.getMeta(compositionKey) as CompositionChange | undefined;
    let position = previous.activeTextblockPos;
    let inputHistory = previous.inputHistory;
    let id = previous.id;
    if (change) {
      switch (change.action) {
        case 'end': return idle;
        case 'start':
          position = change.activeTextblockPos;
          inputHistory = null;
          id = null;
          break;
        default: {
          const exhaustive: never = change;
          throw new Error(`Unknown composition change: ${exhaustive}`);
        }
      }
    } else if (!previous.isComposing) {
      return idle;
    }
    if (position === null) {
      position = compositionPosition(tr.selection);
    } else {
      const mapped = tr.mapping.mapResult(position, 1);
      if (mapped.deletedAfter || !tr.doc.nodeAt(mapped.pos)?.isTextblock) return idle;
      position = mapped.pos;
    }
    if (tr.docChanged && typeof tr.getMeta('composition') === 'number') {
      inputHistory = tr.getMeta('addToHistory') !== false;
      id = tr.getMeta('composition');
    }
    return { isComposing: true, activeTextblockPos: position, inputHistory, id };
  },
};

export const focusField: StateField<FocusState> = {
  init: () => ({ blurPending: false, focused: false }),
  apply(tr, previous) {
    const change = tr.getMeta(focusKey) as Partial<FocusState> | undefined;
    if (!change) return previous;
    return {
      blurPending: change.blurPending ?? previous.blurPending,
      focused: change.focused ?? previous.focused,
    };
  },
};

export function compositionState(state: EditorState): CompositionState | undefined {
  return compositionKey.getState(state);
}

export function compositionPosition(selection: Selection): number | null {
  return selection instanceof TextSelection && selection.$head.parent.isTextblock
    ? selection.$head.before() : null;
}

/** Release native input ownership using only text already accepted by PM. */
export function finishComposition(state: EditorState): Transaction | null {
  const session = compositionState(state);
  if (!session?.isComposing) return null;
  return state.tr.setMeta(compositionKey, { action: 'end' } satisfies CompositionChange)
    .setMeta(compositionCommit, true).setMeta('composition', session.id)
    .setMeta('addToHistory', session.inputHistory ?? false);
}

/** Interactive commands yield to native input until its final DOM change is accepted.
 * This is an ingress check, never a transaction filter: native composition must still edit. */
export function canRunCommand(state: EditorState, view?: EditorView): boolean {
  return !(view && (view.isDestroyed || !view.editable || view.composing)) && !compositionState(state)?.isComposing;
}

/** Composition owns its text until the input session commits. */
export function composing(state: EditorState, transactions: readonly Transaction[]): boolean {
  if (compositionState(state)?.isComposing) return true;
  return transactions.some(tr => tr.getMeta('composition') != null && !tr.getMeta(compositionCommit));
}
