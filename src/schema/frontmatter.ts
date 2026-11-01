/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { correction } from '../state/correction.js';
import { compositionState, compositionCommit } from '../state/input.js';
import { Emitter, type Event as ChangeEvent } from '../event/index.js';
import { EditorView as CodeView, keymap, lineNumbers } from '@codemirror/view';
import { Compartment, EditorState as CodeState, Transaction as CodeTransaction } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, redo, redoDepth, undo, undoDepth } from '@codemirror/commands';
import { parseFile, parseFrontmatterOpening } from '../syntax/index.js';
import { Fragment, Slice, type Node, type ResolvedPos } from 'prosemirror-model';
import { history as editHistory } from '../state/history.js';
import {
  NodeSelection, Plugin, PluginKey, Selection, TextSelection, type Command, type EditorState,
  type Transaction
} from 'prosemirror-state';
import { ReplaceStep } from 'prosemirror-transform';
import type { EditorView } from 'prosemirror-view';
import * as command from '../command/command.js';
import { insert, normalize, remove, replace, update } from '../transform/transform.js';
import { propertyViews } from './propertyview.js';
import { fieldSource, frontMatterSource } from '../parse/field.js';
import { parse } from '../parse/parse.js';
import { inferYAMLScalar } from '../parse/scalar.js';
import { schema } from '../types/schema.js';

/** Structured YAML properties, their draft source, and corrections after editing. */
export function frontmatter(): Plugin[] {
  return [frontmatter.state(), frontmatter.view()];
}

export namespace frontmatter {
  /** Read edited YAML fields and settle the scalar the caret left. */
  export function correction(tr: Transaction, fields: correction.Fields, old: EditorState): void {
    const previous = old.selection.$head;
    if (previous.parent.type === schema.nodes.yamlScalar) {
      const position = fields.mapping(tr).mapResult(previous.before(), 1);
      const scalar = tr.doc.nodeAt(position.pos);
      if (!position.deletedAcross && scalar?.type === schema.nodes.yamlScalar &&
          (!tr.selection.$head.depth || tr.selection.$head.before() !== position.pos))
        normalize(tr, position.pos, position.pos + scalar.nodeSize);
    }
    for (const position of fields.textblocks(tr)) {
      const node = tr.doc.nodeAt(position)!;
      if (node.type === schema.nodes.yamlScalar && node.attrs.tag !== 'string') {
        const tag = inferYAMLScalar(node.textContent);
        if (tag !== node.attrs.tag) update(tr, position, { tag });
      } else if (position === 0 && node.type === schema.nodes.rawFrontMatter) {
        const parsed = parseFile(frontMatterSource(node), { target: 'editor' }).document.frontMatter;
        if (parsed?.type === 'yamlFrontMatter')
          replace(tr, 0, node.nodeSize, new Slice(Fragment.from(parse.frontMatter(parsed, schema)), 0, 0));
      }
    }
  }

  /** A typed opening at the file head starts structured front matter in that input. */
  export function input(old: EditorState, tr: Transaction): void {
    readOpening([tr], old, tr);
  }

  /** A selection in the temporary source text. */
  export interface SourceSelection { readonly anchor: number; readonly head: number }

  /** The source editor's supported option. */
  export interface SourceOptions { readonly readOnly: boolean }

  /** An option update observed by the temporary source editor's owner. */
  export interface SourceOptionsChange { readonly changed: { readonly readOnly?: true } }

  /** A draft survives detaching and attaching an editor without changing the document. */
  export interface Draft {
    readonly initial: string;
    readonly draft: string;
    readonly selection: SourceSelection;
    readonly node: Node;
    readonly error: string | null;
  }

  /** Presentation state belongs to this document's front matter. */
  export interface Session { readonly collapsed: boolean; readonly source: Draft | null }

  export const key = new PluginKey<Session>('frontmatter');

  /** Keep presentation state and apply YAML corrections after edits. */
  export function state(): Plugin<Session> {
    return new Plugin<Session>({
      key,
      state: {
        init: () => ({ collapsed: false, source: null }),
        apply(tr, previous) {
          if (tr.doc.firstChild?.type !== schema.nodes.yamlFrontMatter) return { collapsed: false, source: null };
          return tr.getMeta(key) as Session | undefined ?? previous;
        },
      },
    });
  }

  /** Property views own their DOM; the plugin updates view-dependent presentation. */
  export const view = propertyViews;

  /** The displayed type of a structured value. */
  export function valueType(node: Node): Frontmatter.ValueType {
    if (node.type === schema.nodes.yamlMapping) return 'object';
    if (node.type === schema.nodes.yamlSequence) return 'array';
    switch (node.attrs.tag) {
      case 'integer': case 'float': return 'number';
      case 'boolean': return 'boolean';
      case 'null': return 'null';
      default: return 'string';
    }
  }

  /** Collection conversion retains values; only a single unnamed value can unwrap. */
  export function convertedValue(value: Node, type: Frontmatter.ValueType): Node | null {
    if (valueType(value) === type) return value;
    if (isCollection(value)) {
      if (type === 'array' && value.type === schema.nodes.yamlMapping)
        return schema.nodes.yamlSequence.create(null, value.content.content.map(pair => pair.child(1)));
      if (type === 'object' && value.type === schema.nodes.yamlSequence)
        return schema.nodes.yamlMapping.create(null,
          value.content.content.map(child => schema.nodes.yamlPair.create(null, [newValue('string'), child])));
      if (!value.childCount) return newValue(type);
      if (value.childCount !== 1) return null;
      const only = value.firstChild!;
      if (value.type === schema.nodes.yamlMapping &&
        (only.firstChild!.textContent || only.firstChild!.type !== schema.nodes.yamlScalar)) return null;
      return convertedValue(value.type === schema.nodes.yamlMapping ? only.child(1) : only, type);
    }
    if (type === 'array') return schema.nodes.yamlSequence.create(null, value);
    if (type === 'object')
      return schema.nodes.yamlMapping.create(null, schema.nodes.yamlPair.create(null, [newValue('string'), value]));
    const text = value.textContent;
    const tag = inferYAMLScalar(text);
    const inferred = tag === 'integer' || tag === 'float' ? 'number' : tag;
    if (type !== 'string' && text && inferred !== type) return null;
    if (!text) return newValue(type);
    return schema.nodes.yamlScalar.create({ tag: type === 'number' ? tag : type }, value.content);
  }

  /** Convert a property's value, or replace it with the chosen type's empty value. */
  export function changeType(state: EditorState, pos: number, type: Frontmatter.ValueType): Transaction | null {
    const entry = state.doc.nodeAt(pos);
    const parent = state.doc.resolve(pos).parent;
    if (!entry || entry.type !== schema.nodes.yamlPair && parent.type !== schema.nodes.yamlSequence) return null;
    const value = entryValue(entry, pos);
    const next = convertedValue(value.node, type) ?? newValue(type);
    if (next.eq(value.node)) return null;
    const tr = editHistory.isolate(state.tr);
    if (next.type === value.node.type && next.content.eq(value.node.content))
      update(tr, value.pos, { tag: next.attrs.tag });
    else replace(tr, value.pos, value.pos + value.node.nodeSize, new Slice(Fragment.from(next), 0, 0));
    return edit(focusValue(tr, value.pos));
  }

  /** Insert an unnamed property or an empty array item at the given child index. */
  export function insertEntry(state: EditorState, pos: number, index: number): Transaction | null {
    const container = state.doc.nodeAt(pos);
    if (!container || !isCollection(container) || index < 0 || index > container.childCount) return null;
    let at = pos + 1;
    for (let i = 0; i < index; i++) at += container.child(i).nodeSize;
    const tr = editHistory.isolate(state.tr);
    if (container.type === schema.nodes.yamlMapping)
      insert(tr, at, schema.nodes.yamlPair, {}, Fragment.fromArray([newValue('string'), newValue('string')]));
    else insert(tr, at, schema.nodes.yamlScalar, { tag: 'string' });
    return edit(focusValue(tr, at));
  }

  /** Remove one property or item and select the nearest remaining field. */
  export function removeEntry(state: EditorState, pos: number): Transaction | null {
    const entry = state.doc.nodeAt(pos);
    if (!entry || !isCollection(state.doc.resolve(pos).parent)) return null;
    const tr = editHistory.isolate(state.tr);
    remove(tr, pos, pos + entry.nodeSize);
    return edit(tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(pos, tr.doc.content.size)), -1)));
  }

  /** Set the text of an atomic boolean value in its own history event. */
  export function setBoolean(state: EditorState, pos: number, checked: boolean): Transaction | null {
    const node = state.doc.nodeAt(pos);
    if (node?.type !== schema.nodes.yamlScalar || node.attrs.tag !== 'boolean' ||
      node.textContent.toLowerCase() === String(checked)) return null;
    const tr = editHistory.isolate(state.tr).insertText(String(checked), pos + 1, pos + node.nodeSize - 1);
    return edit(tr.setSelection(NodeSelection.create(tr.doc, pos)));
  }

  /** Visit scalar fields in document order, appending a field at the final Tab. */
  export function navigate(backward = false): Command {
    return (state, dispatch) => {
      const entry = selectedEntry(state.selection.$head);
      if (!entry || !state.selection.empty && !(state.selection instanceof NodeSelection)) return false;
      const fields: ValuePosition[] = [];
      state.doc.firstChild!.descendants((node, offset) => {
        if (node.type === schema.nodes.yamlScalar) fields.push({ node, pos: offset + 1 });
      });
      const head = state.selection.head;
      const index = fields.findIndex(field => head >= field.pos && head <= field.pos + field.node.nodeSize);
      const next = fields[index + (backward ? -1 : 1)];
      if (next) dispatch?.(focusValue(state.tr, next.pos).scrollIntoView());
      else if (!backward) {
        const at = state.doc.resolve(entry.pos);
        const tr = insertEntry(state, at.before(), at.index() + 1);
        if (tr) dispatch?.(tr);
      }
      return true;
    };
  }

  /** Enter moves from a key to its value, adds a string line, or inserts an item. */
  export const enter: Command = (state, dispatch) => {
    const entry = selectedEntry(state.selection.$head);
    if (!entry) return false;
    const value = entryValue(entry.node, entry.pos);
    if (entry.node.type === schema.nodes.yamlPair && state.selection.head < value.pos) {
      dispatch?.(focusValue(state.tr, value.pos).scrollIntoView());
    } else if (value.node.type === schema.nodes.yamlScalar && value.node.attrs.tag === 'string') {
      dispatch?.(state.tr.insertText('\n').scrollIntoView());
    } else {
      const at = state.doc.resolve(entry.pos);
      const tr = insertEntry(state, at.before(), at.index() + 1);
      if (tr) dispatch?.(tr);
    }
    return true;
  };

  /** Mod-Enter adds the next property regardless of the current value's type. */
  export const insertAfter: Command = (state, dispatch) => {
    const entry = selectedEntry(state.selection.$head);
    if (!entry) return false;
    const at = state.doc.resolve(entry.pos);
    const tr = insertEntry(state, at.before(), at.index() + 1);
    if (tr) dispatch?.(tr);
    return true;
  };

  /** Backspace at a key's start removes an empty property and keeps nonempty ones. */
  export const backspace: Command = (state, dispatch) => {
    const entry = selectedEntry(state.selection.$head);
    if (!entry || !state.selection.empty || state.selection.$head.parentOffset ||
        entry.node.type !== schema.nodes.yamlPair || state.selection.head !== entry.pos + 2) return false;
    if (!entry.node.textContent) {
      const tr = removeEntry(state, entry.pos);
      if (tr) dispatch?.(tr);
    }
    return true;
  };

  /** Space toggles the selected atomic boolean. */
  export const toggleBoolean: Command = (state, dispatch) => {
    const selected = state.selection;
    if (!selectedEntry(selected.$head) || !(selected instanceof NodeSelection) ||
      selected.node.type !== schema.nodes.yamlScalar || selected.node.attrs.tag !== 'boolean') return false;
    const tr = setBoolean(state, selected.from, selected.node.textContent.toLowerCase() !== 'true');
    if (tr) dispatch?.(tr);
    return true;
  };

  /** A YAML scalar receives literal clipboard text in one history event. */
  export function pasteText(view: EditorView, event: ClipboardEvent): boolean {
    const { $from, $to } = view.state.selection;
    if (!$from.sameParent($to) || $from.parent.type !== schema.nodes.yamlScalar || !event.clipboardData) return false;
    view.dispatch(edit(editHistory.isolate(view.state.tr).insertText(event.clipboardData.getData('text/plain'))));
    return true;
  }

  /** Property type icons are shared by the live view and the drag preview. */
  export const typeIcons: Record<Frontmatter.ValueType, string> = {
    string: '<path d="M12 4v16" /><path d="M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2" /><path d="M9 20h6" />',
    number: '<line x1="4" x2="20" y1="9" y2="9" /><line x1="4" x2="20" y1="15" y2="15" /><line x1="10" x2="8" y1="3" y2="21" /><line x1="16" x2="14" y1="3" y2="21" />',
    boolean: '<circle cx="9" cy="12" r="3" /><rect width="20" height="14" x="2" y="5" rx="7" />',
    null: '<path d="M5 12h14" />',
    array: '<path d="M16 3h3a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1h-3" /><path d="M8 21H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h3" />',
    object: '<path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1" /><path d="M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1" />',
  };

  /** One temporary source editor owns one CodeMirror history until the draft is applied. */
  export class SourceView {
    readonly view: CodeView;
    readonly element: HTMLElement;
    readonly inputElement: HTMLElement;
    private destroyed = false;
    private options: Readonly<SourceOptions>;
    private readonly changed = new Emitter<SourceOptionsChange>();
    readonly onDidChangeOptions: ChangeEvent<SourceOptionsChange> = this.changed.event;
    private readonly readOnly = new Compartment();

    constructor(place: HTMLElement, markdown: string, selection: SourceSelection | null,
      onUpdate: () => void, onError: (error: unknown) => void, options: Partial<SourceOptions> = {}) {
      validateOptions(options);
      this.options = Object.freeze({ readOnly: options.readOnly ?? false });
      const anchor = clamp(selection?.anchor ?? 0, markdown.length);
      const head = clamp(selection?.head ?? selection?.anchor ?? 0, markdown.length);
      const state = CodeState.create({ doc: markdown, selection: { anchor, head }, extensions: [
        this.readOnly.of([CodeState.readOnly.of(this.options.readOnly), CodeView.editable.of(!this.options.readOnly)]),
        history(), keymap.of([...defaultKeymap, ...historyKeymap]), lineNumbers(), CodeView.lineWrapping,
        CodeView.contentAttributes.of({ 'aria-label': 'Markdown source', spellcheck: 'false' }),
        CodeView.updateListener.of(onUpdate), CodeView.exceptionSink.of(onError),
      ] });
      this.view = new CodeView({ parent: place, state, scrollTo: CodeView.scrollIntoView(state.selection.main) });
      this.element = this.view.dom;
      this.inputElement = this.view.contentDOM;
    }

    read(): { markdown: string; selection: SourceSelection } {
      const { anchor, head } = this.view.state.selection.main;
      return { markdown: this.view.state.doc.toString(), selection: { anchor, head } };
    }
    isDestroyed(): boolean { return this.destroyed; }
    isComposing(): boolean { return !this.destroyed && this.view.compositionStarted; }

    select(position: 'start' | 'end' | SourceSelection): void {
      this.assertAlive();
      if (this.isComposing()) return;
      const offset = position === 'end' ? this.view.state.doc.length : 0;
      const selection = typeof position === 'string' ? { anchor: offset, head: offset } : position;
      if (!Number.isInteger(selection.anchor) || !Number.isInteger(selection.head))
        throw new RangeError('Source positions must be integer UTF-16 offsets');
      this.view.dispatch({ selection: {
        anchor: clamp(selection.anchor, this.view.state.doc.length),
        head: clamp(selection.head, this.view.state.doc.length),
      }, scrollIntoView: true, annotations: CodeTransaction.addToHistory.of(false) });
    }

    getOptions(): Readonly<SourceOptions> {
      this.assertAlive();
      return this.options;
    }

    updateOptions(options: Partial<SourceOptions>): void {
      this.assertAlive();
      validateOptions(options);
      if (options.readOnly === undefined || options.readOnly === this.options.readOnly) return;
      const readOnly = options.readOnly;
      this.options = Object.freeze({ readOnly });
      this.view.dispatch({
        effects: this.readOnly.reconfigure([CodeState.readOnly.of(readOnly),
          CodeView.editable.of(!readOnly)])
      });
      this.changed.fire(Object.freeze({ changed: Object.freeze({ readOnly: true }) }));
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
      try { this.view.destroy(); } finally { this.changed.destroy(); }
    }
    private assertAlive(): void {
      if (this.destroyed) throw new Error('YAMLSourceView is destroyed');
    }
  }
}

/** Commands for properties, including the unnamed items of arrays. */
export namespace Frontmatter {
  export type ValueType = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';

  /** Raised when a property's type button is pressed. */
  export const choosePropertyType = command.requestCommand<{
    readonly pos: number;
    readonly rect: DOMRectReadOnly;
    readonly type: ValueType;
    readonly conversions: Readonly<Record<ValueType, 'convert' | 'reset'>>;
  }>();

  /** Convert the value, or start an empty value of the chosen type. */
  export const setPropertyType: command.Command.Pure<{ readonly pos?: number; readonly type: ValueType }> = ({ state },
    { pos, type }) =>
    state.runCommand(onEntry(pos, (state, at) => frontmatter.changeType(state, at, type)));

  /** Insert an empty property immediately above or below the named or selected one. */
  export const insertProperty: command.Command.Pure<{
    readonly pos?: number; readonly side: 'above' | 'below'
  }> = ({ state }, { pos, side }) =>
    state.runCommand(onEntry(pos, (state, at) => {
      const position = state.doc.resolve(at);
      return frontmatter.insertEntry(state, position.before(), position.index() + (side === 'below' ? 1 : 0));
    }));

  /** Delete the named or selected property or item. */
  export const deleteProperty: command.Command.Pure<{ readonly pos?: number }> = ({ state }, { pos }) =>
    state.runCommand(onEntry(pos, frontmatter.removeEntry));
}

interface ValuePosition { readonly node: Node; readonly pos: number }

function isCollection(node: Node): boolean {
  return node.type === schema.nodes.yamlMapping || node.type === schema.nodes.yamlSequence;
}

function newValue(type: Frontmatter.ValueType): Node {
  switch (type) {
    case 'object': return schema.nodes.yamlMapping.create();
    case 'array': return schema.nodes.yamlSequence.create();
    case 'number': return schema.nodes.yamlScalar.create({ tag: 'integer' }, schema.text('0'));
    case 'boolean': return schema.nodes.yamlScalar.create({ tag: 'boolean' }, schema.text('false'));
    case 'null': return schema.nodes.yamlScalar.create({ tag: 'null' }, schema.text('null'));
    case 'string': return schema.nodes.yamlScalar.create({ tag: 'string' });
  }
}

function selectedEntry(pos: ResolvedPos): ValuePosition | null {
  for (let depth = pos.depth; depth > 0; depth--) {
    const node = pos.node(depth);
    if (node.type === schema.nodes.yamlPair || pos.node(depth - 1).type === schema.nodes.yamlSequence)
      return { node, pos: pos.before(depth) };
  }
  return null;
}

function entryValue(node: Node, pos: number): ValuePosition {
  return node.type === schema.nodes.yamlPair
    ? { node: node.child(1), pos: pos + 1 + node.firstChild!.nodeSize } : { node, pos };
}

function edit(tr: Transaction): Transaction { return editHistory.isolate(tr).scrollIntoView(); }

function focusValue(tr: Transaction, pos: number): Transaction {
  const node = tr.doc.nodeAt(pos);
  if (node?.type === schema.nodes.yamlScalar && node.attrs.tag === 'boolean')
    return tr.setSelection(NodeSelection.create(tr.doc, pos));
  return tr.setSelection(Selection.near(tr.doc.resolve(pos + 1), 1));
}

function onEntry(pos: number | undefined, change: (state: EditorState, pos: number) => Transaction | null): Command {
  return (state, dispatch) => {
    const at = command.findTarget(state, pos ?? state.selection.from,
      type => type === schema.nodes.yamlPair || type.isInGroup('yamlNode'));
    const entry = at === undefined ? null : selectedEntry(state.doc.resolve(at + 1));
    const tr = entry && change(state, entry.pos);
    if (!tr) return false;
    dispatch?.(tr);
    return true;
  };
}

/** Only a text input opening at the file's head creates structured front matter. */
function readOpening(transactions: readonly Transaction[], old: EditorState, tr: Transaction): Transaction | null {
  const first = tr.doc.firstChild;
  const selected = tr.selection;
  if (first?.type !== schema.nodes.paragraph || !(selected instanceof TextSelection) ||
      !selected.empty || selected.$head.depth !== 1 || selected.$head.index(0)) return null;
  const composition = compositionState(old);
  const committed = transactions.some(tr => tr.getMeta(compositionCommit)) &&
    composition?.activeTextblockPos === 0 && composition.inputHistory !== null;
  let edited: number | null = null;
  for (const tr of transactions) {
    for (let i = 0; i < tr.steps.length; i++) {
      const step = tr.steps[i]!;
      if (step instanceof ReplaceStep && !step.slice.openStart && !step.slice.openEnd &&
          step.slice.content.content.every(node => node.isInline)) {
        const doc = tr.docs[i]!;
        const from = doc.resolve(step.from);
        const to = doc.resolve(step.to);
        if (from.depth === 1 && !from.index(0) && from.parent.type === schema.nodes.paragraph && from.sameParent(to))
          edited = 0;
      }
      if (edited !== null) {
        const mapped = step.getMap().mapResult(edited, 1);
        edited = mapped.deletedAfter ? null : mapped.pos;
      }
    }
  }
  if (edited !== 0 && !committed || parseFrontmatterOpening(fieldSource(first))?.marker !== '---') return null;
  const pair = schema.nodes.yamlPair.create(null, [newValue('string'), newValue('string')]);
  insert(tr, 0, schema.nodes.yamlFrontMatter, {}, Fragment.from(schema.nodes.yamlMapping.create(null, pair)));
  const block = tr.doc.firstChild!;
  remove(tr, block.nodeSize, block.nodeSize + first.nodeSize);
  return focusValue(tr, 2).scrollIntoView();
}

function clamp(position: number, size: number): number { return Math.max(0, Math.min(size, position)); }

function validateOptions(options: Partial<frontmatter.SourceOptions>): void {
  if ('readOnly' in options && typeof options.readOnly !== 'boolean') throw new TypeError('readOnly must be a boolean');
}
