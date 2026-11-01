/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Node } from 'prosemirror-model';
import { tables } from './table.js';
import type { TableHandles } from './tablehandles.js';
import type { TableView } from './tableview.js';

interface Drag {
  pointer: number | null;
  axis: TableHandles.Axis;
  from: number;
  tablePos: number;
  doc: Node;
  startX: number;
  startY: number;
  x: number;
  y: number;
  active: boolean;
  boundary: number | null;
}

/** One row or column gesture owns pointer capture, its preview, and its drop boundary. */
export class TableDrag {
  state: Drag | null = null;
  mouseAllowed = true;
  private preview: HTMLElement | null = null;

  private readonly owner: TableView;

  constructor(readonly handles: TableHandles) {
    this.owner = handles.owner;
  }

  consume = (event: Event): void => {
    if (!this.handles.handle(event)) return;
    event.preventDefault();
    event.stopPropagation();
  };

  pointerDown = (event: PointerEvent): void => {
    this.mouseAllowed = event.isPrimary !== false && event.pointerType !== 'touch';
    if (event.isPrimary !== false) this.startDrag(event, event.pointerId);
  };

  mouseDown = (event: MouseEvent): void => {
    if (this.state || !this.mouseAllowed) this.consume(event);
    else this.startDrag(event, null);
  };

  startDrag(event: MouseEvent, pointer: number | null): void {
    const handle = this.handles.handle(event);
    if (!handle) {
      if ((event.target as Element).closest('button[data-add]')) event.preventDefault();
      return;
    }
    event.stopPropagation();
    if (event.button !== 0) return;
    event.preventDefault();
    if (!this.handles.available() || this.state) return;
    const mount = handle.parentElement!;
    const axis = mount.dataset.axis as TableHandles.Axis;
    const from = Number(mount.dataset.index);
    if (!this.handles.select(axis, from)) return;
    this.handles.menu = null;
    this.handles.render();
    this.owner.view.focus();
    const tablePos = this.owner.getPos();
    if (tablePos === undefined) return;
    this.state = {
      pointer,
      axis,
      from,
      tablePos,
      doc: this.owner.view.state.doc,
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      active: false,
      boundary: null,
    };
    if (pointer !== null) {
      this.handles.controls.setPointerCapture?.(pointer);
    } else {
      this.handles.window.addEventListener('mousemove', this.mouseMove, true);
      this.handles.window.addEventListener('mouseup', this.mouseUp, true);
    }
    // Removing a captured element can retarget capture loss to Document.
    this.handles.window.addEventListener('lostpointercapture', this.pointerCancel, true);
    this.handles.window.addEventListener('pointermove', this.pointerMove, true);
    this.handles.window.addEventListener('pointerup', this.pointerUp, true);
    this.handles.window.addEventListener('pointercancel', this.pointerCancel, true);
    this.handles.window.addEventListener('blur', this.cancel);
    this.handles.window.addEventListener('keydown', this.escape, true);
  }

  validDrag(): boolean {
    return !!this.state && this.handles.available() && this.owner.getPos() === this.state.tablePos &&
      this.owner.view.state.doc === this.state.doc;
  }

  pointerMove = (event: PointerEvent): void => {
    const drag = this.state;
    if (!drag) return;
    if (drag.pointer === null) {
      if (event.pointerType !== 'mouse' || event.isPrimary === false) return;
      if (!this.validDrag() || !(event.buttons & 1)) {
        this.cancel();
        return;
      }
      // Mouse presses after native DnD can lack pointerdown. Capture the
      // actual pointer when movement supplies its identity.
      drag.pointer = event.pointerId;
      this.handles.controls.setPointerCapture?.(event.pointerId);
      this.handles.window.removeEventListener('mousemove', this.mouseMove, true);
      this.handles.window.removeEventListener('mouseup', this.mouseUp, true);
    }
    if (drag.pointer === event.pointerId) this.moveDrag(event);
  };

  mouseMove = (event: MouseEvent): void => {
    if (this.state?.pointer === null) this.moveDrag(event);
  };

  moveDrag(event: MouseEvent): void {
    const drag = this.state;
    if (!drag) return;
    if (!this.validDrag() || !(event.buttons & 1)) {
      this.cancel();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    drag.x = event.clientX;
    drag.y = event.clientY;
    if (!drag.active && Math.hypot(drag.x - drag.startX, drag.y - drag.startY) >= 5) {
      drag.active = true;
      this.createPreview(drag);
    }
    this.owner.dom.classList.toggle('kagami-table-drag-active', drag.active);
    this.updateTarget();
  }

  /** The strip preview is a clipped clone, never another editable document. */
  createPreview(drag: Drag): void {
    const table = this.owner.table.getBoundingClientRect();
    const rect = this.owner.rects(drag.axis)[drag.from];
    if (!rect) return;
    const row = drag.axis === 'row';
    const preview = this.handles.div('kagami-table-drag-preview');
    preview.setAttribute('aria-hidden', 'true');
    preview.inert = true;
    preview.style.width = `${row ? table.width : rect.width}px`;
    preview.style.height = `${row ? rect.height : table.height}px`;
    const clone = this.owner.table.cloneNode(true) as HTMLTableElement;
    clone.removeAttribute('id');
    for (const element of clone.querySelectorAll('[id]')) element.removeAttribute('id');
    for (const element of clone.querySelectorAll('[contenteditable]')) element.removeAttribute('contenteditable');
    Object.assign(clone.style, {
      width: `${table.width}px`,
      minWidth: '0',
      position: 'absolute',
      margin: '0',
      left: `${row ? 0 : table.left - rect.left}px`,
      top: `${row ? table.top - rect.top : 0}px`,
    });
    preview.append(clone);
    this.handles.controls.append(preview);
    this.preview = preview;
  }

  updateTarget(): void {
    this.handles.indicator.hidden = true;
    const drag = this.state;
    if (!drag?.active) return;
    drag.boundary = null;
    if (!this.validDrag()) {
      this.cancel();
      return;
    }
    const outer = this.owner.dom.getBoundingClientRect();
    const port = this.owner.scrollDOM.getBoundingClientRect();
    const table = this.owner.table.getBoundingClientRect();
    const rects = this.owner.rects(drag.axis);
    const original = rects[drag.from];
    if (!original) return;
    const row = drag.axis === 'row';
    const rawDelta = row ? drag.y - drag.startY : drag.x - drag.startX;
    const start = row ? table.top - original.top : table.left - original.left;
    const end = row ? table.bottom - original.bottom : table.right - original.right;
    const delta = Math.max(start - 12, Math.min(end + 12, rawDelta));
    // The selected handle is beside the clipped ghost, so its rounded edge
    // stays visible. Both move together; the source selection stays in place.
    this.handles.selectedHandle.dom.dataset.dragging = 'true';
    this.handles.selectedHandle.dom.style.transform = row ? `translateY(${delta}px)` : `translateX(${delta}px)`;
    if (this.preview) {
      this.preview.style.left = `${(row ? table.left : original.left + delta) - outer.left}px`;
      this.preview.style.top = `${(row ? original.top + delta : table.top) - outer.top}px`;
    }
    const coordinate = row ? drag.y : drag.x;
    let boundary = rects.findIndex(rect => coordinate
      < (row ? (rect.top + rect.bottom) / 2 : (rect.left + rect.right) / 2));
    if (boundary < 0) boundary = rects.length;
    drag.boundary = boundary;
    if (boundary === drag.from || boundary === drag.from + 1) return;
    let edge: number;
    if (boundary === rects.length) {
      const last = rects[rects.length - 1]!;
      edge = row ? last.bottom : last.right;
    } else {
      const next = rects[boundary]!;
      edge = row ? next.top : next.left;
    }
    if (!row && (edge < port.left || edge > port.right)) {
      drag.boundary = null;
      return;
    }
    if (row) {
      const left = Math.max(port.left, table.left);
      Object.assign(this.handles.indicator.style, {
        left: `${left - outer.left}px`,
        top: `${edge - outer.top - 1}px`,
        width: `${Math.max(0, Math.min(port.right, table.right) - left)}px`,
        height: '2px',
      });
    } else {
      Object.assign(this.handles.indicator.style, {
        left: `${edge - outer.left - 1}px`,
        top: `${table.top - outer.top}px`,
        width: '2px',
        height: `${table.height}px`,
      });
    }
    this.handles.indicator.hidden = false;
  }

  pointerUp = (event: PointerEvent): void => {
    if (this.state?.pointer === event.pointerId) this.finishDrag(event);
  };

  mouseUp = (event: MouseEvent): void => {
    if (this.state?.pointer === null) this.finishDrag(event);
  };

  finishDrag(event: MouseEvent): void {
    const drag = this.state;
    if (!drag || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    drag.x = event.clientX;
    drag.y = event.clientY;
    this.updateTarget();
    const valid = this.validDrag();
    this.cancel();
    if (!valid) return;
    if (!drag.active) {
      this.handles.chooseAction(drag.axis, drag.from);
      return;
    }
    if (drag.boundary === null) return;
    const to = drag.boundary > drag.from ? drag.boundary - 1 : drag.boundary;
    const move = drag.axis === 'row' ? tables.moveTableRow : tables.moveTableColumn;
    if (move(drag.from, to)(this.owner.view.state, this.owner.view.dispatch, this.owner.view)) this.owner.view.focus();
  }

  pointerCancel = (event: PointerEvent): void => {
    if (event.pointerId !== this.state?.pointer) return;
    event.preventDefault();
    event.stopPropagation();
    this.cancel();
  };

  escape = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || !this.state) return;
    event.preventDefault();
    event.stopPropagation();
    this.cancel();
  };

  cancel = (): void => {
    const pointer = this.state?.pointer;
    this.state = null;
    this.preview?.remove();
    this.preview = null;
    this.handles.indicator.hidden = true;
    this.owner.dom.classList.remove('kagami-table-drag-active');
    delete this.handles.selectedHandle.dom.dataset.dragging;
    this.handles.selectedHandle.dom.style.removeProperty('transform');
    this.handles.window.removeEventListener('pointermove', this.pointerMove, true);
    this.handles.window.removeEventListener('pointerup', this.pointerUp, true);
    this.handles.window.removeEventListener('pointercancel', this.pointerCancel, true);
    this.handles.window.removeEventListener('lostpointercapture', this.pointerCancel, true);
    this.handles.window.removeEventListener('mousemove', this.mouseMove, true);
    this.handles.window.removeEventListener('mouseup', this.mouseUp, true);
    this.handles.window.removeEventListener('blur', this.cancel);
    this.handles.window.removeEventListener('keydown', this.escape, true);
    if (pointer != null && this.handles.controls.hasPointerCapture?.(pointer))
      this.handles.controls.releasePointerCapture(pointer);
  };
}
