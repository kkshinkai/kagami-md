/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { DOMNode } from '../editor/dom.js';
import type { ResolvedPos } from 'prosemirror-model';
import { Plugin, type PluginView } from 'prosemirror-state';
import { CellSelection, cellAround, inSameTable, tableEditing, tableEditingKey } from 'prosemirror-tables';
import type { EditorView } from 'prosemirror-view';

/** Native table input with a mouse session owned by the plugin view. */
export function tableInput(): Plugin {
  const native = tableEditing();
  let input: TableInput;
  return new Plugin({
    key: tableEditingKey,
    state: native.spec.state,
    props: {
      ...native.spec.props,
      handleDOMEvents: { mousedown: (_view, event) => input.start(event) },
    },
    view: view => input = new TableInput(view),
  });
}

/*
 * Mouse selection is adapted from prosemirror-tables 1.8.5, src/input.ts.
 * Copyright (C) 2015-2016 by Marijn Haverbeke <marijnh@gmail.com> and others
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */
class TableInput implements PluginView {
  private startEvent: MouseEvent | null = null;
  private startCell: DOMNode | null = null;
  private root: Document | ShadowRoot | null = null;

  constructor(private readonly view: EditorView) {}

  update(): void {
    if (this.root && (this.root !== this.view.root || !this.view.dom.isConnected)) this.stop();
  }

  destroy(): void {
    this.stop();
  }

  start(event: MouseEvent): false {
    if (event.button !== 0 || event.ctrlKey || event.metaKey) return false;
    this.stop();
    const cell = this.cellAt(event.target);
    const selection = this.view.state.selection;
    const anchor = cellAround(selection.$anchor);
    if (event.shiftKey && selection instanceof CellSelection) {
      this.select(selection.$anchorCell, event);
      event.preventDefault();
    } else if (event.shiftKey && cell && anchor && this.cellUnderMouse(event)?.pos !== anchor.pos) {
      this.select(anchor, event);
      event.preventDefault();
    } else if (!cell) {
      return false;
    }
    this.startEvent = event;
    this.startCell = cell;
    this.root = this.view.root;
    this.root.addEventListener('mousemove', this.move);
    this.root.addEventListener('mouseup', this.stop);
    this.root.addEventListener('dragstart', this.stop);
    return false;
  }

  private move = (event: Event): void => {
    if (!this.startEvent) return;
    const anchor = tableEditingKey.getState(this.view.state);
    let cell: ResolvedPos | null = null;
    if (anchor != null) {
      cell = this.view.state.doc.resolve(anchor);
    } else if (this.cellAt(event.target) !== this.startCell) {
      cell = this.cellUnderMouse(this.startEvent);
      if (!cell) return this.stop();
    }
    if (cell) this.select(cell, event as MouseEvent);
  };

  private select(anchor: ResolvedPos, event: MouseEvent): void {
    const { state } = this.view;
    const starting = tableEditingKey.getState(state) == null;
    let head = this.cellUnderMouse(event);
    if (!head || !inSameTable(anchor, head)) {
      if (!starting) return;
      head = anchor;
    }
    const selection = new CellSelection(anchor, head);
    if (!starting && state.selection.eq(selection)) return;
    const tr = state.tr.setSelection(selection);
    if (starting) tr.setMeta(tableEditingKey, anchor.pos);
    this.view.dispatch(tr);
  }

  private cellAt(target: EventTarget | null): DOMNode | null {
    for (let node = target as DOMNode | null; node && node !== this.view.dom; node = node.parentNode)
      if (node.nodeName === 'TD' || node.nodeName === 'TH') return node;
    return null;
  }

  private cellUnderMouse(event: MouseEvent): ResolvedPos | null {
    const at = this.view.posAtCoords({ left: event.clientX, top: event.clientY });
    if (!at) return null;
    const doc = this.view.state.doc;
    const inside = at.inside >= 0 ? cellAround(doc.resolve(at.inside)) : null;
    return inside || cellAround(doc.resolve(at.pos));
  }

  private stop = (): void => {
    if (this.root) {
      this.root.removeEventListener('mousemove', this.move);
      this.root.removeEventListener('mouseup', this.stop);
      this.root.removeEventListener('dragstart', this.stop);
    }
    this.root = null;
    this.startEvent = null;
    this.startCell = null;
    if (!this.view.isDestroyed && tableEditingKey.getState(this.view.state) != null)
      this.view.dispatch(this.view.state.tr.setMeta(tableEditingKey, -1));
  };
}
