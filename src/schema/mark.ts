/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { compositionState, compositionCommit } from '../state/input.js';
import { isHistoryTransaction } from 'prosemirror-history';
import type { Node } from 'prosemirror-model';
import { Plugin, TextSelection, EditorState, type Transaction } from 'prosemirror-state';
import type { Mapping } from 'prosemirror-transform';
import {
  captureFormattingSession, formattingMode, formattingPluginKey, isFormattingTransaction,
  type FormattingMeta, type FormattingSession, type FormattingState,
} from './format.js';
import { MarkRange } from './markrange.js';
import { bindings } from '../state/bindings.js';
import { readField, fieldSource } from '../parse/field.js';
import type { InlineFormat } from './inlineformat.js';

/** Keep pending inline formatting attached to the characters accepted by native input. */
export function mark(): Plugin[] {
  return [mark.input()];
}

export namespace mark {
  /** Spell the formatting session into the text input that owns it. */
  export function type(state: EditorState, tr: Transaction): void {
    if (compositionState(state)?.isComposing && !tr.getMeta(compositionCommit) ||
        !(tr.selection instanceof TextSelection) || isFormattingTransaction(tr) || isHistoryTransaction(tr) ||
        !(tr.docChanged || tr.getMeta(compositionCommit))) return;
    const previous = formattingPluginKey.getState(state)?.session;
    const session = previous && tr.docChanged ? transport(previous, tr.mapping) : previous;
    if (session) new FormatInput(state, session, tr).apply();
  }

  /** Re-encode accepted text before field reconciliation; composition remains untouched. */
  export function input(): Plugin<FormattingState> {
    return new Plugin<FormattingState>({
      key: formattingPluginKey,
      state: { init: () => idle, apply: applyFormatting },
    });
  }
}

const idle: FormattingState = { rendered: false, session: null };

function applyFormatting(tr: Transaction, previous: FormattingState, old: EditorState): FormattingState {
  const meta = tr.getMeta(formattingPluginKey) as FormattingMeta | undefined;
  if (meta) return meta.kind === 'clear' ? idle : { rendered: true, session: meta.session };
  if (isHistoryTransaction(tr)) return { rendered: previous.rendered, session: null };
  if (tr.getMeta('pointer') || tr.selectionSet && !tr.docChanged && !tr.getMeta('appendedTransaction') &&
      !tr.selection.eq(old.selection)) return idle;
  const session = previous.session && tr.docChanged ? transport(previous.session, tr.mapping) : previous.session;
  return { rendered: previous.rendered, session };
}

/** Edits outside the owned input run end ownership; mark-only steps have empty maps. */
function transport(session: FormattingSession, mapping: Mapping): FormattingSession | null {
  let from = session.from;
  let to = session.to;
  for (const map of mapping.maps) {
    let outside = false;
    map.forEach((start, end) => { if (start < from || end > to) outside = true; });
    if (outside) return null;
    from = map.map(from, -1);
    to = map.map(to, 1);
  }
  return {
    ...session, from, to,
    framing: session.framing.map(range => ({ from: mapping.map(range.from, 1), to: mapping.map(range.to, -1) })),
  };
}

interface Field {
  readonly position: number;
  readonly source: string;
}

interface Operation {
  readonly format: InlineFormat;
  readonly enabled: boolean;
}

/** One accepted input owns the private source transaction and all of its position mappings. */
class FormatInput {
  readonly tr: Transaction;
  readonly environment: bindings.State;
  readonly edits: { from: number; to: number; text: string }[] = [];
  get mapping(): Mapping { return this.tr.mapping; }
  readonly fields: Field[] = [];
  readonly operations: Operation[];
  next: FormattingSession | null = null;

  constructor(readonly state: EditorState, readonly session: FormattingSession, readonly input: Transaction) {
    const tr = this.tr = EditorState.create({ doc: input.doc, selection: input.selection,
      storedMarks: input.storedMarks }).tr;
    this.environment = bindings.after(bindings.get(state), input);
    this.operations = [
      ...session.excluded.map(format => ({ format, enabled: false })),
      ...session.formats.map(format => ({ format, enabled: true })),
    ];
    const from = tr.doc.resolve(session.from);
    const to = tr.doc.resolve(session.to);
    if (from.sameParent(to)) this.collect(from.parent, from.before());
    else tr.doc.nodesBetween(session.from, session.to, (node, position) => this.collect(node, position));
  }

  collect(node: Node, position: number): boolean {
    if (formattingMode(node)) this.fields.push({ position, source: fieldSource(node) });
    return !node.isTextblock;
  }

  apply(): Transaction | null {
    if (!this.fields.length)
      return this.input.setMeta(formattingPluginKey, { kind: 'clear', session: null } satisfies FormattingMeta);
    for (const range of [...this.session.framing].reverse()) {
      if (range.to > range.from) this.insert('', range.from, range.to);
    }
    for (const field of [...this.fields].reverse()) this.field(field);
    const unchanged = this.fields.every(field =>
      fieldSource(this.tr.doc.nodeAt(this.mapping.map(field.position, -1))!) === field.source);
    if (!unchanged) for (const edit of this.edits) this.input.insertText(edit.text, edit.from, edit.to);
    else if (this.tr.selection.eq(this.input.selection) && this.fields.length === 1) return null;
    this.input.setSelection(TextSelection.create(this.input.doc, this.tr.selection.anchor, this.tr.selection.head));
    return this.finish(this.input);
  }

  insert(text: string, from: number, to: number): void {
    this.edits.push({ text, from, to });
    this.tr.insertText(text, from, to);
  }

  finish(tr: Transaction): Transaction {
    return tr.setMeta(formattingPluginKey, { kind: 'input', session: this.next } satisfies FormattingMeta);
  }

  field(field: Field): void {
    const { tr, session } = this;
    const position = this.mapping.map(field.position, -1);
    const node = tr.doc.nodeAt(position)!;
    const start = position + 1;
    const mode = formattingMode(node)!;
    let from = Math.max(start, this.mapping.map(session.from, -1));
    let to = Math.min(start + node.content.size, this.mapping.map(session.to, 1));
    for (const operation of this.operations) {
      const current = tr.doc.nodeAt(position)!;
      const source = fieldSource(current);
      const environment = bindings.after(this.environment, tr);
      const reading = readField(tr.doc.resolve(start), environment);
      if (reading.kind === 'blocks') continue;
      const analysis = { value: source, children: reading.children };
      const change = new MarkRange(analysis, from - start, to - start, operation.format, mode,
        environment).change(operation.enabled);
      if (!change) continue;
      const nextFrom = start + change.map(from - start, 1);
      const nextTo = start + change.map(to - start, -1);
      this.change(start, source, change, to);
      from = nextFrom;
      to = nextTo;
    }
    if (this.fields.length === 1)
      this.next = captureFormattingSession(tr.doc, from, to, bindings.after(bindings.get(this.state), tr),
        session.formats, session.excluded);
  }

  change(start: number, source: string, change: MarkRange.Change, inputEnd: number): void {
    const length = source.length;
    const selection = this.tr.selection;
    const mapStart = this.tr.mapping.maps.length;
    for (let index = 0; index < change.edits.length; index++) {
      const edit = change.edits[index];
      // The final replacement includes the accepted input through its end. Native history
      // then sees the entire rewritten run, including whitespace moved outside its markers.
      const end = index === change.edits.length - 1 ? Math.max(edit.to, inputEnd - start) : edit.to;
      const text = edit.text + source.slice(edit.to, end);
      const mapping = this.tr.mapping.slice(mapStart);
      const from = mapping.map(start + edit.from, 1);
      const to = edit.from === end ? from : mapping.map(start + end, -1);
      this.insert(text, from, to);
    }
    const mapping = this.tr.mapping.slice(mapStart);
    const forward = selection.anchor <= selection.head;
    const anchor = endpoint(selection.anchor, forward ? 1 : -1, start, length, change, mapping);
    const head = selection.empty ? anchor : endpoint(selection.head, forward ? -1 : 1, start, length, change, mapping);
    this.tr.setSelection(TextSelection.create(this.tr.doc, anchor, head));
  }
}

function endpoint(position: number, association: -1 | 1, start: number, length: number,
  change: MarkRange.Change, mapping: Mapping): number {
  return position >= start && position <= start + length
    ? start + change.map(position - start, association) : mapping.map(position, association);
}
