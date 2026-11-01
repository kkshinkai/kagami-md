/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Node } from 'prosemirror-model';
import { Plugin, TextSelection, type Selection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { compositionState } from '../state/input.js';
import { normalization, normalizationKey, normalizeTextSelection, type NormalizationChange } from '../state/normalization.js';
import { sourceEditingSelection } from './reveal.js';
import { getSelection, type DOMNode } from './dom.js';

/** Retain the source presentation during a native or model-owned selection gesture. */
export function selection(): Plugin {
  const pointer = new PointerSelection();
  return new Plugin({
    ...normalization(sourceEditingSelection),
    props: {
      // PM deliberately defers DOM selection synchronization during a native text drag.
      // Once a structured selection takes over, its decorations alone describe the selected
      // content. Publish that ownership synchronously, independently of the delayed DOM range.
      attributes: (state): Record<string, string> =>
        normalizationKey.getState(state)?.modelOwned ? { 'data-pointer-selection': 'model' } : {},
      handleDOMEvents: {
        keydown: () => pointer.clearClicks(),
        beforeinput: () => pointer.clearClicks(),
        copy: () => pointer.clearClicks(),
        cut: () => pointer.clearClicks(),
        paste: () => pointer.clearClicks(),
        pointerdown: (_view, event) => pointer.down(event),
        mousedown: (_view, event) => pointer.mouseDown(event),
        pointermove: (_view, event) => pointer.move(event),
        mousemove: (_view, event) => pointer.mouseMove(event),
        blur: () => pointer.blur(),
      },
    },
    view: view => pointer.attach(view),
  });
}

/** Retain the source presentation for a model-owned selection gesture. */
export function beginOwnedPointerSelection(view: EditorView, origin: Selection): void {
  const pointer = normalizationKey.getState(view.state);
  view.dispatch(view.state.tr.setMeta(normalizationKey, {
    isPointerActive: true,
    isPointerSelecting: true,
    modelOwned: true,
    presentationId: (pointer?.presentationId ?? 0) + 1,
    gestureSelection: origin instanceof TextSelection ? sourceEditingSelection(view.state) : origin,
  } satisfies NormalizationChange).setMeta('addToHistory', false));
}

export function endOwnedPointerSelection(view: EditorView): void {
  view.dispatch(view.state.tr.setMeta(normalizationKey, {
    isPointerActive: false, isPointerSelecting: false,
  } satisfies NormalizationChange).setMeta('addToHistory', false));
}

/** The releasing gesture owns the interpretation of its final selection. */
export function finishPointerSelection(view: EditorView, normalize: boolean): void {
  const state = view.state;
  const tr = state.tr.setMeta(normalizationKey, {
    isPointerActive: false, isPointerSelecting: false,
  } satisfies NormalizationChange).setMeta('addToHistory', false);
  if (normalize && !view.composing && !compositionState(state)?.isComposing &&
      tr.selection instanceof TextSelection && !tr.selection.empty) {
    const normalized = normalizeTextSelection(tr.selection, normalizationKey.getState(state)?.gestureSelection ?? null);
    if (normalized) tr.setSelection(normalized);
  }
  view.dispatch(tr);
}

interface CompletedClick {
  readonly count: number;
  readonly presentationId: number;
  readonly doc: Node;
  readonly origin: Selection | null;
}

interface NativeDrag {
  readonly source: EventTarget;
  readonly end: () => void;
}

interface PointerSession {
  dragStarted: boolean;
  readonly pointerId: number | null;
  readonly pointerType: string;
  hasMouseDown: boolean;
  nativeMouseSelection: boolean;
  nativeDrag: NativeDrag | null;
  readonly startX: number;
  readonly startY: number;
  clickCount: number;
  presentationId: number;
  readonly startDoc: Node;
  readonly previousClick: CompletedClick | undefined;
}

/** One view owns its pointer sessions, native listeners and delayed touch release. */
class PointerSelection {
  view!: EditorView;
  session: PointerSession | undefined;
  completed: CompletedClick | undefined;
  presentationId = 0;
  pendingRelease: number | undefined;

  window!: Window & typeof globalThis;

  attach(view: EditorView): this {
    this.view = view;
    this.connect();
    return this;
  }

  private connect(): void {
    const win = this.window = this.view.dom.ownerDocument.defaultView!;
    // PM installs its mouseup handler on view.root dynamically during mousedown. Window's
    // bubble phase is outside that root, so it follows PM regardless of registration order.
    // A microtask queued by an earlier Document listener is NOT an after-mouseup boundary:
    // native event dispatch can perform a microtask checkpoint between listener callbacks.
    win.addEventListener('mousedown', this.observeMouseDown);
    win.addEventListener('pointerup', this.releaseEvent);
    win.addEventListener('pointercancel', this.releaseEvent);
    win.addEventListener('mouseup', this.releaseEvent);
    win.addEventListener('dragstart', this.dragStart);
    win.addEventListener('drop', this.dragEnd);
    win.addEventListener('dragend', this.dragEnd);
    win.addEventListener('blur', this.windowBlur);
  }

  update(view: EditorView): void {
    if (this.window === view.dom.ownerDocument.defaultView) return;
    this.disconnect();
    this.connect();
    this.release(false);
  }

  destroy(): void {
    this.disconnect();
  }

  private disconnect(): void {
    this.cancelRelease();
    this.clearNativeDrag();
    this.session = undefined;
    this.completed = undefined;
    const win = this.window;
    win.removeEventListener('mousedown', this.observeMouseDown);
    win.removeEventListener('pointerup', this.releaseEvent);
    win.removeEventListener('pointercancel', this.releaseEvent);
    win.removeEventListener('mouseup', this.releaseEvent);
    win.removeEventListener('dragstart', this.dragStart);
    win.removeEventListener('drop', this.dragEnd);
    win.removeEventListener('dragend', this.dragEnd);
    win.removeEventListener('blur', this.windowBlur);
  }

  clearClicks(): false {
    this.completed = undefined;
    return false;
  }

  begin(event: MouseEvent, pointer: PointerEvent | null): PointerSession {
    this.clearNativeDrag();
    this.presentationId = Math.max(this.presentationId,
      normalizationKey.getState(this.view.state)?.presentationId ?? 0) + 1;
    const session: PointerSession = {
      dragStarted: false,
      pointerId: pointer?.pointerId ?? null,
      pointerType: pointer?.pointerType || 'mouse',
      hasMouseDown: false,
      nativeMouseSelection: false,
      nativeDrag: null,
      startX: event.clientX,
      startY: event.clientY,
      clickCount: 0,
      presentationId: this.presentationId,
      startDoc: this.view.state.doc,
      previousClick: this.completed,
    };
    this.session = session;
    this.change({ isPointerActive: true, presentationId: session.presentationId, modelOwned: false });
    return session;
  }

  down(event: PointerEvent): false {
    if (event.button === 0 && event.isPrimary !== false) this.begin(event, event);
    return false;
  }

  mouseDown(event: MouseEvent): false {
    if (event.button !== 0) return false;
    // Freeze before PM and rendered-source handlers, including a mouse stream
    // whose initial pointerdown was omitted by native drag takeover.
    const session = this.session ?? this.begin(event, null);
    session.clickCount = event.detail;
    const previous = session.previousClick;
    // Native detail, not a local timer/distance heuristic, identifies one click series.
    // Its later press must hit-test the same painted text as its first press. Restore that
    // presentation before PM and the browser's mousedown default select a word/paragraph.
    // Keyboard input, content changes, native DnD and owned controls end this eligibility.
    if (previous && event.detail > 1 && previous.count === event.detail - 1 && previous.doc === this.view.state.doc) {
      session.presentationId = previous.presentationId;
      this.change({ presentationId: previous.presentationId, gestureSelection: previous.origin });
    }
    return false;
  }

  move(event: PointerEvent): false {
    const session = this.session;
    if (session &&
        (session.pointerId === null || event.pointerId === undefined || session.pointerId === event.pointerId)) {
      this.dragSelection(event);
    }
    return false;
  }

  mouseMove(event: MouseEvent): false {
    if (this.session?.pointerId === null) this.dragSelection(event);
    return false;
  }

  dragSelection(event: MouseEvent): void {
    const session = this.session;
    if (!session || session.dragStarted) return;
    const moved = (event.buttons & 1) !== 0 &&
      (Math.abs(event.clientX - session.startX) >= 4 || Math.abs(event.clientY - session.startY) >= 4);
    if (!moved && this.view.state.selection.empty) return;
    session.dragStarted = true;
    this.change({ isPointerSelecting: true });
  }

  blur(): false {
    this.completed = undefined;
    this.release(false);
    return false;
  }

  observeMouseDown = (event: MouseEvent): void => {
    if (!this.session || event.button !== 0) return;
    this.session.hasMouseDown = true;
    // A prevented default belongs to the handler that took over the gesture (for example
    // a table selection or a NodeView). Its model selection must not be replaced from DOM.
    this.session.nativeMouseSelection = !event.defaultPrevented;
  };

  releaseEvent = (event: MouseEvent | PointerEvent): void => {
    const session = this.session;
    if (!session || session.nativeDrag) return;
    // HTML dragstart transfers the pointer to browser DnD. Its pointercancel (and any
    // compatibility release) ends pointer delivery, not the native drag's presentation.
    const pointerId = (event as PointerEvent).pointerId;
    if (pointerId !== undefined && session.pointerId !== null && session.pointerId !== pointerId) return;
    if (event.type === 'pointerup' && (session.pointerType === 'mouse' || session.hasMouseDown)) return;
    if (event.type === 'mouseup' && event.button !== 0) return;
    this.cancelRelease();
    if (event.type === 'pointerup') {
      // Touch/pen default actions may follow pointerup propagation. Cross the event task
      // boundary, then read its actual Selection, rather than guessing that a delay made PM
      // observe it. Compatibility mouseup, blur, or a newer gesture may finish it first.
      this.pendingRelease = this.window.setTimeout(() => {
        this.pendingRelease = undefined;
        this.finish(event, session);
      }, 0);
    } else {
      this.finish(event, session);
    }
  };

  finish(event: MouseEvent, session: PointerSession): void {
    const view = this.view;
    if (view.isDestroyed || this.session !== session) return;
    const cancelled = event.type === 'pointercancel';
    const nativeOwner = event.type === 'mouseup' ? session.nativeMouseSelection : !cancelled;
    // Taking over the native gesture owns its final model endpoints as well as DOM
    // selection placement. Release presentation, but do not reinterpret that command's
    // TextSelection by expanding token boundaries after the handler has finished. The
    // view read the gesture's final selection at its own mouseup, before this one.
    const nativeRelease = !cancelled && nativeOwner && !event.defaultPrevented &&
      !normalizationKey.getState(view.state)?.modelOwned;
    this.release(nativeRelease);
    // Selection activity during a press can still end in a caret: clicking inside an
    // existing range with slight movement collapses it on release. The final native
    // endpoint determines repaint eligibility, independently of that earlier activity.
    if (nativeRelease && event.type === 'mouseup') this.repaintCaret();
  }

  repaintCaret(): void {
    const view = this.view;
    if (!(view.state.selection instanceof TextSelection) || !view.state.selection.empty ||
        !view.hasFocus() || view.composing || compositionState(view.state)?.isComposing) return;
    const native = getSelection(view.root);
    if (!native?.isCollapsed || !native.anchorNode || !isEditableSourcePoint(view, native.anchorNode) ||
        view.posAtDOM(native.anchorNode, native.anchorOffset, 1) !== view.state.selection.head) return;
    // Source expansion changes the caret's geometry. Unlike collapse() to the same
    // endpoint, setBaseAndExtent() updates WebKit's painted caret after this reflow.
    native.setBaseAndExtent(native.anchorNode, native.anchorOffset, native.anchorNode, native.anchorOffset);
  }

  dragStart = (event: DragEvent): void => {
    const session = this.session;
    if (!session || event.defaultPrevented || !event.dataTransfer ||
        !(event.target instanceof this.window.Node) || !this.view.dom.contains(event.target)) return;
    // Window bubble follows PM's dragstart serialization and selection ownership. Keep
    // the same frozen geometry until the browser's drop hit test and PM's edit finish.
    this.clearNativeDrag();
    const end = () => {
      if (this.session === session) this.release(false);
    };
    session.nativeDrag = { source: event.target, end };
    event.target.addEventListener('dragend', end);
    this.cancelRelease();
  };

  dragEnd = (): void => {
    // Drop bubbles here after PM has inserted/moved the slice and chosen its selection.
    // No DOM reread or endpoint normalization may replace that command-owned selection.
    // Also release on dragend without a drop, including a cancelled/out-of-editor drag.
    if (this.session?.nativeDrag) this.release(false);
  };

  windowBlur = (): void => {
    this.blur();
  };

  clearNativeDrag(): void {
    const drag = this.session?.nativeDrag;
    if (!drag) return;
    drag.source.removeEventListener('dragend', drag.end);
    this.session!.nativeDrag = null;
  }

  cancelRelease(): void {
    if (this.pendingRelease !== undefined) this.window.clearTimeout(this.pendingRelease);
    this.pendingRelease = undefined;
  }

  release(normalize: boolean): void {
    const session = this.session;
    this.clearNativeDrag();
    this.session = undefined;
    const view = this.view;
    const pointer = normalizationKey.getState(view.state);
    // Shift-click, native word selection and dragging all produce directed text ranges. Their
    // original painted source, not which mouse action produced the range, determines whether
    // hidden boundaries may expand. A single collapsed click has no range to normalize.
    const selected = view.state.selection;
    const shouldNormalize = normalize && selected instanceof TextSelection && !selected.empty;
    if (!pointer?.isPointerActive && !pointer?.isPointerSelecting && !shouldNormalize) return;
    finishPointerSelection(view, shouldNormalize);
    // A small move can extend a native word selection without ending the browser's click
    // count. dragStarted tracks selection activity, so it cannot veto a later native detail.
    // HTML DnD and model-owned gestures release with normalize=false instead.
    this.completed = normalize && session && session.clickCount > 0 && session.startDoc === view.state.doc
      ? { count: session.clickCount, presentationId: session.presentationId, doc: view.state.doc,
        origin: pointer?.gestureSelection ?? null } : undefined;
  }

  change(change: NormalizationChange): void {
    const previous = normalizationKey.getState(this.view.state);
    const activeChanged = change.isPointerActive !== undefined && change.isPointerActive !== previous?.isPointerActive;
    const selectingChanged = change.isPointerSelecting !== undefined &&
      change.isPointerSelecting !== previous?.isPointerSelecting;
    const presentationChanged = change.presentationId !== undefined &&
      change.presentationId !== previous?.presentationId;
    if (activeChanged || selectingChanged || presentationChanged) {
      this.view.dispatch(this.view.state.tr.setMeta(normalizationKey, change).setMeta('addToHistory', false));
    }
  }
}

/** Whether a DOM point belongs to editable source that agrees with the current document. */
export function isEditableSourcePoint(view: EditorView, node: DOMNode): boolean {
  if (!view.dom.contains(node)) return false;
  for (let element = node.nodeType === 1 ? node as Element : node.parentElement;
    element && element !== view.dom; element = element.parentElement) {
    if (element.getAttribute('contenteditable') === 'false') return false;
  }
  if (node.nodeType !== 3) return true;
  // Unparsed native text changes still belong to PM's DOM observer, not the old model's offsets.
  const from = view.posAtDOM(node, 0, 1);
  const to = view.posAtDOM(node, node.nodeValue!.length, 1);
  return from >= 0 && to >= from && to <= view.state.doc.content.size &&
    to - from === node.nodeValue!.length && view.state.doc.textBetween(from, to) === node.nodeValue;
}
