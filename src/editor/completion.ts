/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { closeHistory, isHistoryTransaction } from 'prosemirror-history';
import { Plugin, PluginKey, TextSelection, type Command as PMCommand, type EditorState, type Transaction } from 'prosemirror-state';
import { ReplaceStep } from 'prosemirror-transform';
import type { EditorView } from 'prosemirror-view';
import { isFormattingTransaction } from '../schema/format.js';
import { isolateHistory, restoringHistory } from '../state/history.js';
import { compositionState, compositionCommit } from '../state/input.js';
import type { KagamiMD } from './editor.js';

/** Mapped prompts and a view that owns asynchronous lookup and geometry. */
export function completion(
  sources: readonly CompletionSource<KagamiMD.CompletionCandidate>[],
  editor?: KagamiMD,
): Plugin<CompletionState> {
  const attachment: CompletionAttachment = { view: null };
  return new Plugin<CompletionState>({
    key: completionKey,
    state: { init: () => ({ serial: 0, active: null, dismissed: null, attachment }), apply: (tr, previous, old, state) => {
      const next = applyCompletion(tr, previous, old, state);
      return attachment.view ? reconcile(tr, next, state, sources, attachment.view.editor) : next;
    } },
    props: {
      handleKeyDown(view, event) {
        if (!available(view) || event.isComposing || event.keyCode === 229 ||
            event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
        const active = completionKey.getState(view.state)?.active;
        if (!active) return false;
        if (event.key === 'Escape') return dismissCompletion(view.state, view.dispatch);
        if (active.status !== 'ready' || !active.items.length ||
            event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return false;
        view.dispatch(view.state.tr.setMeta(completionKey, {
          kind: 'select', index: active.selectedIndex + (event.key === 'ArrowUp' ? -1 : 1),
        } satisfies CompletionMeta));
        return true;
      },
      handlePaste(view) {
        dismissCompletion(view.state, view.dispatch);
        return false;
      },
      handleDrop(view) {
        dismissCompletion(view.state, view.dispatch);
        return false;
      },
      handleDOMEvents: { blur(view) {
        dismissCompletion(view.state, view.dispatch);
        return false;
      } },
    },
    view(view) {
      return attachment.view = new CompletionView(view, attachment, editor ?? null);
    },
  });
}

export interface CompletionAttachment {
  view: { readonly editor: KagamiMD | null; read(): KagamiMD.Completion | null } | null;
}

export interface ActiveCompletion {
  readonly requestId: number;
  readonly source: CompletionSource<KagamiMD.CompletionCandidate>;
  readonly context: CompletionPrompt;
  readonly status: 'pending' | 'ready';
  readonly items: readonly KagamiMD.CompletionCandidate[];
  readonly selectedIndex: number;
}

export interface DismissedCompletion {
  readonly source: CompletionSource<KagamiMD.CompletionCandidate>;
  readonly from: number;
}

export interface CompletionState {
  readonly attachment: CompletionAttachment;
  readonly serial: number;
  readonly active: ActiveCompletion | null;
  readonly dismissed: DismissedCompletion | null;
}

type CompletionMeta = { kind: 'dismiss' | 'accept' }
  | { kind: 'select'; index: number }
  | { kind: 'results'; requestId: number; items: readonly KagamiMD.CompletionCandidate[] }
  | { kind: 'providers'; target: 'tag' | 'wikilink'; enabled: boolean };

export const completionKey = new PluginKey<CompletionState>('markdown-completion');

/** Dismiss the prompt without editing its source or selection. */
const dismissCompletion: PMCommand = (state, dispatch) => {
  if (!completionKey.getState(state)?.active) return false;
  dispatch?.(state.tr.setMeta(completionKey, { kind: 'dismiss' } satisfies CompletionMeta));
  return true;
};

/** Recheck the current prompt before inserting one parser-validated source replacement. */
export function acceptCompletion(index?: number): PMCommand {
  return (state, dispatch, view) => {
    if (compositionState(state)?.isComposing || view && !available(view)) return false;
    const active = completionKey.getState(state)?.active;
    if (!active || active.status !== 'ready') return false;
    const candidate = active.items[index ?? active.selectedIndex];
    if (!candidate) return false;
    const context = active.source.match(state);
    if (!context || context.from !== active.context.from || !samePrompt(active.source, context, active.context))
      return false;
    const replacement = active.source.apply(candidate, context, state);
    if (replacement === null) return false;
    if (dispatch) {
      const transaction = isolateHistory(state.tr).insertText(replacement, context.from, context.to);
      transaction.setSelection(TextSelection.create(transaction.doc, context.from + replacement.length));
      dispatch(transaction.setMeta(completionKey, { kind: 'accept' } satisfies CompletionMeta).scrollIntoView());
      // A standalone ProseMirror view has no KagamiState history settlement.
      if (view && !completionKey.getState(view.state)?.attachment.view?.editor) {
        view.dispatch(closeHistory(view.state.tr));
      }
    }
    return true;
  };
}

/** Positions address the current document. Features may add their own prompt data. */
export interface CompletionPrompt {
  readonly query: string;
  readonly from: number;
  readonly to: number;
}

/** Actions bound to one active completion prompt. */
export interface CompletionActions {
  accept(index?: number): boolean;
  activate(index: number): boolean;
  dismiss(): boolean;
}

/** The measured presentation of one source's candidates before attaching actions. */
export interface CompletionSnapshot<C extends KagamiMD.CompletionCandidate> {
  readonly query: string;
  readonly pending: boolean;
  readonly items: readonly C[];
  readonly active: number;
  readonly rect: DOMRectReadOnly;
}

/** Recognition, lookup, writing and presentation belong to the feature. */
export interface CompletionSource<
  C extends KagamiMD.CompletionCandidate,
  P extends CompletionPrompt = CompletionPrompt,
> {
  readonly kind: 'tag' | 'wikilink' | 'callout';
  match(state: EditorState): P | null;
  enabled(editor: KagamiMD | null): boolean;
  candidates(query: string, signal: AbortSignal, editor: KagamiMD | null): readonly C[] | Promise<readonly C[]>;
  apply(candidate: C, prompt: P, state: EditorState): string | null;
  same(a: P, b: P): boolean;
  publish(state: CompletionSnapshot<C>, prompt: P, actions: CompletionActions): KagamiMD.Completion;
}

/** The completion currently open at the caret, with the feature's typed candidates. */
export function readCompletion(editor: KagamiMD): KagamiMD.Completion | null {
  const view = editor.view;
  if (editor.isDestroyed() || !view) return null;
  return completionKey.getState(view.state)?.attachment.view?.read() ?? null;
}

/** Query registered providers in parallel, isolating failures and keeping registration order. */
export async function queryCompletionProviders(
  providers: readonly KagamiMD.CompletionProvider[],
  query: string,
  signal: AbortSignal,
  editor: KagamiMD | null,
): Promise<readonly KagamiMD.CompletionCandidate[]> {
  if (!providers.length || !editor) return [];
  const snapshot = [...providers];
  const lists = await Promise.all(snapshot.map(async provider => {
    try {
      return await provider.provideCandidates(query, signal);
    } catch (error) {
      if (!signal.aborted && !editor.isDestroyed()) editor._onDidError.fire(error);
      return [];
    }
  }));
  return lists.flat();
}

/** Re-query or close an active completion prompt when its provider registrations change. */
export function refreshCompletion(
  editor: KagamiMD,
  target: 'tag' | 'wikilink',
  enabled: boolean,
): void {
  const view = editor.view;
  if (!view || view.isDestroyed || editor.isDestroyed()) return;
  if (completionKey.getState(view.state)?.active?.source.kind !== target) return;
  view.dispatch(view.state.tr.setMeta(completionKey, {
    kind: 'providers',
    target,
    enabled,
  } satisfies CompletionMeta));
}

function samePrompt(source: CompletionSource<KagamiMD.CompletionCandidate>, a: CompletionPrompt,
  b: CompletionPrompt): boolean {
  return a.query === b.query && source.same(a, b);
}

function available(view: EditorView): boolean {
  return !view.isDestroyed && view.editable && !view.composing && !compositionState(view.state)?.isComposing;
}

/** Text insertion or a settled composition can open a prompt; explicit dismissal still wins. */
function startsPrompt(transaction: Transaction): boolean {
  if (transaction.getMeta(compositionCommit)) return true;
  return transaction.docChanged && !isHistoryTransaction(transaction) && !isFormattingTransaction(transaction) &&
    !transaction.getMeta('appendedTransaction') && transaction.getMeta('addToHistory') !== false &&
    !['paste', 'drop'].includes(transaction.getMeta('uiEvent')) && transaction.steps.some(step =>
      step instanceof ReplaceStep && !step.slice.openStart && !step.slice.openEnd && step.slice.content.size > 0 &&
      step.slice.content.content.every(node => node.isText));
}

function applyCompletion(transaction: Transaction, previous: CompletionState, _old: EditorState,
  state: EditorState): CompletionState {
  const meta = transaction.getMeta(completionKey) as CompletionMeta | undefined;
  const dismissed = previous.dismissed &&
    { ...previous.dismissed, from: transaction.mapping.map(previous.dismissed.from, 1) };
  if (meta?.kind === 'accept' || meta?.kind === 'dismiss') {
    return { ...previous, active: null, dismissed: previous.active ? {
      source: previous.active.source, from: transaction.mapping.map(previous.active.context.from, -1),
    } : dismissed };
  }
  const appended = transaction.getMeta('appendedTransaction') as Transaction | undefined;
  if (compositionState(state)?.isComposing || isHistoryTransaction(transaction) ||
      appended && isHistoryTransaction(appended)) {
    return { ...previous, active: null, dismissed };
  }
  if (!previous.active) return dismissed === previous.dismissed ? previous : { ...previous, dismissed };
  if (meta?.kind === 'providers' && previous.active.source.kind === meta.target) {
    if (!meta.enabled) return { ...previous, active: null, dismissed };
    const serial = previous.serial + 1;
    const active: ActiveCompletion = {
      ...previous.active,
      requestId: serial,
      status: 'pending',
      items: Object.freeze([]),
      selectedIndex: 0,
    };
    return { ...previous, serial, active, dismissed };
  }
  const prior = previous.active;
  let active: ActiveCompletion = { ...prior, context: { ...prior.context,
    from: transaction.mapping.map(prior.context.from, 1), to: transaction.mapping.map(prior.context.to, -1),
  } };
  if (meta?.kind === 'results' && meta.requestId === active.requestId) {
    active = {
      ...active, status: 'ready',
      items: Object.freeze(meta.items.map(item => Object.freeze({ ...item }))), selectedIndex: 0
    };
  } else if (meta?.kind === 'select' && active.items.length) {
    active = { ...active, selectedIndex: (meta.index + active.items.length) % active.items.length };
  }
  return { ...previous, active, dismissed };
}

function reconcile(transaction: Transaction, previous: CompletionState, state: EditorState,
  sources: readonly CompletionSource<KagamiMD.CompletionCandidate>[], editor: KagamiMD | null): CompletionState {
  if (compositionState(state)?.isComposing || restoringHistory([transaction]) ||
      !(transaction.docChanged || transaction.selectionSet || transaction.getMeta(compositionCommit))) return previous;
  const started = startsPrompt(transaction);
  if (!previous.active && !previous.dismissed && !started) return previous;
  let source: CompletionSource<KagamiMD.CompletionCandidate> | undefined;
  let context: CompletionPrompt | null = null;
  // Later sources take precedence when more than one recognizes the same caret.
  for (let index = sources.length - 1; index >= 0; index--) {
    const candidate = sources[index]!;
    const prompt = candidate.match(state);
    if (prompt) {
      source = candidate;
      context = prompt;
      break;
    }
  }
  let next: CompletionState;
  if (!context || !source?.enabled(editor)) {
    if (!previous.active && !previous.dismissed) return previous;
    next = { ...previous, active: null, dismissed: null };
  } else if (previous.dismissed?.from === context.from && previous.dismissed.source === source) {
    return previous;
  } else {
    const prior = previous.active;
    const same = prior?.context.from === context.from && prior.source === source;
    if (!same && !started) next = { ...previous, active: null, dismissed: null };
    else if (!prior || !same || !samePrompt(source, prior.context, context)) {
      const serial = previous.serial + 1;
      next = { ...previous, serial, dismissed: null, active: {
        requestId: serial, source, context, status: 'pending', items: Object.freeze([]), selectedIndex: 0,
      } };
    } else {
      if (prior.context.to === context.to && !previous.dismissed) return previous;
      next = { ...previous, dismissed: null, active: { ...prior, context } };
    }
  }
  return next;
}

interface RunningQuery {
  readonly id: number;
  readonly controller: AbortController;
}

interface PublishedCompletion {
  readonly requestId: number;
  readonly value: KagamiMD.Completion;
}

/** The attachment owns requests and measured prompt geometry. */
class CompletionView {
  private document: Document;
  private request: RunningQuery | null = null;
  private published: PublishedCompletion | null = null;
  private scheduled = false;
  private destroyed = false;

  constructor(
    readonly view: EditorView,
    private readonly attachment: CompletionAttachment,
    readonly editor: KagamiMD | null,
  ) {
    this.document = view.dom.ownerDocument;
    this.listen(true);
    this.update();
  }

  /** A published rectangle is usable only by the prompt and results it measured. */
  read(): KagamiMD.Completion | null {
    const active = completionKey.getState(this.view.state)?.active;
    const measured = this.published;
    if (this.destroyed || !available(this.view) || !this.view.dom.isConnected ||
        !active || active.requestId !== measured?.requestId ||
        active.items !== measured.value.items ||
        (active.status === 'pending') !== measured.value.pending) return null;
    if (active.selectedIndex === measured.value.active) return measured.value;
    return Object.freeze({ ...measured.value, active: active.selectedIndex });
  }

  update(): void {
    if (this.document !== this.view.dom.ownerDocument) {
      this.listen(false);
      this.document = this.view.dom.ownerDocument;
      this.listen(true);
    }
    const active = completionKey.getState(this.view.state)?.active;
    this.schedule();
    if (!active) {
      this.request?.controller.abort();
      this.request = null;
    } else if (this.request?.id !== active.requestId) {
      this.request?.controller.abort();
      const query = { id: active.requestId, controller: new AbortController() };
      this.request = query;
      void Promise.resolve()
        .then(() => this.current(query)
          ? active.source.candidates(active.context.query, query.controller.signal, this.editor) : [])
        .then(items => this.results(query, items))
        .catch(error => {
          if (!this.current(query)) return;
          this.view.dispatch(this.view.state.tr.setMeta(completionKey, {
            kind: 'results', requestId: query.id, items: [],
          } satisfies CompletionMeta));
          this.editor?._onDidError.fire(error);
        });
    }
  }

  destroy(): void {
    this.destroyed = true;
    if (this.attachment.view === this) this.attachment.view = null;
    this.request?.controller.abort();
    this.listen(false);
    this.published = null;
  }

  private current(request: RunningQuery): boolean {
    return !this.destroyed && !this.view.isDestroyed && !request.controller.signal.aborted && this.request === request;
  }

  private results(request: RunningQuery, items: readonly KagamiMD.CompletionCandidate[]): void {
    if (!this.current(request)) return;
    const active = completionKey.getState(this.view.state)?.active;
    if (active?.requestId !== request.id) return;
    const seen = new Set<string>();
    const accepted: KagamiMD.CompletionCandidate[] = [];
    for (const candidate of items) {
      if (seen.has(candidate.id) || active.source.apply(candidate, active.context, this.view.state) === null) continue;
      seen.add(candidate.id);
      accepted.push(candidate);
      if (accepted.length === 8) break;
    }
    this.view.dispatch(this.view.state.tr.setMeta(completionKey, {
      kind: 'results', requestId: request.id, items: accepted,
    } satisfies CompletionMeta));
  }

  private listen(add: boolean): void {
    if (add) {
      this.document.defaultView!.addEventListener('resize', this.schedule);
      this.document.addEventListener('scroll', this.schedule, true);
    } else {
      this.document.defaultView!.removeEventListener('resize', this.schedule);
      this.document.removeEventListener('scroll', this.schedule, true);
    }
  }

  private readonly schedule = (): void => {
    if (this.scheduled || this.destroyed) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (!this.destroyed) this.publish();
    });
  };

  private publish(): void {
    const active = completionKey.getState(this.view.state)?.active;
    if (!active || !available(this.view) || !this.view.dom.isConnected) {
      if (this.published) {
        this.published = null;
        this.changed(null);
      }
      return;
    }
    const caret = this.view.coordsAtPos(active.context.from);
    const rect = new DOMRectReadOnly(caret.left, caret.top, caret.right - caret.left, caret.bottom - caret.top);
    const previous = this.published;
    const value = previous?.value;
    const pending = active.status === 'pending';
    if (previous?.requestId === active.requestId && value?.items === active.items &&
        value.pending === pending && value.active === active.selectedIndex &&
        value.rect.x === rect.x && value.rect.y === rect.y && value.rect.width === rect.width &&
        value.rect.height === rect.height) return;
    const requestId = active.requestId;
    const items = active.items;
    const actions: CompletionActions = {
      accept: index => this.accept(requestId, items, pending, index),
      activate: index => this.activate(requestId, items, pending, index),
      dismiss: () => this.dismiss(requestId),
    };
    const published = Object.freeze(active.source.publish({
      query: active.context.query, pending, items, active: active.selectedIndex, rect,
    }, active.context, actions));
    this.published = { requestId, value: published };
    this.changed(published);
  }

  private accept(
    requestId: number,
    items: readonly KagamiMD.CompletionCandidate[],
    pending: boolean,
    index?: number,
  ): boolean {
    if (this.destroyed || !this.editor || this.editor.isDestroyed() || pending || !available(this.view)) return false;
    const active = completionKey.getState(this.view.state)?.active;
    if (!active || active.requestId !== requestId || active.items !== items || active.status !== 'ready') return false;
    return (index === undefined || Number.isInteger(index)) &&
      this.editor.state.runCommand(acceptCompletion(typeof index === 'number' ? index : undefined));
  }

  private activate(
    requestId: number,
    items: readonly KagamiMD.CompletionCandidate[],
    pending: boolean,
    index: number,
  ): boolean {
    if (this.destroyed || !this.editor || this.editor.isDestroyed() || pending || !available(this.view)) return false;
    const active = completionKey.getState(this.view.state)?.active;
    if (!active || active.requestId !== requestId || active.items !== items || active.status !== 'ready') return false;
    if (!Number.isInteger(index) || index < 0 || index >= active.items.length) return false;
    return this.editor.state.runCommand((current, dispatch) => {
      if (active.selectedIndex !== index) {
        dispatch?.(current.tr.setMeta(completionKey, { kind: 'select', index } satisfies CompletionMeta));
      }
      return true;
    });
  }

  private dismiss(requestId: number): boolean {
    if (this.destroyed || !this.editor || this.editor.isDestroyed()) return false;
    if (completionKey.getState(this.view.state)?.active?.requestId !== requestId) return false;
    return this.editor.state.runCommand(dismissCompletion);
  }

  private changed(value: KagamiMD.Completion | null): void {
    if (this.editor && !this.editor.isDestroyed()) this.editor._onDidChangeCompletion.fire(value);
  }
}
