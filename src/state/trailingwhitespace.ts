/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Node, ResolvedPos } from 'prosemirror-model';
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from 'prosemirror-state';
import { fieldSource } from '../parse/field.js';
import { type correction } from './correction.js';
import { history } from './history.js';
import { focusKey, type FocusState } from './input.js';
import { normalizationKey } from './normalization.js';

/** Texts whose terminal whitespace still belongs to an unfinished edit. */
interface PendingWhitespace {
  readonly positions: readonly number[];
  readonly blurred: boolean;
}

const key = new PluginKey<PendingWhitespace>('trailing-whitespace');

/**
 * Settle a text's terminal whitespace after the text loses the caret or the editor loses focus
 * (private-docs/rules/no-junk.md, "Trailing whitespace settles").
 */
export function trailingWhitespace(): Plugin<PendingWhitespace> {
  return new Plugin({
    key,
    state: { init: () => ({ positions: [], blurred: false }), apply: track },
  });
}

export namespace trailingWhitespace {
  /** Settle edited and departed fields in the correction's transaction. */
  export function correct(tr: Transaction, fields: correction.Fields, state: EditorState): boolean {
    const pointer = normalizationKey.getState(state);
    if (pointer?.isPointerActive || pointer?.isPointerSelecting) return false;
    const pending = key.getState(state)!;
    const active = tr.selection instanceof TextSelection && tr.selection.$head.depth
      ? tr.selection.$head.before() : null;
    const positions = new Set(fields.textblocks(tr));
    for (const position of pending.positions) positions.add(tr.mapping.map(position, 1));
    for (const position of [...positions].sort((a, b) => b - a)) {
      const node = tr.doc.nodeAt(position);
      if (!node || !pending.blurred && position === active) continue;
      const length = terminalWhitespace(node);
      if (!length) continue;
      fields.include(position, tr);
      const end = position + 1 + node.content.size;
      tr.insertText('', end - length, end);
    }
    const settled = !!(pending.positions.length || pending.blurred);
    if (settled) tr.setMeta(key, true);
    return settled;
  }

  /** Whether detaching an unfocused surface still has an active text to settle. */
  export function pending(position: ResolvedPos): boolean {
    return terminalWhitespace(position.parent) > 0;
  }
}

/** Keep only edited or departed texts; untouched file units are never scanned. */
function track(tr: Transaction, pending: PendingWhitespace, before: EditorState,
  state: EditorState): PendingWhitespace {
  if (history.restoring([tr])) return { positions: [], blurred: false };
  const focus = tr.getMeta(focusKey) as Partial<FocusState> | undefined;
  const previous = new Set(pending.positions);
  const head = before.selection.$head;
  if (head.depth && (tr.selectionSet || focus?.blurPending) && trailingWhitespace.pending(head))
    previous.add(head.before());
  const positions = new Set<number>();
  for (const position of previous) {
    const mapped = tr.mapping.mapResult(position, 1);
    if (!mapped.deletedAfter) positions.add(mapped.pos);
  }
  for (const position of positions) {
    const node = state.doc.nodeAt(position);
    if (!node || !terminalWhitespace(node)) positions.delete(position);
  }
  const blurred = !tr.getMeta(key) && !focus?.focused && (!!focus?.blurPending || pending.blurred);
  return { positions: [...positions], blurred };
}

/**
 * The length of what settles at a text's end: spaces and tabs, and in a paragraph line endings too.
 * Markdown text edges settle; literal bodies and delimited definition strings keep their contents.
 */
function terminalWhitespace(node: Node): number {
  const types = node.type.schema.nodes;
  if (node.type !== types.paragraph && node.type !== types.heading &&
      node.type !== types.tableParagraph && node.type !== types.calloutTitle) return 0;
  const lineEndings = node.type === types.paragraph;
  const settles = (code: number) => code === 32 || code === 9 || lineEndings && code === 10;
  const text = fieldSource(node);
  let end = text.length;
  while (end && settles(text.charCodeAt(end - 1))) end--;
  return text.length - end;
}
