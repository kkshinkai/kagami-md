/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { input } from '../editor/input.js';
import { canRunCommand } from '../state/input.js';
import type { EditorState } from 'prosemirror-state';
import { CellSelection, type Rect } from 'prosemirror-tables';
import { findEditor } from '../editor/dom.js';
import * as command from '../command/command.js';
import { Table, tables } from './table.js';
import { TableDrag } from './tabledrag.js';
import type { TableView } from './tableview.js';

const svgNamespace = 'http://www.w3.org/2000/svg';

interface Target { readonly axis: TableHandles.Axis; readonly index: number }

interface Handle {
  dom: HTMLDivElement;
  axis: TableHandles.Axis;
  index: number;
  selected: boolean;
}

interface TableLayout {
  outer: DOMRect;
  port: DOMRect;
  table: DOMRect;
  rows: DOMRect[];
  columns: DOMRect[];
}

/** The row and column controls, their selection, and their measured layout. */
export class TableHandles {
  readonly controls: HTMLDivElement;
  readonly indicator: HTMLDivElement;
  readonly outline: HTMLDivElement;
  readonly rowHandle: Handle;
  readonly columnHandle: Handle;
  readonly selectedHandle: Handle;
  readonly addRow: HTMLDivElement;
  readonly addColumn: HTMLDivElement;
  readonly handles: Handle[];
  readonly drag: TableDrag;
  document: Document;
  window: Window;
  connected = false;
  row = 0;
  column = 0;
  hover = false;
  menu: TableHandles.Axis | null = null;
  selected: Target | null = null;
  observer: ResizeObserver | null = null;
  frame: number | null = null;

  constructor(readonly owner: TableView) {
    this.document = owner.dom.ownerDocument;
    this.window = this.document.defaultView!;
    this.controls = this.div('kagami-table-drag-controls');
    this.controls.contentEditable = 'false';
    this.indicator = this.div('kagami-table-drag-indicator');
    this.outline = this.div('kagami-table-selection-outline');
    this.indicator.hidden = true;
    this.outline.hidden = true;
    this.indicator.setAttribute('aria-hidden', 'true');
    this.outline.setAttribute('aria-hidden', 'true');
    this.rowHandle = this.createHandle('row', false);
    this.columnHandle = this.createHandle('column', false);
    this.selectedHandle = this.createHandle('row', true);
    this.handles = [this.rowHandle, this.columnHandle, this.selectedHandle];
    this.addRow = this.createAddButton('row');
    this.addColumn = this.createAddButton('column');
    this.controls.append(this.indicator, this.outline);
    for (const handle of this.handles) this.controls.append(handle.dom);
    this.controls.append(this.addRow, this.addColumn);
    this.owner.dom.append(this.controls);
    this.drag = new TableDrag(this);
    this.controls.addEventListener('pointerdown', this.drag.pointerDown, true);
    this.controls.addEventListener('mousedown', this.drag.mouseDown, true);
    this.controls.addEventListener('dragstart', this.drag.consume);
    this.controls.addEventListener('keydown', this.handleKey);
    this.controls.addEventListener('click', this.click);
    this.owner.dom.addEventListener('pointermove', this.hoverMove);
    this.owner.dom.addEventListener('pointerleave', this.hoverLeave);
    this.render();
    this.scheduleLayout();
  }

  div(className: string): HTMLDivElement {
    const element = this.document.createElement('div');
    element.className = className;
    return element;
  }

  createHandle(axis: TableHandles.Axis, selected: boolean): Handle {
    const dom = this.div('kagami-table-handle-mount');
    const axes: TableHandles.Axis[] = selected ? ['row', 'column'] : [axis];
    for (const direction of axes) {
      const button = this.document.createElement('button');
      button.type = 'button';
      button.className = 'kagami-table-drag-handle';
      button.dataset.axis = direction;
      const svg = this.document.createElementNS(svgNamespace, 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('fill', 'currentColor');
      svg.setAttribute('aria-hidden', 'true');
      for (const y of [5, 12, 19]) {
        const circle = this.document.createElementNS(svgNamespace, 'circle');
        circle.setAttribute('cx', '12');
        circle.setAttribute('cy', String(y));
        circle.setAttribute('r', '2');
        svg.append(circle);
      }
      button.append(svg);
      dom.append(button);
    }
    return { dom, axis, selected, index: 0 };
  }

  createAddButton(axis: TableHandles.Axis): HTMLDivElement {
    const mount = this.div('kagami-table-add-mount');
    const button = this.document.createElement('button');
    button.type = 'button';
    button.className = 'kagami-table-add';
    button.dataset.add = axis;
    button.setAttribute('aria-label', `Add ${axis}`);
    const svg = this.document.createElementNS(svgNamespace, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('aria-hidden', 'true');
    const path = this.document.createElementNS(svgNamespace, 'path');
    path.setAttribute('d', 'M12 5v14M5 12h14');
    svg.append(path);
    button.append(svg);
    mount.append(button);
    return mount;
  }

  concerns(): boolean {
    return this.hover || !!this.drag.state || !!this.selected || !!this.menu || !!this.selectionRect() ||
      this.connected !== this.owner.dom.isConnected || this.document !== this.owner.dom.ownerDocument;
  }

  refresh(previous: EditorState, force = false): void {
    if (!force && !this.concerns()) return;
    this.refreshConnection();
    if (previous.doc !== this.owner.view.state.doc || !this.available()) this.drag.cancel();
    const rect = this.selectionRect();
    const map = tables.tableGrid(this.owner.node);
    const row = rect && map && rect.left === 0 && rect.right === map.width && rect.bottom - rect.top === 1;
    const column = rect && map && rect.top === 0 && rect.bottom === map.height && rect.right - rect.left === 1;
    // A 1x1 selection fits both axes. Keep the one the user chose, while
    // always reading its index from the current mapped selection.
    if (column && (!row || this.selected?.axis === 'column')) {
      this.selected = { axis: 'column', index: rect.left };
    } else if (row) {
      this.selected = { axis: 'row', index: rect.top };
    } else {
      this.selected = null;
    }
    if (!this.selected || !this.available()) this.menu = null;
    this.render();
    this.layout();
  }

  refreshConnection(): void {
    const connected = this.owner.dom.isConnected;
    const document = this.owner.dom.ownerDocument;
    if (connected === this.connected && document === this.document) return;
    this.connected = connected;
    this.releaseConnection();
    this.document = document;
    this.window = document.defaultView!;
    this.hover = false;
    this.menu = null;
    if (!connected) return;
    this.window.addEventListener('scroll', this.layout, true);
    this.window.addEventListener('resize', this.layout);
    document.fonts?.addEventListener('loadingdone', this.fontsLoaded);
    const Observer = (this.window as Window & typeof globalThis).ResizeObserver;
    if (Observer) {
      this.observer = new Observer(this.layout);
      this.observer.observe(this.owner.table);
      this.observer.observe(this.owner.scrollDOM);
    }
  }

  releaseConnection(): void {
    this.drag.cancel();
    if (this.frame !== null) this.window.cancelAnimationFrame(this.frame);
    this.frame = null;
    this.observer?.disconnect();
    this.observer = null;
    this.window.removeEventListener('scroll', this.layout, true);
    this.window.removeEventListener('resize', this.layout);
    this.document.fonts?.removeEventListener('loadingdone', this.fontsLoaded);
  }

  available(): boolean {
    return !this.owner.view.isDestroyed && canRunCommand(this.owner.view.state, this.owner.view) &&
      !!tables.tableGrid(this.owner.node);
  }

  private get align(): Table.Align | null {
    const column = this.selected?.axis === 'column' ? this.selected.index : this.column;
    return this.owner.node.attrs.alignments[column] ?? null;
  }

  render(): void {
    const disabled = !this.available();
    this.controls.hidden = disabled;
    this.rowHandle.index = this.row;
    this.columnHandle.index = this.column;
    this.selectedHandle.axis = this.selected?.axis ?? 'row';
    this.selectedHandle.index = this.selected?.index ?? 0;
    for (const handle of this.handles) {
      handle.dom.dataset.axis = handle.axis;
      handle.dom.dataset.index = String(handle.index);
      handle.dom.dataset.selected = String(handle.selected);
      for (const button of handle.dom.querySelectorAll('button')) {
        button.dataset.index = String(handle.index);
        button.disabled = disabled;
        const label = button.dataset.axis === 'row' ? 'Row' : 'Column';
        button.setAttribute('aria-label', `${label} ${handle.index + 1} actions`);
        if (handle.selected && this.menu === button.dataset.axis) button.setAttribute('aria-expanded', 'true');
        else button.removeAttribute('aria-expanded');
      }
    }
    for (const button of this.controls.querySelectorAll<HTMLButtonElement>('.kagami-table-add')) {
      button.disabled = disabled;
    }
  }

  scheduleLayout(): void {
    if (this.frame !== null || this.owner.view.isDestroyed) return;
    this.frame = this.window.requestAnimationFrame(() => {
      this.frame = null;
      this.layout();
    });
  }

  selectionRect(): Rect | null {
    const selection = this.owner.view.state.selection;
    const pos = this.owner.getPos();
    const map = tables.tableGrid(this.owner.node);
    if (!(selection instanceof CellSelection) || pos === undefined || !map ||
        selection.$anchorCell.node(-1) !== this.owner.node || selection.$headCell.node(-1) !== this.owner.node)
      return null;
    return map.rectBetween(selection.$anchorCell.pos - pos - 1, selection.$headCell.pos - pos - 1);
  }

  /**
   * Reveal a whole row through its outline, outside the horizontal scroller.
   * Following selection.head would pull a wide table toward its last cell.
   */
  scrollRowSelectionIntoView(): boolean {
    if (this.selected?.axis !== 'row' || this.outline.hidden) return false;
    this.outline.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    return true;
  }

  layout = (): void => {
    if (this.owner.view.isDestroyed || !this.owner.dom.isConnected) return;
    const geometry: TableLayout = {
      outer: this.owner.dom.getBoundingClientRect(),
      port: this.owner.scrollDOM.getBoundingClientRect(),
      table: this.owner.table.getBoundingClientRect(),
      rows: this.owner.rects('row'),
      columns: this.owner.rects('column'),
    };
    this.drawHandles(geometry);
    if (this.menu && this.selectedHandle.dom.hidden) {
      this.menu = null;
      this.render();
    }
    this.drawSelection(geometry);
    this.drawAddButtons(geometry);
    this.drag.updateTarget();
  };

  drawHandles(geometry: TableLayout): void {
    const { outer, port, table, rows, columns } = geometry;
    for (const handle of this.handles) {
      const row = handle.axis === 'row';
      const rect = (row ? rows : columns)[handle.index];
      const visible = handle.selected ? !!this.selected : this.hover &&
        !(this.selected?.axis === handle.axis && this.selected.index === handle.index);
      handle.dom.hidden = !visible || !rect;
      if (!rect) continue;
      if (row) {
        const center = (rect.top + rect.bottom) / 2;
        handle.dom.hidden ||= table.left < port.left - 1 || center < port.top || center > port.bottom;
        handle.dom.style.left = `${table.left - outer.left - 5}px`;
        handle.dom.style.top = `${center - outer.top - 11}px`;
      } else {
        const center = (rect.left + rect.right) / 2;
        handle.dom.hidden ||= center < port.left || center > port.right;
        handle.dom.style.left = `${center - outer.left - 11}px`;
        handle.dom.style.top = `${table.top - outer.top - 5}px`;
      }
    }
  }

  drawSelection(geometry: TableLayout): void {
    const selection = this.selectionRect();
    this.outline.hidden = !selection;
    if (!selection) return;
    const first = this.owner.contentDOM.rows[selection.top]?.cells[selection.left]?.getBoundingClientRect();
    const last = this.owner.contentDOM.rows[selection.bottom - 1]?.cells[selection.right - 1]?.getBoundingClientRect();
    if (!first || !last) return;
    const { outer, port, table, columns, rows } = geometry;
    // Outline and handle start at the table's outer edge. Collapsed cell
    // borders sit half a pixel inside it; internal edges straddle the grid.
    const left = Math.max(selection.left === 0 ? table.left : first.left - 1, port.left);
    const right = Math.min(selection.right === columns.length ? table.right : last.right + 1, port.right);
    const top = selection.top === 0 ? table.top : first.top - 1;
    const bottom = selection.bottom === rows.length ? table.bottom : last.bottom + 1;
    this.outline.hidden = right <= left;
    Object.assign(this.outline.style, {
      left: `${left - outer.left}px`,
      top: `${top - outer.top}px`,
      width: `${Math.max(0, right - left)}px`,
      height: `${bottom - top}px`,
    });
  }

  drawAddButtons(geometry: TableLayout): void {
    const { outer, port, table, rows, columns } = geometry;
    const hidden = !this.hover || !!this.drag.state || !!this.menu;
    this.addRow.hidden = hidden || this.row !== rows.length - 1;
    this.addColumn.hidden = hidden || this.column !== columns.length - 1 || table.right > port.right + 1;
    // The add affordance spans the edge, four pixels outside it. Moving
    // toward the plus must not change its target to another cell.
    const left = Math.max(table.left, port.left);
    Object.assign(this.addRow.style, {
      left: `${left - outer.left}px`,
      top: `${table.bottom + 4 - outer.top}px`,
      width: `${Math.max(0, Math.min(table.right, port.right) - left)}px`,
      height: '12px',
    });
    Object.assign(this.addColumn.style, {
      left: `${table.right + 4 - outer.left}px`,
      top: `${table.top - outer.top}px`,
      width: '12px',
      height: `${table.height}px`,
    });
  }

  fontsLoaded = (): void => this.scheduleLayout();

  hoverMove = (event: PointerEvent): void => {
    if (event.pointerType === 'mouse' && !event.buttons) this.drag.mouseAllowed = true;
    if (this.drag.state || this.menu || event.buttons || !this.available()) return;
    const cell = (event.target as Element).closest?.('td,th') as HTMLTableCellElement | null;
    if (!cell || cell.closest('table') !== this.owner.table) return;
    this.hover = true;
    this.row = (cell.parentElement as HTMLTableRowElement).rowIndex;
    this.column = cell.cellIndex;
    this.render();
    this.layout();
  };

  hoverLeave = (): void => {
    this.hover = false;
    if (!this.drag.state) this.layout();
  };

  /** Select the axis, allowing the text being left to settle before a handle acts. */
  select(axis: TableHandles.Axis, index: number): boolean {
    const pos = this.owner.getPos();
    const map = tables.tableGrid(this.owner.node);
    if (!this.available() || pos === undefined || !map) return false;
    const count = axis === 'row' ? map.height : map.width;
    if (index < 0 || index >= count) return false;
    const row = axis === 'row' ? index : 0;
    const column = axis === 'column' ? index : 0;
    const $cell = this.owner.view.state.doc.resolve(pos + 1 + map.positionAt(row, column, this.owner.node));
    this.selected = { axis, index };
    const selection = axis === 'row' ? CellSelection.rowSelection($cell) : CellSelection.colSelection($cell);
    this.owner.view.dispatch(this.owner.view.state.tr.setSelection(selection));
    this.render();
    this.layout();
    return true;
  }

  chooseAction(axis: TableHandles.Axis, index: number): void {
    if (!this.select(axis, index)) return;
    const pos = this.owner.getPos();
    if (pos === undefined) return;
    const editor = findEditor(this.owner.view.dom);
    if (!editor) return;
    command.Command.dispatch(editor, Table.chooseAction, {
      pos,
      rect: this.selectedHandle.dom.getBoundingClientRect(),
      axis,
      index,
      align: this.align,
    });
  }

  /** The menu remains open while the host holds the request. */
  request(): command.CommandRequest {
    return {
      pos: () => this.owner.getPos(),
      rect: () => this.selectedHandle.dom.getBoundingClientRect(),
      held: on => {
        if (this.owner.view.isDestroyed) return;
        this.menu = on && this.selected ? this.selected.axis : null;
        this.render();
        this.layout();
      },
    };
  }

  add(axis: TableHandles.Axis): void {
    const map = tables.tableGrid(this.owner.node);
    if (!map) return;
    const count = axis === 'row' ? map.height : map.width;
    if (!this.select(axis, count - 1)) return;
    this.menu = null;
    this.render();
    this.owner.view.focus();
    tables.insertTableAxis(axis, 'after')(this.owner.view.state, this.owner.view.dispatch, this.owner.view);
  }

  handleKeyDown(event: KeyboardEvent): boolean {
    if (this.owner.view.isDestroyed) return false;
    if (input.historyKey(this.owner.view, event)) return true;
    if (event.altKey || !(event.metaKey || event.ctrlKey) || !this.selected) return false;
    switch (event.key.toLowerCase()) {
      case 'v':
        // Give the browser's paste default action back to the editable DOM.
        this.menu = null;
        this.render();
        this.owner.view.focus();
        return false;
      case 'c':
        event.preventDefault();
        this.owner.view.focus();
        this.owner.view.dom.ownerDocument.execCommand('copy');
        return true;
      case 'x':
        event.preventDefault();
        this.owner.view.focus();
        this.owner.view.dom.ownerDocument.execCommand('cut');
        return true;
      default:
        return false;
    }
  }

  handle(event: Event): HTMLButtonElement | null {
    const button = (event.target as Element).closest?.('button[data-axis]') as HTMLButtonElement | null;
    return button && this.controls.contains(button) ? button : null;
  }

  click = (event: MouseEvent): void => {
    const button = (event.target as Element).closest('button');
    if (!button || !this.controls.contains(button) || !this.available()) return;
    const axis = button.dataset.add;
    if (axis === 'row' || axis === 'column') {
      this.add(axis);
    } else if (event.detail === 0) {
      const mount = button.parentElement!;
      this.chooseAction(mount.dataset.axis as TableHandles.Axis, Number(mount.dataset.index));
    }
  };

  handleKey = (event: KeyboardEvent): void => {
    if (this.handleKeyDown(event)) {
      event.stopPropagation();
      return;
    }
    const handle = this.handle(event);
    if (!handle || !this.available() || event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
    const mount = handle.parentElement!;
    const axis = mount.dataset.axis as TableHandles.Axis;
    let delta: number;
    if (event.key === (axis === 'row' ? 'ArrowUp' : 'ArrowLeft')) delta = -1;
    else if (event.key === (axis === 'row' ? 'ArrowDown' : 'ArrowRight')) delta = 1;
    else return;
    event.preventDefault();
    event.stopPropagation();
    const from = Number(mount.dataset.index);
    if (!this.select(axis, from)) return;
    const move = axis === 'row' ? tables.moveTableRow : tables.moveTableColumn;
    move(from, from + delta)(this.owner.view.state, this.owner.view.dispatch, this.owner.view);
    // Focus follows ownership from the hover handle to the selected handle,
    // even when a table edge prevents movement.
    this.selectedHandle.dom.querySelector<HTMLButtonElement>(`button[data-axis='${axis}']`)?.focus();
  };

  destroy(): void {
    this.releaseConnection();
    this.controls.removeEventListener('pointerdown', this.drag.pointerDown, true);
    this.controls.removeEventListener('mousedown', this.drag.mouseDown, true);
    this.controls.removeEventListener('dragstart', this.drag.consume);
    this.controls.removeEventListener('keydown', this.handleKey);
    this.controls.removeEventListener('click', this.click);
    this.owner.dom.removeEventListener('pointermove', this.hoverMove);
    this.owner.dom.removeEventListener('pointerleave', this.hoverLeave);
  }
}

export namespace TableHandles {
  export type Axis = 'row' | 'column';
}
