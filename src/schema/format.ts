/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { walkInline } from '../parse/inline.js';
import { compositionState } from '../state/input.js';
import { DelimitedSyntax, LinkSyntax, Syntax, type Bindings, type Phrasing } from '../syntax/index.js';
import type { Node } from 'prosemirror-model';
import { PluginKey, TextSelection, type Command, type EditorState, type Transaction } from 'prosemirror-state';

import { bindings } from '../state/bindings.js';
import { readField, fieldSource } from '../parse/field.js';
import { inlineBody, inlineFormat, inlineFormats, type InlineBranch, type InlineFormat } from './inlineformat.js';
import { history } from '../state/history.js';
import { MarkRange } from './markrange.js';

interface FormattingRange { readonly from: number; readonly to: number }

/** A typing preference and the source framing it owns. */
export interface FormattingSession extends FormattingRange {
  readonly formats: readonly InlineFormat[];
  readonly excluded: readonly InlineFormat[];
  readonly framing: readonly FormattingRange[];
}

export interface FormattingState {
  readonly rendered: boolean;
  readonly session: FormattingSession | null;
}

export interface FormattingMeta {
  readonly kind: 'command' | 'input' | 'clear';
  readonly session: FormattingSession | null;
}

export const formattingPluginKey = new PluginKey<FormattingState>('inline-formatting');

export function isFormattingTransaction(tr: Transaction): boolean {
  return !!tr.getMeta(formattingPluginKey);
}

export function keepsFormattedSourceRendered(state: EditorState): boolean {
  return formattingPluginKey.getState(state)?.rendered ?? false;
}

type FormatAction = 'toggle' | 'add' | 'remove';
interface Field { pos: number; target: MarkRange }
interface ChangedField extends Field { change: MarkRange.Change }

/**
 * Change the Markdown behind an inline format. Toggle removes a format only
 * when every eligible selected character has it. Add and remove are idempotent.
 * A dry run checks the same Markdown encodings without changing the state.
 */
export function toggleMark(format: InlineFormat, action: FormatAction = 'toggle'): Command {
  if (!inlineFormats.includes(format) || !['toggle', 'add', 'remove'].includes(action)) {
    throw new TypeError('Unknown inline format or formatting action');
  }
  return (state, dispatch, view) => {
    if ((view && (!view.editable || view.composing)) || compositionState(state)?.isComposing) {
      return false;
    }
    const fields = new SelectedFields(state, format).read();
    if (!fields.length) return false;
    const previous = formattingPluginKey.getState(state)?.session;
    if (state.selection instanceof TextSelection && state.selection.empty &&
        fields.every(field => field.target.coverage === 'none')) {
      const field = fields[0]!;
      const offset = state.selection.from - field.pos - 1;
      if (!blankPosition(field.target.analysis.children, offset)) return false;
      const prior = previous?.formats ?? formatsAt(field.target.analysis.children, offset);
      const enabled = action === 'toggle' ? !prior.includes(format) : action === 'add';
      const formats = changeSet(prior, format, enabled);
      const excluded = changeSet(previous?.excluded ?? [], format, !enabled);
      const session: FormattingSession = {
        from: state.selection.from, to: state.selection.to, formats, excluded, framing: [],
      };
      dispatch?.(history.isolate(state.tr).setMeta(formattingPluginKey,
        { kind: 'command', session } satisfies FormattingMeta));
      return true;
    }
    const eligible = fields.filter(field => field.target.coverage !== 'none');
    if (!eligible.length) return false;
    const enabled = action === 'toggle'
      ? !eligible.every(field => field.target.coverage === 'on') : action === 'add';
    const changes: ChangedField[] = [];
    for (const field of fields) {
      const change = field.target.change(enabled);
      if (!change) return false;
      changes.push({ ...field, change });
    }
    if (!dispatch) return true;
    const tr = applyChanges(state.tr, changes);
    const formats = changeSet(previous?.formats ?? [], format, enabled);
    const session = fields.length === 1 && formats.length
      ? captureFormattingSession(tr.doc, tr.selection.from, tr.selection.to, bindings.after(bindings.get(state), tr), formats) : null;
    dispatch(history.isolate(tr).setMeta(formattingPluginKey, { kind: 'command', session } satisfies FormattingMeta));
    return true;
  };
}

function changeSet(formats: readonly InlineFormat[], format: InlineFormat, enabled: boolean): InlineFormat[] {
  return enabled ? [...new Set([...formats, format])] : formats.filter(value => value !== format);
}

/** The prose mode of an editable field; literal bodies have no formatting mode. */
export function formattingMode(node: Node): Phrasing | null {
  const { nodes } = node.type.schema;
  if (node.type === nodes.tableParagraph) return 'tableCell';
  if (node.type === nodes.heading) return node.attrs.form === 'atx' ? 'atxHeading' : 'setextHeading';
  if (node.type === nodes.paragraph) return 'paragraph';
  if (node.type === nodes.calloutTitle) return 'calloutTitle';
  return null;
}

/** Collects eligible fields without joining disjoint selection ranges. */
class SelectedFields {
  readonly fields = new Map<number, Field>();
  readonly bindings: Bindings;

  constructor(readonly state: EditorState, readonly format: InlineFormat) {
    this.bindings = bindings.get(state);
  }

  read(): Field[] {
    const { selection, doc } = this.state;
    if (selection instanceof TextSelection && selection.empty) {
      this.add(selection.$from.parent, selection.$from.before(), selection.from, selection.to);
    } else {
      for (const range of selection.ranges) {
        doc.nodesBetween(range.$from.pos, range.$to.pos, (node, pos) => {
          if (!node.isTextblock) return;
          this.add(node, pos, range.$from.pos, range.$to.pos);
          return false;
        });
      }
    }
    return [...this.fields.values()].sort((left, right) => left.pos - right.pos);
  }

  add(node: Node, pos: number, start: number, end: number): void {
    const mode = formattingMode(node);
    if (!mode) return;
    const value = fieldSource(node);
    const reading = readField(this.state.doc.resolve(pos + 1), this.bindings);
    if (reading.kind === 'blocks') return;
    let from = Math.max(0, start - pos - 1);
    let to = Math.min(value.length, end - pos - 1);
    if (from > to) return;
    if (this.state.selection.empty && from === to) {
      const word = wordAt(reading.children, value, from);
      if (word) [from, to] = word;
    }
    this.fields.set(pos, {
      pos, target: new MarkRange({ value, children: reading.children }, from, to, this.format, mode, this.bindings),
    });
  }
}

const words = new Intl.Segmenter(undefined, { granularity: 'word' });

function formatsAt(nodes: readonly Syntax[], offset: number): InlineFormat[] {
  const result: InlineFormat[] = [];
  walkInline(nodes, node => {
    if (offset < node.start || offset > node.end ||
        !(node instanceof DelimitedSyntax || node instanceof LinkSyntax)) return false;
    const body = inlineBody(node);
    if (offset < body.from || offset > body.to) return false;
    const format = inlineFormat(node);
    if (format) result.push(format);
    return !!format || node instanceof LinkSyntax;
  });
  return result;
}

function wordAt(nodes: readonly Syntax[], source: string, offset: number): [number, number] | null {
  let found: [number, number] | null = null;
  walkInline(nodes, node => {
    if (offset < node.start || offset > node.end) return false;
    if (node instanceof DelimitedSyntax || node instanceof LinkSyntax) {
      return !!inlineFormat(node) || node instanceof LinkSyntax;
    }
    if (node.type !== 'text') return false;
    for (const word of words.segment(source.slice(node.start, node.end))) {
      const from = node.start + word.index;
      const to = from + word.segment.length;
      if (word.isWordLike && offset > from && offset < to) found = [from, to];
    }
    return false;
  });
  return found;
}

function blankPosition(nodes: readonly Syntax[], offset: number): boolean {
  let blank = true;
  walkInline(nodes, node => {
    if (offset < node.start || offset > node.end) return false;
    if ((node instanceof DelimitedSyntax || node instanceof LinkSyntax) &&
        (inlineFormat(node) || node instanceof LinkSyntax)) {
      const body = inlineBody(node);
      if (offset < body.from || offset > body.to) blank = false;
      return blank;
    }
    if (node.type !== 'text' && offset !== node.start && offset !== node.end) blank = false;
    return false;
  });
  return blank;
}

/** Keep retained body characters in native step maps and selections inside new framing. */
function applyChanges(tr: Transaction, fields: readonly ChangedField[]): Transaction {
  const selection = tr.selection;
  for (let index = fields.length - 1; index >= 0; index--) {
    const field = fields[index]!;
    for (const edit of [...field.change.edits].reverse()) {
      tr.insertText(edit.text, field.pos + 1 + edit.from, field.pos + 1 + edit.to);
    }
  }
  if (selection instanceof TextSelection) {
    const forward = selection.anchor <= selection.head;
    const anchor = mapEndpoint(tr, fields, selection.anchor, forward ? 1 : -1);
    let head = anchor;
    if (!selection.empty) head = mapEndpoint(tr, fields, selection.head, forward ? -1 : 1);
    tr.setSelection(TextSelection.create(tr.doc, anchor, head));
  }
  return tr;
}

function mapEndpoint(tr: Transaction, fields: readonly ChangedField[], pos: number, association: -1 | 1): number {
  const field = fields.find(field => pos >= field.pos + 1 && pos <= field.pos + 1 + field.target.analysis.value.length);
  if (!field) return tr.mapping.map(pos, association);
  return tr.mapping.map(field.pos, -1) + 1 + field.change.map(pos - field.pos - 1, association);
}

/** Capture complete format bodies owned by a typing run, excluding inherited outer framing. */
export function captureFormattingSession(
  doc: Node,
  from: number,
  to: number,
  environment: Bindings,
  formats: readonly InlineFormat[],
  excluded: readonly InlineFormat[] = []
): FormattingSession | null {
  const $from = doc.resolve(from);
  if (!$from.sameParent(doc.resolve(to)) || !formattingMode($from.parent)) return null;
  const reading = readField($from, environment);
  if (reading.kind === 'blocks') return null;
  const start = $from.start();
  const frames: InlineBranch[] = [];
  walkInline(reading.children, node => {
    if (!(node instanceof DelimitedSyntax || node instanceof LinkSyntax)) return false;
    const format = inlineFormat(node);
    if (format && formats.includes(format)) {
      const body = inlineBody(node);
      if (start + body.from >= from && start + body.to <= to) frames.push(node);
    }
    return !!format || node instanceof LinkSyntax;
  });
  return {
    from: Math.min(from, ...frames.map(frame => start + frame.start)),
    to: Math.max(to, ...frames.map(frame => start + frame.end)),
    formats, excluded,
    framing: frames.flatMap(frame => [
      { from: start + frame.start, to: start + inlineBody(frame).from },
      { from: start + inlineBody(frame).to, to: start + frame.end },
    ]).sort((left, right) => left.from - right.from),
  };
}
