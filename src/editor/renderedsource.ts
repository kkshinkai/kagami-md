/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { DOMNode } from './dom.js';
import type { Node } from 'prosemirror-model';
import { NodeSelection, TextSelection, type PluginView } from 'prosemirror-state';
import { tableEditingKey } from 'prosemirror-tables';
import type { EditorView } from 'prosemirror-view';

/** The complete source represented by a noneditable preview, and its click entry point. */
interface RenderedSourceRange {
  readonly from: number;
  readonly to: number;
  readonly entry?: number;
}

interface Registration {
  readonly read: () => RenderedSourceRange | undefined;
  readonly selectionDrag: boolean;
}

interface SourceDOM extends Element { renderedSource?: Registration; }
interface SourceRoot extends HTMLElement { sourceSelection?: SourceSelection; }

/** Passive previews supply endpoints; selectionDrag previews also own their presses. */
export function registerRenderedSource(
  element: Element, read: () => RenderedSourceRange | undefined, selectionDrag = false,
): void {
  (element as SourceDOM).renderedSource = { read, selectionDrag };
}

export function renderedSourceRange(element: Element): RenderedSourceRange | undefined {
  return (element as SourceDOM).renderedSource?.read();
}

function sourceAt(view: EditorView, target: EventTarget | null): Registration | undefined {
  const node = target as DOMNode | null;
  if (!node || !view.dom.contains(node)) return undefined;
  let element = node.nodeType === 1 ? node as Element : node.parentElement;
  for (; element && element !== view.dom; element = element.parentElement) {
    const source = (element as SourceDOM).renderedSource;
    if (source) return source;
  }
  return undefined;
}

interface Press {
  readonly doc: Node;
  readonly range: RenderedSourceRange;
  readonly x: number;
  readonly y: number;
  dragging: boolean;
}

interface SourceInteraction {
  readonly mousedown: (view: EditorView, event: MouseEvent) => boolean;
  readonly view: (view: EditorView) => PluginView;
}

/** Select a preview's source extent using native positions beyond its complete edges. */
export function renderedSourceInteraction(): SourceInteraction {
  return {
    mousedown: (view, event) => (view.dom as SourceRoot).sourceSelection!.start(event),
    view: view => new SourceSelection(view),
  };
}

class SourceSelection implements PluginView {
  private press: Press | null = null;
  private window: Window;

  constructor(private readonly view: EditorView) {
    (view.dom as SourceRoot).sourceSelection = this;
    this.window = view.dom.ownerDocument.defaultView!;
    view.dom.addEventListener('blur', this.cancel);
    this.connect();
  }

  private connect(): void {
    // Native tables observe movement at view.root first and may take the gesture.
    this.window.addEventListener('mousemove', this.move);
    // Complete the owned selection before the shared pointer release handler runs.
    this.window.addEventListener('mouseup', this.up, true);
    this.window.addEventListener('selectstart', this.suppress, true);
    this.window.addEventListener('dragstart', this.suppress, true);
    this.window.addEventListener('pointercancel', this.cancel, true);
    this.window.addEventListener('blur', this.cancel);
  }

  private disconnect(): void {
    this.cancel();
    this.window.removeEventListener('mousemove', this.move);
    this.window.removeEventListener('mouseup', this.up, true);
    this.window.removeEventListener('selectstart', this.suppress, true);
    this.window.removeEventListener('dragstart', this.suppress, true);
    this.window.removeEventListener('pointercancel', this.cancel, true);
    this.window.removeEventListener('blur', this.cancel);
  }

  update(): void {
    const window = this.view.dom.ownerDocument.defaultView!;
    if (window !== this.window) {
      this.disconnect();
      this.window = window;
      this.connect();
    }
    if (this.press && (this.press.doc !== this.view.state.doc || !this.view.dom.isConnected)) this.cancel();
  }

  destroy(): void {
    this.disconnect();
    this.view.dom.removeEventListener('blur', this.cancel);
    delete (this.view.dom as SourceRoot).sourceSelection;
  }

  start(event: MouseEvent): boolean {
    this.cancel();
    const view = this.view;
    if (!view.editable || event.button !== 0 || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey)
      return false;
    const registration = sourceAt(view, event.target);
    const range = registration?.read();
    if (!registration?.selectionDrag || !range || range.entry === undefined ||
        range.from < 0 || range.to > view.state.doc.content.size || range.from >= range.to) return false;
    event.preventDefault();
    this.press = { doc: view.state.doc, range, x: event.clientX, y: event.clientY, dragging: false };
    return true;
  }

  private select(anchor: number, head: number): void {
    const view = this.view;
    const from = Math.min(anchor, head);
    const to = Math.max(anchor, head);
    const node = from < to ? view.state.doc.nodeAt(from) : null;
    // A whole block needs its structural edges so copying its formula retains its fences.
    const selection = node?.isBlock && from + node.nodeSize === to && NodeSelection.isSelectable(node)
      ? NodeSelection.create(view.state.doc, from)
      : TextSelection.between(view.state.doc.resolve(anchor), view.state.doc.resolve(head));
    if (!selection.eq(view.state.selection))
      view.dispatch(view.state.tr.setSelection(selection).setMeta('addToHistory', false).setMeta('pointer', true));
    view.focus();
  }

  private extend(event: MouseEvent): void {
    const press = this.press;
    const view = this.view;
    if (!press || view.state.doc !== press.doc || tableEditingKey.getState(view.state) != null) {
      this.cancel();
      return;
    }
    if (!press.dragging && Math.max(Math.abs(event.clientX - press.x), Math.abs(event.clientY - press.y)) <= 4) return;
    press.dragging = true;
    const { from, to } = press.range;
    const target = sourceAt(view, event.target)?.read();
    let hit: number | undefined;
    if (!target) hit = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
    else if (target.to <= from) hit = target.from;
    else if (target.from >= to) hit = target.to;
    else hit = event.clientX < press.x ? from : to;
    if (hit === undefined) return;
    // Reversing direction switches the fixed edge, keeping both source delimiters.
    if (hit <= from) this.select(to, hit);
    else this.select(from, Math.max(to, hit));
  }

  private move = (event: MouseEvent): void => {
    if (!this.press) return;
    if ((event.buttons & 1) === 0) {
      this.cancel();
      return;
    }
    event.preventDefault();
    this.extend(event);
  };

  private up = (event: MouseEvent): void => {
    if (!this.press || event.button !== 0) return;
    event.preventDefault();
    this.extend(event);
    const finished = this.press;
    this.cancel();
    if (finished && !finished.dragging && finished.range.entry !== undefined)
      this.select(finished.range.entry, finished.range.entry);
  };

  private suppress = (event: Event): void => {
    if (this.press) event.preventDefault();
  };

  private cancel = (): void => {
    this.press = null;
  };
}
