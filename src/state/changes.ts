/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Transaction } from 'prosemirror-state';
import {
  AddMarkStep, AddNodeMarkStep, AttrStep, Mapping, RemoveMarkStep, RemoveNodeMarkStep, type Step,
} from 'prosemirror-transform';

/** Compose each transaction's mapping in application order. */
export function transactionMapping(transactions: readonly Transaction[]): Mapping {
  const mapping = new Mapping();
  for (const transaction of transactions) mapping.appendMapping(transaction.mapping);
  return mapping;
}

/** A range an edit changed: `from` to `to` in the document before it, `start` to `end` after it. */
export interface Change {
  from: number;
  to: number;
  start: number;
  end: number;
}

/**
 * The ranges an edit changed, found from its steps, in file order, with those that overlap or
 * touch on either side merged. A step's map names the content it replaced. A step that keeps
 * every size (a mark or an attribute step) has an empty map and names its range itself. Any other
 * step that maps nothing changed nothing but the document's own attributes, which the sweep
 * compares itself.
 *
 * @param mapping The edit's mapping, one map for each of `steps`.
 */
export function changedRanges(steps: readonly Step[], mapping: Mapping): Change[] {
  const found: Change[] = [];
  const inverse = mapping.invert();
  steps.forEach((step, index) => {
    const back = inverse.slice(steps.length - index);
    const forward = mapping.slice(index + 1);
    const add = (from: number, to: number, start: number, end: number) => found.push({
      from: back.map(from, -1), to: back.map(to, 1), start: forward.map(start, -1), end: forward.map(end, 1),
    });
    let mapped = false;
    mapping.maps[index]!.forEach((from, to, start, end) => {
      mapped = true;
      add(from, to, start, end);
    });
    if (mapped) return;
    if (step instanceof AddMarkStep || step instanceof RemoveMarkStep) add(step.from, step.to, step.from, step.to);
    else if (step instanceof AttrStep || step instanceof AddNodeMarkStep || step instanceof RemoveNodeMarkStep)
      add(step.pos, step.pos + 1, step.pos, step.pos + 1);
  });
  found.sort((a, b) => a.from - b.from || a.start - b.start);
  const merged: Change[] = [];
  for (const change of found) {
    const last = merged.at(-1);
    if (last && (change.from <= last.to || change.start <= last.end)) {
      last.to = Math.max(last.to, change.to);
      last.start = Math.min(last.start, change.start);
      last.end = Math.max(last.end, change.end);
    } else merged.push({ ...change });
  }
  return merged;
}

export namespace changedRanges {
  /** The ranges a batch of transactions changed, in the document before the first and after the last. */
  export function of(transactions: readonly Transaction[]): Change[] {
    return changedRanges(transactions.flatMap(tr => tr.steps), transactionMapping(transactions));
  }
}
