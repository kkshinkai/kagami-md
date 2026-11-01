/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { closeHistory, isHistoryTransaction } from 'prosemirror-history';
import { Plugin, PluginKey, TextSelection, type Command, type EditorState, type Transaction } from 'prosemirror-state';
import { ReplaceStep } from 'prosemirror-transform';
import type { EditorView } from 'prosemirror-view';
import { isFormattingTransaction } from '../schema/format.js';
import { history } from '../state/history.js';
import { compositionState, compositionCommit } from '../state/input.js';
import type { KagamiMD } from './editor.js';
import { findEditor } from './dom.js';
import type { Command as PublicCommand } from '../command/command.js';
import type { Tag } from '../schema/tag.js';
import type { Wikilink } from '../schema/wikilink.js';
import type { Callout } from '../schema/callout.js';

/** Mapped prompts and a view that owns asynchronous lookup, geometry, and accessibility. */
export function completion(sources: readonly Completion.Source<Completion.Candidate>[]): Plugin<completion.State> {
  const attachment: Attachment = { view: null };
  return new Plugin<completion.State>({
    key: completion.key,
    state: { init: () => ({ serial: 0, active: null, dismissed: null, attachment }), apply: (tr, previous, old, state) => {
      const next = applyCompletion(tr, previous, old, state);
      return attachment.view ? reconcile(tr, next, state, sources, attachment.view.editor) : next;
    } },
    props: {
      handleKeyDown(view, event) {
        if (!available(view) || event.isComposing || event.keyCode === 229 ||
            event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
        const active = completion.key.getState(view.state)?.active;
        if (!active) return false;
        if (event.key === 'Escape') return completion.dismiss(view.state, view.dispatch);
        if (active.status !== 'ready' || !active.items.length ||
            event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return false;
        view.dispatch(view.state.tr.setMeta(completion.key, {
          kind: 'select', index: active.selectedIndex + (event.key === 'ArrowUp' ? -1 : 1),
        } satisfies completion.Meta));
        return true;
      },
      handlePaste(view) {
        completion.dismiss(view.state, view.dispatch);
        return false;
      },
      handleDrop(view) {
        completion.dismiss(view.state, view.dispatch);
        return false;
      },
      handleDOMEvents: { blur(view) {
        completion.dismiss(view.state, view.dispatch);
        return false;
      } },
    },
    view(view) {
      return attachment.view = new CompletionView(view, attachment);
    },
  });
}

export namespace completion {
  export interface Active {
    readonly requestId: number;
    readonly source: Completion.Source<Completion.Candidate>;
    readonly context: Completion.Prompt;
    readonly status: 'pending' | 'ready';
    readonly items: readonly Completion.Candidate[];
    readonly selectedIndex: number;
  }

  export interface Dismissed {
    readonly source: Completion.Source<Completion.Candidate>;
    readonly from: number;
  }

  export interface State {
    readonly attachment: Attachment;
    readonly serial: number;
    readonly active: Active | null;
    readonly dismissed: Dismissed | null;
  }

  export type Meta = { kind: 'dismiss' | 'accept' }
    | { kind: 'select'; index: number }
    | { kind: 'results'; requestId: number; items: readonly Completion.Candidate[] }
    | { kind: 'refresh'; state: State };

  export const key = new PluginKey<State>('markdown-completion');

  /** Dismiss the prompt without editing its source or selection. */
  export const dismiss: Command = (state, dispatch) => {
    if (!key.getState(state)?.active) return false;
    dispatch?.(state.tr.setMeta(key, { kind: 'dismiss' } satisfies Meta));
    return true;
  };

  /** Recheck the current prompt before inserting one parser-validated source replacement. */
  export function accept(index?: number): Command {
    return (state, dispatch, view) => {
      if (compositionState(state)?.isComposing || view && !available(view)) return false;
      const active = key.getState(state)?.active;
      if (!active || active.status !== 'ready') return false;
      const candidate = active.items[index ?? active.selectedIndex];
      if (!candidate) return false;
      const context = active.source.match(state);
      if (!context || context.from !== active.context.from || !samePrompt(active.source, context, active.context))
        return false;
      const replacement = active.source.apply(candidate, context, state);
      if (replacement === null) return false;
      if (dispatch) {
        const transaction = history.isolate(state.tr).insertText(replacement, context.from, context.to);
        transaction.setSelection(TextSelection.create(transaction.doc, context.from + replacement.length));
        dispatch(transaction.setMeta(key, { kind: 'accept' } satisfies Meta).scrollIntoView());
        // A standalone ProseMirror view has no State completion hook.
        if (view) view.dispatch(closeHistory(view.state.tr));
      }
      return true;
    };
  }

  /** Clear attachment-owned prompts before the view is destroyed. */
  export function detach(view: EditorView): void {
    const state = key.getState(view.state)!;
    if (state.active || state.dismissed) view.dispatch(view.state.tr.setMeta(key, {
      kind: 'refresh', state: { ...state, active: null, dismissed: null },
    } satisfies Meta));
  }
}

/** The source's own data distinguishes the completion a host draws. */
export type Completion = Tag.Completion | Wikilink.Completion | Callout.Completion;

export namespace Completion {
  /** One offered value, with its stable identity and optional presentation. */
  export interface Candidate {
    readonly id: string;
    readonly value: string;
    readonly label?: string;
    readonly description?: string;
  }

  /** Positions address the current document. Features may add their own prompt data. */
  export interface Prompt {
    readonly query: string;
    readonly from: number;
    readonly to: number;
  }

  /** The measured presentation of one source's candidates. */
  export interface State<C extends Candidate> {
    readonly query: string;
    readonly pending: boolean;
    readonly items: readonly C[];
    readonly active: number;
    readonly rect: DOMRectReadOnly;
  }

  /** Recognition, lookup, writing and presentation belong to the feature. */
  export interface Source<C extends Candidate, P extends Prompt = Prompt> {
    match(state: EditorState): P | null;
    enabled(editor: KagamiMD | null): boolean;
    candidates(query: string, signal: AbortSignal, editor: KagamiMD | null): readonly C[] | Promise<readonly C[]>;
    apply(candidate: C, prompt: P, state: EditorState): string | null;
    same(a: P, b: P): boolean;
    publish(state: State<C>, prompt: P): Completion;
  }

  /** The completion currently open at the caret, with the feature's typed candidates. */
  export function current(editor: KagamiMD): Completion | null {
    const view = editor.view;
    if (editor.isDestroyed() || !view) return null;
    return completion.key.getState(view.state)?.attachment.view?.read() ?? null;
  }

  /** Put the active candidate, or the candidate at an explicit index, in the text. */
  export const accept: PublicCommand.Pure<number | void> = ({ state }, index) =>
    (index === undefined || Number.isInteger(index)) &&
      state.runCommand(completion.accept(typeof index === 'number' ? index : undefined));

  /** Make a candidate of the open completion active. */
  export const activate: PublicCommand.Pure<number> = ({ state }, index) => state.runCommand((current, dispatch) => {
    const active = completion.key.getState(current)?.active;
    if (!active || active.status !== 'ready' || !Number.isInteger(index) || index < 0 || index >= active.items.length)
      return false;
    if (active.selectedIndex !== index)
      dispatch?.(current.tr.setMeta(completion.key, { kind: 'select', index } satisfies completion.Meta));
    return true;
  });

  /** Dismiss the prompt without changing its source or selection. */
  export const dismiss: PublicCommand.Pure = ({ state }) => state.runCommand(completion.dismiss);
}

interface Attachment {
  view: CompletionView | null;
}

function samePrompt(source: Completion.Source<Completion.Candidate>, a: Completion.Prompt,
  b: Completion.Prompt): boolean {
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

function applyCompletion(transaction: Transaction, previous: completion.State, _old: EditorState,
  state: EditorState): completion.State {
  const meta = transaction.getMeta(completion.key) as completion.Meta | undefined;
  if (meta?.kind === 'refresh') return meta.state;
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
  const prior = previous.active;
  let active: completion.Active = { ...prior, context: { ...prior.context,
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

function reconcile(transaction: Transaction, previous: completion.State, state: EditorState,
  sources: readonly Completion.Source<Completion.Candidate>[], editor: KagamiMD | null): completion.State {
  if (compositionState(state)?.isComposing || history.restoring([transaction]) ||
      !(transaction.docChanged || transaction.selectionSet || transaction.getMeta(compositionCommit))) return previous;
  const started = startsPrompt(transaction);
  if (!previous.active && !previous.dismissed && !started) return previous;
  let source: Completion.Source<Completion.Candidate> | undefined;
  let context: Completion.Prompt | null = null;
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
  let next: completion.State;
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
  readonly value: Completion;
}

/** The attachment owns requests, measured data, and its additions to native ARIA. */
class CompletionView {
  private document: Document;
  readonly editor: KagamiMD | null;
  private readonly release: (() => void) | undefined;
  private request: RunningQuery | null = null;
  private published: PublishedCompletion | null = null;
  private previousARIA: readonly (readonly [string, string | null])[] | null = null;
  private scheduled = false;
  private destroyed = false;

  constructor(readonly view: EditorView, private readonly attachment: Attachment) {
    this.editor = findEditor(view.dom);
    this.release = this.editor?.beforeDetach(() => completion.detach(view));
    this.document = view.dom.ownerDocument;
    this.listen(true);
    this.update();
  }

  /** A published rectangle is usable only by the prompt and results it measured. */
  read(): Completion | null {
    const active = completion.key.getState(this.view.state)?.active;
    const measured = this.published;
    if (this.destroyed || !available(this.view) || !this.view.dom.isConnected ||
        !active || active.requestId !== measured?.requestId ||
        active.items !== measured.value.items) return null;
    if (active.selectedIndex === measured.value.active) return measured.value;
    return Object.freeze({ ...measured.value, active: active.selectedIndex });
  }

  update(): void {
    if (this.document !== this.view.dom.ownerDocument) {
      this.listen(false);
      this.document = this.view.dom.ownerDocument;
      this.listen(true);
    }
    const active = completion.key.getState(this.view.state)?.active;
    if (!active) this.hide();
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
          this.view.dispatch(this.view.state.tr.setMeta(completion.key, {
            kind: 'results', requestId: query.id, items: [],
          } satisfies completion.Meta));
          this.editor?.errors.fire(error);
        });
    }
  }

  destroy(): void {
    this.destroyed = true;
    if (this.attachment.view === this) this.attachment.view = null;
    this.release?.();
    this.request?.controller.abort();
    this.listen(false);
    this.hide();
    this.published = null;
  }

  private current(request: RunningQuery): boolean {
    return !this.destroyed && !this.view.isDestroyed && !request.controller.signal.aborted && this.request === request;
  }

  private results(request: RunningQuery, items: readonly Completion.Candidate[]): void {
    if (!this.current(request)) return;
    const active = completion.key.getState(this.view.state)?.active;
    if (active?.requestId !== request.id) return;
    const seen = new Set<string>();
    const accepted: Completion.Candidate[] = [];
    for (const candidate of items) {
      if (seen.has(candidate.id) || active.source.apply(candidate, active.context, this.view.state) === null) continue;
      seen.add(candidate.id);
      accepted.push(candidate);
      if (accepted.length === 8) break;
    }
    this.view.dispatch(this.view.state.tr.setMeta(completion.key, {
      kind: 'results', requestId: request.id, items: accepted,
    } satisfies completion.Meta));
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
    const active = completion.key.getState(this.view.state)?.active;
    if (!active || !available(this.view) || !this.view.dom.isConnected) {
      this.hide();
      if (this.published) {
        this.published = null;
        this.changed();
      }
      return;
    }
    const caret = this.view.coordsAtPos(active.context.from);
    const rect = new DOMRectReadOnly(caret.left, caret.top, caret.right - caret.left, caret.bottom - caret.top);
    const list = this.editor?.spec.completionList;
    if (list !== undefined && active.status === 'ready' && active.items.length)
      this.show(list, `${list}-${active.selectedIndex}`);
    else this.hide();
    const previous = this.published;
    const value = previous?.value;
    if (previous?.requestId === active.requestId && value?.items === active.items &&
        value.pending === (active.status === 'pending') && value.active === active.selectedIndex &&
        value.rect.x === rect.x && value.rect.y === rect.y && value.rect.width === rect.width &&
      value.rect.height === rect.height) return;
    this.published = { requestId: active.requestId, value: Object.freeze(active.source.publish({
      query: active.context.query, pending: active.status === 'pending', items: active.items,
      active: active.selectedIndex, rect,
    }, active.context)) };
    this.changed();
  }

  private show(list: string, option: string): void {
    this.previousARIA ??= ['aria-controls', 'aria-autocomplete', 'aria-activedescendant']
      .map(name => [name, this.view.dom.getAttribute(name)] as const);
    this.view.dom.setAttribute('aria-controls', [this.previousARIA[0]![1], list].filter(Boolean).join(' '));
    this.view.dom.setAttribute('aria-autocomplete', 'list');
    this.view.dom.setAttribute('aria-activedescendant', option);
  }

  private hide(): void {
    if (!this.previousARIA) return;
    for (const [name, value] of this.previousARIA) {
      if (value === null) this.view.dom.removeAttribute(name);
      else this.view.dom.setAttribute(name, value);
    }
    this.previousARIA = null;
  }

  private changed(): void {
    if (this.editor && !this.editor.isDestroyed())
      this.editor.updates.fire({ state: this.editor.state, docChanged: false });
  }
}
