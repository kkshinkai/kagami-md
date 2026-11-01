/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { DOMNode } from './dom.js';
import type { Node } from 'prosemirror-model';
import { Plugin, Selection, TextSelection, type EditorState } from 'prosemirror-state';
import { closeHistory } from 'prosemirror-history';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import { canRunCommand } from '../state/input.js';
import { insert, remove } from '../transform/transform.js';
import { beginOwnedPointerSelection, endOwnedPointerSelection } from './selection.js';
import {
  BlockSelection, selectedBlocks, commonBlockRange, selectableBlocks,
  type BlockRange, type SelectableBlock,
} from '../state/selection.js';
import {
  autoScroll, overlayPoint, positionOverlay, viewportPoint, localScale, unionRects,
  type Rect
} from './coords.js';
import { observeLayout, type LayoutSubscription } from './layout.js';
import { nodeView, measureBlockBox } from './blockview.js';
import { BlockSelectionPaint } from './drawselection.js';
import { BlockHandle } from './blockhandle.js';
import { BlockGesture } from './blockgesture.js';
import type { DragImage } from './dragimage.js';

/** Install block selection, whitespace brushing, and native block dragging. */
export function blockDrag(preview: DragImage): Plugin {
  return new Plugin({
    props: {
      attributes: (state) => ({ 'data-block-selection': String(state.selection instanceof BlockSelection) }),
      decorations(state) {
        const selection = state.selection;
        if (!(selection instanceof BlockSelection)) return null;
        const decorations: Decoration[] = [];
        for (const block of selectedBlocks(state.doc, selection)) {
          decorations.push(Decoration.node(block.from, block.to, { class: 'md-block-selected' }));
        }
        return DecorationSet.create(state.doc, decorations);
      },
      handleKeyDown(view, event) {
        const { selection, doc } = view.state;
        if (!(selection instanceof BlockSelection) || event.isComposing) return false;
        if (event.key === 'Backspace' || event.key === 'Delete') {
          const tr = view.state.tr;
          remove(tr, selection.from, selection.to);
          view.dispatch(tr.scrollIntoView());
          return true;
        }
        if (
          ['Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) &&
          !event.shiftKey
        ) {
          const backward = ['Escape', 'ArrowLeft', 'ArrowUp'].includes(event.key);
          view.dispatch(
            view.state.tr.setSelection(
              Selection.near(
                doc.resolve(backward ? selection.from : selection.to),
                backward && event.key !== 'Escape' ? -1 : 1,
              ),
            ),
          );
          return true;
        }
        if (event.key === 'Enter') {
          const tr = view.state.tr;
          insert(tr, selection.from, tr.doc.type.schema.nodes.paragraph, {});
          remove(tr, selection.from + 2, selection.to + 2);
          tr.setSelection(Selection.near(tr.doc.resolve(selection.from + 1)));
          view.dispatch(tr.scrollIntoView());
          return true;
        }
        return false;
      },
    },
    view: (view) => new BlockDragView(view, preview),
  });
}

type Point = { x: number; y: number };
type Brush = {
  pointer: number | null;
  anchor: Point;
  mouse: Point;
  origin: Selection;
  doc: Node;
  active: boolean;
  trailingParagraph: boolean;
};

/** The view's block controls, brush gesture, and selection overlays. */
class BlockDragView {
  private document: Document;
  private window: Window;
  private readonly host: HTMLElement;
  private surface: HTMLElement;
  private connected = false;
  private readonly blocks: BlockLayout;
  private readonly handle: BlockHandle;
  private readonly drag: BlockGesture;
  private readonly gutter: HTMLElement;
  private readonly brushBox: HTMLElement;
  private readonly selectionPaint: BlockSelectionPaint;
  private readonly layout: LayoutSubscription;
  private brush: Brush | undefined;
  private mouseBrushAllowed = true;
  private frame = 0;
  private destroyed = false;

  constructor(
    private readonly view: EditorView,
    preview: DragImage,
  ) {
    this.document = view.dom.ownerDocument;
    this.window = this.document.defaultView!;
    this.host = view.dom.parentElement!;
    this.surface = brushSurface(this.host);
    this.gutter = this.host.appendChild(this.document.createElement('div'));
    this.gutter.className = 'md-block-gutter';
    this.gutter.contentEditable = 'false';
    this.gutter.setAttribute('aria-hidden', 'true');
    this.blocks = new BlockLayout(view);
    this.handle = new BlockHandle(this.blocks, (event) => {
      const source = this.handle.source();
      if (source && !this.brush) this.drag.start(event, source);
    });
    this.drag = new BlockGesture(this.blocks, this.handle, preview);
    this.brushBox = this.host.appendChild(this.document.createElement('div'));
    this.brushBox.className = 'md-block-brush';
    this.brushBox.hidden = true;
    this.selectionPaint = new BlockSelectionPaint(view);
    this.selectionPaint.update();
    this.layout = observeLayout(view.dom, this.paintLayout);
    this.host.addEventListener('pointermove', this.hover);
    this.host.addEventListener('pointerleave', this.leave);
    this.refreshConnection();
  }

  private refreshConnection() {
    const connected = this.host.isConnected;
    const surface = brushSurface(this.host);
    const document = this.host.ownerDocument;
    if (this.connected === connected && this.surface === surface && this.document === document) return;
    this.connected = connected;
    this.surface.removeEventListener('pointerdown', this.startPointerBrush, true);
    this.surface.removeEventListener('mousedown', this.startMouseBrush, true);
    this.surface.removeEventListener('click', this.finishClick, true);
    this.document.removeEventListener('scroll', this.paintLayout, true);
    this.window.removeEventListener('resize', this.paintLayout);
    this.surface = surface;
    if (this.brush) this.releaseBrush();
    this.drag.disconnect();
    this.document = document;
    this.window = document.defaultView!;
    this.handle.hide();
    this.layout.refreshAncestors();
    if (!connected) return;
    // Capture establishes gesture ownership before PM/browser default handlers run.
    this.surface.addEventListener('pointerdown', this.startPointerBrush, true);
    this.surface.addEventListener('mousedown', this.startMouseBrush, true);
    this.surface.addEventListener('click', this.finishClick, true);
    this.document.addEventListener('scroll', this.paintLayout, true);
    this.window.addEventListener('resize', this.paintLayout);
  }

  private hover = (event: PointerEvent) => {
    if (event.pointerType === 'mouse' && !event.buttons) this.mouseBrushAllowed = true;
    if (!this.brush && !this.drag.isBusy()) this.handle.hover(event);
  };
  private leave = () => {
    if (!this.brush) this.handle.hide();
  };

  private startPointerBrush = (event: PointerEvent) => {
    this.suppressClick = false;
    this.mouseBrushAllowed = event.isPrimary !== false && event.pointerType !== 'touch';
    if (this.mouseBrushAllowed) this.startBrush(event, event.pointerId);
  };
  private startMouseBrush = (event: MouseEvent) => {
    this.suppressClick = false;
    if (this.brush) event.preventDefault();
    // WebKit can omit pointerdown after native DnD. That mouse gesture owns its own
    // move/release stream; touch compatibility events must not become a brush.
    else if (this.mouseBrushAllowed) this.startBrush(event, null);
  };
  private startBrush(event: MouseEvent, pointer: number | null) {
    if (
      this.brush ||
      this.drag.isBusy() ||
      event.button !== 0 ||
      !this.view.editable ||
      this.view.composing ||
      !canStartBrush(this.view, this.surface, this.gutter, event)
    )
      return;
    const trailingParagraph = this.isBelowDocument(event);
    event.preventDefault();
    this.brush = {
      pointer,
      anchor: overlayPoint(this.host, event.clientX, event.clientY),
      mouse: { x: event.clientX, y: event.clientY },
      origin: this.view.state.selection,
      doc: this.view.state.doc,
      active: false,
      trailingParagraph,
    };
    if (pointer === null) {
      this.window.addEventListener('mousemove', this.moveBrush);
      this.window.addEventListener('mouseup', this.endBrush);
    } else {
      this.window.addEventListener('pointermove', this.moveBrush);
      this.window.addEventListener('pointerup', this.endBrush);
      this.window.addEventListener('pointercancel', this.cancelPointerBrush);
    }
    this.window.addEventListener('blur', this.cancelBrush);
    this.window.addEventListener('keydown', this.cancelKey, true);
    this.document.addEventListener('selectstart', this.preventSelection, true);
  }
  private preventSelection = (event: Event) => {
    if (this.brush) event.preventDefault();
  };
  private suppressClick = false;
  private finishClick = (event: MouseEvent) => {
    if (this.suppressClick && event.detail > 0) {
      event.preventDefault();
      event.stopPropagation();
      this.suppressClick = false;
    }
  };
  private moveBrush = (event: MouseEvent) => {
    const brush = this.brush;
    if (!brush || (brush.pointer !== null && (!('pointerId' in event) || event.pointerId !== brush.pointer)))
      return;
    if (!(event.buttons & 1)) {
      // A native zero-button move can precede pointerup. It completes an active brush;
      // a pending press cannot become a bottom-space click without an explicit release.
      if (brush.active) this.finishBrush(event);
      else this.cancelBrush();
      return;
    }
    event.preventDefault();
    brush.mouse = { x: event.clientX, y: event.clientY };
    const anchor = viewportPoint(this.host, brush.anchor);
    if (!brush.active && Math.hypot(event.clientX - anchor.x, event.clientY - anchor.y) >= 6) {
      brush.active = true;
      this.handle.hide();
      this.view.dom.classList.add('md-block-brushing');
      beginOwnedPointerSelection(this.view, brush.origin);
    }
    if (brush.active) {
      this.updateBrush();
      this.requestFrame();
    }
  };

  /** Measure the brush from its content anchor and select the blocks it reaches. */
  private updateBrush() {
    const brush = this.brush;
    if (!brush?.active) return;
    const { x, y } = viewportPoint(this.host, brush.anchor);
    const rect = {
      left: Math.min(x, brush.mouse.x),
      right: Math.max(x, brush.mouse.x),
      top: Math.min(y, brush.mouse.y),
      bottom: Math.max(y, brush.mouse.y),
    };
    const region = brushRegion(this.view, this.surface, this.gutter);
    const visible = {
      left: Math.max(rect.left, region.left),
      right: Math.min(rect.right, region.right),
      top: Math.max(rect.top, region.top),
      bottom: Math.min(rect.bottom, region.bottom),
    };
    this.brushBox.hidden = visible.left >= visible.right || visible.top >= visible.bottom;
    if (!this.brushBox.hidden) positionOverlay(this.host, this.brushBox, visible);
    const range = BlockLayout.brush(this.view.state.doc, this.blocks.measure(), rect);
    let selection: Selection;
    if (range) {
      const forward = brush.mouse.y >= y;
      selection = BlockSelection.create(
        this.view.state.doc,
        forward ? range.from : range.to,
        forward ? range.to : range.from,
      );
    } else {
      selection = Selection.near(this.view.state.doc.resolve(brush.origin.from));
    }
    if (!selection.eq(this.view.state.selection))
      this.view.dispatch(this.view.state.tr.setSelection(selection));
  }

  private requestFrame() {
    if (!this.frame)
      this.frame = this.window.requestAnimationFrame(() => {
        this.frame = 0;
        if (!this.brush?.active) return;
        if (autoScroll(this.host, this.brush.mouse.y)) {
          this.updateBrush();
          this.requestFrame();
        }
      });
  }
  private endBrush = (event: MouseEvent) => {
    const brush = this.brush;
    if (
      !brush ||
      event.button !== 0 ||
      (brush.pointer !== null && (!('pointerId' in event) || event.pointerId !== brush.pointer))
    )
      return;
    this.finishBrush(event);
  };
  private finishBrush(event: MouseEvent) {
    const brush = this.brush!;
    brush.mouse = { x: event.clientX, y: event.clientY };
    const anchor = viewportPoint(this.host, brush.anchor);
    const trailingParagraph =
      !brush.active &&
      brush.trailingParagraph &&
      this.isBelowDocument(event) &&
      Math.hypot(event.clientX - anchor.x, event.clientY - anchor.y) < 6 &&
      canRunCommand(this.view.state, this.view);
    this.suppressClick = brush.active || trailingParagraph;
    // The associated pointer click or the next press ends suppression, independently of
    // scheduling between a zero-button move and the subsequent release/click.
    if (brush.active) this.updateBrush();
    else if (!trailingParagraph) {
      const hit = this.view.posAtCoords({ left: event.clientX, top: event.clientY });
      this.view.dispatch(
        this.view.state.tr.setSelection(
          Selection.near(this.view.state.doc.resolve(hit?.pos ?? brush.origin.from)),
        ),
      );
    }
    this.releaseBrush();
    if (trailingParagraph) {
      const { state } = this.view;
      const end = state.doc.content.size;
      const last = state.doc.lastChild;
      const append = !last || last.type !== state.schema.nodes.paragraph || last.content.size !== 0;
      const tr = append ? closeHistory(state.tr) : state.tr;
      if (append) insert(tr, end, tr.doc.type.schema.nodes.paragraph, {});
      this.view.dispatch(
        tr.setSelection(TextSelection.create(tr.doc, append ? end + 1 : end - 1)).scrollIntoView(),
      );
    }
    this.view.focus();
  }
  private isBelowDocument(event: MouseEvent): boolean {
    if (
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      !canStartBrush(this.view, this.surface, this.gutter, event)
    )
      return false;
    const { doc } = this.view.state;
    const last = doc.lastChild;
    const dom = last && (this.view.nodeDOM(doc.content.size - last.nodeSize) as Element | null);
    return dom?.nodeType == 1 && event.clientY > dom.getBoundingClientRect().bottom;
  }
  private cancelKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.cancelBrush();
    }
  };
  private cancelBrush = () => {
    const brush = this.brush;
    if (!brush) return;
    this.releaseBrush();
    if (!this.destroyed && this.view.state.doc === brush.doc)
      this.view.dispatch(this.view.state.tr.setSelection(brush.origin));
  };
  private cancelPointerBrush = (event: PointerEvent) => {
    if (event.pointerId === this.brush?.pointer) this.cancelBrush();
  };
  private releaseBrush() {
    this.brush = undefined;
    this.window.cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.brushBox.hidden = true;
    this.view.dom.classList.remove('md-block-brushing');
    this.window.removeEventListener('pointermove', this.moveBrush);
    this.window.removeEventListener('pointerup', this.endBrush);
    this.window.removeEventListener('pointercancel', this.cancelPointerBrush);
    this.window.removeEventListener('mousemove', this.moveBrush);
    this.window.removeEventListener('mouseup', this.endBrush);
    this.window.removeEventListener('blur', this.cancelBrush);
    this.window.removeEventListener('keydown', this.cancelKey, true);
    this.document.removeEventListener('selectstart', this.preventSelection, true);
    if (!this.destroyed) endOwnedPointerSelection(this.view);
  }
  private paintLayout = () => {
    if (this.destroyed) return;
    this.selectionPaint.update();
    this.handle.refresh();
    this.drag.refresh();
    if (this.brush?.active) {
      this.updateBrush();
      this.requestFrame();
    }
  };
  update(view: EditorView, previous: EditorState) {
    this.refreshConnection();
    if (view.state.doc !== previous.doc || !view.editable) {
      this.handle.hide();
      if (this.brush) this.cancelBrush();
    }
    this.drag.update(previous);
    this.handle.update();
    this.selectionPaint.update();
  }
  destroy() {
    this.destroyed = true;
    this.layout.destroy();
    this.selectionPaint.destroy();
    this.releaseBrush();
    this.drag.destroy();
    this.handle.destroy();
    this.brushBox.remove();
    this.gutter.remove();
    this.host.removeEventListener('pointermove', this.hover);
    this.host.removeEventListener('pointerleave', this.leave);
    this.surface.removeEventListener('pointerdown', this.startPointerBrush, true);
    this.surface.removeEventListener('mousedown', this.startMouseBrush, true);
    this.surface.removeEventListener('click', this.finishClick, true);
    this.document.removeEventListener('scroll', this.paintLayout, true);
    this.window.removeEventListener('resize', this.paintLayout);
  }
}

/** The declared document pane, or the editor's own host when no pane is declared. */
function brushSurface(host: HTMLElement): HTMLElement {
  return host.closest<HTMLElement>('[data-editor-surface]') ?? host;
}

function clientBox(element: HTMLElement): Rect {
  const box = element.getBoundingClientRect();
  const scale = localScale(element);
  const style = element.ownerDocument.defaultView!.getComputedStyle(element);
  const left = parseFloat(style.borderLeftWidth);
  const right = parseFloat(style.borderRightWidth);
  const top = parseFloat(style.borderTopWidth);
  const bottom = parseFloat(style.borderBottomWidth);
  // clientWidth/Height round fractional layout dimensions. Use them only for native scrollbar
  // thickness; the clipping edges themselves come from the rendered box and actual borders.
  const scrollbarX = Math.max(0, element.offsetWidth - element.clientWidth - Math.round(left + right));
  const scrollbarY = Math.max(0, element.offsetHeight - element.clientHeight - Math.round(top + bottom));
  return {
    left: box.left + left * scale.x,
    top: box.top + top * scale.y,
    right: box.right - (right + scrollbarX) * scale.x,
    bottom: box.bottom - (bottom + scrollbarY) * scale.y,
  };
}

/** The visible document surface in which a brush can start and be drawn. */
function brushRegion(view: EditorView, surface: HTMLElement, gutter: HTMLElement): Rect {
  const host = view.dom.parentElement!;
  const editor = view.dom.getBoundingClientRect();
  const region = { ...clientBox(surface) };
  if (surface === host) region.left = Math.min(region.left, gutter.getBoundingClientRect().left);
  region.top = Math.max(region.top, editor.top);
  region.bottom = Math.min(region.bottom, editor.bottom);
  for (let node: HTMLElement | null = host; node; node = node.parentElement) {
    const style = node.ownerDocument.defaultView!.getComputedStyle(node);
    const box = clientBox(node);
    if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
      region.left = Math.max(region.left, box.left);
      region.right = Math.min(region.right, box.right);
    }
    if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
      region.top = Math.max(region.top, box.top);
      region.bottom = Math.min(region.bottom, box.bottom);
    }
  }
  const win = view.dom.ownerDocument.defaultView!;
  return {
    left: Math.max(0, region.left),
    top: Math.max(0, region.top),
    right: Math.min(win.innerWidth, region.right),
    bottom: Math.min(win.innerHeight, region.bottom),
  };
}

/** Whether a press falls in document whitespace available for brushing. */
function canStartBrush(
  view: EditorView,
  surface: HTMLElement,
  gutter: HTMLElement,
  event: MouseEvent,
): boolean {
  const target = event.target as Element | null;
  if (
    target?.nodeType != 1 ||
    event.defaultPrevented ||
    (target !== gutter &&
      target.closest(
        'button,input,textarea,select,a,[role="button"],[role="slider"],[role="separator"],[contenteditable="false"]',
      ))
  )
    return false;
  const region = brushRegion(view, surface, gutter);
  if (
    event.clientX < region.left ||
    event.clientX >= region.right ||
    event.clientY < region.top ||
    event.clientY >= region.bottom
  )
    return false;
  if (!view.dom.contains(target)) {
    // An empty ancestor owns the background; sibling content and embedded editors do not.
    return target === gutter || target.contains(view.dom);
  }
  if (event.altKey) return true;
  // Editing ownership comes from PM, independently of block/handle eligibility. YAML scalar
  // fields, for example, are textblocks inside an entry's frame, not child block boxes. Their
  // text and empty editable row must retain the browser's selection gesture. Resolving the
  // event's actual DOM target also leaves container gaps available, unlike nearest-caret hits.
  if (view.state.doc.resolve(view.posAtDOM(target, 0)).parent.isTextblock) return false;
  const frame = target.closest<HTMLElement>('[data-block-box]');
  if (!frame) return true;
  const layout = nodeView(frame);
  if (!layout) return false;
  if (layout.field?.contains(target)) return false;
  // Paragraphs/headings and self-contained fields (table, code, math, definitions) own their
  // complete row/surface. Container chrome is whitespace only outside those child fields.
  return layout.brush === true;
}

export interface RenderedBlock extends SelectableBlock {
  rect: Rect;
  row: Rect;
  /** Available horizontal hit space; this never changes the visible bar's anchor. */
  handleSpace?: HorizontalRange;
}

interface HorizontalRange {
  left: number;
  right: number;
}

export interface HandleLane {
  block: RenderedBlock;
  center: number;
  left: number;
  right: number;
}
/** Measurements for one editor, shared by its brush, handle, and drag gesture. */
export class BlockLayout {
  constructor(readonly view: EditorView) {}

  /** Measure the owning DOM, including its whole visible subtree. Leaf text geometry supplies the
   * handle's first-line alignment; fixed fields and table cells never become independent blocks. */
  measure(): RenderedBlock[] {
    const view = this.view;
    return selectableBlocks(view.state.doc).flatMap((block) => {
      const dom = view.nodeDOM(block.from) as HTMLElement | null;
      if (dom?.nodeType != 1) return [];
      // The owning border box includes marker lanes and descendants, but excludes
      // inter-block margins. Selection, brushing and drop previews use this same boundary.
      const rect = measureBlockBox(view, block);
      if (!rect) return [];
      const scale = localScale(dom).x;
      const style = dom.ownerDocument.defaultView!.getComputedStyle(dom);
      const parentDOM = block.parent ? view.nodeDOM(block.parent.from) : null;
      const body = parentDOM && nodeView(parentDOM)?.markerLane;
      // List markers end 8px before their body column. Leave 2px between that
      // reserved lane and the hit target. Textblocks with no inner padding also
      // need a right boundary, so their first glyph remains directly clickable.
      const handleSpace = {
        left: body ? body.getBoundingClientRect().left - 6 * scale : -Infinity,
        right: block.node.isTextblock
          ? rect.left + (parseFloat(style.paddingLeft) + parseFloat(style.borderLeftWidth) - 2) * scale
          : Infinity,
      };
      return [{ ...block, rect, row: handleAnchor(view, block), handleSpace }];
    });
  }
  /** Handle bars sit 2px outside their block; their hit areas stop at reserved text and marker space. */
  lanes(blocks: readonly RenderedBlock[], scale = 1): HandleLane[] {
    return blocks.map((block) => {
      const center = block.rect.left - 4 * scale;
      return {
        block,
        center,
        left: Math.max(center - 8 * scale, block.handleSpace?.left ?? -Infinity),
        right: Math.min(center + 8 * scale, block.handleSpace?.right ?? Infinity),
      };
    });
  }

  atPoint(lanes: readonly HandleLane[], x: number, y: number): HandleLane | undefined {
    const rows = lanes.filter(({ block }) => y >= block.rect.top && y < block.rect.bottom);
    const hit = rows.find((lane) => x >= lane.left && x < lane.right);
    if (hit) return hit;
    // In the text, prefer the deepest owner. In its left gutter, use the closest allocated lane.
    // This gives overlapping list/item/paragraph rectangles distinct, continuous hit regions.
    return rows.sort(
      (a, b) =>
        Math.abs(Math.min(x - a.center, 0)) - Math.abs(Math.min(x - b.center, 0)) ||
        b.block.depth - a.block.depth,
    )[0];
  }

  /** Two-frontier brush semantics, integrated over actual layout edges instead of an
   * arbitrary pixel sampling step. A frontier may descend while it encounters only descendants;
   * the first sibling locks it. Thus a deeper child cannot bypass an already crossed sibling.
   * This treats a 1px visible block exactly like a tall block and is independent of drag direction.
   * The right edge is intentional: a brush from either side earns the same indentation lane. */
  static brush(
    doc: Node,
    blocks: readonly RenderedBlock[],
    brush: Rect,
  ): BlockRange | null {
    if (brush.bottom <= brush.top || brush.right <= brush.left) return null;
    const edges = [brush.top, brush.bottom];
    for (const { rect } of blocks) {
      if (rect.top > brush.top && rect.top < brush.bottom) edges.push(rect.top);
      if (rect.bottom > brush.top && rect.bottom < brush.bottom) edges.push(rect.bottom);
    }
    const sorted = [...new Set(edges)].sort((a, b) => a - b);
    const hits: RenderedBlock[] = [];
    for (let i = 1; i < sorted.length; i++) {
      const hit = blockAtPoint(blocks, brush.right, (sorted[i - 1]! + sorted[i]!) / 2);
      if (hit && hit !== hits.at(-1)) hits.push(hit);
    }
    if (!hits.length) return null;
    return commonBlockRange(doc, brushFrontier(hits), brushFrontier(hits.toReversed()));
  }
}

/** X selects the deepest entered indentation lane; Y selects within that owner's complete
 * subtree. Requiring a strict crossing makes a child touching the brush edge remain unselected. */
function blockAtPoint(blocks: readonly RenderedBlock[], x: number, y: number): RenderedBlock | undefined {
  let result: RenderedBlock | undefined;
  for (const block of blocks) {
    if (
      x > block.rect.left &&
      y >= block.rect.top &&
      y < block.rect.bottom &&
      (!result || block.depth > result.depth)
    )
      result = block;
  }
  return result;
}

function brushFrontier(sequence: readonly RenderedBlock[]): RenderedBlock {
  let current = sequence[0]!;
  for (const hit of sequence.slice(1)) {
    if (hit.from === current.from) continue;
    if (hit.from <= current.from || hit.to >= current.to) break;
    current = hit;
  }
  return current;
}

/** The first visible row of an editable element, including its inline previews. */
class TextRow {
  private readonly win: Window;
  private readonly fragments: DOMRect[] = [];
  private hasInk = false;

  constructor(readonly element: HTMLElement) {
    this.win = element.ownerDocument.defaultView!;
  }

  read(): Rect {
    this.visit(this.element);
    if (this.fragments.length && this.hasInk) {
      // The first logical fragment identifies the row even for centered/right-aligned text.
      // Include mixed fonts and atomic inline content which overlap that row, but not later rows.
      // A leading blank code line or BR has zero width, yet still owns the first row.
      const first = this.fragments[0]!;
      return unionRects(this.fragments.filter(rect => rect.top < first.bottom && rect.bottom > first.top));
    }
    // Empty fields and default Callout labels still have a first row. Their own CSS line-height
    // and content edge define it; never skip this owner and fall through to its next body block.
    const rect = this.element.getBoundingClientRect();
    const style = this.win.getComputedStyle(this.element);
    const scale = localScale(this.element).y;
    const top = rect.top + (parseFloat(style.borderTopWidth) + parseFloat(style.paddingTop)) * scale;
    const bottom = rect.bottom - (parseFloat(style.borderBottomWidth) + parseFloat(style.paddingBottom)) * scale;
    const line = parseFloat(style.lineHeight);
    return {
      left: rect.left, right: rect.right, top,
      bottom: Number.isFinite(line) ? Math.min(bottom, top + line * scale) : bottom
    };
  }

  private visit(node: DOMNode): void {
    if (node.nodeType === 3) {
      if (!node.textContent) return;
      const range = this.element.ownerDocument.createRange();
      range.selectNodeContents(node);
      const rects = [...range.getClientRects()].filter(rect => rect.height > 0);
      this.fragments.push(...rects);
      this.hasInk ||= rects.some(rect => rect.width > 0);
      return;
    }
    if (node.nodeType !== 1) return;
    const dom = node as HTMLElement;
    const style = this.win.getComputedStyle(dom);
    const bounds = dom.getBoundingClientRect();
    if (style.display === 'none' || style.visibility === 'hidden' || style.fontSize === '0px' ||
        bounds.height === 0 && /(hidden|clip)/.test(style.overflowY)) return;
    if (dom.tagName === 'BR') {
      if (bounds.height) this.fragments.push(bounds);
    } else if (dom !== this.element &&
               (dom.contentEditable === 'false' || dom.tagName === 'IMG' || style.display === 'inline-block')) {
      if (bounds.height && bounds.width) {
        this.fragments.push(bounds);
        this.hasInk = true;
      }
    } else {
      for (const child of node.childNodes) this.visit(child);
    }
  }
}

/** The row or box to which the block's handle is aligned. */
function handleAnchor(view: EditorView, block: SelectableBlock): Rect {
  const dom = view.nodeDOM(block.from) as HTMLElement;
  const layout = nodeView(dom)!;
  const handle = layout.handle;
  if (!handle) return new TextRow(layout.content!).read();
  switch (handle.kind) {
    case 'text': return new TextRow(handle.target).read();
    case 'box': return handle.target.getBoundingClientRect();
    case 'child':
      return block.children.length ? handleAnchor(view, block.children[0]!) : new TextRow(handle.target).read();
  }
}
