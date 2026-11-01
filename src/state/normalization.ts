/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MarkType, Node, ResolvedPos } from 'prosemirror-model';
import {
  PluginKey, TextSelection, type EditorState, type PluginSpec, type Selection,
  type Transaction
} from 'prosemirror-state';
import { pendingMarks, schema } from '../types/schema.js';

/** The selection gesture whose original source presentation is still in use. */
interface NormalizationState {
  readonly isPointerActive: boolean;
  readonly isPointerSelecting: boolean;
  readonly gestureSelection: Selection | null;
  readonly presentationId: number;
  readonly modelOwned: boolean;
}

/** A change to gesture ownership, or a request to interpret its released endpoints. */
export interface NormalizationChange {
  readonly isPointerActive?: boolean;
  readonly isPointerSelecting?: boolean;
  readonly presentationId?: number;
  readonly gestureSelection?: Selection | null;
  readonly modelOwned?: boolean;
}

export const normalizationKey = new PluginKey<NormalizationState>('selection-normalization');

/** Preserve a gesture's source endpoints and normalize a completed text selection. The view
 * supplies the selection whose source is presented, including its current formatting policy. */
export function normalization(editing: (state: EditorState) => TextSelection | null): PluginSpec<NormalizationState> {
  return {
    key: normalizationKey,
    state: {
      init: () => ({ isPointerActive: false, isPointerSelecting: false, gestureSelection: null,
        presentationId: 0, modelOwned: false }),
      apply: (tr, value, before) => mapGesture(tr, value, before, editing),
    },
  };
}

/** Carry a gesture's initial presentation through edits until the view releases it. */
function mapGesture(tr: Transaction, value: NormalizationState, before: EditorState,
  editing: (state: EditorState) => TextSelection | null): NormalizationState {
  const change = tr.getMeta(normalizationKey) as NormalizationChange | undefined;
  const active = change?.isPointerActive ?? value.isPointerActive;
  // A gesture can start as native text selection and be claimed later (for example,
  // tableEditing installs CellSelection only when the pointer leaves its starting cell).
  // That claim lasts through release, even after the owner's own dragging flag clears.
  // Merely pressing with an existing model selection does NOT claim a new gesture: the
  // transaction must actually install it. The next click can still place a normal caret.
  const modelOwned = active && (change?.modelOwned ??
    (value.modelOwned || tr.selectionSet && !(tr.selection instanceof TextSelection)));
  if (!change || change.isPointerActive === undefined && change.isPointerSelecting === undefined &&
      change.presentationId === undefined) {
    const origin = value.isPointerActive || value.isPointerSelecting ? value.gestureSelection : null;
    return { ...value, modelOwned, gestureSelection: origin?.map(tr.doc, tr.mapping) ?? null };
  }
  const begins = !value.isPointerActive && !value.isPointerSelecting &&
    (change.isPointerActive || change.isPointerSelecting);
  let origin = value.gestureSelection;
  if (change.gestureSelection !== undefined) origin = change.gestureSelection;
  else if (begins) origin = editing(before);
  return {
    isPointerActive: active,
    isPointerSelecting: change.isPointerSelecting ?? value.isPointerSelecting,
    gestureSelection: origin?.map(tr.doc, tr.mapping) ?? null,
    presentationId: change.presentationId ?? value.presentationId,
    modelOwned,
  };
}

/** A stretch of a document or of a field, from one position to another. */
export interface Extent {
  readonly from: number;
  readonly to: number;
}

/** An outermost inline construct, taken with everything in it. */
interface Constituent extends Extent {
  readonly meta: readonly Extent[];
  readonly body: Extent | null;
}

/** The endpoints and whole constituents exposed by a text selection. */
export interface Revealing {
  readonly ends: readonly number[];
  readonly constituents: readonly Constituent[];
}

/** Only the fields containing selection ends are read, however large the document is. */
export function revealing(editing: TextSelection | null): Revealing {
  if (!editing) return { ends: [], constituents: [] };
  const ends = editing.empty ? [editing.$head] : [editing.$from, editing.$to];
  const fields = new Map<Node, readonly Constituent[]>();
  const constituents: Constituent[] = [];
  for (const end of ends) {
    if (!end.parent.isTextblock) continue;
    let field = fields.get(end.parent);
    if (!field) {
      field = new Constituents(end.parent).read();
      fields.set(end.parent, field);
    }
    constituents.push(...constituentsAt(field, end));
  }
  return { ends: ends.map(end => end.pos), constituents };
}

/** The same selection relation reveals every kind of construct, including nested ones. */
export function isRevealed(revealed: Revealing, construct: Extent): boolean {
  return revealed.ends.some(end => end >= construct.from && end <= construct.to) ||
    revealed.constituents.some(value => value.from <= construct.from && construct.to <= value.to);
}

interface Occurrence extends Extent {
  to: number;
  sound: boolean;
}

interface Piece extends Extent {
  readonly meta: boolean;
}

/** Marked pieces give live extents while native composition moves text. Containment,
 * rather than mark order, identifies the outermost constructs. */
class Constituents {
  readonly occurrences = new Map<MarkType, Map<number, Occurrence>>();
  readonly pieces: Piece[] = [];

  constructor(field: Node) {
    field.forEach((piece, from) => {
      const to = from + piece.nodeSize;
      this.pieces.push({ from, to, meta: piece.marks.some(mark => mark.type.spec.meta === true) });
      for (const mark of piece.marks) {
        if (mark.type === schema.marks.meta || mark.type === schema.marks.softLineBreak ||
            mark.type === schema.marks.hardLineBreak || mark.type === schema.marks.atxClosingSequence ||
            pendingMarks.has(mark.type)) continue;
        this.add(mark.type, mark.attrs.occurrence, from, to);
      }
    });
  }

  add(type: MarkType, id: number, from: number, to: number): void {
    let occurrences = this.occurrences.get(type);
    if (!occurrences) this.occurrences.set(type, occurrences = new Map());
    const previous = occurrences.get(id);
    if (!previous) occurrences.set(id, { from, to, sound: true });
    else {
      previous.sound &&= previous.to === from;
      previous.to = to;
    }
  }

  read(): Constituent[] {
    const occurrences = [...this.occurrences.values()].flatMap(values => [...values.values()]);
    const outer: Occurrence[] = [];
    for (const value of occurrences.sort((a, b) => a.from - b.from || b.to - a.to)) {
      const previous = outer.at(-1);
      if (!previous || value.to > previous.to) outer.push(value);
    }
    const result: Constituent[] = [];
    let firstPiece = 0;
    for (const value of outer) {
      if (!value.sound) continue;
      while (firstPiece < this.pieces.length && this.pieces[firstPiece].to <= value.from) firstPiece++;
      result.push(this.constituent(value, firstPiece));
    }
    return result;
  }

  constituent(value: Occurrence, firstPiece: number): Constituent {
    const meta: Extent[] = [];
    let bodyFrom: number | null = null;
    let bodyTo = 0;
    for (let index = firstPiece; index < this.pieces.length && this.pieces[index].from < value.to; index++) {
      const piece = this.pieces[index];
      if (piece.meta) meta.push({ from: piece.from, to: piece.to });
      else {
        bodyFrom ??= piece.from;
        bodyTo = piece.to;
      }
    }
    return { from: value.from, to: value.to, meta, body: bodyFrom === null ? null : { from: bodyFrom, to: bodyTo } };
  }
}

/** The constituents a position is in or at the edge of, in document positions. */
function constituentsAt(field: readonly Constituent[], position: ResolvedPos): Constituent[] {
  const start = position.start();
  const offset = position.parentOffset;
  return field.filter(value => value.from <= offset && offset <= value.to).map(value => ({
    from: start + value.from,
    to: start + value.to,
    meta: value.meta.map(range => ({ from: start + range.from, to: start + range.to })),
    body: value.body && { from: start + value.body.from, to: start + value.body.to },
  }));
}

export function normalizeTextSelection(selection: TextSelection, origin: Selection | null): TextSelection | null {
  const shown = revealing(origin instanceof TextSelection ? origin : null);
  const from = normalizeEndpoint(selection.$from, false, shown);
  const to = normalizeEndpoint(selection.$to, true, shown);
  if (from === selection.from && to === selection.to) return null;
  const forward = selection.anchor <= selection.head;
  return TextSelection.create(selection.$from.doc, forward ? from : to, forward ? to : from);
}

function normalizeEndpoint(cursor: ResolvedPos, end: boolean, shown: Revealing): number {
  if (!cursor.parent.isTextblock) return cursor.pos;
  // An end that is at the edge of a constituent's body, with the constituent's markers
  // concealed beside it, is at the edge of the constituent as far as the user can see. An
  // image has no body: it is meta throughout, and an end is not moved over it.
  const constituent = constituentsAt(new Constituents(cursor.parent).read(), cursor).find(value =>
    value.body !== null && value.meta.length > 0 && cursor.pos === (end ? value.body.to : value.body.from));
  if (!constituent) return cursor.pos;
  // When the constituent was revealed at pointerdown, the user could deliberately select the
  // body without its markers. Keep those exact ends. This asks what revealing asks.
  if (shown.constituents.some(value => value.from === constituent.from && value.to === constituent.to))
    return cursor.pos;
  return end ? constituent.to : constituent.from;
}
