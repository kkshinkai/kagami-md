/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { prepareInput } from './input.js';
import { Destroyable, Emitter, type Event, type IDestroyable } from '../event/index.js';
import { toDestroyable } from '../event/lifecycle.js';
import { EditorView } from 'prosemirror-view';
import { KagamiState } from '../state/state.js';
import type { EditorLoc } from '../source/index.js';
import { refreshImages } from '../schema/image.js';
import { prepareClipboard } from './clipboard.js';
import { readCompletion, refreshCompletion } from './completion.js';
import { connectionEvent, createEditorElement } from './dom.js';

/** A rendered document. Its state can outlive this attachment. */
export class KagamiMD extends Destroyable {
  static create(spec: KagamiMD.Spec = {}): KagamiMD {
    const state = KagamiState.create(spec);
    try {
      return new KagamiMD(state, spec, true);
    } catch (error) {
      try { state.destroy(); } catch { /* Preserve the construction error. */ }
      throw error;
    }
  }

  static fromState(state: KagamiState, spec: KagamiMD.View.Spec = {}): KagamiMD {
    return new KagamiMD(state, spec, false);
  }

  readonly dom: HTMLElement;
  readonly state: KagamiMD.State;
  /** @internal */
  view: EditorView | undefined;
  /** @internal */
  readonly _onDidUpdate = this._register(new Emitter<KagamiMD.Update>());
  /** @internal */
  readonly _onDidError = this._register(new Emitter<unknown>());
  /** @internal */
  readonly _onDidChangeCompletion = this._register(new Emitter<KagamiMD.Completion | null>());
  /** @internal */
  readonly _onDidClickCodeBlockLanguage = this._register(new Emitter<KagamiMD.CodeBlockLanguageEvent>());
  /** @internal */
  readonly _onDidClickCalloutType = this._register(new Emitter<KagamiMD.CalloutTypeEvent>());
  /** @internal */
  readonly _onDidClickFrontmatterPropertyType = this._register(new Emitter<KagamiMD.FrontmatterPropertyTypeEvent>());
  /** @internal */
  readonly _onDidClickTableHandle = this._register(new Emitter<KagamiMD.TableHandleEvent>());
  /** @internal */
  readonly drawnSelection: boolean;
  private readonly tagCompletionProviders: ProviderRegistration<KagamiMD.CompletionProvider>[] = [];
  private readonly wikilinkCompletionProviders: ProviderRegistration<KagamiMD.CompletionProvider>[] = [];
  private readonly imageProviders: ProviderRegistration<KagamiMD.ImageProvider>[] = [];
  private readonly ownsState: boolean;
  private readonly detachHandlers = new Set<() => void>();
  private readOnlyValue: boolean;
  private destroyed = false;
  private destroying = false;

  get onDidUpdate() { return this._onDidUpdate.event; }
  get onDidError() { return this._onDidError.event; }
  get onDidChangeCompletion() { return this._onDidChangeCompletion.event; }
  get onDidClickCodeBlockLanguage() { return this._onDidClickCodeBlockLanguage.event; }
  get onDidClickCalloutType() { return this._onDidClickCalloutType.event; }
  get onDidClickFrontmatterPropertyType() { return this._onDidClickFrontmatterPropertyType.event; }
  get onDidClickTableHandle() { return this._onDidClickTableHandle.event; }

  private constructor(state: KagamiState, spec: KagamiMD.View.Spec, ownsState: boolean) {
    super();
    this.state = state;
    this.drawnSelection = spec.drawnSelection ?? false;
    this.ownsState = ownsState;
    if (this.state.isDestroyed()) throw new Error('Editor state is destroyed');
    this.readOnlyValue = spec.readOnly ?? false;
    this.dom = createEditorElement(document);
    const content = this.dom.appendChild(document.createElement('div'));
    this.state.attachView(this);
    try {
      const editor = this;
      const view = new EditorView({ mount: content }, {
        state: this.state.editorState,
        plugins: this.state.plugins.view(this),
        editable: () => !this.readOnlyValue,
        dispatchTransaction(transaction) {
          if (editor.destroyed) return;
          try {
            prepareClipboard(this.state, transaction);
            prepareInput(this.state, transaction);
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

  /** Whether edits on this editor view are currently disabled. */
  isReadOnly(): boolean { return this.readOnlyValue; }

  setReadOnly(value: boolean): void {
    this.assertAlive();
    if (value === this.readOnlyValue) return;
    this.readOnlyValue = value;
    this.view?.setProps({ editable: () => !this.readOnlyValue });
  }

  /** Whether the editor view currently holds focus. */
  hasFocus(): boolean { return !this.destroyed && !!this.view?.hasFocus(); }

  focus(): void {
    this.assertAlive();
    this.view?.focus();
  }

  /** Take back the last change. Returns `false` when there is none. */
  undo(): boolean {
    this.assertAlive();
    return this.state.undo();
  }

  /** Apply again the last undone change. Returns `false` when there is none. */
  redo(): boolean {
    this.assertAlive();
    return this.state.redo();
  }

  /** Copy the active selection through the browser clipboard. */
  copy(): boolean {
    this.assertAlive();
    return this.clipboard('copy');
  }

  /** Cut the active selection through the browser clipboard. */
  cut(): boolean {
    this.assertAlive();
    return this.clipboard('cut');
  }

  /** The completion currently open at the caret, or `null` when none is active. */
  getCompletion(): KagamiMD.Completion | null {
    return readCompletion(this);
  }

  /** Register a completion provider for `#name` tags on this editor. */
  registerTagCompletionProvider(provider: KagamiMD.CompletionProvider): IDestroyable {
    this.assertAlive();
    if (!this.state.tagEnabled) {
      console.warn('Cannot register a tag completion provider when tag syntax is disabled.');
      return Destroyable.None;
    }
    return this.registerCompletion(this.tagCompletionProviders, 'tag', provider);
  }

  /** Register a completion provider for `[[name]]` page links on this editor. */
  registerWikilinkCompletionProvider(provider: KagamiMD.CompletionProvider): IDestroyable {
    this.assertAlive();
    if (!this.state.wikilinkEnabled) {
      console.warn('Cannot register a wikilink completion provider when wikilink syntax is disabled.');
      return Destroyable.None;
    }
    return this.registerCompletion(this.wikilinkCompletionProviders, 'wikilink', provider);
  }

  /** Register an image URL provider for Markdown and HTML images on this editor. */
  registerImageProvider(provider: KagamiMD.ImageProvider): IDestroyable {
    this.assertAlive();
    const entry: ProviderRegistration<KagamiMD.ImageProvider> = {
      provider,
      subscription: provider.onDidChange?.(() => {
        if (!this.destroyed) refreshImages(this);
      }),
    };
    this.imageProviders.unshift(entry);
    refreshImages(this);
    return toDestroyable(() => {
      const index = this.imageProviders.indexOf(entry);
      if (index < 0) return;
      this.imageProviders.splice(index, 1);
      entry.subscription?.destroy();
      if (!this.destroyed) refreshImages(this);
    });
  }

  /** @internal */
  getTagCompletionProviders(): readonly KagamiMD.CompletionProvider[] {
    return this.tagCompletionProviders.map(entry => entry.provider);
  }

  /** @internal */
  getWikilinkCompletionProviders(): readonly KagamiMD.CompletionProvider[] {
    return this.wikilinkCompletionProviders.map(entry => entry.provider);
  }

  /** @internal */
  getImageProviders(): readonly KagamiMD.ImageProvider[] {
    return this.imageProviders.map(entry => entry.provider);
  }

  private clipboard(operation: 'copy' | 'cut'): boolean {
    const view = this.view;
    if (!view || view.state.selection.empty || operation === 'cut' && !view.editable) return false;
    view.focus();
    return view.dom.ownerDocument.execCommand(operation);
  }

  private registerCompletion(
    list: ProviderRegistration<KagamiMD.CompletionProvider>[],
    target: 'tag' | 'wikilink',
    provider: KagamiMD.CompletionProvider,
  ): IDestroyable {
    const entry: ProviderRegistration<KagamiMD.CompletionProvider> = { provider };
    list.unshift(entry);
    refreshCompletion(this, target, true);
    return toDestroyable(() => {
      const index = list.indexOf(entry);
      if (index < 0) return;
      list.splice(index, 1);
      refreshCompletion(this, target, list.length > 0);
    });
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
    this.tagCompletionProviders.length = 0;
    this.wikilinkCompletionProviders.length = 0;
    for (const entry of this.imageProviders.splice(0)) clean(() => entry.subscription?.destroy());
    this.dom.remove();
    if (this.ownsState) clean(() => this.state.destroy());
    else clean(() => this.state.detachView(this));
    clean(() => super.destroy());
    this.view = undefined;
    this.destroying = false;
    if (errors.length) throw errors[0];
  }

  /** @internal */
  reportError(error: unknown): void {
    if (this.destroyed) return;
    if (this._onDidError.hasListeners()) this._onDidError.fire(error);
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
  /** View options shared by {@link KagamiMD.create} and {@link KagamiMD.fromState}. Every field may be left out. */
  export namespace View {
    /** Options for rendering and integrating an editor view without document state. */
    export interface Spec {
      /** When given, the editor's element is appended to it. */
      readonly parent?: Element | DocumentFragment;
      readonly readOnly?: boolean;
      /** Draw text selection highlights instead of native highlights. Defaults to false. */
      readonly drawnSelection?: boolean;
    }
  }

  /** What {@link KagamiMD.create} is given. Every field may be left out. */
  export interface Spec extends State.Spec, View.Spec {}

  /** The document owner, defined once in the state subsystem. */
  export import State = KagamiState;

  /** What {@link KagamiMD.onDidUpdate} is fired with. */
  export interface Update {
    readonly state: State;
    /** Whether the Markdown text changed. */
    readonly docChanged: boolean;
  }

  /** A host's open UI anchor, keeping a canvas control marked expanded until destroyed. */
  export interface Hold extends IDestroyable {
    /** The control's current rectangle, or `null` after it leaves the document. */
    rect(): DOMRectReadOnly | null;
  }

  /** One offered completion item, with its stable identity and optional presentation. */
  export interface CompletionCandidate {
    readonly id: string;
    readonly value: string;
    readonly label?: string;
    readonly description?: string;
  }

  /** A supported callout declaration type. */
  export type CalloutType = 'note' | 'tip' | 'important' | 'warning' | 'caution';

  /** A supported declaration offered by callout completion. */
  export interface CalloutCompletionCandidate extends CompletionCandidate {
    readonly value: CalloutType;
  }

  /** Supplies completion candidates for a query until its request is aborted. */
  export interface CompletionProvider {
    provideCandidates(
      query: string,
      signal: AbortSignal,
    ): readonly CompletionCandidate[] | Promise<readonly CompletionCandidate[]>;
  }

  interface CompletionBase<C extends CompletionCandidate> {
    readonly query: string;
    readonly pending: boolean;
    readonly items: readonly C[];
    readonly active: number;
    readonly rect: DOMRectReadOnly;
    accept(index?: number): boolean;
    activate(index: number): boolean;
    dismiss(): boolean;
  }

  /** Active `#name` tag completion presentation and controls. */
  export interface TagCompletion extends CompletionBase<CompletionCandidate> {
    readonly kind: 'tag';
  }

  /** Active `[[name]]` page-link completion presentation and controls. */
  export interface WikilinkCompletion extends CompletionBase<CompletionCandidate> {
    readonly kind: 'wikilink';
    readonly alias: string | null;
  }

  /** Active callout declaration completion presentation and controls. */
  export interface CalloutCompletion extends CompletionBase<CalloutCompletionCandidate> {
    readonly kind: 'callout';
  }

  /** The completion currently open at the caret, discriminated by `kind`. */
  export type Completion = TagCompletion | WikilinkCompletion | CalloutCompletion;

  /** Resolves image destinations written in the document to loadable URLs. */
  export interface ImageProvider {
    readonly onDidChange?: Event<void>;
    resolveImageURL(destination: string, signal: AbortSignal): string | null | Promise<string | null>;
  }

  /** One language label offered by code block language selection. */
  export interface CodeBlockLanguageChoice {
    readonly value: string;
    readonly label: string;
  }

  /** Fired when a code block's language control is clicked. */
  export interface CodeBlockLanguageEvent {
    readonly pos: EditorLoc;
    readonly rect: DOMRectReadOnly;
    readonly language: string;
    readonly languages: readonly CodeBlockLanguageChoice[];
    hold(): Hold | null;
    setLanguage(language: string): boolean;
  }

  /** One declaration type and its display label for callouts. */
  export interface CalloutTypeChoice {
    readonly value: CalloutType;
    readonly label: string;
  }

  /** Fired when a callout's declaration type control is clicked. */
  export interface CalloutTypeEvent {
    readonly pos: EditorLoc;
    readonly rect: DOMRectReadOnly;
    readonly type: CalloutType;
    readonly types: readonly CalloutTypeChoice[];
    hold(): Hold | null;
    setType(type: CalloutType): boolean;
    toQuote(): boolean;
  }

  /** A structured frontmatter value type. */
  export type FrontmatterValueType = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';

  /** Fired when a frontmatter property or sequence item's type control is clicked. */
  export interface FrontmatterPropertyTypeEvent {
    readonly pos: EditorLoc;
    readonly rect: DOMRectReadOnly;
    readonly type: FrontmatterValueType;
    readonly conversions: Readonly<Record<FrontmatterValueType, 'convert' | 'reset'>>;
    hold(): Hold | null;
    setType(type: FrontmatterValueType): boolean;
    insertProperty(side: 'above' | 'below'): boolean;
    deleteProperty(): boolean;
  }

  /** A GFM column alignment, or `'default'` when the delimiter cell sets none. */
  export type TableAlign = 'default' | 'left' | 'center' | 'right';

  /** Fired after clicking a table row or column handle selects its axis. */
  export interface TableHandleEvent {
    readonly pos: EditorLoc;
    readonly rect: DOMRectReadOnly;
    readonly axis: 'row' | 'column';
    readonly index: number;
    readonly align: TableAlign;
    hold(): Hold | null;
    insertBefore(): boolean;
    insertAfter(): boolean;
    setColumnAlign(align: TableAlign): boolean;
    delete(): boolean;
  }
}

interface ProviderRegistration<T> {
  readonly provider: T;
  readonly subscription?: IDestroyable;
}
