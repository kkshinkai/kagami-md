/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { EditorState, Selection, TextSelection, type Command, type Transaction } from 'prosemirror-state';
import type { KagamiMD } from '../editor/editor.js';
import { fullSchema } from '../schema/bundle.js';
import { read, source, type EditorLoc, type SourceLoc } from '../source/index.js';
import { schema } from '../types/schema.js';
import { history } from './history.js';
import { canRunCommand } from './input.js';

/**
 * A document: its Markdown text and its history. It needs no editor: a command that needs
 * only the document runs on a state that nothing shows.
 *
 * State.create installs the fixed feature bundle. Its public contract has no configuration
 * parameter, so this bootstrap crosses into schema/. The attached KagamiMD is also held
 * here: destroying the document destroys its attachment, including during construction.
 */
export class State {
  static create(spec: State.Spec = {}): State {
    return new State(spec);
  }

  private current: EditorState;
  private editor: KagamiMD | null = null;
  private destroyed = false;
  private destroying = false;

  private constructor(spec: State.Spec) {
    const initial = read(spec.doc ?? '');
    this.current = EditorState.create({
      schema,
      ...initial,
      selection: Selection.atStart(initial.doc),
      plugins: fullSchema(),
    });
  }

  get doc(): string {
    this.assertAlive();
    return source.get(this.current).text();
  }

  sourceToEditor(location: SourceLoc): EditorLoc {
    this.assertAlive();
    return source.get(this.current).sourceToEditor(location);
  }

  editorToSource(location: EditorLoc): SourceLoc {
    this.assertAlive();
    return source.get(this.current).editorToSource(location);
  }

  /** Where the selection starts and where its moving end is. They are equal for a cursor. */
  get selection(): { readonly anchor: EditorLoc; readonly head: EditorLoc } {
    this.assertAlive();
    const { anchor, head } = this.current.selection;
    return { anchor: anchor as EditorLoc, head: head as EditorLoc };
  }

  /** Select from `anchor` to `head`, or put the cursor at `anchor`, at the nearest text. */
  select(anchor: EditorLoc, head: EditorLoc = anchor): void {
    this.assertAlive();
    const { doc } = this.current;
    this.applyTransaction(this.current.tr.setSelection(TextSelection.between(doc.resolve(anchor), doc.resolve(head))));
  }

  /** @internal */
  get editorState(): EditorState { return this.current; }

  /**
   * Apply against the current immutable state. A retained asynchronous intent must create a
   * new transaction; document equality alone cannot validate its selection or plugin state.
   * All appended transactions settle before the attached surface publishes the result.
   * @internal
   */
  applyTransaction(transaction: Transaction, baseState: EditorState = this.current): EditorState {
    this.assertAlive();
    if (baseState !== this.current) {
      throw new RangeError('A transaction must be dispatched against the current editor state');
    }
    const applied = baseState.applyTransaction(transaction);
    const next = history.finish(source.settle(applied.state), applied.transactions);
    if (next === baseState) return next;
    this.current = next;
    const editor = this.editor;
    if (editor?.view && !editor.isDestroyed()) {
      editor.view.updateState(next);
      const before = source.get(baseState);
      const after = source.get(next);
      editor.updates.fire({ state: this, get docChanged() { return !after.sameText(before); } });
    }
    return next;
  }

  /** @internal */
  runCommand(command: Command): boolean {
    this.assertAlive();
    const state = this.current;
    const view = this.editor?.view;
    return canRunCommand(state, view) && command(state, transaction => this.applyTransaction(transaction, state), view);
  }

  /** Attach the surface without replacing any document field or plugin. @internal */
  attachView(editor: KagamiMD): void {
    this.assertAlive();
    if (this.editor) throw new Error('State is already attached to an editor');
    this.editor = editor;
  }

  /** @internal */
  detachView(editor: KagamiMD): void {
    if (this.editor === editor) this.editor = null;
  }

  isDestroyed(): boolean { return this.destroyed; }

  destroy(): void {
    if (this.destroyed || this.destroying) return;
    this.destroying = true;
    try {
      this.editor?.destroy();
    } finally {
      this.editor = null;
      this.destroyed = true;
      this.destroying = false;
    }
  }

  private assertAlive(): void {
    if (this.destroyed) throw new Error('Editor state is destroyed');
  }
}

export namespace State {
  /** The Markdown text from which a document starts. */
  export interface Spec { readonly doc?: string; }
}
