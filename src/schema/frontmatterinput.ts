/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Node, ResolvedPos } from 'prosemirror-model';
import { NodeSelection, Plugin, TextSelection, type PluginView, type Selection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { nodeView } from '../editor/blockview.js';
import { getSelection, type DOMNode } from '../editor/dom.js';
import { beginOwnedPointerSelection, endOwnedPointerSelection } from '../editor/selection.js';
import { normalizationKey, type NormalizationChange } from '../state/normalization.js';
import {
  BlockSelection, blockAtPosition, selectableBlocks, type SelectableBlock,
} from '../state/selection.js';
import { schema } from '../types/schema.js';
import { entryAt, isFlowCollection, type ValuePosition, type YAMLEntry } from './frontmatter.js';
import { scalarDOM } from './propertyview.js';

/** Distance from `value` to `[min, max]`, or 0 when inside the interval. */
function intervalDistance(value: number, min: number, max: number): number {
  if (value < min) return min - value;
  if (value > max) return value - max;
  return 0;
}

/** A visual row of elements whose vertical spans overlap cleanly. */
interface VisualRow<T extends { readonly rect: DOMRect }> {
  top: number;
  bottom: number;
  commonTop: number;
  commonBottom: number;
  readonly items: T[];
}

/** Group measured boxes into left-to-right visual rows ordered from top to bottom. */
export function groupVisualRows<T extends { readonly rect: DOMRect }>(items: readonly T[]): VisualRow<T>[] {
  const sorted = items.slice().sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
  const rows: VisualRow<T>[] = [];
  for (const item of sorted) {
    const last = rows.at(-1);
    const overlap = last
      ? Math.min(last.commonBottom, item.rect.bottom) - Math.max(last.commonTop, item.rect.top)
      : 0;
    if (last && overlap > 2) {
      last.top = Math.min(last.top, item.rect.top);
      last.bottom = Math.max(last.bottom, item.rect.bottom);
      last.commonTop = Math.max(last.commonTop, item.rect.top);
      last.commonBottom = Math.min(last.commonBottom, item.rect.bottom);
      last.items.push(item);
    } else {
      rows.push({
        top: item.rect.top,
        bottom: item.rect.bottom,
        commonTop: item.rect.top,
        commonBottom: item.rect.bottom,
        items: [item],
      });
    }
  }
  for (const row of rows) row.items.sort((a, b) => a.rect.left - b.rect.left);
  return rows;
}

/** Pick the item in a visual row nearest horizontally to `x`. */
export function closestInVisualRow<T extends { readonly rect: DOMRect }>(items: readonly T[], x: number): T {
  let best = items[0]!;
  let bestDist = Infinity;
  let bestCenterDist = Infinity;
  for (const item of items) {
    const dist = intervalDistance(x, item.rect.left, item.rect.right);
    const centerDist = Math.abs((item.rect.left + item.rect.right) / 2 - x);
    if (dist < bestDist || (dist === bestDist && centerDist < bestCenterDist)) {
      best = item;
      bestDist = dist;
      bestCenterDist = centerDist;
    }
  }
  return best;
}

/** Pointer selection ownership and cross-boundary clamping for front matter. */
export function frontmatterInputPlugin(): Plugin {
  let controller: FrontmatterInput;
  return new Plugin({
    props: {
      handleDOMEvents: { mousedown: (_view, event) => controller.mouseDown(event) },
      createSelectionBetween: (view, $anchor, $head) => controller.selectionBetween(view, $anchor, $head),
    },
    view: view => controller = new FrontmatterInput(view),
  });
}

/** Active pointer-drag state owned by `FrontmatterInput` during a single press-to-release gesture. */
type DragSession = YAMLDragSession | BodyDragSession;

/** Pointer drag originating inside a structured YAML scalar capsule or boolean control. */
interface YAMLDragSession {
  readonly mode: 'yaml';
  readonly doc: Node;
  readonly startScalarEl: HTMLElement | null;
  readonly boundsEl: HTMLElement;
  readonly startScalarPos: number;
  startTextPos: number | null;
  readonly anchorBlock: SelectableBlock;
  readonly origin: Selection;
  readonly startX: number;
  readonly startY: number;
  moved: boolean;
  owned: boolean;
  syntheticTextDrag: boolean;
}

/** Pointer drag originating in the Markdown body that must clamp before crossing into front matter. */
interface BodyDragSession {
  readonly mode: 'body';
  readonly doc: Node;
  anchorPos: number;
  refinedAnchor: boolean;
  owned: boolean;
}

/** Resolved target scalar element and document node under an initial `mousedown` inside front matter. */
interface ClickedScalar {
  readonly pos: number;
  readonly node: Node;
  readonly el: HTMLElement;
  readonly placeCaret: boolean;
}

/** Selectable YAML block paired with its DOM element and current bounding box for 2D pointer hit-testing. */
interface MeasuredBlock {
  readonly block: SelectableBlock;
  readonly dom: HTMLElement;
  readonly rect: DOMRect;
}

/** Enforces region-clamped pointer drag selection and capsule click focusing around front matter. */
class FrontmatterInput implements PluginView {
  private session: DragSession | null = null;
  private win: (Window & typeof globalThis) | null = null;
  private doc: Document | null = null;
  private syncingNative = false;

  constructor(private readonly view: EditorView) {}

  /** Abort any active drag gesture if the view unmounts, becomes read-only, or the document changes. */
  update(): void {
    if (
      this.session &&
      (!this.view.dom.isConnected || !this.view.editable || this.view.state.doc !== this.session.doc)
    ) {
      this.stop();
    }
  }

  /** Clean up attached window/document listeners on plugin view teardown. */
  destroy(): void {
    this.stop();
  }

  /** Clamp browser selection reconciliation across the frontmatter/body boundary and during owned drags. */
  selectionBetween(view: EditorView, $anchor: ResolvedPos, $head: ResolvedPos): Selection | null {
    const first = view.state.doc.firstChild;
    const session = this.session;
    if (!session) {
      if (first?.type.isInGroup('frontMatter') && Math.min($anchor.pos, $head.pos) < first.nodeSize &&
          !$anchor.sameParent($head)) {
        return view.state.selection;
      }
      return null;
    }
    if (session.mode === 'yaml') {
      return session.owned ? view.state.selection : null;
    }
    if (!first?.type.isInGroup('frontMatter')) return null;
    if (session.owned) return view.state.selection;
    if ($anchor.pos >= first.nodeSize && $head.pos < first.nodeSize) {
      const anchor = Math.max(first.nodeSize, Math.min(view.state.doc.content.size, session.anchorPos));
      const head = bodyStartPosition(view.state.doc, first.nodeSize);
      return TextSelection.between(view.state.doc.resolve(anchor), view.state.doc.resolve(head));
    }
    return null;
  }

  /** Start either a body-origin or YAML-origin drag session, or handle Shift+click region clamping. */
  mouseDown(event: MouseEvent): false {
    this.stop();
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey ||
        event.defaultPrevented || !this.view.editable || this.view.composing) {
      return false;
    }
    const doc = this.view.state.doc;
    const first = doc.firstChild;
    if (!first?.type.isInGroup('frontMatter')) return false;
    const target = event.target as Element | null;
    if (!target || !this.view.dom.contains(target)) return false;
    if (target.closest(
      'button, input, textarea, select, a, [role="button"], .frontmatter-header, .md-frontmatter-yaml-source, .md-yaml-add',
    )) {
      return false;
    }
    const frontmatterDOM = this.view.nodeDOM(0) as HTMLElement | null;
    const inFrontmatter = frontmatterDOM
      ? frontmatterDOM.contains(target)
      : Boolean(target.closest('.md-frontmatter, .md-frontmatter-source'));
    if (event.shiftKey) {
      return this.handleShiftClick(event, target, inFrontmatter, frontmatterDOM);
    }
    if (!inFrontmatter) {
      if (target.closest('td, th')) return false;
      const hit = this.view.posAtCoords({ left: event.clientX, top: event.clientY });
      const anchorPos = hit && hit.pos >= first.nodeSize ? hit.pos : bodyStartPosition(doc, first.nodeSize);
      this.session = { mode: 'body', doc, anchorPos, refinedAnchor: false, owned: false };
      this.attach();
      return false;
    }
    if (first.type !== schema.nodes.yamlFrontMatter) return false;
    const clicked = this.resolveClickedScalar(target, frontmatterDOM, event.clientX);
    if (!clicked) return false;
    return this.beginFromScalar(event, clicked);
  }

  /** Extend existing selection or clamp cross-boundary Shift+click inside the active region. */
  private handleShiftClick(
    event: MouseEvent,
    target: Element,
    inFrontmatter: boolean,
    frontmatterDOM: HTMLElement | null,
  ): false {
    const doc = this.view.state.doc;
    const first = doc.firstChild;
    if (!first?.type.isInGroup('frontMatter')) return false;
    const sel = this.view.state.selection;
    if (sel.anchor >= first.nodeSize && inFrontmatter) {
      const bodyStart = bodyStartPosition(doc, first.nodeSize);
      event.preventDefault();
      this.view.dispatch(
        this.view.state.tr.setSelection(TextSelection.between(doc.resolve(sel.anchor), doc.resolve(bodyStart)))
          .scrollIntoView(),
      );
      return false;
    }
    if (sel.anchor >= first.nodeSize || first.type !== schema.nodes.yamlFrontMatter) return false;
    const blocks = yamlBlocks(doc, first.nodeSize);
    if (!blocks.length) return false;
    if (!inFrontmatter) {
      const anchorBlock = sel instanceof BlockSelection ? sel.anchorBlock : blockAtPosition(blocks, sel.anchor);
      const lastBlock = blocks.filter(b => b.depth === 0).at(-1) ?? blocks.at(-1);
      if (anchorBlock && lastBlock) {
        event.preventDefault();
        this.view.dispatch(
          this.view.state.tr.setSelection(BlockSelection.between(doc, anchorBlock, lastBlock)).scrollIntoView(),
        );
      }
      return false;
    }
    if (sel instanceof TextSelection && sel.$anchor.parent.type === schema.nodes.yamlScalar) {
      const clicked = this.resolveClickedScalar(target, frontmatterDOM, event.clientX);
      if (clicked && clicked.node.attrs.tag !== 'boolean' && clicked.pos === sel.$anchor.before()) {
        if (!clicked.placeCaret) return false;
        const head = this.scalarPosAtX(doc, clicked.pos, clicked.node, clicked.el, event.clientX);
        event.preventDefault();
        this.view.dispatch(
          this.view.state.tr.setSelection(TextSelection.create(doc, sel.anchor, head)).scrollIntoView(),
        );
        return false;
      }
    }
    const frontmatterRect = frontmatterDOM ? frontmatterDOM.getBoundingClientRect() : null;
    const headBlock = this.yamlBlockAtCoords(event.clientX, event.clientY, frontmatterRect);
    if (!headBlock) return false;
    const anchorBlock = sel instanceof BlockSelection ? sel.anchorBlock : blockAtPosition(blocks, sel.anchor);
    if (anchorBlock) {
      event.preventDefault();
      const next = sel instanceof BlockSelection
        ? sel.extend(headBlock)
        : BlockSelection.between(doc, anchorBlock, headBlock);
      this.view.dispatch(this.view.state.tr.setSelection(next).scrollIntoView());
    }
    return false;
  }

  /** Map pointer `clientX` inside `scalarEl` to a clamped intra-scalar text position. */
  private scalarPosAtX(
    doc: Node,
    scalarPos: number,
    scalarNode: Node,
    scalarEl: HTMLElement,
    clientX: number,
    clientY?: number,
  ): number {
    const minPos = scalarPos + 1;
    const maxPos = scalarPos + scalarNode.nodeSize - 1;
    const rect = scalarEl.getBoundingClientRect();
    const y = clientY ?? (rect.top + rect.bottom) / 2;
    const hit = this.view.posAtCoords({ left: clientX, top: y });
    if (hit && hit.pos >= minPos && hit.pos <= maxPos && doc === this.view.state.doc) {
      return hit.pos;
    }
    return clientX <= (rect.left + rect.right) / 2 ? minPos : maxPos;
  }

  /** Resolve a click inside front matter to the target `yamlScalar` node and DOM element, or `null` outside scalars/capsules. */
  private resolveClickedScalar(
    target: Element,
    frontmatterDOM: HTMLElement | null,
    clientX: number,
  ): ClickedScalar | null {
    const doc = this.view.state.doc;
    let current: Element | null = target;
    while (current && current !== frontmatterDOM && current !== this.view.dom) {
      const registered = nodeView(current);
      const pos = registered?.nodePosition?.();
      if (pos !== undefined && pos <= doc.content.size) {
        // In a sequence item, `EntryView` and its inner `ScalarView` / `BooleanView` share `pos`; comparing
        // against `scalarDOM(this.view, pos)` tells a direct scalar hit apart from flow-capsule padding.
        const directEl = scalarDOM(this.view, pos);
        if (directEl === current) {
          const node = doc.nodeAt(pos);
          if (node?.type === schema.nodes.yamlScalar) {
            return { pos, node, el: directEl, placeCaret: false };
          }
        }
        const entry = entryAt(doc, pos);
        if (entry && isFlowCollection(entry.parent) && entry.value.node.type === schema.nodes.yamlScalar) {
          const chosen = this.pickCapsuleScalar(entry, clientX);
          const chosenEl = scalarDOM(this.view, chosen.pos);
          if (chosenEl) {
            return { pos: chosen.pos, node: chosen.node, el: chosenEl, placeCaret: true };
          }
        }
      }
      current = current.parentElement;
    }
    return null;
  }

  /** Pick the key or value scalar when clicking the outer padding of a flow capsule. */
  private pickCapsuleScalar(entry: YAMLEntry, clientX: number): ValuePosition {
    switch (entry.kind) {
      case 'item':
        return entry.value;
      case 'pair': {
        const keyEl = scalarDOM(this.view, entry.key.pos);
        if (keyEl && clientX <= keyEl.getBoundingClientRect().right) return entry.key;
        return entry.value;
      }
    }
  }

  /** Focus the clicked scalar (placing a caret or selecting a boolean) and arm pointer tracking. */
  private beginFromScalar(event: MouseEvent, scalar: ClickedScalar): false {
    const doc = this.view.state.doc;
    const first = doc.firstChild;
    if (!first) return false;
    const { pos, node, el: scalarEl, placeCaret } = scalar;
    const blocks = yamlBlocks(doc, first.nodeSize);
    const anchorBlock = blockAtPosition(blocks, pos);
    if (!anchorBlock) return false;
    const isBoolean = node.attrs.tag === 'boolean';
    let startTextPos: number | null = null;
    if (isBoolean) {
      event.preventDefault();
      if (!this.view.hasFocus()) this.view.focus();
      this.view.dispatch(this.view.state.tr.setSelection(NodeSelection.create(doc, pos)));
    } else {
      const minPos = pos + 1;
      const maxPos = pos + node.nodeSize - 1;
      const hit = this.view.posAtCoords({ left: event.clientX, top: event.clientY });
      if (placeCaret) {
        const rect = scalarEl.getBoundingClientRect();
        const mid = (rect.left + rect.right) / 2;
        if (hit && hit.pos >= minPos && hit.pos <= maxPos) {
          startTextPos = hit.pos;
        } else {
          startTextPos = event.clientX <= mid ? minPos : maxPos;
        }
        event.preventDefault();
        if (!this.view.hasFocus()) this.view.focus();
        this.view.dispatch(this.view.state.tr.setSelection(TextSelection.create(doc, startTextPos)));
      } else {
        startTextPos = hit ? Math.max(minPos, Math.min(maxPos, hit.pos)) : minPos;
      }
    }
    this.session = {
      mode: 'yaml',
      doc,
      startScalarEl: isBoolean ? null : scalarEl,
      boundsEl: scalarEl,
      startScalarPos: pos,
      startTextPos,
      anchorBlock,
      origin: this.view.state.selection,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
      owned: false,
      syntheticTextDrag: placeCaret && !isBoolean,
    };
    this.attach();
    return false;
  }

  /** Attach window/document drag listeners for the active gesture. */
  private attach(): void {
    this.doc = this.view.dom.ownerDocument;
    this.win = this.doc.defaultView!;
    this.win.addEventListener('mousemove', this.move);
    this.doc.addEventListener('selectionchange', this.selectionChange);
    this.win.addEventListener('mouseup', this.release);
    this.win.addEventListener('pointerup', this.pointerUp);
    this.win.addEventListener('dragstart', this.release);
    this.win.addEventListener('blur', this.release);
  }

  /** Prevent native browser drag selection from pulling the body caret into front matter. */
  private selectionChange = (): void => {
    if (this.syncingNative) return;
    const session = this.session;
    if (!session || session.mode !== 'body' || session.owned) return;
    const first = this.view.state.doc.firstChild;
    if (!first?.type.isInGroup('frontMatter')) return;
    const native = getSelection(this.view.root);
    const frontmatterDOM = this.view.nodeDOM(0) as HTMLElement | null;
    if (!native?.focusNode) return;
    const inFrontmatterDOM = frontmatterDOM && frontmatterDOM.contains(native.focusNode);
    const inFrontmatterPos = this.view.dom.contains(native.focusNode) &&
      this.view.posAtDOM(native.focusNode, native.focusOffset) < first.nodeSize;
    if (inFrontmatterDOM || inFrontmatterPos) {
      this.clampBodyToStart(session);
    }
  };

  /** Dispatch drag motion to the active region controller or stop if the primary button is released. */
  private move = (event: MouseEvent): void => {
    const session = this.session;
    if (!session || this.view.state.doc !== session.doc) {
      this.stop();
      return;
    }
    if ((event.buttons & 1) === 0) {
      this.release();
      return;
    }
    if (session.mode === 'body') {
      this.moveBody(session, event);
    } else {
      this.moveYAML(session, event);
    }
  };

  /** Lock in the body drag's resolved DOM anchor position once the native selection exists. */
  private refineBodyAnchor(session: BodyDragSession): void {
    if (session.refinedAnchor) return;
    const first = this.view.state.doc.firstChild;
    if (!first) return;
    const firstSize = first.nodeSize;
    const native = getSelection(this.view.root);
    if (native?.anchorNode && this.view.dom.contains(native.anchorNode)) {
      const pos = this.view.posAtDOM(native.anchorNode, native.anchorOffset);
      if (pos >= firstSize) session.anchorPos = pos;
    }
    session.refinedAnchor = true;
  }

  /** Take selection ownership and clamp a body-origin drag's head to the start of the Markdown body. */
  private clampBodyToStart(session: BodyDragSession): void {
    const doc = this.view.state.doc;
    const first = doc.firstChild;
    if (!first?.type.isInGroup('frontMatter')) return;
    this.refineBodyAnchor(session);
    const firstSize = first.nodeSize;
    const anchor = Math.max(firstSize, Math.min(doc.content.size, session.anchorPos));
    const bodyStart = bodyStartPosition(doc, firstSize);
    const clampedSel = TextSelection.between(doc.resolve(anchor), doc.resolve(bodyStart));
    const needsOwn = !session.owned || !normalizationKey.getState(this.view.state)?.modelOwned;
    session.owned = true;
    if (needsOwn || !this.view.state.selection.eq(clampedSel)) {
      const pointer = normalizationKey.getState(this.view.state);
      const tr = this.view.state.tr.setSelection(clampedSel).setMeta('addToHistory', false);
      if (needsOwn) {
        tr.setMeta(normalizationKey, {
          isPointerActive: true,
          isPointerSelecting: true,
          modelOwned: true,
          presentationId: (pointer?.presentationId ?? 0) + 1,
        } satisfies NormalizationChange);
      }
      this.view.dispatch(tr);
    }
  }

  /** Update or clamp a drag that started in the Markdown body when moving toward or above front matter. */
  private moveBody(session: BodyDragSession, event: MouseEvent): void {
    const doc = this.view.state.doc;
    const first = doc.firstChild;
    if (!first?.type.isInGroup('frontMatter')) return;
    this.refineBodyAnchor(session);
    const frontmatterDOM = this.view.nodeDOM(0) as HTMLElement | null;
    if (!frontmatterDOM) return;
    const frontmatterRect = frontmatterDOM.getBoundingClientRect();
    const bodyDOM = doc.childCount > 1 ? this.view.nodeDOM(first.nodeSize) as HTMLElement | null : null;
    const bodyRect = bodyDOM?.getBoundingClientRect();
    const inGapOrFrontmatter = event.clientY <= frontmatterRect.bottom ||
      (bodyRect !== undefined && bodyRect.height > 0 && event.clientY < bodyRect.top);
    if (inGapOrFrontmatter) {
      event.preventDefault();
      this.clampBodyToStart(session);
      return;
    }
    if (!session.owned) {
      const hit = this.view.posAtCoords({ left: event.clientX, top: event.clientY });
      if (hit && hit.pos < first.nodeSize) {
        event.preventDefault();
        this.clampBodyToStart(session);
      }
      return;
    }
    event.preventDefault();
    const anchor = Math.max(first.nodeSize, Math.min(doc.content.size, session.anchorPos));
    const hit = this.view.posAtCoords({ left: event.clientX, top: event.clientY });
    let head: number;
    if (hit && hit.pos >= first.nodeSize) {
      head = hit.pos;
    } else if (event.clientY > this.view.dom.getBoundingClientRect().bottom) {
      head = TextSelection.near(doc.resolve(doc.content.size), -1).to;
    } else {
      head = bodyStartPosition(doc, first.nodeSize);
    }
    const next = TextSelection.between(doc.resolve(anchor), doc.resolve(head));
    if (!this.view.state.selection.eq(next)) {
      this.view.dispatch(this.view.state.tr.setSelection(next).setMeta('addToHistory', false));
    }
  }

  /** Promote cross-capsule YAML drags to `BlockSelection`, revert when returning to the starting scalar, and clamp before body. */
  private moveYAML(session: YAMLDragSession, event: MouseEvent): void {
    const doc = this.view.state.doc;
    const first = doc.firstChild;
    if (first?.type !== schema.nodes.yamlFrontMatter) return;
    this.syncYAMLTextAnchor(session);
    if (!session.moved) {
      if (Math.abs(event.clientX - session.startX) < 3 && Math.abs(event.clientY - session.startY) < 3) return;
      session.moved = true;
    }
    const frontmatterDOM = this.view.nodeDOM(0) as HTMLElement | null;
    if (!frontmatterDOM) return;
    const frontmatterRect = frontmatterDOM.getBoundingClientRect();
    const hitEl = elementAtEvent(this.view, event);
    const inStartScalar = this.inBoundsElement(session.startScalarEl, hitEl, event.clientX, event.clientY);
    if (event.clientY < frontmatterRect.bottom && inStartScalar && session.startTextPos !== null) {
      this.dragInsideStartScalar(session, event);
      return;
    }
    if (event.clientY < frontmatterRect.bottom && !session.startScalarEl &&
        this.inBoundsElement(session.boundsEl, hitEl, event.clientX, event.clientY)) {
      return;
    }
    const headBlock = this.resolveYAMLHeadBlock(event, frontmatterRect);
    if (!headBlock) return;
    if (!session.owned && session.startScalarEl &&
        event.clientY >= frontmatterRect.top && event.clientY < frontmatterRect.bottom &&
        headBlock.from === session.anchorBlock.from) {
      if (!crossedPairField(this.view, session.anchorBlock, session.startScalarPos, event.clientX)) return;
    }
    if (!session.owned) {
      session.owned = true;
      getSelection(this.view.root)?.removeAllRanges();
      beginOwnedPointerSelection(this.view, session.origin);
    }
    const next = BlockSelection.between(doc, session.anchorBlock, headBlock);
    if (!next.eq(this.view.state.selection)) {
      this.view.dispatch(this.view.state.tr.setSelection(next));
    }
  }

  /** Capture the browser's text anchor inside `startScalarEl` before promoting to `BlockSelection`. */
  private syncYAMLTextAnchor(session: YAMLDragSession): void {
    if (session.owned || session.startTextPos === null || !session.startScalarEl) return;
    const native = getSelection(this.view.root);
    const scalar = this.view.state.doc.nodeAt(session.startScalarPos);
    if (!scalar || !native?.anchorNode || !session.startScalarEl.contains(native.anchorNode)) return;
    const anchor = this.view.posAtDOM(native.anchorNode, native.anchorOffset);
    const minPos = session.startScalarPos + 1;
    const maxPos = session.startScalarPos + scalar.nodeSize - 1;
    if (anchor >= minPos && anchor <= maxPos) session.startTextPos = anchor;
  }

  /** Whether the pointer event stays over `element` (by hit element or bounding rect). */
  private inBoundsElement(element: HTMLElement | null, hitEl: Element | null, x: number, y: number): boolean {
    if (!element) return false;
    const win = this.win;
    if (win && hitEl instanceof win.Node && element.contains(hitEl)) return true;
    return pointInRect(element.getBoundingClientRect(), x, y);
  }

  /** Extend synthetic intra-capsule selection or revert a YAML `BlockSelection` drag back into the starting scalar. */
  private dragInsideStartScalar(session: YAMLDragSession, event: MouseEvent): void {
    if ((!session.owned && !session.syntheticTextDrag) || session.startTextPos === null) return;
    const doc = this.view.state.doc;
    const scalar = doc.nodeAt(session.startScalarPos);
    if (!scalar || !session.startScalarEl) return;
    const head = this.scalarPosAtX(
      doc,
      session.startScalarPos,
      scalar,
      session.startScalarEl,
      event.clientX,
      event.clientY,
    );
    const nextSel = TextSelection.create(doc, session.startTextPos, head);
    if (session.owned) {
      session.owned = false;
      session.syntheticTextDrag = true;
      this.syncNativeRange(session.startTextPos, head);
      this.view.dispatch(
        this.view.state.tr.setSelection(nextSel)
          .setMeta(normalizationKey, { modelOwned: false } satisfies NormalizationChange)
          .setMeta('addToHistory', false),
      );
      return;
    }
    if (!nextSel.eq(this.view.state.selection)) {
      this.syncNativeRange(session.startTextPos, head);
      this.view.dispatch(this.view.state.tr.setSelection(nextSel).setMeta('addToHistory', false));
    }
  }

  /** Resolve the YAML target block for the pointer position, clamping to the last root entry below front matter. */
  private resolveYAMLHeadBlock(event: MouseEvent, frontmatterRect: DOMRect): SelectableBlock | null {
    const doc = this.view.state.doc;
    const first = doc.firstChild;
    if (!first) return null;
    if (event.clientY >= frontmatterRect.bottom) {
      const blocks = yamlBlocks(doc, first.nodeSize);
      return blocks.filter(b => b.depth === 0).at(-1) ?? blocks.at(-1) ?? null;
    }
    return this.yamlBlockAtCoords(event.clientX, event.clientY, frontmatterRect);
  }

  /** Pick the deepest selectable YAML entry corresponding to viewport coordinates `(x, y)`. */
  private yamlBlockAtCoords(x: number, y: number, frontmatterRect: DOMRect | null): SelectableBlock | null {
    const doc = this.view.state.doc;
    const first = doc.firstChild;
    if (!first) return null;
    const roots = yamlBlocks(doc, first.nodeSize).filter(b => b.depth === 0);
    if (!roots.length) return null;
    if (frontmatterRect && frontmatterRect.height > 0 && y < frontmatterRect.top) return roots[0]!;
    return this.resolveBlockInSiblings(roots, x, y) ?? roots[0]!;
  }

  /** Pick the nearest block row in `siblings`, descending into nested children only past the collection boundary. */
  private resolveBlockInSiblings(
    siblings: readonly SelectableBlock[],
    x: number,
    y: number,
  ): SelectableBlock | null {
    const measured: MeasuredBlock[] = [];
    for (const block of siblings) {
      const dom = this.view.nodeDOM(block.from) as HTMLElement | null;
      if (!dom) continue;
      const rect = dom.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) measured.push({ block, dom, rect });
    }
    if (!measured.length) return siblings[0] ?? null;

    const rows = groupVisualRows(measured);
    let bestRow = rows[0]!;
    let bestRowDist = Infinity;
    for (const row of rows) {
      const dy = intervalDistance(y, row.top, row.bottom);
      if (dy < bestRowDist) {
        bestRowDist = dy;
        bestRow = row;
      }
    }
    const chosen = closestInVisualRow(bestRow.items, x);
    if (chosen.block.children.length > 0 && this.inChildrenRegion(chosen.block, chosen.dom, x, y)) {
      return this.resolveBlockInSiblings(chosen.block.children, x, y) ?? chosen.block;
    }
    return chosen.block;
  }

  /** Whether `(x, y)` lies inside `block`'s nested collection area rather than its own key/padding region. */
  private inChildrenRegion(block: SelectableBlock, dom: HTMLElement, x: number, y: number): boolean {
    const collection = block.node.type === schema.nodes.yamlPair ? block.node.child(1) : block.node;
    const isFlow = collection.attrs.flow === true;
    let collectionEl: HTMLElement | null = null;
    if (block.node.type === schema.nodes.yamlPair && block.sequence) {
      // `block.sequence` covers the collection's content range, so `from - 1` is the collection node's own start.
      collectionEl = this.view.nodeDOM(block.sequence.from - 1) as HTMLElement | null;
    } else if (!isFlow) {
      collectionEl = nodeView(dom)?.content ?? null;
    }
    const collectionRect = collectionEl?.getBoundingClientRect();
    let minChildLeft = Infinity;
    let minChildTop = Infinity;
    for (const child of block.children) {
      const childDOM = this.view.nodeDOM(child.from) as HTMLElement | null;
      const rect = childDOM?.getBoundingClientRect();
      if (rect && rect.width > 0 && rect.height > 0) {
        minChildLeft = Math.min(minChildLeft, rect.left);
        minChildTop = Math.min(minChildTop, rect.top);
      }
    }
    if (isFlow) {
      const leftEdge = collectionRect && collectionRect.width > 0
        ? Math.min(collectionRect.left, minChildLeft)
        : minChildLeft;
      return leftEdge < Infinity && x >= leftEdge;
    }
    const topEdge = collectionRect && collectionRect.height > 0
      ? Math.min(collectionRect.top, minChildTop)
      : minChildTop;
    return topEdge < Infinity && minChildLeft < Infinity && y >= topEdge && x >= minChildLeft;
  }

  /** Mirror a ProseMirror range back onto the native DOM selection without re-entering `selectionChange`. */
  private syncNativeRange(anchorPos: number, headPos: number): void {
    const native = getSelection(this.view.root);
    if (!native) return;
    this.syncingNative = true;
    try {
      const anchor = this.view.domAtPos(anchorPos, 1);
      const head = this.view.domAtPos(headPos, -1);
      if (typeof native.setBaseAndExtent === 'function') {
        native.setBaseAndExtent(anchor.node as DOMNode, anchor.offset, head.node as DOMNode, head.offset);
        return;
      }
      const range = this.view.dom.ownerDocument.createRange();
      if (anchorPos <= headPos) {
        range.setStart(anchor.node as DOMNode, anchor.offset);
        range.setEnd(head.node as DOMNode, head.offset);
      } else {
        range.setStart(head.node as DOMNode, head.offset);
        range.setEnd(anchor.node as DOMNode, anchor.offset);
      }
      native.removeAllRanges();
      native.addRange(range);
    } finally {
      this.syncingNative = false;
    }
  }

  /** Release touch/pen gestures cleanly on `pointerup` without waiting for synthetic mouse events. */
  private pointerUp = (event: PointerEvent): void => {
    if (event.pointerType !== 'mouse') this.release();
  };

  /** Sync any owned clamped body selection to the DOM and end the active drag session. */
  private release = (): void => {
    if (this.session?.mode === 'body' && this.session.owned) {
      const sel = this.view.state.selection;
      if (sel instanceof TextSelection && this.view.hasFocus()) {
        this.syncNativeRange(sel.anchor, sel.head);
      }
    }
    if (this.session?.owned && normalizationKey.getState(this.view.state)?.isPointerSelecting) {
      endOwnedPointerSelection(this.view);
    }
    this.stop();
  };

  /** Tear down drag event listeners and clear the current session. */
  private stop(): void {
    if (this.doc) {
      this.doc.removeEventListener('selectionchange', this.selectionChange);
      this.doc = null;
    }
    if (this.win) {
      this.win.removeEventListener('mousemove', this.move);
      this.win.removeEventListener('mouseup', this.release);
      this.win.removeEventListener('pointerup', this.pointerUp);
      this.win.removeEventListener('dragstart', this.release);
      this.win.removeEventListener('blur', this.release);
      this.win = null;
    }
    this.session = null;
  }
}

/** Return the topmost DOM element under the pointer, falling back to `event.target` in synthetic tests. */
function elementAtEvent(view: EditorView, event: MouseEvent): Element | null {
  const fromRoot = view.root.elementFromPoint?.(event.clientX, event.clientY);
  if (fromRoot) return fromRoot;
  const fromDoc = view.dom.ownerDocument.elementFromPoint?.(event.clientX, event.clientY);
  if (fromDoc) return fromDoc;
  return event.target instanceof Element ? event.target : null;
}

/** List selectable entry blocks strictly contained within the structured front matter subtree. */
function yamlBlocks(doc: Node, frontmatterSize: number): SelectableBlock[] {
  return selectableBlocks(doc, { from: 0, to: frontmatterSize }).filter(block => block.to <= frontmatterSize);
}

/** First selectable text position in the Markdown body immediately following front matter. */
function bodyStartPosition(doc: Node, frontmatterSize: number): number {
  return TextSelection.near(doc.resolve(Math.min(frontmatterSize, doc.content.size)), 1).from;
}

/** Whether `(x, y)` lies inside a non-empty `DOMRect`. */
function pointInRect(rect: DOMRect, x: number, y: number): boolean {
  return rect.width > 0 && rect.height > 0 && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

/** Whether a horizontal pointer drag inside one `yamlPair` crossed between its key and value scalars. */
function crossedPairField(
  view: EditorView,
  anchorBlock: SelectableBlock,
  startScalarPos: number,
  clientX: number,
): boolean {
  if (anchorBlock.node.type !== schema.nodes.yamlPair) return false;
  const keyPos = anchorBlock.from + 1;
  const keyEl = scalarDOM(view, keyPos);
  if (!keyEl) return false;
  const keyRect = keyEl.getBoundingClientRect();
  if (keyRect.width <= 0) return false;
  // Require a 4px margin past the key edge before promoting key -> value drags so normal right-edge
  // character selection does not prematurely collapse the whole property into a `BlockSelection`.
  return startScalarPos === keyPos ? clientX > keyRect.right + 4 : clientX <= keyRect.right;
}
