/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Node } from 'prosemirror-model';
import { AllSelection, NodeSelection, Plugin, TextSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { compositionState } from '../state/input.js';
import { localScale, overlayPoint, positionOverlay, type Rect } from './coords.js';
import { observeLayout, type LayoutSubscription } from './layout.js';
import { nodeView, measureBlockBox } from './blockview.js';
import { renderedSourceRange } from './renderedsource.js';
import { isEditableSourcePoint } from './selection.js';
import { BlockSelection, selectedBlocks } from '../state/selection.js';
import { getSelection, type DOMNode } from './dom.js';

/** TextSelection and AllSelection overlays, measured from the visible document. */
class TextSelectionPaint {
  private document: Document | null = null;
  private win: Window | null = null;
  private readonly host: HTMLElement;
  private readonly layer: HTMLElement;
  private layout: LayoutSubscription | undefined;
  private painted = false;
  private readonly masks: readonly [HTMLElement, HTMLElement, HTMLElement];
  private readonly styles: [string, string, string] = ['', '', ''];
  constructor(private readonly view: EditorView) {
    const document = view.dom.ownerDocument;
    this.host = view.dom.parentElement!;
    this.layer = this.host.appendChild(document.createElement('div'));
    this.layer.className = 'md-text-selection-layer';
    this.layer.setAttribute('aria-hidden', 'true');
    const mask = () => {
      const element = document.createElement('div');
      element.className = 'md-text-selection-rect';
      return element;
    };
    this.masks = [mask(), mask(), mask()];
    view.dom.addEventListener('focus', this.update, true);
    view.dom.addEventListener('blur', this.update, true);
    this.update();
  }
  update = () => {
    this.connect();
    if (!this.range()) {
      this.deactivate();
      return;
    }
    if (!this.layout) this.layout = observeLayout(this.view.dom, this.measure);
    this.layout.refreshAncestors();
    this.schedule();
  };
  private range(): { from: number; to: number } | null {
    const { selection } = this.view.state;
    if (
      !this.view.dom.isConnected ||
      !(selection instanceof TextSelection || selection instanceof AllSelection) ||
      compositionState(this.view.state)?.isComposing ||
      this.view.composing ||
      this.view.dom.classList.contains('ProseMirror-hideselection')
    )
      return null;
    const root = this.view.root;
    if (
      root.activeElement !== this.view.dom &&
      root.activeElement &&
      this.view.dom.contains(root.activeElement)
    )
      return null;
    // AllSelection owns document edges even before the browser updates its DOM selection.
    if (selection instanceof AllSelection || this.view.dom.dataset.pointerSelection === 'model') {
      return selection.empty ? null : selection;
    }
    const native = getSelection(root);
    if (
      this.view.hasFocus() &&
      native?.anchorNode &&
      native.focusNode &&
      isEditableSourcePoint(this.view, native.anchorNode) &&
      isEditableSourcePoint(this.view, native.focusNode)
    ) {
      if (native.isCollapsed) return null;
      const anchor = this.view.posAtDOM(native.anchorNode, native.anchorOffset);
      const head = this.view.posAtDOM(native.focusNode, native.focusOffset);
      return anchor === head ? null : { from: Math.min(anchor, head), to: Math.max(anchor, head) };
    }
    return selection.empty ? null : { from: selection.from, to: selection.to };
  }
  private schedule = () => this.layout?.schedule();
  private measure = () => {
    const range = this.range();
    if (!range) {
      this.deactivate();
      return;
    }
    this.draw(new SelectionMeasure(this.view, range.from, range.to).read());
  };
  private draw(bands: SelectionBands) {
    if (!bands.some((rect) => rect.right > rect.left && rect.bottom > rect.top)) {
      this.clear();
      return;
    }
    const origin = overlayPoint(this.host, 0, 0);
    const scale = localScale(this.host);
    const rects = bands.map((rect) => ({
      left: origin.x + rect.left / scale.x,
      top: origin.y + rect.top / scale.y,
      right: origin.x + rect.right / scale.x,
      bottom: origin.y + rect.bottom / scale.y,
    }));
    this.masks.forEach((mask, index) => {
      const rect = rects[index];
      if (!rect || rect.right === rect.left || rect.bottom === rect.top) {
        mask.remove();
        return;
      }
      if (mask.parentElement !== this.layer) this.layer.appendChild(mask);
      // Every vertex is in the same containing block. Clipping shares edge coordinates at
      // paint time, without independently quantized box sizes or redistributed grid tracks.
      const css = `clip-path:polygon(${rect.left}px ${rect.top}px,${
        rect.right}px ${rect.top}px,${rect.right}px ${rect.bottom}px,${rect.left}px ${rect.bottom}px);`;
      if (this.styles[index] !== css) {
        mask.style.cssText = css;
        this.styles[index] = css;
      }
    });
    if (!this.painted) {
      this.view.dom.classList.add('md-drawn-text-selection');
      this.painted = true;
    }
  }
  private clear() {
    if (!this.painted) return;
    for (const mask of this.masks) mask.remove();
    this.view.dom.classList.remove('md-drawn-text-selection');
    this.painted = false;
  }
  private deactivate() {
    this.layout?.destroy();
    this.layout = undefined;
    this.clear();
  }
  private connect() {
    const document = this.view.dom.ownerDocument;
    if (document === this.document) return;
    this.disconnect();
    this.document = document;
    this.win = document.defaultView!;
    document.addEventListener('selectionchange', this.update);
    document.addEventListener('scroll', this.schedule, true);
    this.win.addEventListener('resize', this.schedule);
  }

  private disconnect() {
    this.document?.removeEventListener('selectionchange', this.update);
    this.document?.removeEventListener('scroll', this.schedule, true);
    this.win?.removeEventListener('resize', this.schedule);
    this.document = null;
    this.win = null;
  }

  destroy() {
    this.deactivate();
    this.disconnect();
    this.view.dom.removeEventListener('focus', this.update, true);
    this.view.dom.removeEventListener('blur', this.update, true);
    this.layer.remove();
  }
}

type SelectionBands =
  | readonly []
  | readonly [line: Rect]
  | readonly [startLine: Rect, endLine: Rect]
  | readonly [startLine: Rect, middle: Rect, endLine: Rect];

const selectionOutset = 2;

interface Row {
  top: number;
  bottom: number;
  commonTop: number;
  commonBottom: number;
  left: number;
  right: number;
}

/** The text, line-break, and preview rectangles inside a DOM range. */
class SelectionFragments {
  private readonly leaf: Range;
  private readonly rects: Rect[] = [];

  constructor(readonly range: Range) {
    this.leaf = range.startContainer.ownerDocument!.createRange();
  }

  read(): Rect[] {
    this.visit(this.range.commonAncestorContainer);
    return this.rects;
  }

  private visit(node: DOMNode): void {
    if (!this.range.intersectsNode(node)) return;
    if (node.nodeType === 3) {
      this.leaf.setStart(node, node === this.range.startContainer ? this.range.startOffset : 0);
      this.leaf.setEnd(node, node === this.range.endContainer ? this.range.endOffset : node.textContent!.length);
      if (!this.leaf.collapsed) this.rects.push(...[...this.leaf.getClientRects()].filter(rect => rect.height > 0));
    } else if (node.nodeType === 1) {
      const element = node as HTMLElement;
      if (element.matches('br, img, [contenteditable="false"]')) {
        this.rects.push(...[...element.getClientRects()].filter(rect => rect.height > 0));
      } else {
        for (const child of element.childNodes) this.visit(child);
      }
    }
  }
}

function rowsFor(fragments: readonly Rect[]): Row[] {
  const rows: Row[] = [];
  for (const rect of fragments) {
    const previous = rows.at(-1);
    // Keep the shared vertical interval separately so a tall fragment cannot join neighboring lines.
    if (previous && Math.min(previous.commonBottom, rect.bottom) > Math.max(previous.commonTop, rect.top)) {
      previous.top = Math.min(previous.top, rect.top);
      previous.bottom = Math.max(previous.bottom, rect.bottom);
      previous.commonTop = Math.max(previous.commonTop, rect.top);
      previous.commonBottom = Math.min(previous.commonBottom, rect.bottom);
      previous.left = Math.min(previous.left, rect.left);
      previous.right = Math.max(previous.right, rect.right);
    } else {
      rows.push({
        top: rect.top,
        bottom: rect.bottom,
        commonTop: rect.top,
        commonBottom: rect.bottom,
        left: rect.left,
        right: rect.right,
      });
    }
  }
  return rows;
}

function visualOrder(a: Rect, b: Rect): number {
  return a.top - b.top || a.left - b.left;
}

/** Give selected rows the height of the complete visual line. */
function completeRowHeights(selected: Row[], layout: readonly Row[]): void {
  let index = 0;
  for (const row of selected) {
    while (index < layout.length && layout[index]!.commonBottom <= row.commonTop) index++;
    const line = layout[index];
    if (line && line.commonTop < row.commonBottom) {
      row.top = line.top;
      row.bottom = line.bottom;
    }
  }
}

function clipRect(element: HTMLElement, viewport: Rect): Rect {
  const clip = { ...viewport };
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const style = node.ownerDocument.defaultView!.getComputedStyle(node);
    const clipX = /auto|scroll|hidden|clip/.test(style.overflowX);
    const clipY = /auto|scroll|hidden|clip/.test(style.overflowY);
    if (!clipX && !clipY) continue;
    const bounds = node.getBoundingClientRect();
    const scale = localScale(node);
    if (clipX) {
      clip.left = Math.max(clip.left, bounds.left + node.clientLeft * scale.x);
      clip.right = Math.min(clip.right, bounds.left + (node.clientLeft + node.clientWidth) * scale.x);
    }
    if (clipY) {
      clip.top = Math.max(clip.top, bounds.top + node.clientTop * scale.y);
      clip.bottom = Math.min(clip.bottom, bounds.top + (node.clientTop + node.clientHeight) * scale.y);
    }
  }
  return clip;
}

function positionsAtHeight(view: EditorView, bounds: Rect, clip: Rect, y: number): number[] {
  return [Math.max(bounds.left, clip.left) + 1, Math.min(bounds.right, clip.right) - 1].flatMap((left) => {
    const hit = view.posAtCoords({ left, top: y });
    return hit ? [hit.pos] : [];
  });
}

/** The first, middle, and last bands of a visible text selection. */
class SelectionMeasure {
  private readonly viewport: Rect;
  private left = 0;
  private right = 0;
  private readonly measuredRows: Rect[] = [];
  private openStart = false;
  private openEnd = false;
  private fieldCount = 0;

  constructor(
    private readonly view: EditorView,
    private readonly from: number,
    private readonly to: number,
  ) {
    const win = view.dom.ownerDocument.defaultView!;
    this.viewport = { left: 0, right: win.innerWidth, top: 0, bottom: win.innerHeight };
  }

  read(): SelectionBands {
    if (this.from === this.to) return [];
    const document = this.view.dom.ownerDocument;
    const win = document.defaultView!;
    const content = this.view.dom.getBoundingClientRect();
    const visible = clipRect(this.view.dom, this.viewport);
    if (
      visible.bottom <= visible.top ||
      visible.right <= visible.left ||
      content.bottom <= visible.top ||
      content.top >= visible.bottom
    )
      return [];
    let scanFrom = this.from;
    let scanTo = this.to;
    if (content.top < visible.top) {
      const hits = positionsAtHeight(this.view, content, visible, visible.top + 1);
      if (hits.length) {
        const position = this.view.state.doc.resolve(Math.min(...hits));
        scanFrom = Math.max(scanFrom, position.depth ? position.before(1) : position.pos);
      }
    }
    if (content.bottom > visible.bottom) {
      const hits = positionsAtHeight(this.view, content, visible, visible.bottom - 1);
      if (hits.length) {
        const position = this.view.state.doc.resolve(Math.max(...hits));
        scanTo = Math.min(scanTo, position.depth ? position.after(1) : position.pos);
      }
    }
    if (scanFrom > scanTo) return [];
    const column = sharedTextColumn(this.view, this.from, this.to);
    const columnClip = clipRect(column.element, this.viewport);
    this.left = Math.max(columnClip.left, column.left - selectionOutset * column.scale);
    this.right = Math.min(columnClip.right, column.right + selectionOutset * column.scale);
    if (this.right <= this.left) return [];
    this.view.state.doc.nodesBetween(scanFrom, scanTo, this.measureNode);
    this.measuredRows.sort(visualOrder);
    return this.bands(rowsFor(this.measuredRows), win.getComputedStyle(column.element).direction === 'rtl');
  }

  /** First/middle/last bands, with one horizontal extent per visual row.
   * Shared edges are values, not independently computed positions and dimensions.
   * Midpoints use the immediate neighboring rows so extending one end leaves the other fixed. */
  private bands(rows: Row[], rtl: boolean): SelectionBands {
    const { left, right, openStart, openEnd } = this;
    const first = rows[0];
    const last = rows.at(-1);
    if (!first || !last) return [];
    const startLine = { left: first.left, right: first.right, top: first.top, bottom: first.bottom };
    const endLine = { left: last.left, right: last.right, top: last.top, bottom: last.bottom };
    if (openStart) {
      if (rtl) startLine.right = right;
      else startLine.left = left;
    }
    if (first === last) {
      if (openEnd) {
        if (rtl) startLine.left = left;
        else startLine.right = right;
      }
      return [startLine];
    }
    if (openEnd) {
      if (rtl) endLine.left = left;
      else endLine.right = right;
    }
    if (rtl) {
      startLine.left = left;
      endLine.right = right;
    } else {
      startLine.right = right;
      endLine.left = left;
    }
    startLine.bottom = (first.bottom + rows[1]!.top) / 2;
    endLine.top = (rows[rows.length - 2]!.bottom + last.top) / 2;
    if (rows.length === 2) {
      return [startLine, endLine];
    }
    return [startLine, { left, right, top: startLine.bottom, bottom: endLine.top }, endLine];
  }

  private measureSelectedBox(position: number, size: number) {
    if (this.from > position || this.to < position + size) return;
    const dom = this.view.nodeDOM(position);
    const element = dom && nodeSelectionTarget(dom);
    if (!element) return;
    const bounds = element.getBoundingClientRect();
    const clip = clipRect(element, this.viewport);
    const rect = {
      left: Math.max(bounds.left, clip.left, this.left),
      right: Math.min(bounds.right, clip.right, this.right),
      top: Math.max(bounds.top, clip.top),
      bottom: Math.min(bounds.bottom, clip.bottom),
    };
    if (rect.right <= rect.left || rect.bottom <= rect.top) return;
    if (this.fieldCount++ === 0) this.openStart = this.from <= position;
    this.openEnd = this.to >= position + size;
    this.measuredRows.push(rect);
  }
  private measure(from: number, to: number): Rect[] {
    if (from === to) return [];
    const range = this.view.dom.ownerDocument.createRange();
    const a = this.view.domAtPos(from, 1);
    const b = this.view.domAtPos(to, -1);
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, b.offset);
    // A zero-width PM widget may sit immediately outside a source endpoint. Include its
    // declared complete source selection without treating its typesetting DOM as source text.
    for (const [point, end] of [
      [a, false],
      [b, true],
    ] as const) {
      for (let node = point.node; node !== this.view.dom; node = node.parentNode!) {
        const sibling = end ? node.nextSibling : node.previousSibling;
        if (!sibling) continue;
        for (
          let edge: DOMNode | null = sibling;
          edge?.nodeType === 1;
          edge = end ? edge.firstChild : edge.lastChild
        ) {
          const extent = renderedSourceRange(edge as Element);
          if (!extent) continue;
          if (from <= extent.from && to >= extent.to) {
            if (end) range.setEndAfter(edge);
            else range.setStartBefore(edge);
          }
          break;
        }
        break;
      }
    }
    return new SelectionFragments(range).read();
  }
  private measureNode = (node: Node, position: number): boolean => {
    if (node.isLeaf && !node.isText) {
      this.measureSelectedBox(position, node.nodeSize);
      return false;
    }
    if (!node.isTextblock) return true;
    const start = position + 1;
    const end = start + node.content.size;
    // side=0 returns this textblock's contentDOM, including specialized NodeViews whose
    // outer DOM also contains a toolbar or preview with different line edges.
    const dom = this.view.domAtPos(start, 0).node;
    if (!dom || dom.nodeType !== 1) return false;
    const element = dom as HTMLElement;
    const bounds = element.getBoundingClientRect();
    const clip = clipRect(element, this.viewport);
    if (bounds.height === 0 || bounds.width === 0) {
      this.measureSelectedBox(position, node.nodeSize);
      return false;
    }
    if (
      bounds.bottom <= clip.top ||
      bounds.top >= clip.bottom ||
      bounds.right <= clip.left ||
      bounds.left >= clip.right
    )
      return false;
    // Like CM's wrappedLine, hit both visual edges. Keep one character beyond each hit so
    // a clipped boundary row is measured with its actual rendered height.
    let visibleStart = start;
    let visibleEnd = end;
    if (bounds.top < clip.top) {
      const hits = positionsAtHeight(this.view, bounds, clip, clip.top + 1).filter(
        (pos) => pos >= start && pos <= end,
      );
      if (hits.length) visibleStart = Math.max(start, Math.min(...hits) - 1);
    }
    if (bounds.bottom > clip.bottom) {
      const hits = positionsAtHeight(this.view, bounds, clip, clip.bottom - 1).filter(
        (pos) => pos >= start && pos <= end,
      );
      if (hits.length) visibleEnd = Math.min(end, Math.max(...hits) + 1);
    }
    const selectedFrom = Math.max(visibleStart, this.from);
    const selectedTo = Math.min(visibleEnd, this.to);
    if (selectedFrom > selectedTo) return false;
    const selectedContent = this.measure(selectedFrom, selectedTo);
    const measured = [...selectedContent];
    // PM positions retain a selected line end even when that line contributes no glyph.
    const point = this.view.coordsAtPos(selectedFrom, selectedFrom === start ? 1 : -1);
    measured.push(point);
    measured.push(this.view.coordsAtPos(selectedTo, selectedTo === start ? 1 : -1));
    const clipped = measured
      .map((rect) => ({
        left: Math.max(rect.left, clip.left, this.left),
        right: Math.min(rect.right, clip.right, this.right),
        top: Math.max(rect.top, clip.top),
        bottom: Math.min(rect.bottom, clip.bottom),
      }))
      .filter((rect) => rect.right >= rect.left && rect.bottom > rect.top);
    if (!clipped.length) return false;
    const selectedRows = rowsFor(clipped.sort(visualOrder));
    const wholeField =
      selectedFrom === visibleStart && selectedTo === visibleEnd
        ? selectedContent
        : this.measure(visibleStart, visibleEnd);
    const layout = wholeField
      .map((rect) => ({
        left: rect.left,
        right: rect.right,
        top: Math.max(rect.top, clip.top),
        bottom: Math.min(rect.bottom, clip.bottom),
      }))
      .filter((rect) => rect.bottom > rect.top);
    completeRowHeights(selectedRows, rowsFor(layout.sort(visualOrder)));
    if (this.fieldCount++ === 0) this.openStart = this.from < visibleStart;
    this.openEnd = this.to > visibleEnd;
    this.measuredRows.push(...selectedRows);
    return false;
  };
}

/** Border-box overlays for NodeSelection and BlockSelection, outside editable content. */
export class BlockSelectionPaint {
  private readonly host: HTMLElement;
  private readonly masks = new Map<number, HTMLElement>();
  constructor(private readonly view: EditorView) {
    this.host = view.dom.parentElement!;
  }
  update() {
    const { selection, doc } = this.view.state;
    const structural =
      this.view.dom.isConnected &&
      (selection instanceof BlockSelection || selection instanceof NodeSelection);
    const frontier = structural ? selectedBlocks(doc, selection) : [];
    const targets = frontier.map((block) => ({ from: block.from, box: measureBlockBox(this.view, block) }));
    if (structural && selection instanceof NodeSelection && !frontier.length) {
      const dom = this.view.nodeDOM(selection.from);
      const target = dom && nodeSelectionTarget(dom);
      targets.push({ from: selection.from, box: target?.getBoundingClientRect() });
    }
    const remaining = new Set(this.masks.keys());
    for (const { from, box } of targets) {
      if (!box || box.width <= 0 || box.height <= 0) continue;
      remaining.delete(from);
      let mask = this.masks.get(from);
      if (!mask) {
        mask = this.host.appendChild(this.host.ownerDocument.createElement('div'));
        mask.className = 'md-block-selection-box';
        mask.dataset.blockFrom = String(from);
        mask.setAttribute('aria-hidden', 'true');
        this.masks.set(from, mask);
      }
      positionOverlay(this.host, mask, box);
    }
    for (const from of remaining) {
      this.masks.get(from)!.remove();
      this.masks.delete(from);
    }
    this.view.dom.classList.toggle(
      'md-drawn-node-selection',
      selection instanceof NodeSelection && this.masks.size > 0,
    );
  }
  destroy() {
    for (const mask of this.masks.values()) mask.remove();
    this.masks.clear();
    this.view.dom.classList.remove('md-drawn-node-selection');
  }
}

/** Paint text selections with the editor's first, middle, and last line bands. */
export function drawSelection(): Plugin {
  return new Plugin({ view: view => new TextSelectionPaint(view) });
}

/** The shared PM container owns the paragraph column. Descendant widths, indentation
 * and overflow cannot widen it. Text fields instead use their own contentDOM inset.
 * The first, middle and last selection bands all use this one column. */
function sharedTextColumn(view: EditorView, from: number, to: number) {
  const start = view.state.doc.resolve(from);
  const depth = start.sharedDepth(to);
  const parent = start.node(depth);
  const frame = depth ? view.nodeDOM(start.before(depth)) : view.dom;
  const element = (
    parent.isTextblock
      ? view.domAtPos(start.start(depth), 0).node
      : ((frame && nodeView(frame)?.content) ?? view.domAtPos(start.start(depth), 0).node)
  ) as HTMLElement;
  const style = element.ownerDocument.defaultView!.getComputedStyle(element);
  const bounds = element.getBoundingClientRect();
  const scale = localScale(element);
  const inset = parent.isTextblock ? 0 : parseFloat(style.getPropertyValue('--editor-block-padding-inline'));
  return {
    element,
    left: bounds.left + (parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft) + inset) * scale.x,
    right:
      bounds.right - (parseFloat(style.borderRightWidth) + parseFloat(style.paddingRight) + inset) * scale.x,
    scale: scale.x,
  };
}

/** A declared visible field takes precedence over ordinary schema DOM. */
function nodeSelectionTarget(dom: DOMNode): HTMLElement | undefined {
  const view = nodeView(dom);
  return view?.box ?? view?.selectionTarget ?? (dom.nodeType === 1 ? dom as HTMLElement : undefined);
}
