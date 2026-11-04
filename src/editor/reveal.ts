/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { DOMNode } from './dom.js';
import type { Node } from 'prosemirror-model';
import {
  Plugin, PluginKey, TextSelection, type EditorState, type StateField,
  type Transaction
} from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import { keepsFormattedSourceRendered } from '../schema/format.js';
import { focusKey } from '../state/input.js';
import { normalizationKey, revealing, type Extent, type Revealing } from '../state/normalization.js';
import { schema } from '../types/schema.js';
import { decorateBlocks } from './decoration.js';

/** A meta character: one that belongs to how something is written, not to what it says. */
export const META = 'md-meta';
/** On the meta characters of a constituent that is revealed. */
export const REVEALED = 'md-revealed';
/** On the source of a constituent that is concealed and has a stand-in in its place. */
export const CONCEALED = 'md-concealed';
/** On what is drawn in the place of a concealed constituent. */
const STAND_IN = 'md-stand-in';
/** On characters shown because a text is pending, and on the closing sequence of a heading. */
const ATX_CLOSING = 'md-atx-closing';
/** On the element that holds a capsule occurrence's opening delimiter. */
export const CAPSULE_START = 'md-capsule-start';

/** Every class this family paints with. Copies of the painted page read this list. */
export const presentationClasses: readonly string[] = [META, REVEALED, CONCEALED, ATX_CLOSING,
  CAPSULE_START];

/** The current source painting and the geometry retained by a pointer gesture. */
export interface SourcePresentation {
  readonly current: DecorationSet;
  readonly decorations: DecorationSet;
  readonly selection: decorateBlocks.Range | null;
  readonly gesture: Gesture | null;
  readonly previous: Gesture | null;
}

const revealKey = new PluginKey<SourcePresentation>('inline-presentation');

/** Reveal source around the text selection, retaining the painted geometry during a gesture. */
export function reveal(): Plugin<SourcePresentation> {
  return new Plugin({
    key: revealKey,
    state: reveal.state(drawSource),
    props: {
      decorations(state) { return revealKey.getState(state)?.decorations ?? null; },
    },
  });
}

export namespace reveal {
  /** One block's painting, sharing the selection reading made for this pass. */
  export type Draw = (
    node: Node,
    position: number,
    state: EditorState,
    editing: TextSelection | null,
    visible: Revealing,
  ) => readonly Decoration[];

  export type Refresh = (
    before: decorateBlocks.Range | null,
    after: decorateBlocks.Range | null,
  ) => readonly decorateBlocks.Range[];

  /** All source presentations share the pointer controller's gesture identity. Rendered
   * content follows document edits while these visibility decorations retain their origin. */
  export function state(draw: Draw, refresh: Refresh = endpoints): StateField<SourcePresentation> {
    return {
      init(_config, state) {
        const selection = sourceEditingSelection(state);
        const visible = revealing(selection);
        const current = decorateBlocks(state.doc, (node, position) => draw(node, position, state, selection, visible));
        return { current, decorations: current, selection, gesture: null, previous: null };
      },
      apply(transaction, value, before, state) {
        const selection = sourceEditingSelection(state);
        const visible = revealing(selection);
        const current = decorateBlocks.update(
          value.current,
          transaction,
          (node, position) => draw(node, position, state, selection, visible),
          refreshRanges(before, state, selection, transaction, refresh),
        );
        let gesture = value.gesture?.map(transaction) ?? null;
        let previous = value.previous?.map(transaction) ?? null;
        const pointer = normalizationKey.getState(state);
        if (!pointer?.isPointerActive && !pointer?.isPointerSelecting) {
          return { current, decorations: current, selection, gesture, previous };
        }
        const mapped = value.decorations.map(transaction.mapping, transaction.doc);
        const mappedSelection = mapRange(value.selection, transaction);
        if (pointer.presentationId && gesture?.id !== pointer.presentationId) {
          const restored = previous?.id === pointer.presentationId ? previous : null;
          previous = gesture;
          gesture = restored ?? new Gesture(pointer.presentationId, mapped, mappedSelection);
        }
        return {
          current,
          gesture,
          previous,
          decorations: gesture ? gesture.origin : mapped,
          selection: gesture ? gesture.selection : mappedSelection,
        };
      },
    };
  }
}

class Gesture {
  constructor(
    readonly id: number,
    readonly origin: DecorationSet,
    readonly selection: decorateBlocks.Range | null,
  ) {}

  map(transaction: Transaction): Gesture {
    return new Gesture(this.id, this.origin.map(transaction.mapping, transaction.doc),
      mapRange(this.selection, transaction));
  }
}

function mapRange(range: decorateBlocks.Range | null, transaction: Transaction): decorateBlocks.Range | null {
  if (!range) return null;
  return { from: transaction.mapping.map(range.from, -1), to: transaction.mapping.map(range.to, 1) };
}

function refreshRanges(
  before: EditorState,
  state: EditorState,
  selection: TextSelection | null,
  transaction: Transaction,
  refresh: reveal.Refresh,
): readonly decorateBlocks.Range[] {
  const old = sourceEditingSelection(before);
  const same = old === selection || old !== null && selection !== null && old.eq(selection);
  if (same && focusKey.getState(before) === focusKey.getState(state)) return [];
  return refresh(mapRange(old, transaction), selection);
}

function endpoints(before: decorateBlocks.Range | null, after: decorateBlocks.Range | null): decorateBlocks.Range[] {
  const result: decorateBlocks.Range[] = [];
  for (const range of [before, after]) {
    if (!range) continue;
    result.push({ from: range.from, to: range.from });
    if (range.to !== range.from) result.push({ from: range.to, to: range.to });
  }
  return result;
}

/** Structural selections and explicit rendered formatting have no source-editing endpoints. */
export function sourceEditingSelection(state: EditorState): TextSelection | null {
  if (keepsFormattedSourceRendered(state) || !(state.selection instanceof TextSelection)) return null;
  return state.selection;
}

function drawSource(
  node: Node,
  position: number,
  state: EditorState,
  editing: TextSelection | null,
  visible: Revealing,
): Decoration[] {
  const end = position + node.nodeSize;
  const ranges: Extent[] = [];
  for (const constituent of visible.constituents) {
    for (const range of constituent.meta) {
      if (range.from >= position && range.to <= end &&
          !ranges.some(other => other.from === range.from && other.to === range.to)) ranges.push(range);
    }
  }
  const decorations = ranges.sort((a, b) => a.from - b.from || a.to - b.to)
    .map(range => Decoration.inline(range.from, range.to, { class: REVEALED }));
  const head = editing?.$head;
  if (!head || focusKey.getState(state)?.focused === false || head.pos < position || head.pos >= end ||
      head.parent.type !== schema.nodes.heading || head.parent.attrs.form !== 'atx') return decorations;
  head.parent.forEach((child, offset) => {
    if (!schema.marks.atxClosingSequence.isInSet(child.marks)) return;
    decorations.push(Decoration.inline(head.start() + offset, head.start() + offset + child.nodeSize,
      { class: ATX_CLOSING }));
  });
  return decorations;
}

/** A stand-in is beside the source and outside all of its mark spans, so composition
 * cannot take the stand-in off the page while the constituent's source is concealed. */
export function standIn(
  position: number,
  draw: (view: EditorView, getPos: () => number | undefined) => HTMLElement,
  options: standIn.Options,
): Decoration {
  return Decoration.widget(position, (view, getPos) => {
    const dom = draw(view, getPos);
    dom.classList.add(STAND_IN);
    return dom;
  }, { ...options, marks: [] });
}

export namespace standIn {
  export interface Options {
    readonly key: string;
    readonly side: number;
    readonly ignoreSelection?: boolean;
    readonly relaxedSide?: boolean;
    readonly stopEvent?: (event: Event) => boolean;
    readonly destroy?: (node: DOMNode) => void;
    readonly [property: string]: unknown;
  }
}
