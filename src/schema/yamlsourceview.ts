/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { defaultKeymap, history, historyKeymap, redo, redoDepth, undo, undoDepth } from '@codemirror/commands';
import { Compartment, EditorState, Transaction } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { Emitter } from '../event/index.js';

/** One temporary source editor owns one CodeMirror history until the draft is applied. */
export class YAMLSourceView {
  readonly view: EditorView;
  readonly element: HTMLElement;
  readonly inputElement: HTMLElement;
  private destroyed = false;
  private options: Readonly<YAMLSourceView.Options>;
  private readonly _onDidChangeOptions = new Emitter<YAMLSourceView.OptionsChange>();
  get onDidChangeOptions() { return this._onDidChangeOptions.event; }
  private readonly readOnly = new Compartment();

  constructor(place: HTMLElement, markdown: string, selection: YAMLSourceView.Selection | null,
    onUpdate: () => void, onError: (error: unknown) => void, options: Partial<YAMLSourceView.Options> = {}) {
    validateOptions(options);
    this.options = Object.freeze({ readOnly: options.readOnly ?? false });
    const anchor = clamp(selection?.anchor ?? 0, markdown.length);
    const head = clamp(selection?.head ?? selection?.anchor ?? 0, markdown.length);
    const state = EditorState.create({ doc: markdown, selection: { anchor, head }, extensions: [
      this.readOnly.of([EditorState.readOnly.of(this.options.readOnly), EditorView.editable.of(!this.options.readOnly)]),
      history(), keymap.of([...defaultKeymap, ...historyKeymap]), lineNumbers(), EditorView.lineWrapping,
      EditorView.contentAttributes.of({ 'aria-label': 'Markdown source', spellcheck: 'false' }),
      EditorView.updateListener.of(onUpdate), EditorView.exceptionSink.of(onError),
    ] });
    this.view = new EditorView({ parent: place, state, scrollTo: EditorView.scrollIntoView(state.selection.main) });
    this.element = this.view.dom;
    this.inputElement = this.view.contentDOM;
  }

  read(): { markdown: string; selection: YAMLSourceView.Selection } {
    const { anchor, head } = this.view.state.selection.main;
    return { markdown: this.view.state.doc.toString(), selection: { anchor, head } };
  }
  isDestroyed(): boolean { return this.destroyed; }
  isComposing(): boolean { return !this.destroyed && this.view.compositionStarted; }

  select(position: 'start' | 'end' | YAMLSourceView.Selection): void {
    this.assertAlive();
    if (this.isComposing()) return;
    const offset = position === 'end' ? this.view.state.doc.length : 0;
    const selection = typeof position === 'string' ? { anchor: offset, head: offset } : position;
    if (!Number.isInteger(selection.anchor) || !Number.isInteger(selection.head))
      throw new RangeError('Source positions must be integer UTF-16 offsets');
    this.view.dispatch({ selection: {
      anchor: clamp(selection.anchor, this.view.state.doc.length),
      head: clamp(selection.head, this.view.state.doc.length),
    }, scrollIntoView: true, annotations: Transaction.addToHistory.of(false) });
  }

  getOptions(): Readonly<YAMLSourceView.Options> {
    this.assertAlive();
    return this.options;
  }

  updateOptions(options: Partial<YAMLSourceView.Options>): void {
    this.assertAlive();
    validateOptions(options);
    if (options.readOnly === undefined || options.readOnly === this.options.readOnly) return;
    const readOnly = options.readOnly;
    this.options = Object.freeze({ readOnly });
    this.view.dispatch({
      effects: this.readOnly.reconfigure([EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly)])
    });
    this._onDidChangeOptions.fire(Object.freeze({ changed: Object.freeze({ readOnly: true }) }));
  }

  canUndo(): boolean { return undoDepth(this.view.state) > 0; }
  canRedo(): boolean { return redoDepth(this.view.state) > 0; }
  undo(): boolean {
    this.assertAlive();
    return !this.isComposing() && undo(this.view);
  }
  redo(): boolean {
    this.assertAlive();
    return !this.isComposing() && redo(this.view);
  }
  focus(): void {
    this.assertAlive();
    this.view.focus();
  }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    try { this.view.destroy(); } finally { this._onDidChangeOptions.destroy(); }
  }
  private assertAlive(): void {
    if (this.destroyed) throw new Error('YAMLSourceView is destroyed');
  }
}

export namespace YAMLSourceView {
  /** A selection in the temporary source text. */
  export interface Selection { readonly anchor: number; readonly head: number }

  /** The source editor's supported option. */
  export interface Options { readonly readOnly: boolean }

  /** An option update observed by the temporary source editor's owner. */
  export interface OptionsChange { readonly changed: { readonly readOnly?: true } }
}

function clamp(position: number, size: number): number { return Math.max(0, Math.min(size, position)); }

function validateOptions(options: Partial<YAMLSourceView.Options>): void {
  if ('readOnly' in options && typeof options.readOnly !== 'boolean') throw new TypeError('readOnly must be a boolean');
}
