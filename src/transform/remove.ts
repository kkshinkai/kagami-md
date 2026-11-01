/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Fragment, Slice, type ResolvedPos } from 'prosemirror-model';
import { ReplaceAroundStep, type Transform } from 'prosemirror-transform';
import { combine } from './classes.js';

/** Delete across fields and carry the final field's surviving suffix into the first. */
export function removeAcrossFields(tr: Transform, from: number, to: number): void {
  let left = tr.doc.resolve(from);
  let right = tr.doc.resolve(to);
  // Literal fields hold line endings as text. The conversion has equal width,
  // so the suffix's character positions remain the ones the selection named.
  if (left.parent.type.spec.code || left.parent.type.spec.marks === '') {
    const endings: number[] = [];
    tr.doc.nodesBetween(to, right.end(), (node, position) => {
      if (node.type === tr.doc.type.schema.nodes.lineEnding) endings.push(position);
    });
    for (let index = endings.length - 1; index >= 0; index--) {
      const position = endings[index]!;
      tr.replaceWith(position, position + 1, tr.doc.type.schema.text('\n'));
    }
    tr.removeMark(to, right.end());
    left = tr.doc.resolve(from);
    right = tr.doc.resolve(to);
  }
  const depth = left.sharedDepth(to);
  let end = right.after();
  let open = right.depth - 1;
  while (open > depth && right.indexAfter(open) === right.node(open).childCount) end = right.after(open--);
  const slice = new Slice(leadingFrames(left, right, depth).append(trailingFrames(right, open, depth)),
    left.depth - depth, open - depth);
  tr.step(new ReplaceAroundStep(from, end, to, right.end(), slice, 0));
}

function leadingFrames(left: ResolvedPos, right: ResolvedPos, depth: number): Fragment {
  const node = left.parent;
  const attrs = node.type === right.parent.type
    ? {
      ...node.attrs,
      spelling: combine(node.type, node.attrs.spelling, right.parent.attrs.spelling, ['front', 'ordinary'])
    }
      : node.attrs;
  let content = Fragment.from(node.type.create(attrs));
  for (let level = left.depth - 1; level > depth; level--) content = Fragment.from(left.node(level).copy(content));
  return content;
}

function trailingFrames(right: ResolvedPos, open: number, depth: number): Fragment {
  let content = Fragment.empty;
  for (let level = open; level > depth; level--) {
    const parent = right.node(level);
    const remaining = Fragment.fromArray(parent.content.content.slice(right.indexAfter(level)));
    const required = parent.type.contentMatch.fillBefore(content.append(remaining));
    if (!required) throw new RangeError('The surviving container cannot hold its remaining blocks');
    content = Fragment.from(parent.copy(required.append(content)));
  }
  return content;
}
