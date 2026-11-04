/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Node } from 'prosemirror-model';
import {
  isLinkDestination, isLinkTitle, type LinkDestinationSpelling,
  type LinkTitleSpelling
} from '../syntax/index.js';
import type { Closing, ListPattern } from './unparsed.js';
import { schema } from '../types/schema.js';
import { fieldSource } from '../parse/field.js';

/** The source text of one inline node. */
export function inlineNode(node: Node): string {
  if (node.isText) return node.text!;
  if (node.type === schema.nodes.lineEnding) return '\n';
  throw new RangeError(`Not inline source: ${node.type.name}`);
}

/** The column after text whose tabs use four-column stops. */
export function after(text: string, column: number): number {
  for (let index = 0; index < text.length; index++) column += text.charAt(index) === '\t' ? 4 - column % 4 : 1;
  return column;
}

/** A quote marker whose following whitespace belongs wholly to the quote. */
export function quoteMarker(gap: string, column: number): string {
  // The quote owns one column after `>`. A whole tab recorded at a one-column tab
  // stop can become shared at its new column; write the quote's column as a space.
  if (gap === '\t' && after('>\t', column) - column > 2) gap = ' ';
  return '>' + gap;
}

/** The blank lines recorded at one edge of a node. */
export function blanks(node: Node, side: 'leadingBlankLines' | 'trailingBlankLines' | 'start' | 'end'): number {
  return node.attrs.spelling?.[side] ?? 0;
}

/** The recorded first-line margin of a block. */
export function indentation(node: Node): string {
  // A field converts with any number of typed spaces before a marker; a file holds at most three
  // before a block, and a fourth would open indented code (private-docs/deviations/zwsp-edge-mark.md).
  return ' '.repeat(Math.min(3, node.attrs.spelling?.spacesBeforeBlock ?? 0));
}

/**
 * A list's punctuation: the one it records, or the default of its kind, changed to the other of its
 * kind where a list of that punctuation is open before it (private-docs/design/influences.md, I3).
 */
export function listPattern(node: Node, previous: ListPattern | null): ListPattern {
  const ordered = node.type === schema.nodes.orderedList;
  const pattern: ListPattern = node.attrs.spelling?.pattern ?? (ordered ? 'decimalDot' : 'dash');
  if (pattern !== previous) return pattern;
  if (ordered) return pattern === 'decimalDot' ? 'decimalRightParenthesis' : 'decimalDot';
  return pattern === 'dash' ? 'plusSign' : 'dash';
}

/**
 * The punctuation of the item at `index` of `list`, given what precedes it: the first item sets
 * the list's apart from a list open before it, and a later item continues the list its previous
 * item left open.
 */
export function itemPattern(list: Node, index: number, preceding: Closing | null): ListPattern {
  return index > 0 && preceding?.openList ? preceding.openList : listPattern(list, preceding?.openList ?? null);
}

/** Write an item's marker from its list's numbering and punctuation. */
export function itemMarker(list: Node, item: Node, index: number, pattern: ListPattern): string {
  if (list.type !== schema.nodes.orderedList) {
    if (pattern === 'asterisk') return '*';
    return pattern === 'plusSign' ? '+' : '-';
  }
  const numbering: 'sequential' | 'constant' | null | undefined = list.attrs.spelling?.numbering;
  const saved: string | undefined = item.attrs.spelling?.marker;
  const number = numbering === null && saved !== undefined
    ? saved.slice(0, -1)
    : String(list.attrs.startNumber + (numbering === 'constant' ? 0 : index));
  return number + (pattern === 'decimalRightParenthesis' ? ')' : '.');
}

/** Whether an item's marker changes with its index: an ordered list numbered in sequence. */
export function numberedByIndex(list: Node, item: Node): boolean {
  const numbering: 'sequential' | 'constant' | null | undefined = list.attrs.spelling?.numbering;
  return list.type === schema.nodes.orderedList && numbering !== 'constant' &&
    !(numbering === null && item.attrs.spelling?.marker !== undefined);
}

/** Whether an empty paragraph at `index` of `parent` reads back from the parent's syntax alone. */
export function expressesEmpty(parent: Node, index: number): boolean {
  switch (parent.type) {
    case schema.nodes.document:
      return parent.childCount === 1 ||
        parent.childCount === 2 && index === 1 && parent.child(0).type.isInGroup('frontMatter');
    case schema.nodes.blockQuote: return parent.childCount === 1;
    case schema.nodes.listItem: return index === 0 && (parent.childCount === 1 || parent.attrs.checked !== null);
    case schema.nodes.footnoteDefinition: return parent.childCount === 2;
    default: return false;
  }
}

/** Punctuation around one editable field. */
interface FieldFrame {
  before: string;
  after: string;
}

/** The effective punctuation adjoining each definition field. */
export function definitionFrames(node: Node): readonly FieldFrame[] {
  if (node.childCount < 2) throw new RangeError('A definition requires a label and a destination');
  const spelling = node.attrs.spelling;
  const destination = node.child(1);
  const destinationText = fieldSource(destination);
  const destinationSpelling: LinkDestinationSpelling | null = destination.attrs.spelling;
  let angle = destinationSpelling?.inAngleBrackets === true;
  if (!isLinkDestination(destinationText, angle)) angle = !angle;
  if (!isLinkDestination(destinationText, angle))
    throw new RangeError('The definition destination has no framing that preserves its source');
  const result: FieldFrame[] = [
    { before: '[', after: ']:' },
    { before: (spelling?.whitespaceAfterLabel ?? ' ') + (angle ? '<' : ''), after: angle ? '>' : '' },
  ];
  const title = node.maybeChild(2);
  if (!title) return result;
  const titleSpelling: LinkTitleSpelling | null = title.attrs.spelling;
  const preferred = titleSpelling?.delimiter ?? '"';
  const delimiters = [preferred, ...(['"', "'", '('] as const).filter(value => value !== preferred)];
  const text = fieldSource(title);
  const delimiter = delimiters.find(value => isLinkTitle(text, value));
  if (!delimiter) throw new RangeError('The definition title has no delimiter that preserves its source');
  result.push({
    before: (spelling?.whitespaceBeforeTitle ?? ' ') + delimiter,
    after: delimiter === '(' ? ')' : delimiter
  });
  return result;
}
