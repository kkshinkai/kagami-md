/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Bindings, CalloutSyntax, parseBlocks, type BlockSyntax } from '../syntax/index.js';
import type { Node } from 'prosemirror-model';
import type { Transform } from 'prosemirror-transform';
import { fieldSource } from '../parse/field.js';
import { looseList, setAttributes } from './frames.js';
import { readingShapes } from './reading.js';
import { reshapeBlocks } from './reshape.js';
import type { PositionMapping, Shape } from './transform.js';

/**
 * Replace the textblock at a position by the blocks its text reads as: what Pending settles and
 * what converts at once. Their spelling is the one the text was read with, what the user typed:
 * `~~~` gives a fence of tildes, `* b` beside no list a `*` item, `[^note]:Remember` a
 * definition with no separator. The text that stays text keeps its positions.
 * Returns their authored position map for the caller to place its selection.
 */
export function realizeParagraph(tr: Transform, pos: number, blocks: readonly BlockSyntax[], text: string,
                                 offset: number, keep?: Shape.Range): PositionMapping {
  if (!tr.doc.nodeAt(pos)?.isTextblock) throw new RangeError('Realization requires a textblock');
  if (!blocks.length) return position => position;
  retainHTMLBlankLines(tr, pos, blocks[0]!, text);
  const node = tr.doc.nodeAt(pos)!;
  const authored = new Map<Shape, Node>();
  const reading = readingShapes(blocks, text, tr.doc.type.schema,
    [{ start: offset, end: offset + node.content.size, origin: pos + 1 }], authored);
  for (const [shape, block] of authored) authored.set(shape, settledFrame(block));
  for (const [shape, name] of [[reading.shapes[0], 'leadingBlankLines'],
    [reading.shapes.at(-1), 'trailingBlankLines']] as const) {
    if (!shape) continue;
    const block = authored.get(shape)!;
    const spelling = { ...block.attrs.spelling };
    if (name === 'leadingBlankLines' && node.attrs.spelling?.[name] === undefined) delete spelling[name];
    else spelling[name] = node.attrs.spelling?.[name];
    authored.set(shape, block.type.create({ ...block.attrs, spelling }, block.content));
  }
  const inside = keep && keep.from >= pos + 1 && keep.to <= pos + node.nodeSize - 1;
  const changed = reshapeBlocks(tr, pos, pos + node.nodeSize, reading.shapes, authored, keep);
  refreshEnclosingLists(tr, pos);
  return inside ? position => changed.locate(pos + reading.locate(position - pos - 1 + offset)) : changed.map;
}

/** Newly parsed leading lines in an HTML field belong to its containing boundary. */
function retainHTMLBlankLines(tr: Transform, position: number, block: BlockSyntax, text: string): void {
  const at = tr.doc.resolve(position);
  const field = at.nodeAfter!;
  const types = field.type.schema.nodes;
  if (field.type !== types.htmlBlock && field.type !== types.htmlTagBlock) return;
  const count = text.slice(0, block.start).split('\n').length - 1;
  if (!count) return;
  const first = !at.nodeBefore?.type.isInGroup('block');
  const node = first ? at.parent : field;
  const name = first ? 'start' : 'leadingBlankLines';
  const spelling = { ...node.attrs.spelling, [name]: (node.attrs.spelling?.[name] ?? 0) + count };
  if (first && !at.depth) tr.setDocAttribute('spelling', spelling);
  else setAttributes(tr, first ? at.before() : position, { spelling });
}

/** Move title characters that the callout reader owns into its declaration's separator. */
export function realizeCalloutTitle(tr: Transform, position: number): void {
  const title = tr.doc.nodeAt(position)!;
  const text = fieldSource(title);
  if (!/^[ \t]/.test(text)) return;
  const node = tr.doc.resolve(position + 1).node(-1);
  const gap: string = node.attrs.spelling?.whitespaceAfterDeclaration ?? '';
  const head = `> [!${node.attrs.calloutType.toUpperCase()}]`;
  const parsed = parseBlocks(head + gap + text, { target: 'editor' }, Bindings.none)[0];
  if (!(parsed instanceof CalloutSyntax)) throw new RangeError('A callout title must keep its declaration');
  const whitespace = parsed.spelling.whitespaceAfterDeclaration;
  tr.delete(position + 1, position + 1 + whitespace.length - gap.length);
  setAttributes(tr, position - 1, { spelling: {
    ...parsed.spelling, ...node.attrs.spelling, whitespaceAfterDeclaration: whitespace,
  } });
}

function settledFrame(node: Node): Node {
  const types = node.type.schema.nodes;
  let spelling = node.attrs.spelling;
  // Pending explicitly supplies the space for a newly typed >a. Imported
  // quotes bypass realization and retain their own marker whitespace.
  if (node.type === types.blockQuote && spelling?.whitespaceAfterMarker === '')
    spelling = { ...spelling, whitespaceAfterMarker: ' ' };
  else if (node.type === types.codeBlock && spelling?.fence && spelling.fence.closingFence === null) {
    spelling = { ...spelling, fence: { ...spelling.fence, closingFence: spelling.fence.fence } };
  } else if (node.type === types.mathBlock && spelling?.closingFence === null)
    spelling = { ...spelling, closingFence: spelling.fence };
  return node.type.create({ ...node.attrs, spelling }, node.content);
}

function refreshEnclosingLists(tr: Transform, pos: number): void {
  // A paragraph pair can force an otherwise tight list to be loose. Once it
  // becomes a block that interrupts its predecessor, only recorded blank lines remain.
  const at = tr.doc.resolve(Math.min(pos, tr.doc.content.size));
  for (let depth = at.depth; depth > 0; depth--) {
    const node = at.node(depth);
    if (!node.type.isInGroup('list')) continue;
    const tight = !looseList(node);
    if ((node.attrs.spelling?.tight ?? true) !== tight)
      setAttributes(tr, at.before(depth), { spelling: { ...node.attrs.spelling, tight } });
  }
}
