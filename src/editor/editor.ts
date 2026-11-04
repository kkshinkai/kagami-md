/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { input } from './input.js';
import { Destroyable, Emitter, type Event, type IDestroyable } from '../event/index.js';
import { EditorView } from 'prosemirror-view';
import type { Command } from '../command/command.js';
import type { Tag } from '../schema/tag.js';
import type { Wikilink } from '../schema/wikilink.js';
import * as documentState from '../state/state.js';
import { clipboard } from './clipboard.js';
import { connectionEvent, createEditorElement, type EditorElement } from './dom.js';

/** A rendered document. Its state can outlive this attachment. */
export class KagamiMD extends Destroyable {
  static create(spec: KagamiMD.Spec = {}): KagamiMD { return new KagamiMD(spec); }

  readonly dom: HTMLElement;
  readonly state: KagamiMD.State;
  /** @internal */
  view: EditorView | undefined;
  /** @internal */
  readonly updates = this._register(new Emitter<KagamiMD.Update>());
  readonly onDidUpdate: Event<KagamiMD.Update> = this.updates.event;
  /** @internal */
  readonly errors = this._register(new Emitter<unknown>());
  readonly onDidError: Event<unknown> = this.errors.event;
  /** @internal */
  readonly spec: KagamiMD.Spec;
  private readonly ownsState: boolean;
  private readonly handlers = new Map<Command<never>, Command<never>[]>();
  private readonly detachHandlers = new Set<() => void>();
  private readOnlyValue: boolean;
  private destroyed = false;
  private destroying = false;

  private constructor(spec: KagamiMD.Spec) {
    super();
    this.spec = spec;
    this.ownsState = !spec.state;
    this.state = spec.state ?? KagamiMD.State.create(spec);
    if (this.state.isDestroyed()) throw new Error('Editor state is destroyed');
    this.readOnlyValue = spec.readOnly ?? false;
    this.dom = createEditorElement(document, this);
    const content = this.dom.appendChild(document.createElement('div'));
    this.state.attachView(this);
    try {
      const editor = this;
      const view = new EditorView({ mount: content }, {
        state: this.state.editorState,
        editable: () => !this.readOnlyValue,
        dispatchTransaction(transaction) {
          if (editor.destroyed) return;
          try {
            clipboard.prepare(this.state, transaction);
            input.prepare(this.state, transaction);
            editor.state.applyTransaction(transaction, this.state);
          } catch (error) {
            editor.reportError(error);
          }
        },
      });
      if (this.destroyed) {
        view.destroy();
        throw new Error('Editor was destroyed during construction');
      }
      this.view = view;
      if (view.state !== this.state.editorState) view.updateState(this.state.editorState);
      this.dom.addEventListener(connectionEvent, this.connectionChanged);
      spec.parent?.appendChild(this.dom);
    } catch (error) {
      try { this.destroy(); } catch { /* Preserve the construction error. */ }
      throw error;
    }
  }

  get readOnly(): boolean { return this.readOnlyValue; }

  setReadOnly(value: boolean): void {
    this.assertAlive();
    if (value === this.readOnlyValue) return;
    this.readOnlyValue = value;
    this.view?.setProps({ editable: () => !this.readOnlyValue });
  }

  get hasFocus(): boolean { return !this.destroyed && !!this.view?.hasFocus(); }

  focus(): void {
    this.assertAlive();
    this.view?.focus();
  }

  handle<Param>(command: Command<Param>, handler: Command<Param>): IDestroyable {
    this.assertAlive();
    const key: Command<never> = command;
    const entry: Command<never> = handler;
    this.handlers.set(key, [entry, ...this.handlers.get(key) ?? []]);
    return {
      destroy: () => {
        const handlers = this.handlers.get(key);
        if (handlers) this.handlers.set(key, handlers.filter(each => each !== entry));
      },
    };
  }

  /** @internal */
  commandHandlers<Param>(command: Command<Param>): readonly Command<Param>[] {
    return this.destroyed ? [] : (this.handlers.get(command) ?? []) as Command<Param>[];
  }

  /** Register settlement that must finish before the native view is destroyed. @internal */
  beforeDetach(action: () => void): () => void {
    this.detachHandlers.add(action);
    return () => { this.detachHandlers.delete(action); };
  }

  isDestroyed(): boolean { return this.destroyed; }

  override destroy(): void {
    if (this.destroyed || this.destroying) return;
    this.destroying = true;
    const errors: unknown[] = [];
    const clean = (action: () => void) => {
      try { action(); } catch (error) { errors.push(error); }
    };
    const view = this.view;
    for (const detach of this.detachHandlers) clean(detach);
    this.detachHandlers.clear();
    this.destroyed = true;
    this.dom.removeEventListener(connectionEvent, this.connectionChanged);
    clean(() => view?.destroy());
    (this.dom as EditorElement).editor = null;
    this.handlers.clear();
    this.dom.remove();
    clean(() => this.state.detachView(this));
    if (this.ownsState) clean(() => this.state.destroy());
    clean(() => super.destroy());
    this.view = undefined;
    this.destroying = false;
    if (errors.length) throw errors[0];
  }

  /** @internal */
  reportError(error: unknown): void {
    if (this.destroyed) return;
    if (this.errors.hasListeners()) this.errors.fire(error);
    else throw error;
  }

  private connectionChanged = (): void => {
    const view = this.view;
    if (this.destroyed || !view) return;
    view.updateRoot();
    view.setProps({});
  };

  private assertAlive(): void {
    if (this.destroyed) throw new Error('Editor is destroyed');
  }
}

export namespace KagamiMD {
  /** What {@link KagamiMD.create} is given. Every field may be left out. */
  export interface Spec extends State.Spec {
    /** When given, the editor's element is appended to it. */
    readonly parent?: Element | DocumentFragment;
    /** A document made beforehand with {@link State.create}. The editor does not destroy it. */
    readonly state?: State;
    readonly readOnly?: boolean;
    /** Given what the user has typed of a tag, answers the tags to offer. */
    readonly completeTag?: Tag.Completer;
    /** Given what the user has typed of a wikilink, answers the pages to offer. */
    readonly completeWikilink?: Wikilink.Completer;
    /**
     * The id of the element in which the host draws the completions. Given, the editor names
     * that element, and the candidate at `index` as `${completionList}-${index}`, to a screen
     * reader as what the caret is in. Without it the editor says nothing of a list.
     */
    readonly completionList?: string;
    /** Given the destination written in an image, answers the address to load it from. */
    readonly resolveImage?: (destination: string) => string;
  }

  /** The document owner, defined once in the state subsystem. */
  export import State = documentState.State;

  /** What {@link KagamiMD.onDidUpdate} is fired with. */
  export interface Update {
    readonly state: State;
    /** Whether the Markdown text changed. */
    readonly docChanged: boolean;
  }
}
