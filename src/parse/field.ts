/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Node, ResolvedPos } from 'prosemirror-model';
import {
  transduce, type Bindings, type FrontMatterSpelling, type Transduction, type TransduceOptions,
} from '../syntax/index.js';
import { pendingMarks } from '../types/schema.js';

/** Read a field in its grammatical context. */
export function readField(position: ResolvedPos, bindings: Bindings, settle = false): Transduction {
  const parent = position.depth > 1 ? position.node(-1) : null;
  const options = fieldOptions(position.parent, parent, position.index(-1));
  return transduce(fieldSource(position.parent), { ...options, settle }, bindings);
}

/** Source as edited, with a literal line ending for each line-ending node. */
export function fieldSource(node: Node): string {
  return node.textBetween(0, node.content.size, '', '\n');
}

/** Raw front matter as edited: its text between its two fences. */
export function frontMatterSource(node: Node): string {
  const spelling: FrontMatterSpelling | null = node.attrs.spelling;
  const fence = spelling?.fence ?? '---';
  return fence + '\n' + node.textContent + '\n' + fence;
}

/** The field reader and the two contexts where its opening can consume a marker. */
export function fieldOptions(node: Node, parent: Node | null, index: number): TransduceOptions {
  const types = node.type.schema.nodes;
  if (node.type === types.paragraph) return {
    phrasing: 'paragraph',
    firstInListItem: index === 0 && parent?.type === types.listItem && parent.attrs.checked === null,
    firstInBlockQuote: index === 0 && parent?.type === types.blockQuote,
  };
  if (node.type === types.heading) return { phrasing: node.attrs.form === 'atx' ? 'atxHeading' : 'setextHeading' };
  if (node.type === types.tableParagraph) return { phrasing: 'tableCell' };
  if (node.type === types.calloutTitle) return { phrasing: 'calloutTitle' };
  if (node.type === types.linkLabel) return { phrasing: 'linkLabel' };
  if (node.type === types.linkDestination) return { phrasing: 'linkDestination' };
  if (node.type === types.linkTitle) return { phrasing: 'linkTitle' };
  if (node.type === types.footnoteLabel) return { phrasing: 'footnoteLabel' };
  throw new RangeError(`Not a phrasing: ${node.type.name}`);
}

/** Pending marks distinguish authored block syntax from imported lazy lines. */
export function hasPending(node: Node): boolean {
  return node.content.content.some(piece => piece.marks.some(mark => pendingMarks.has(mark.type)));
}

/** An imported lazy line remains a paragraph until its writing unit is repaired. */
export function lazyField(position: ResolvedPos, bindings: Bindings): boolean {
  const node = position.parent;
  if (node.type !== node.type.schema.nodes.paragraph || position.depth < 2 ||
      !fieldSource(node).includes('\n') || hasPending(node)) return false;
  const result = readField(position, bindings);
  return result.kind === 'pending' &&
    (result.pending.type === 'pendingSetextUnderline' || result.pending.type === 'pendingTable');
}
