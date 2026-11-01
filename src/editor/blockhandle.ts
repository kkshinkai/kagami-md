/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { DOMNode } from './dom.js';
import type { EditorView } from 'prosemirror-view';
import { canRunCommand } from '../state/input.js';
import { BlockSelection, blockRangeForHandle, type BlockRange } from '../state/selection.js';
import { localScale, positionOverlay, unionRects } from './coords.js';
import type { BlockLayout, HandleLane, RenderedBlock } from './blockdrag.js';
import { input } from './input.js';

/** A draggable block button whose bar expands inside a stable hit area on hover. */
export class BlockHandle {
  readonly dom: HTMLElement;
  private readonly button: HTMLButtonElement;
  private readonly host: HTMLElement;
  private lane?: HandleLane;
  private over = false;
  private lockedSource?: BlockRange;
  private paintedGeometry?: number[];

  constructor(
    private readonly layout: BlockLayout,
    private readonly press: (event: MouseEvent, block: RenderedBlock) => void,
  ) {
    const view = layout.view;
    this.host = view.dom.parentElement!;
    this.dom = this.host.appendChild(view.dom.ownerDocument.createElement('div'));
    this.dom.className = 'md-block-handle';
    this.dom.contentEditable = 'false';
    this.dom.hidden = true;
    this.button = this.dom.appendChild(view.dom.ownerDocument.createElement('button'));
    this.button.type = 'button';
    this.button.draggable = true;
    this.button.className = 'md-block-grip';
    this.button.setAttribute('aria-label', 'Select block');
    this.button.disabled = !view.editable;
    const grabber = this.button.appendChild(view.dom.ownerDocument.createElement('span'));
    grabber.className = 'md-block-grabber';
    grabber.setAttribute('aria-hidden', 'true');
    this.button.onclick = event => this.select(event.shiftKey);
    this.button.onkeydown = event => {
      if (!this.view.isDestroyed && input.historyKey(this.view, event)) event.stopPropagation();
    };
    this.dom.addEventListener('pointerenter', this.enter);
    this.dom.addEventListener('pointerleave', this.leave);
    this.dom.addEventListener('mousedown', this.down);
  }

  private get view(): EditorView { return this.layout.view; }

  source(): BlockRange | undefined {
    if (this.lockedSource) return this.lockedSource;
    const block = this.lane?.block;
    if (!block) return;
    return blockRangeForHandle(this.view.state.doc, this.view.state.selection, block);
  }

  private select(extend: boolean) {
    if (!this.lane || this.view.isDestroyed || !canRunCommand(this.view.state, this.view)) return;
    const { state } = this.view;
    const current = state.selection;
    const source = this.source()!;
    let selection: BlockSelection;
    if (extend && current instanceof BlockSelection) {
      selection = current.extend(this.lane.block);
    } else if (current instanceof BlockSelection && current.from === source.from && current.to === source.to) {
      selection = current;
    } else {
      const backward = current.anchor > current.head;
      selection = BlockSelection.create(state.doc, backward ? source.to : source.from,
        backward ? source.from : source.to);
    }
    this.view.dispatch(state.tr.setSelection(selection));
    this.view.focus();
    this.paint();
  }

  hover(event: PointerEvent) {
    if (this.lockedSource || event.buttons || this.view.isDestroyed || !canRunCommand(this.view.state, this.view))
      return;
    if (this.dom.contains(event.target as DOMNode)) return;
    const bounds = this.view.dom.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return this.hide();
    const scale = localScale(this.host);
    const blocks = this.layout.measure();
    const lanes = this.layout.lanes(blocks, scale.x);
    const lane = this.layout.atPoint(lanes, event.clientX, event.clientY);
    const left = Math.min(...lanes.map(item => item.left));
    const target = event.target as Element;
    if (!lane || event.clientX < left - 16 * scale.x ||
        target.nodeType === 1 && target.closest('button,[role="button"],input')) return this.hide();
    const changed = this.lane?.block.from !== lane.block.from;
    this.lane = lane;
    if (changed) {
      this.over = false;
      this.stopAnimation();
    }
    this.paint(blocks);
    if (changed) {
      void this.dom.offsetHeight;
      this.dom.dataset.animate = 'true';
    }
  }

  private paint(measured?: RenderedBlock[]) {
    if (!this.lane) return;
    const { block, center, left, right } = this.lane;
    const source = this.source()!;
    const members = (measured ?? this.layout.measure()).filter(block => block.from >= source.from &&
      block.to <= source.to);
    const rect = unionRects(members.map(block => block.rect));
    const scale = localScale(this.host);
    // The resolved source may extend coverage only when this owner is one of its frontier
    // members. Its horizontal identity remains the hovered block's own lane.
    const height = Math.max(24 * scale.y, rect.bottom - rect.top) + 8 * scale.y;
    const top = rect.top - 4 * scale.y;
    const rowCenter = (block.row.top + block.row.bottom) / 2;
    const geometry = [block.from, left, right, top, height, rowCenter];
    const changed = !this.paintedGeometry || geometry.some((value, index) => value !== this.paintedGeometry![index]);
    if (changed) {
      // Theme/line wrapping changes are layout, not a hover transition. Only expansion inside
      // an unchanged frame may animate; moving its anchor must snap in this same paint.
      this.stopAnimation();
    }
    positionOverlay(this.host, this.dom, { left, right, top, bottom: top + height });
    const paddingTop = Math.max(0, Math.min(height / scale.y - 12, (rowCenter - top) / scale.y - 6));
    this.dom.style.setProperty('--block-grip-center', `${(center - left) / scale.x}px`);
    this.dom.style.setProperty('--block-grip-top', `${paddingTop}px`);
    this.dom.style.setProperty('--block-grip-bottom', `${height / scale.y - paddingTop - 12}px`);
    this.dom.dataset.expanded = String(this.over || !!this.lockedSource);
    this.dom.dataset.blockType = block.node.type.name;
    this.dom.dataset.blockFrom = String(block.from);
    this.dom.hidden = false;
    this.paintedGeometry = geometry;
    if (changed) {
      void this.dom.offsetHeight;
      this.dom.dataset.animate = 'true';
    }
  }

  private stopAnimation() {
    // A transition must not carry coordinates from a different block or layout.
    this.dom.dataset.animate = 'false';
    this.dom.getAnimations({ subtree: true }).forEach(animation => animation.cancel());
  }

  private enter = () => {
    this.over = true;
    this.paint();
  };
  private leave = () => {
    this.over = false;
    if (!this.lockedSource) this.paint();
  };
  private down = (event: MouseEvent) => {
    if (event.button === 0 && this.lane && !this.view.isDestroyed && canRunCommand(this.view.state, this.view)) {
      this.press(event, this.lane.block);
    }
  };

  /** Keep the pressed source fixed until the gesture releases it. */
  lock(source?: BlockRange) {
    this.lockedSource = source && { from: source.from, to: source.to };
    if (source) this.paint();
  }

  hide() {
    if (this.lockedSource) return;
    this.dom.hidden = true;
    this.lane = undefined;
    this.over = false;
  }

  /** Keep the same owner across layout changes, but never retain its old coordinates. */
  refresh() {
    if (!this.lane) return;
    const blocks = this.layout.measure();
    const from = this.lane.block.from;
    this.lane = this.layout.lanes(blocks, localScale(this.host).x).find(lane => lane.block.from === from);
    if (this.lane) this.paint(blocks);
    else this.dom.hidden = true;
  }

  update() {
    this.button.disabled = !this.view.editable;
    if (this.view.editable) this.refresh();
    else this.hide();
  }

  destroy() {
    this.button.onclick = this.button.onkeydown = null;
    this.dom.removeEventListener('pointerenter', this.enter);
    this.dom.removeEventListener('pointerleave', this.leave);
    this.dom.removeEventListener('mousedown', this.down);
    this.dom.remove();
  }
}
