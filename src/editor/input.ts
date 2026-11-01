/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { DOMParser, DOMSerializer, type Mark, type ParseRule, type Schema } from 'prosemirror-model';
import { Plugin, TextSelection, type EditorState, type Transaction, type PluginView } from 'prosemirror-state';
import { tableEditingKey } from 'prosemirror-tables';
import type { EditorView, MarkView, MarkViewConstructor } from 'prosemirror-view';
import { normalizationKey, normalizeTextSelection } from '../state/normalization.js';
import { selection, finishPointerSelection } from './selection.js';
import { phrasing } from '../state/correction.js';
import { trailingWhitespace } from '../state/trailingwhitespace.js';
import {
  canRunCommand, compositionCommit, compositionField, compositionKey, compositionPosition, compositionState, finishComposition,
  focusField, focusKey, type CompositionChange, type CompositionState, type FocusState,
} from '../state/input.js';
import { mark } from '../schema/mark.js';
import { frontmatter } from '../schema/frontmatter.js';
import { isHistoryTransaction } from 'prosemirror-history';
import { sourceEditingSelection } from './reveal.js';
import { schema } from '../types/schema.js';
import { findEditor, type DOMNode } from './dom.js';

/** Install the attached editor's native input and focus lifetime. */
export function input(): Plugin[] {
  return [input.markReading(), input.composition(), input.focus()];
}

export namespace input {
  /** Prepare native input before it enters the document's transaction loop. */
  export function prepare(state: EditorState, tr: Transaction): void {
    if (isHistoryTransaction(tr) || tr.getMeta('appendedTransaction')) return;
    const committing = tr.getMeta(compositionCommit);
    if (!committing && (compositionState(state)?.isComposing || tr.getMeta('composition') != null)) return;
    mark.type(state, tr);
    if (tr.docChanged || committing) frontmatter.input(state, tr);
    const pointer = normalizationKey.getState(state);
    if (!tr.docChanged && tr.selectionSet && !pointer?.isPointerActive && !pointer?.isPointerSelecting &&
        tr.selection instanceof TextSelection && !tr.selection.empty) {
      const normalized = normalizeTextSelection(tr.selection, sourceEditingSelection(state));
      if (normalized) tr.setSelection(normalized);
    }
  }

  /** Route history keys pressed on noneditable document buttons through the native keymap. */
  export function historyKey(view: EditorView, event: KeyboardEvent): boolean {
    if (!canRunCommand(view.state, view) || event.isComposing || event.keyCode === 229 || event.altKey ||
        !(event.metaKey || event.ctrlKey) || !['z', 'y'].includes(event.key.toLowerCase())) return false;
    const handled = !!view.someProp('handleKeyDown', handler => handler(view, event));
    if (handled) event.preventDefault();
    return handled;
  }

  /** Install pointer ownership at its place in the selection-correction order. */
  export function pointer(): Plugin[] {
    return [selection()];
  }

  /** The browser and ProseMirror own composition text and selection. */
  export function composition(): Plugin<CompositionState> {
    return new Plugin({
      key: compositionKey,
      state: compositionField,
      props: {
        handleKeyDown(view, event) {
          return event.key === 'Enter' && compositionState(view.state)?.isComposing === true;
        },
      },
      view: view => new CompositionView(view),
    });
  }

  /** Focus changes request settlement after the browser has completed its event. */
  export function focus(): Plugin<FocusState> {
    let current: FocusView | null = null;
    return new Plugin({
      key: focusKey,
      state: focusField,
      props: { handleDOMEvents: {
        focus: () => current?.focus() ?? false,
        blur: () => current?.blur() ?? false,
      } },
      view: view => current = new FocusView(view),
    });
  }

  /** Read each mark back from the span the view drew for it. During composition PM
   * temporarily sets its own mark descriptions aside and asks the DOM parser instead. */
  export function markReading(): Plugin {
    const reader = new MarkReader(schema);
    return new Plugin({ props: { markViews: reader.views, domParser: reader.parser } });
  }
}

/** Composition bookkeeping around ProseMirror's native input handling. */
class CompositionView implements PluginView {
  private generation = 0;
  private destroyed = false;
  private editable: boolean;
  private readonly detach?: () => void;

  constructor(readonly view: EditorView) {
    this.detach = findEditor(view.dom)?.beforeDetach(() => releaseInput(view));
    this.editable = view.editable;
    // Capture precedes PM's initial flush; the end continuation follows its final replacement.
    view.dom.addEventListener('compositionstart', this.start, true);
    view.dom.addEventListener('compositionend', this.end);
  }

  private start = (event: CompositionEvent): void => {
    const { view } = this;
    if (!view.editable || !ownsInput(view, event)) return;
    this.generation++;
    view.dispatch(view.state.tr.setMeta('composition', true).setMeta('addToHistory', false)
      .setMeta(compositionKey, {
        action: 'start', activeTextblockPos: compositionPosition(view.state.selection),
      } satisfies CompositionChange));
  };

  private end = (event: CompositionEvent): void => {
    if (!ownsInput(this.view, event)) return;
    const generation = this.generation;
    queueMicrotask(() => {
      if (this.destroyed || this.view.isDestroyed || this.generation !== generation) return;
      const tr = finishComposition(this.view.state);
      // Bookkeeping has no steps. Appended source corrections inherit the last native
      // replacement's history policy and remain part of that input's undo event.
      if (tr) this.view.dispatch(tr);
    });
  };

  update(view: EditorView): void {
    const editable = this.editable;
    this.editable = view.editable;
    if (editable && !this.editable) releaseInput(view);
  }

  destroy(): void {
    this.detach?.();
    this.destroyed = true;
    this.generation++;
    this.view.dom.removeEventListener('compositionstart', this.start, true);
    this.view.dom.removeEventListener('compositionend', this.end);
  }
}

class FocusView implements PluginView {
  private generation = 0;
  private readonly detach?: () => void;

  constructor(readonly view: EditorView) {
    this.detach = findEditor(view.dom)?.beforeDetach(() => settleBlur(view));
  }

  focus(): false {
    this.generation++;
    this.view.dispatch(this.view.state.tr.setMeta(focusKey, { blurPending: false, focused: true })
      .setMeta('addToHistory', false));
    return false;
  }

  blur(): false {
    const generation = ++this.generation;
    queueMicrotask(() => {
      if (this.view.isDestroyed || generation !== this.generation) return;
      this.view.dispatch(this.view.state.tr.setMeta(focusKey, { blurPending: true, focused: false }));
    });
    return false;
  }

  destroy(): void {
    this.detach?.();
    this.generation++;
  }
}

/** A control's own input is not a composition in the document behind that control. */
function ownsInput(view: EditorView, event: Event): boolean {
  let target = event.target as DOMNode | null;
  if (!target || !view.dom.contains(target)) return false;
  for (; target && target !== view.dom; target = target.parentNode) {
    if (target.nodeType !== 1) continue;
    const element = target as HTMLElement;
    if (element.contentEditable === 'false' || /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName)) return false;
  }
  return true;
}

/** Attachment ends without manufacturing a final native input event. */
function releaseInput(view: EditorView): void {
  const composition = finishComposition(view.state);
  if (composition) view.dispatch(composition);
  const pointer = normalizationKey.getState(view.state);
  if (pointer?.isPointerActive || pointer?.isPointerSelecting) {
    finishPointerSelection(view, true);
  }
  if (tableEditingKey.getState(view.state) != null) {
    view.dispatch(view.state.tr.setMeta(tableEditingKey, -1).setMeta('addToHistory', false));
  }
}

function settleBlur(view: EditorView): void {
  const state = view.state;
  const focus = focusKey.getState(state);
  if (!focus?.focused && !focus?.blurPending && !phrasing.settles(state.selection.$head, state) &&
      !trailingWhitespace.pending(state.selection.$head)) return;
  view.dispatch(state.tr.setMeta(focusKey, { blurPending: true, focused: false }));
}

/** DOM keys belong to the browser; the reader owns the marks associated with them. */
class MarkReader {
  readonly views: Record<string, MarkViewConstructor> = {};
  readonly parser: DOMParser;
  private readonly drawn = new WeakMap<DOMNode, Mark>();

  constructor(schema: Schema) {
    const rules: ParseRule[] = [];
    for (const name of Object.keys(schema.marks)) {
      const type = schema.marks[name]!;
      if (!type.spec.toDOM) continue;
      this.views[name] = (mark, view, inline) => this.draw(mark, view.dom.ownerDocument, inline);
      rules.push({ tag: '*', mark: name, getAttrs: dom => {
        const mark = this.drawn.get(dom as DOMNode);
        return mark?.type === type ? mark.attrs : false;
      } });
    }
    this.parser = new DOMParser(schema, [...rules, ...DOMParser.fromSchema(schema).rules]);
  }

  private draw(mark: Mark, document: Document, inline: boolean): MarkView {
    const rendered = DOMSerializer.renderSpec(document, mark.type.spec.toDOM!(mark, inline));
    this.drawn.set(rendered.dom, mark);
    return rendered as MarkView;
  }
}
