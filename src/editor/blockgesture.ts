/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Node } from 'prosemirror-model';
import type { EditorState, Selection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { blockDropIntents, moveBlocks, type DropIntent } from './blockdrop.js';
import { BlockSelection, type BlockRange } from '../state/selection.js';
import { beginOwnedPointerSelection, endOwnedPointerSelection } from './selection.js';
import { autoScroll, visibleDropRegion } from './coords.js';
import type { BlockLayout } from './blockdrag.js';
import type { BlockHandle } from './blockhandle.js';
import { dropIntentAtPoint, measureDropIntents, DropCursor, type RenderedIntent } from './dropcursor.js';
import { mountDragImage, positionDragImage, type DragImage } from './dragimage.js';

interface Drag {
  mouse: { x: number; y: number };
  intents: DropIntent[];
  source: BlockRange;
  origin: Selection;
  doc: Node;
  active: boolean;
  intent?: RenderedIntent;
}

/** A native block drag, with its source selection, preview, and drop cursor. */
export class BlockGesture {
  private readonly host: HTMLElement;
  private win: Window;
  private doc: Document;
  private readonly cursor: DropCursor;
  private preview?: HTMLElement;
  private completePreview?: () => void;
  private session?: Drag;
  private frame = 0;
  private destroyed = false;
  private imageFrame = 0;
  private nativeDrag = false;
  constructor(
    private readonly layout: BlockLayout,
    private readonly handle: BlockHandle,
    private readonly previewRenderer: DragImage,
  ) {
    const view = layout.view;
    this.host = view.dom.parentElement!;
    this.doc = view.dom.ownerDocument;
    this.win = this.doc.defaultView!;
    this.cursor = new DropCursor(view);
    this.handle.dom.addEventListener('dragstart', this.begin);
  }
  private get view(): EditorView { return this.layout.view; }

  isBusy() {
    return !!this.session;
  }
  refresh() {
    if (this.session?.active) this.paint();
  }
  start = (event: MouseEvent, source: BlockRange) => {
    if (this.session || this.nativeDrag || !this.view.editable || this.view.composing || event.button !== 0)
      return;
    const origin = this.view.state.selection;
    this.session = {
      mouse: { x: event.clientX, y: event.clientY },
      intents: blockDropIntents(this.view.state.doc, source),
      source,
      origin,
      doc: this.view.state.doc,
      active: false,
    };
    this.handle.lock(source);
    beginOwnedPointerSelection(this.view, origin);
    this.win.addEventListener('mouseup', this.releasePress);
    this.win.addEventListener('blur', this.releasePress);
    this.win.addEventListener('dragover', this.over, true);
    this.win.addEventListener('drop', this.end, true);
    this.win.addEventListener('dragend', this.finish);
    this.win.addEventListener('keydown', this.key, true);
    this.doc.addEventListener('scroll', this.scroll, true);
    this.win.addEventListener('resize', this.scroll);
  };
  private releasePress = () => {
    if (this.session && !this.session.active) this.release();
  };
  private begin = (event: DragEvent) => {
    const session = this.session;
    const data = event.dataTransfer;
    if (!session || !data || !this.view.editable || this.view.composing) {
      event.preventDefault();
      return;
    }
    event.stopPropagation();
    session.active = true;
    this.nativeDrag = true;
    const selection = BlockSelection.create(this.view.state.doc, session.source.from, session.source.to);
    const { dom, text } = this.view.serializeForClipboard(selection.content());
    data.clearData();
    data.setData('text/html', dom.innerHTML);
    data.setData('text/plain', text);
    data.effectAllowed = 'copyMove';
    const preview = (this.preview = mountDragImage(this.view, session.source, this.previewRenderer));
    this.win.queueMicrotask(() => {
      if (this.session !== session || this.preview !== preview) return;
      positionDragImage(preview);
      data.setDragImage(preview, 0, 0);
    });
    // Preview generation precedes browser capture; source selection paint follows capture.
    this.completePreview = () => {
      this.removePreview();
      if (this.session !== session) return;
      this.view.dispatch(this.view.state.tr.setSelection(selection));
      if (this.session !== session) return;
      this.view.dom.classList.add('md-block-dragging');
    };
    this.imageFrame = this.win.requestAnimationFrame(() => this.completePreview?.());
    this.paint();
  };
  private over = (event: DragEvent) => {
    if (!this.nativeDrag) return;
    this.completePreview?.();
    const session = this.session;
    if (!session) {
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'none';
      return;
    }
    session.mouse = { x: event.clientX, y: event.clientY };
    this.paint();
    this.tick();
    // Own internal drops before PM's ordinary slice insertion, including invalid targets.
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = session.intent ? 'move' : 'none';
  };
  private removePreview() {
    this.win.cancelAnimationFrame(this.imageFrame);
    this.imageFrame = 0;
    this.completePreview = undefined;
    this.preview?.remove();
    this.preview = undefined;
  }
  private paint() {
    const session = this.session;
    if (!session?.active) return;
    const blocks = this.layout.measure();
    const targets = measureDropIntents(this.view, blocks, session.intents);
    const region = visibleDropRegion(this.view.dom);
    const inside =
      session.mouse.x >= region.left &&
      session.mouse.x <= region.right &&
      session.mouse.y >= region.top &&
      session.mouse.y <= region.bottom;
    session.intent = inside
      ? dropIntentAtPoint(this.view, blocks, targets, session.mouse.x, session.mouse.y)
      : undefined;
    this.cursor.draw(session.intent);
  }

  private tick() {
    if (!this.frame)
      this.frame = this.win.requestAnimationFrame(() => {
        this.frame = 0;
        if (!this.session?.active) return;
        if (autoScroll(this.host, this.session.mouse.y)) {
          this.paint();
          this.tick();
        }
      });
  }
  private scroll = () => {
    if (this.session?.active) {
      this.paint();
      this.tick();
    }
  };
  private end = (event: DragEvent) => {
    if (!this.nativeDrag) return;
    this.completePreview?.();
    const session = this.session;
    event.preventDefault();
    event.stopPropagation();
    this.nativeDrag = false;
    if (!session) {
      this.release();
      return;
    }
    session.mouse = { x: event.clientX, y: event.clientY };
    if (session.active) this.paint();
    if (session.active && !session.intent) {
      this.cancel();
      return;
    }
    // Compute while the presentation and document used by the preview are still owned. Clear
    // the session before dispatch: native reconciliation can synchronously update this View.
    const tr =
      session.active && session.intent
        ? moveBlocks(this.view.state, session.source, session.intent.intent)
        : null;
    this.session = undefined;
    if (tr) this.view.dispatch(tr);
    this.release();
    if (session.active) this.view.focus();
  };
  private finish = () => {
    this.nativeDrag = false;
    if (this.session) this.cancel();
    else this.release();
  };
  private key = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.cancel();
    }
  };
  private cancel = () => {
    const session = this.session;
    if (!session) return;
    this.release();
    if (!this.destroyed && this.view.state.doc === session.doc) {
      this.view.dispatch(this.view.state.tr.setSelection(session.origin));
      this.view.focus();
    }
  };
  private release() {
    const wasDragging = this.session?.active;
    this.session = undefined;
    this.win.cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.removePreview();
    this.cursor.draw();
    this.view.dom.classList.remove('md-block-dragging');
    this.handle.lock();
    if (wasDragging) this.handle.hide();
    this.win.removeEventListener('mouseup', this.releasePress);
    this.win.removeEventListener('blur', this.releasePress);
    if (!this.nativeDrag) {
      this.win.removeEventListener('dragover', this.over, true);
      this.win.removeEventListener('drop', this.end, true);
      this.win.removeEventListener('dragend', this.finish);
    }
    this.win.removeEventListener('keydown', this.key, true);
    this.doc.removeEventListener('scroll', this.scroll, true);
    this.win.removeEventListener('resize', this.scroll);
    if (!this.destroyed) endOwnedPointerSelection(this.view);
  }
  update(previous: EditorState) {
    if (this.doc !== this.view.dom.ownerDocument) {
      this.disconnect();
      this.doc = this.view.dom.ownerDocument;
      this.win = this.doc.defaultView!;
    }
    if (this.session && (previous.doc !== this.view.state.doc || !this.view.editable)) this.cancel();
  }
  disconnect() {
    const owned = this.session || this.nativeDrag;
    this.nativeDrag = false;
    if (owned) this.release();
  }
  destroy() {
    this.destroyed = true;
    this.nativeDrag = false;
    this.release();
    this.handle.dom.removeEventListener('dragstart', this.begin);
    this.cursor.destroy();
  }
}
