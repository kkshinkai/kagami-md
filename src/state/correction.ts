/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Node, ResolvedPos } from 'prosemirror-model';
import { Plugin, PluginKey, type EditorState, type Transaction } from 'prosemirror-state';
import { Mapping } from 'prosemirror-transform';
import type { BindingSet, BindingLabels } from '../parse/bindings.js';
import { BindingState } from './bindings.js';
import { readField, fieldSource, fieldOptions, hasPending, lazyField } from '../parse/field.js';
import type { Parser } from '../syntax/index.js';
import { changedRanges, transactionChangedRanges, transactionMapping, type Change } from './changes.js';
import { getParser } from './parser.js';
import { restoringHistory } from './history.js';
import { update } from '../transform/transform.js';
import { activePending, leftLine, normalizeLines, setContent } from './field.js';
import { composing, compositionCommit, compositionState, focusKey } from './input.js';
import { normalizationKey } from './normalization.js';
import { correctFrontmatter } from '../schema/frontmatter.js';
import { correctHTML } from '../schema/html.js';
import { correctList } from '../schema/list.js';
import { correctCallout } from '../schema/callout.js';
import { correctTrailingWhitespace } from './trailingwhitespace.js';
import { pretense } from './pretense.js';
import { conditional, refreshDefinitionMeaning, replaceParagraph, rereadDefinition } from './settlement.js';

/** Fields waiting for a settled reading, also marking transactions produced by that reading. */
export const phrasingKey = new PluginKey<readonly number[]>('phrasing');

/** One evaluation's completed nodes and its actual binding environment, including local definitions. */
export interface PhrasingUpdate {
  bindings: BindingSet;
  completed: ReadonlySet<Node>;
}

/** One ordered Markdown reading correction, sharing one plan for each change batch. */
export function correction(): Plugin {
  return new Plugin<readonly number[]>({
    key: phrasingKey,
    state: { init: () => [], apply: pendingFields },
    appendTransaction(transactions, before, state) {
      if (composing(state, transactions)) return null;
      const tr = state.tr;
      const replay = restoringHistory(transactions);
      if (replay) tr.setMeta('addToHistory', false);
      let settled = false;
      let fields = new CorrectionFields(transactions, before, state, tr);
      for (;;) {
        if (!replay) {
          correctFrontmatter(tr, fields, before);
          settled = correctTrailingWhitespace(tr, fields, state) || settled;
        }
        new PhrasingCorrection(transactions, before, state, tr, fields).apply();
        if (!replay) correctHTML(tr, fields, state);
        const start = tr.steps.length;
        const doc = tr.doc;
        pretense(tr, fields);
        new BindingCorrection(transactions, before, state, tr, fields).apply();
        correctList(tr, fields);
        if (!replay) correctCallout(tr, fields);
        if (tr.steps.length === start) break;
        fields = fields.next(doc, start);
      }
      return tr.steps.length || tr.getMeta(phrasingKey) || tr.getMeta(focusKey) ||
        settled ? tr : null;
    },
  });
}

/** The fields and ranges owned by one reading batch. */
export class CorrectionFields {
  readonly updates: PhrasingUpdate[] = [];
  private readonly inputs = new Set<number>();
  private readonly repairs = new Set<number>();
  private readonly start: number;
  private readonly changes: readonly Change[];

  constructor(readonly transactions: readonly Transaction[], readonly before: EditorState,
    readonly state: EditorState, readonly tr: Transaction, previous = before.doc,
    changes = transactionChangedRanges(transactions), mapping = transactionMapping(transactions), start = tr.steps.length,
    updates = transactions.flatMap(transaction => phrasingUpdates(transaction))) {
    this.updates.push(...updates);
    const completed = new Set(updates.flatMap(update => [...update.completed]));
    this.start = start;
    this.changes = changes;
    const inverse = mapping.invert();
    const replay = start === 0 && restoringHistory(transactions);
    const scanned = new Set<number>();
    const scan = (node: Node, position: number): boolean => {
      if (scanned.has(position)) return false;
      scanned.add(position);
      if (!node.isTextblock) return true;
      if (node.type === node.type.schema.nodes.paragraph) this.repairs.add(position);
      const old = previous.resolve(inverse.map(position + 1, 1));
      const current = tr.doc.resolve(position + 1);
      if (!completed.has(node) &&
          (replay || !old.parent.content.eq(current.parent.content) || !samePhrasing(old, current)))
        this.inputs.add(position);
      return false;
    };
    for (const change of changes) tr.doc.nodesBetween(change.start, change.end, (node, position) => {
      if (node.type.isInGroup('list')) return true;
      if (scan(node, position)) node.descendants((child, offset) => scan(child, position + 1 + offset));
      return false;
    });
    if (!start && transactions.some(tr => tr.getMeta(compositionCommit))) {
      const head = tr.selection.$head;
      if (head.depth) this.inputs.add(head.before());
      const position = compositionState(before)?.activeTextblockPos;
      if (position != null) {
        const at = mapping.mapResult(position, 1);
        if (!at.deletedAfter) this.inputs.add(at.pos);
      }
    }
  }

  textblocks(tr: Transaction): number[] { return this.positions(this.inputs, tr); }

  /** A preceding correction changed this field's source within the same batch. */
  include(position: number, tr: Transaction): void {
    const original = tr.mapping.slice(this.start).invert().map(position, 1);
    this.inputs.add(original);
    if (tr.doc.nodeAt(position)?.type === tr.doc.type.schema.nodes.paragraph) this.repairs.add(original);
  }
  paragraphs(tr: Transaction): number[] {
    return this.positions(this.repairs, tr)
      .filter(pos => tr.doc.nodeAt(pos)!.type === tr.doc.type.schema.nodes.paragraph);
  }

  private positions(positions: ReadonlySet<number>, tr: Transaction): number[] {
    const mapping = tr.mapping.slice(this.start);
    const result = new Set<number>();
    for (const position of positions) {
      const at = mapping.mapResult(position, 1);
      if (!at.deletedAcross && tr.doc.nodeAt(at.pos)?.isTextblock) result.add(at.pos);
    }
    return [...result].sort((a, b) => b - a);
  }

  ranges(tr: Transaction): { from: number; to: number }[] {
    const mapping = tr.mapping.slice(this.start);
    const ranges = this.changes.map(change => ({
      from: mapping.map(change.start, -1), to: mapping.map(change.end, 1),
    }));
    for (const change of changedRanges(tr.steps.slice(this.start), new Mapping(tr.mapping.maps.slice(this.start))))
      ranges.push({ from: change.start, to: change.end });
    if (!this.start && this.transactions.some(tr => tr.getMeta(compositionCommit)))
      for (const position of this.textblocks(tr))
        ranges.push({ from: position, to: position + tr.doc.nodeAt(position)!.nodeSize });
    ranges.sort((a, b) => a.from - b.from);
    const merged: { from: number; to: number }[] = [];
    for (const range of ranges) {
      const previous = merged.at(-1);
      if (previous && range.from <= previous.to) previous.to = Math.max(previous.to, range.to);
      else merged.push(range);
    }
    return merged;
  }

  mapping(tr: Transaction): Mapping {
    const mapping = transactionMapping(this.transactions);
    mapping.appendMapping(tr.mapping);
    return mapping;
  }

  next(previous: Node, start: number): CorrectionFields {
    const mapping = new Mapping(this.tr.mapping.maps.slice(start));
    const fields = new CorrectionFields(this.transactions, this.before, this.state, this.tr, previous,
      changedRanges(this.tr.steps.slice(start), mapping), mapping, this.tr.steps.length, this.updates);
    return fields;
  }
}

/** Whether leaving this field can settle a Pending block or empty definition label. */
export function settlesPhrasing(position: ResolvedPos, state: EditorState): boolean {
  const node = position.parent;
  const types = node.type.schema.nodes;
  if (node.type === types.linkLabel || node.type === types.footnoteLabel) return !fieldSource(node);
  if (node.type !== types.paragraph) return false;
  return hasPending(node) || BindingState.get(state).blockReading(position.before());
}

/** A structural reading owns its generated phrasings, not the native nodes it kept. */
export function completedPhrasing(doc: Node, from: number, to: number, retained?: ReadonlySet<Node>): Set<Node> {
  const completed = new Set<Node>();
  doc.nodesBetween(from, to, node => {
    if (node.isTextblock && !retained?.has(node)) completed.add(node);
    return !node.isTextblock;
  });
  return completed;
}

/** Equal source has the same reading only when the field's grammatical context agrees. */
function samePhrasing(before: ResolvedPos, after: ResolvedPos): boolean {
  if (!before.depth || before.parent.type !== after.parent.type) return false;
  if (fieldSource(before.parent) !== fieldSource(after.parent)) return false;
  if (!after.parent.type.isInGroup('field')) return true;
  const previous = fieldOptions(before.parent, before.depth > 1 ? before.node(-1) : null, before.index(-1));
  const current = fieldOptions(after.parent, after.depth > 1 ? after.node(-1) : null, after.index(-1));
  return previous.phrasing === current.phrasing && previous.firstInListItem === current.firstInListItem &&
    previous.firstInBlockQuote === current.firstInBlockQuote;
}

/** Read the completed fields from either phase of correction. */
function phrasingUpdates(transaction: Transaction): readonly PhrasingUpdate[] {
  return transaction.getMeta(phrasingKey) ?? [];
}

/** Track fields whose caret left while a pointer gesture deferred their settlement. */
function pendingFields(tr: Transaction, before: readonly number[], state: EditorState): readonly number[] {
  if (tr.getMeta(phrasingKey) || restoringHistory([tr])) return [];
  const pending = new Set(before);
  const previous = state.selection.$head;
  if (tr.selectionSet && previous.depth && leftLine(previous, tr.selection, tr.mapping) &&
      settlesPhrasing(previous, state)) {
    pending.add(previous.before());
  }
  const mapped: number[] = [];
  for (const position of pending) {
    const result = tr.mapping.mapResult(position, 1);
    if (!result.deletedAcross) mapped.push(result.pos);
  }
  return mapped;
}

/** One correction's transaction, mapping, binding environments and completed readings. */
class PhrasingCorrection {
  readonly doc: Node;
  readonly start: number;
  get output(): Mapping { return this.tr.mapping.slice(this.start); }
  readonly mapping: Mapping;
  readonly inverse: Mapping;
  readonly parser: Parser;
  readonly replay: boolean;
  readonly released: boolean;
  readonly blur: boolean;
  readonly updates: PhrasingUpdate[] = [];

  constructor(readonly transactions: readonly Transaction[], readonly before: EditorState,
    readonly state: EditorState, readonly tr: Transaction, readonly fields: CorrectionFields) {
    this.doc = tr.doc;
    this.start = tr.steps.length;
    this.mapping = fields.mapping(tr);
    this.inverse = this.mapping.invert();
    this.parser = getParser(state);
    this.replay = restoringHistory(transactions);
    const pointer = normalizationKey.getState(state);
    this.released = !pointer?.isPointerActive && !pointer?.isPointerSelecting;
    this.blur = !tr.getMeta(focusKey) && !!focusKey.getState(state)?.blurPending;
    if (this.replay) this.tr.setMeta('addToHistory', false);
  }

  apply(): Transaction | null {
    const positions = this.positions();
    if (!positions.length && !this.blur) return null;
    const previousBindings = BindingState.get(this.before);
    // Frame readings can consume several edited phrasings, so normalize every input first.
    if (!this.replay) this.normalize(positions);
    const definitions = this.definitions(positions, previousBindings);
    const current = BindingState.after(BindingState.get(this.state), this.tr);
    for (const position of positions) {
      if (!definitions.has(position)) this.field(position, current, previousBindings);
    }
    this.fields.updates.push(...this.updates);
    this.tr.setMeta(phrasingKey, this.fields.updates);
    if (this.blur) this.tr.setMeta(focusKey, { blurPending: false });
    return this.tr;
  }

  positions(): number[] {
    const positions = new Set(this.fields.textblocks(this.tr).filter(position =>
      this.tr.doc.nodeAt(position)!.type.isInGroup('field')));
    if (!this.replay && this.released && !this.tr.getMeta(phrasingKey)) {
      for (const position of phrasingKey.getState(this.state)!) positions.add(this.tr.mapping.map(position, 1));
      const previous = this.before.selection.$head;
      if (previous.depth && (this.blur || leftLine(previous, this.tr.selection, this.mapping)) &&
          settlesPhrasing(previous, this.before)) {
        const mapped = this.mapping.mapResult(previous.before(), 1);
        if (!mapped.deletedAcross) positions.add(mapped.pos);
      }
    }
    return [...positions].sort((a, b) => b - a);
  }

  normalize(positions: readonly number[]): void {
    for (const position of positions) {
      const at = this.output.map(position, 1);
      const node = this.tr.doc.nodeAt(at);
      if (node && node.type.isInGroup('field')) normalizeLines(this.tr, at, node);
    }
  }

  /** Existing definition frames establish meaning before any dependent phrasing is read. */
  definitions(positions: readonly number[], bindings: BindingSet): Set<number> {
    const frames = new Set<number>();
    const fields = new Set<number>();
    for (const position of positions) {
      const location = this.doc.resolve(position + 1);
      if (!definitionPhrasing(location)) continue;
      fields.add(position);
      frames.add(location.before(location.depth - 1));
      this.definitionField(position, bindings);
    }
    for (const position of [...frames].sort((a, b) => b - a)) {
      const at = this.output.map(position, 1);
      if (this.replay) refreshDefinitionMeaning(this.tr, at);
      else {
        const update = rereadDefinition(this.tr, at, this.parser, bindings, this.blur);
        if (update) this.updates.push(update);
        else {
          const frame = this.tr.doc.nodeAt(at)!;
          this.updates.push({ bindings, completed: completedPhrasing(this.tr.doc, at, at + frame.nodeSize) });
        }
      }
    }
    return fields;
  }

  definitionField(position: number, bindings: BindingSet): void {
    const at = this.output.map(position, 1);
    const text = fieldSource(this.tr.doc.nodeAt(at)!);
    const before = this.before.doc.resolve(this.inverse.map(position + 1, 1));
    if (this.replay && samePhrasing(before, this.tr.doc.resolve(at + 1))) {
      restoreMarks(this.tr, at, before.parent);
      BindingState.record(this.tr, at, BindingState.get(this.before).references(before.before()));
      return;
    }
    const result = readField(this.tr.doc.resolve(at + 1), this.parser, bindings);
    if (result.kind === 'blocks') throw new Error('A definition phrasing cannot produce blocks');
    if (result.kind === 'inline' && result.identifier !== null) {
      const field = this.tr.doc.resolve(at + 1);
      update(this.tr, field.before(field.depth - 1), { identifier: result.identifier });
    }
    if (this.replay || !conditional(this.tr, at, result, this.parser, bindings)) {
      setContent(this.tr, at, result.frontier, text, result.references);
    }
  }

  field(position: number, bindings: BindingSet, previousBindings: BindingSet): void {
    const { tr } = this;
    const mapped = this.output.mapResult(position, 1);
    if (mapped.deletedAcross) return;
    const at = mapped.pos;
    const node = tr.doc.nodeAt(at);
    if (!node || !node.type.isInGroup('field')) return;
    const before = this.before.doc.resolve(this.inverse.map(position + 1, 1));
    if (this.replay && samePhrasing(before, tr.doc.resolve(at + 1))) {
      restoreMarks(tr, at, before.parent);
      BindingState.record(tr, at, BindingState.get(this.before).references(before.before()));
      return;
    }
    const text = fieldSource(node);
    const paragraph = node.type === tr.doc.type.schema.nodes.paragraph;
    const waits = !this.released || !this.blur && activePending(tr.selection, at, text);
    const lazy = paragraph && lazyField(before, this.parser, previousBindings);
    const settle = paragraph && !this.replay && !waits && !lazy;
    const reading = readField(tr.doc.resolve(at + 1), this.parser, bindings, settle);
    const start = tr.mapping.maps.length;
    let environment = bindings;
    switch (reading.kind) {
      case 'blocks': {
        if (this.replay) return;
        const trailingBreak = before.parent.isTextblock && text.endsWith('\n') &&
          text.slice(0, -1) === fieldSource(before.parent);
        replaceParagraph(tr, at, node, text, reading.blocks, trailingBreak);
        environment = bindings.withBlocks(reading.blocks);
        break;
      }
      case 'pending':
      case 'inline': {
        if (reading.kind === 'pending' && (this.replay || lazy)) {
          BindingState.record(tr, at, reading.references);
          return;
        }
        const converted = this.replay ? null : conditional(tr, at, reading, this.parser, bindings);
        if (converted) {
          this.updates.push(converted);
          return;
        }
        setContent(tr, at, reading.frontier, text, reading.references);
        break;
      }
      default: {
        const exhaustive: never = reading;
        throw new Error(`Unknown transduction: ${exhaustive}`);
      }
    }
    const changed = tr.mapping.slice(start);
    this.updates.push({ bindings: environment,
      completed: completedPhrasing(tr.doc, changed.map(at, -1), changed.map(at + node.nodeSize, 1)) });
  }
}

/** Native history can restore obsolete marks even when its text edit was already removed. */
function restoreMarks(tr: Transaction, position: number, before: Node): void {
  if (tr.doc.nodeAt(position)!.content.eq(before.content)) return;
  const start = position + 1;
  tr.removeMark(start, start + before.content.size);
  before.forEach((piece, offset) => {
    for (const mark of piece.marks) tr.addMark(start + offset, start + offset + piece.nodeSize, mark);
  });
}

/** Definition fields settle their containing frame before dependent fields are read. */
function definitionPhrasing(position: ResolvedPos): boolean {
  if (position.depth < 2) return false;
  const type = position.parent.type;
  const types = type.schema.nodes;
  return type === types.linkLabel || type === types.linkDestination || type === types.linkTitle ||
    type === types.footnoteLabel;
}

/** A completed reading together with the bindings changed since it was evaluated. */
interface InvalidatedReading extends PhrasingUpdate {
  changed: BindingLabels;
}

/** One binding correction visits only fields indexed under changed labels. */
class BindingCorrection {
  readonly parser: Parser;
  readonly bindings: BindingState;
  readonly changed: BindingLabels;
  readonly updates: InvalidatedReading[];
  readonly completed = new Set<Node>();
  readonly start: number;
  readonly doc: Node;

  constructor(readonly transactions: readonly Transaction[], readonly before: EditorState,
    readonly state: EditorState, readonly tr: Transaction, readonly fields: CorrectionFields) {
    this.start = tr.steps.length;
    this.doc = tr.doc;
    this.parser = getParser(state);
    this.bindings = BindingState.after(BindingState.get(state), tr);
    this.changed = BindingState.get(before).changed(this.bindings);
    this.updates = [];
    for (const update of fields.updates) this.updates.push({
      ...update, changed: update.bindings.changed(this.bindings),
    });
    if (restoringHistory(transactions)) this.tr.setMeta('addToHistory', false);
  }

  apply(): Transaction | null {
    if (!this.changed.size && this.updates.every(update => !update.changed.size)) return null;
    // The parser recorded which fields asked about each label; only those are read again.
    const positions = this.bindings.affected(this.changed);
    for (const update of this.updates) {
      for (const position of this.bindings.affected(update.changed)) positions.add(position);
    }
    for (const position of [...positions].sort((a, b) => b - a)) {
      const node = this.doc.nodeAt(position);
      if (node) this.refresh(node, position);
    }
    const update = { bindings: this.bindings as BindingSet, completed: this.completed };
    this.fields.updates.push(update);
    this.tr.setMeta(phrasingKey, this.fields.updates);
    return this.tr.steps.length || this.completed.size ? this.tr : null;
  }

  refresh(node: Node, pos: number): void {
    if (!node.isTextblock) return;
    const types = node.type.schema.nodes;
    if (node.type !== types.paragraph && node.type !== types.heading &&
        node.type !== types.tableParagraph && node.type !== types.calloutTitle) return;
    const previous = this.updates.findLast(update => update.completed.has(node));
    const invalidated = previous ? previous.changed : this.changed;
    if (!invalidated.size) return;
    if (!invalidated.intersects(this.bindings.references(pos))) return;
    const text = fieldSource(node);
    const location = this.doc.resolve(pos + 1);
    const reading = readField(location, this.parser, this.bindings);
    const at = this.tr.mapping.slice(this.start).map(pos, 1);
    // Imported lazy lines retain their unmarked paragraph reading until pretense repair.
    if (reading.kind === 'blocks' || reading.kind === 'pending' &&
        (reading.pending.type === 'pendingTable' || reading.pending.type === 'pendingSetextUnderline') &&
        location.depth >= 2 && !hasPending(node)) {
      BindingState.record(this.tr, at, reading.references, reading.kind === 'blocks');
      this.completed.add(this.tr.doc.nodeAt(at)!);
      return;
    }
    setContent(this.tr, at, reading.frontier, text, reading.references);
    this.completed.add(this.tr.doc.nodeAt(at)!);
    return;
  }

}
