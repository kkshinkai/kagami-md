/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import * as pm from 'prosemirror-history';
import {
  EditorState, Selection, TextSelection, type Command, type Plugin, type Transaction,
} from 'prosemirror-state';
import type { KagamiMD } from '../editor/editor.js';
import type { CompiledPlugins } from '../editor/plugin.js';
import { compilePlugins } from '../editor/plugins.js';
import { Source, read, type EditorLoc, type SourceLoc } from '../source/index.js';
import { Parser, tag, wikilink, type Extension } from '../syntax/index.js';
import { schema } from '../types/schema.js';
import { defaultUnparseOptions, type unparse } from '../unparse/unparse.js';
import { finishHistory } from './history.js';
import { canRunCommand } from './input.js';

/**
 * A document: its Markdown text and its history. It needs no editor: a command that needs
 * only the document runs on a state that nothing shows.
 *
 * KagamiState.create installs only persistent document plugins and fixes the writing options for
 * the document. Attaching a KagamiMD reconfigures view-state plugins in, and detaching
 * reconfigures them back out. Destroying the document destroys its attachment.
 */
export class KagamiState {
  static create(spec: KagamiState.Spec = {}): KagamiState {
    return new KagamiState(spec);
  }

  /** @internal */
  readonly parser: Parser;
  /** @internal */
  readonly plugins: CompiledPlugins;
  /** @internal */
  readonly tagEnabled: boolean;
  /** @internal */
  readonly wikilinkEnabled: boolean;
  private readonly statePlugins: readonly Plugin[];
  private current: EditorState;
  private editor: KagamiMD | null = null;
  private destroyed = false;
  private destroying = false;

  private constructor(spec: KagamiState.Spec) {
    this.tagEnabled = spec.tag != null;
    this.wikilinkEnabled = spec.wikilink != null;
    const extensions: Extension[] = [];
    if (this.wikilinkEnabled) extensions.push(wikilink);
    if (this.tagEnabled) extensions.push(tag);
    this.parser = new Parser({ target: 'editor', cjkFriendly: spec.cjkFriendly !== false, extensions });
    this.plugins = compilePlugins(spec);
    const options: unparse.Options = {
      keepEmptyParagraph: spec.keepEmptyParagraph ?? defaultUnparseOptions.keepEmptyParagraph,
      keepEmptySetextHeading: spec.keepEmptySetextHeading ?? defaultUnparseOptions.keepEmptySetextHeading,
      keepStartingSpaceOrTab: spec.keepStartingSpaceOrTab ?? defaultUnparseOptions.keepStartingSpaceOrTab,
    };
    const initial = read(spec.doc ?? '', options, this.parser);
    this.statePlugins = this.plugins.state(this);
    this.current = EditorState.create({
      schema,
      ...initial,
      selection: Selection.atStart(initial.doc),
      plugins: this.statePlugins,
    });
  }

  getMarkdown(): string {
    this.assertAlive();
    return Source.get(this.current).text();
  }

  sourceToEditor(location: SourceLoc): EditorLoc {
    this.assertAlive();
    return Source.get(this.current).sourceToEditor(location);
  }

  editorToSource(location: EditorLoc): SourceLoc {
    this.assertAlive();
    return Source.get(this.current).editorToSource(location);
  }

  /** Where the selection starts and where its moving end is. They are equal for a cursor. */
  getSelection(): KagamiState.Selection {
    this.assertAlive();
    const { anchor, head } = this.current.selection;
    return { anchor: anchor as EditorLoc, head: head as EditorLoc };
  }

  /** Select from `anchor` to `head`, or put the cursor at `anchor`, at the nearest text. */
  setSelection(anchor: EditorLoc, head: EditorLoc = anchor): void {
    this.assertAlive();
    const { doc } = this.current;
    this.applyTransaction(this.current.tr.setSelection(TextSelection.between(doc.resolve(anchor), doc.resolve(head))));
  }

  /** Take back the last change. Returns `false` when there is none. */
  undo(): boolean {
    return this.runCommand(pm.undo);
  }

  /** Apply again the last undone change. Returns `false` when there is none. */
  redo(): boolean {
    return this.runCommand(pm.redo);
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
    const next = finishHistory(Source.settle(applied.state), applied.transactions);
    if (next === baseState) return next;
    this.current = next;
    const editor = this.editor;
    if (editor?.view && !editor.isDestroyed()) {
      editor.view.updateState(next);
      const before = Source.get(baseState);
      const after = Source.get(next);
      editor._onDidUpdate.fire({ state: this, get docChanged() { return !after.sameText(before); } });
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

  /** Attach the surface and reconfigure view-state plugins onto the document state. @internal */
  attachView(editor: KagamiMD): void {
    this.assertAlive();
    if (this.editor) throw new Error('State is already attached to an editor');
    this.editor = editor;
    this.current = this.current.reconfigure({
      plugins: [...this.statePlugins, ...this.plugins.viewState(editor)],
    });
  }

  /** Detach the surface and reconfigure back to persistent document plugins. @internal */
  detachView(editor: KagamiMD): void {
    if (this.editor !== editor) return;
    this.editor = null;
    if (!this.destroyed && !this.destroying) {
      this.current = this.current.reconfigure({ plugins: this.statePlugins });
    }
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

export namespace KagamiState {
  /** A text selection range inside a document state. */
  export interface Selection {
    readonly anchor: EditorLoc;
    readonly head: EditorLoc;
  }

  /** The initial Markdown and the writing options fixed for the document's lifetime. */
  export interface Spec extends Partial<unparse.Options> {
    /** The Markdown text to begin with. */
    readonly doc?: string;
    /** Use CJK-friendly inline delimiter boundaries. Defaults to true. */
    readonly cjkFriendly?: boolean;
    /** Enable `#tag` syntax when an object is given; `null` or omission disables it. */
    readonly tag?: Record<string, never> | null;
    /** Enable `[[wikilink]]` syntax when an object is given; `null` or omission disables it. */
    readonly wikilink?: Record<string, never> | null;
  }
}
