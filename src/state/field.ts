/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { bindings } from './bindings.js';
import { repairPhrasing, type Frontier, type ReferenceLabels } from '../syntax/index.js';
import type { Fragment, Mark, Node, ResolvedPos } from 'prosemirror-model';
import { TextSelection, type Selection, type Transaction } from 'prosemirror-state';
import type { Mapping } from 'prosemirror-transform';
import { fieldSource, fieldOptions } from '../parse/field.js';
import { parse } from '../parse/parse.js';

/** A source range and the marks and atom width assigned by its reading. */
interface FieldPiece {
  readonly from: number;
  readonly to: number;
  readonly lineEnding: boolean;
  readonly marks: readonly Mark[];
}

/** sourceStart maps a retained source suffix into the current phrasing after a prefix is consumed. */
export function setContent(tr: Transaction, position: number, frontier: Frontier, text: string, references: ReferenceLabels, sourceStart = 0): void {
  const field = tr.doc.nodeAt(position);
  if (!field) throw new RangeError('Missing phrasing');
  bindings.record(tr, position, references);
  const content = parse.content(frontier, text, tr.doc.type.schema);
  if (field.content.eq(content)) return;
  const pieces = classify(frontier, content, sourceStart);
  const start = tr.steps.length;
  const lineEnding = tr.doc.type.schema.nodes.lineEnding;
  // Interior gaps in the frontier are layout, such as continuation indentation. They must
  // leave the field when its reading does; opening and terminal edges keep their own rules.
  for (let index = pieces.length - 1; index >= 0; index--) {
    const piece = pieces[index];
    if (piece.lineEnding && field.nodeAt(piece.from)?.type !== lineEnding) {
      tr.replaceWith(position + 1 + piece.from, position + 1 + piece.to, tr.doc.type.schema.nodes.lineEnding.create());
    }
    const previous = pieces[index - 1];
    if (previous && previous.to < piece.from) {
      tr.insertText('', position + 1 + previous.to, position + 1 + piece.from);
    }
  }
  const mapping = tr.mapping.slice(start);
  tr.removeMark(position + 1, mapping.map(position + 1 + field.content.size, -1));
  for (const piece of pieces) {
    const from = mapping.map(position + 1 + piece.from, 1);
    const to = mapping.map(position + 1 + piece.to, -1);
    for (const mark of piece.marks) tr.addMark(from, to, mark);
  }
}

/** Pair the frontier's source coordinates with the converted fragment's marks. */
function classify(frontier: Frontier, content: Fragment, sourceStart: number): FieldPiece[] {
  const pieces: FieldPiece[] = [];
  let offset = 0;
  let index = 0;
  let childStart = 0;
  for (const piece of frontier) {
    while (index < content.childCount && childStart + content.child(index).nodeSize <= offset) {
      childStart += content.child(index).nodeSize;
      index++;
    }
    const tail = piece.nodes.at(-1);
    const lineEnding = tail?.type === 'lineEnding' || tail?.type === 'softLineBreak';
    pieces.push({ from: piece.start - sourceStart, to: piece.end - sourceStart,
      lineEnding, marks: content.maybeChild(index)?.marks ?? [] });
    offset += lineEnding ? 1 : piece.end - piece.start;
  }
  return pieces;
}

/** Insert the reader's line repairs before a field is classified. */
export function normalizeLines(tr: Transaction, position: number, node: Node): void {
  const at = tr.doc.resolve(position + 1);
  const parent = at.depth > 1 ? at.node(-1) : null;
  const options = fieldOptions(node, parent, at.index(-1));
  const repairs = repairPhrasing(fieldSource(node), options.phrasing);
  for (let index = repairs.length - 1; index >= 0; index--) {
    const repair = repairs[index];
    tr.insertText(repair.insert, position + 1 + repair.start, position + 1 + repair.end);
  }
}

/** Whether the caret is still editing the final line whose syntax is pending. */
export function activePending(selection: Selection, position: number, text: string): boolean {
  if (!(selection instanceof TextSelection) || !selection.$head.depth) return false;
  return selection.$head.before() === position && selection.head - position - 1 >= text.lastIndexOf('\n') + 1;
}

/** Whether a selection left the previous caret's line after the changes were mapped. */
export function leftLine(before: ResolvedPos, selection: Selection, mapping: Mapping): boolean {
  if (!(selection instanceof TextSelection) || !selection.$head.depth) return true;
  if (mapping.map(before.before(), 1) !== selection.$head.before()) return true;
  const text = fieldSource(before.parent);
  const start = text.lastIndexOf('\n', before.parentOffset - 1) + 1;
  const newline = text.indexOf('\n', before.parentOffset);
  const end = newline < 0 ? text.length : newline;
  return selection.head < mapping.map(before.start() + start, -1) ||
    selection.head > mapping.map(before.start() + end, 1);
}
