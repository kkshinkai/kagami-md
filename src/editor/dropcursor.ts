/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { EditorView } from 'prosemirror-view';
import type { DropIntent } from './blockdrop.js';
import {
  selectableBlocks,
  rootBlockSequences,
  blockAtPosition,
  type BlockRange,
  type SelectableBlock,
} from '../state/selection.js';
import { nodeView, type ChildSequence } from './blockview.js';
import { localScale, positionOverlay, type Rect } from './coords.js';
import type { RenderedBlock } from './blockdrag.js';

export interface RenderedIntent {
  intent: DropIntent;
  x: number;
  y: number;
  right: number;
  parent: Rect | null;
  /** Indentation boundaries, outermost first, ending at the main line. */
  edges: number[];
}

/** The element's content box in viewport coordinates. */
function contentRect(element: HTMLElement): Rect {
  const rect = element.getBoundingClientRect();
  const style = element.ownerDocument.defaultView!.getComputedStyle(element);
  const { x: sx, y: sy } = localScale(element);
  return {
    left: rect.left + (parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft)) * sx,
    right: rect.right - (parseFloat(style.borderRightWidth) + parseFloat(style.paddingRight)) * sx,
    top: rect.top + (parseFloat(style.borderTopWidth) + parseFloat(style.paddingTop)) * sy,
    bottom: rect.bottom - (parseFloat(style.borderBottomWidth) + parseFloat(style.paddingBottom)) * sy,
  };
}

interface SequenceGeometry {
  rect: Rect;
  end: number;
  trailing?: Rect;
}

/** A child sequence's visible column and trailing insertion edge. */
function measureSequence(layout: ChildSequence): SequenceGeometry | undefined {
  const content = layout.content.getBoundingClientRect();
  const tail = layout.trailing.getBoundingClientRect();
  const trailing = tail.width > 0 && tail.height > 0 ? tail : undefined;
  if (content.width <= 0 && !trailing) return;
  const rect =
    content.width > 0
      ? contentRect(layout.content)
      : { left: trailing!.left, right: trailing!.right, top: trailing!.top, bottom: trailing!.top };
  return {
    rect,
    trailing,
    end: trailing ? Math.max(rect.bottom, (rect.bottom + trailing.top) / 2) : rect.bottom,
  };
}

function rootSequenceLayout(view: EditorView, range: BlockRange): ChildSequence | undefined {
  const $start = view.state.doc.resolve(range.from);
  const dom = $start.depth ? view.nodeDOM($start.before()) : view.dom;
  return dom ? nodeView(dom)?.sequence : undefined;
}

/** A block's child column, its overlapping header, and its trailing insertion edge. */
function bodyGeometry(view: EditorView, block: RenderedBlock): SequenceGeometry & { header?: Rect } {
  const dom = view.nodeDOM(block.from) as HTMLElement;
  const layout = nodeView(dom)!;
  const content = layout.content!;
  const sequence = nodeView(content)?.sequence;
  const measured = sequence && measureSequence(sequence);
  const rect = measured?.rect ?? contentRect(content);
  const field = layout.field?.getBoundingClientRect();
  const header = field && field.left < rect.right && field.right > rect.left ? field : undefined;
  return { rect, header, end: measured?.end ?? block.rect.bottom, trailing: measured?.trailing };
}

/** Measure drop boundaries and their ancestor indentation edges from the rendered blocks. */
export function measureDropIntents(
  view: EditorView,
  blocks: readonly RenderedBlock[],
  intents: readonly DropIntent[],
): RenderedIntent[] {
  const byPosition = new Map(blocks.map((block) => [block.from, block]));
  const roots = selectableBlocks(view.state.doc).filter((block) => !block.parent);
  const rootSequences = rootBlockSequences(view.state.doc);
  return intents.flatMap((intent) => {
    const parent = intent.parent ? byPosition.get(intent.parent.from)! : null;
    if (intent.parent && !parent) return []; // Hidden subtrees have no painted targets.
    const children = parent ? parent.children : roots;
    // A transparent root mapping ends before the Markdown body begins. Do not average a
    // property's trailing edge with an unrelated body block (or use its horizontal column).
    const sequence = !parent
      ? rootSequences.find((range) => intent.boundary >= range.from && intent.boundary <= range.to)
      : undefined;
    const neighbor = (block: BlockRange | undefined) =>
      block && (!sequence || (block.from >= sequence.from && block.to <= sequence.to))
        ? byPosition.get(block.from)
        : undefined;
    const before = neighbor(children[intent.index - 1]);
    const after = neighbor(children[intent.index]);
    const rootLayout = sequence && rootSequenceLayout(view, sequence);
    const rootGeometry = rootLayout && measureSequence(rootLayout);
    if (rootLayout && !rootGeometry) return [];
    const {
      rect: body,
      header,
      end,
      trailing,
    } = parent
      ? bodyGeometry(view, parent)
      : {
          ...(rootGeometry ?? { rect: contentRect(view.dom), end: undefined }),
          header: undefined,
          trailing: rootGeometry?.trailing,
        };
    // A nested subtree's end stays at its bottom. An ordinary sibling gap uses
    // its midpoint. A preceding header contributes only an actual vertical gap;
    // a side label or an overlapping box must not move the line into the child.
    let y: number;
    if (!before && !after && trailing) y = end!;
    else if (before) {
      if (after && !before.children.length) y = (before.rect.bottom + after.rect.top) / 2;
      else if (!after && end !== undefined) y = end;
      else y = before.rect.bottom;
    } else if (header && (!after || header.bottom <= after.rect.top)) {
      y = after ? (header.bottom + after.rect.top) / 2 : header.bottom;
    } else {
      y = parent ? parent.rect.top : (after?.rect.top ?? body.top);
    }
    const reference = before ?? after;
    const x = reference?.rect.left ?? body.left;
    const right = parent?.rect.right ?? reference?.rect.right ?? body.right;
    const ancestors: number[] = [];
    for (let owner = parent; owner; owner = owner.parent ? byPosition.get(owner.parent.from)! : null)
      ancestors.unshift(owner.rect.left);
    const edges: number[] = [];
    for (const left of [...ancestors, x]) if (!edges.length || left > edges.at(-1)!) edges.push(left);
    return [{ intent, x, y, right, parent: parent?.rect ?? null, edges }];
  });
}

/** Find the legal drop boundary along the hit block's ancestor chain. */
export function dropIntentAtPoint(
  view: EditorView,
  blocks: readonly RenderedBlock[],
  targets: readonly RenderedIntent[],
  x: number,
  y: number,
): RenderedIntent | undefined {
  return new DropHit(view, blocks, targets, x, y).read();
}

class DropHit {
  readonly lookup: Map<number, RenderedBlock>;
  readonly roots: SelectableBlock[];
  readonly sequences: BlockRange[];

  constructor(
    readonly view: EditorView,
    readonly blocks: readonly RenderedBlock[],
    readonly targets: readonly RenderedIntent[],
    readonly x: number,
    readonly y: number,
  ) {
    this.lookup = new Map(blocks.map((block) => [block.from, block]));
    this.roots = selectableBlocks(view.state.doc).filter((block) => !block.parent);
    this.sequences = rootBlockSequences(view.state.doc);
  }

  private blockAtPoint(): RenderedBlock | undefined {
    const { view, blocks, lookup, x, y } = this;
    const root = contentRect(view.dom);
    const native = view.posAtCoords({ left: Math.max(root.left, Math.min(root.right - 1, x)), top: y });
    let owner = native ? blockAtPosition(blocks, native.pos) : undefined;
    while (owner) {
      const block = lookup.get(owner.from)!;
      if (y >= block.rect.top && y <= block.rect.bottom && (x >= block.rect.left || !block.parent)) break;
      owner = owner.parent ?? undefined;
    }
    const roots = blocks.filter((block) => !block.parent);
    const initial = owner
      ? lookup.get(owner.from)
      : (roots.find((candidate) => candidate.rect.bottom >= y) ?? roots.at(-1));
    if (!initial) return;
    let block: RenderedBlock = initial;
    // A header retains its upper half; a side label does not block entry to the child column.
    while (block.children.length && y >= block.rect.top && y <= block.rect.bottom) {
      const children: RenderedBlock[] = block.children.map((child) => lookup.get(child.from)!);
      const next: RenderedBlock = children.find((child) => child.rect.bottom >= y) ?? children.at(-1)!;
      const { header, end, trailing } = bodyGeometry(view, block);
      if (x < next.rect.left || (header && y < (header.top + header.bottom) / 2) || (trailing && y >= end))
        break;
      block = next;
    }
    return block;
  }

  targetAt(parent: RenderedBlock | null, index: number, boundary?: number) {
    const candidates = this.targets.filter(
      (target) => target.intent.parentPos === (parent?.from ?? -1) && target.intent.index === index,
    );
    // A single logical boundary may be spelled at either side of transparent
    // list tokens. Only distinct storage-sequence intents need disambiguation.
    return candidates.length === 1
      ? candidates[0]
      : candidates.find((target) => target.intent.boundary === boundary);
  }
  siblingBlocks(block: RenderedBlock): readonly SelectableBlock[] {
    return block.parent ? block.parent.children : this.roots;
  }
  afterTail(block: RenderedBlock): RenderedIntent | undefined {
    const children = block.children.map((child) => this.lookup.get(child.from)!);
    const { rect, trailing } = bodyGeometry(this.view, block);
    // A trailing row closes this sequence. Crossing its footer cannot re-enter a descendant's
    // footer merely because the pointer is far to the right.
    if (trailing && this.x >= rect.left) return this.targetAt(block, children.length);
    const last = children.at(-1);
    if (last && this.x >= last.rect.left) {
      const deeper = this.afterTail(last);
      if (deeper) return deeper;
    }
    const parent = block.parent ? this.lookup.get(block.parent.from)! : null;
    return this.targetAt(
      parent,
      this.siblingBlocks(block).findIndex((sibling) => sibling.from === block.from) + 1,
      block.to,
    );
  }

  read(): RenderedIntent | undefined {
    // A transparent root sequence has no block to hit, especially when empty. Its own trailing
    // region still denotes append, with no parent highlight or invented carrier depth.
    for (const sequence of this.sequences) {
      const layout = rootSequenceLayout(this.view, sequence);
      const geometry = layout && measureSequence(layout);
      if (
        !geometry?.trailing ||
        this.x < geometry.rect.left ||
        this.x > geometry.rect.right ||
        this.y < geometry.end ||
        this.y > geometry.trailing.bottom
      )
        continue;
      const index = this.roots.filter((block) => block.to <= sequence.to).length;
      const target = this.targetAt(null, index, sequence.to);
      if (target) return target;
    }
    let block = this.blockAtPoint();
    while (block) {
      const children = block.children.map((child) => this.lookup.get(child.from)!);
      const { rect: body, header, end, trailing } = bodyGeometry(this.view, block);
      if (trailing && this.y >= end && this.y <= block.rect.bottom && this.x >= body.left) {
        const append = this.targetAt(block, children.length);
        if (append) return append;
      }
      const entryTop = header ? (header.top + header.bottom) / 2 : body.top;
      if (this.y >= entryTop && this.x >= body.left && (!children.length || this.y < children[0]!.rect.top)) {
        const first = this.targetAt(block, 0);
        if (first) return first;
      }
      const siblings = this.siblingBlocks(block);
      const index = siblings.findIndex((sibling) => sibling.from === block!.from);
      const parent = block.parent ? this.lookup.get(block.parent.from)! : null;
      if (this.y > (block.rect.top + block.rect.bottom) / 2) {
        const after = this.targetAt(parent, index + 1, block.to);
        if (after) return after;
      } else {
        const previous = this.lookup.get(siblings[index - 1]?.from ?? -1);
        if (
          previous?.children.length &&
          (parent ||
            this.sequences.some((sequence) => previous.from >= sequence.from && block!.to <= sequence.to))
        ) {
          const tail = this.afterTail(previous);
          if (tail) return tail;
        }
        const before = this.targetAt(parent, index, block.from);
        if (before) return before;
      }
      block = parent ?? undefined;
    }
    return undefined;
  }
}

/** The measured drop boundary and its containing block, drawn outside editable content. */
export class DropCursor {
  private readonly host: HTMLElement;
  private readonly line: HTMLElement;
  private readonly parent: HTMLElement;

  constructor(view: EditorView) {
    this.host = view.dom.parentElement!;
    this.line = this.element('md-block-drop-line');
    this.parent = this.element('md-block-drop-parent');
  }

  private element(className: string): HTMLElement {
    const dom = this.host.appendChild(this.host.ownerDocument.createElement('div'));
    dom.className = className;
    dom.contentEditable = 'false';
    dom.hidden = true;
    return dom;
  }

  draw(target?: RenderedIntent) {
    this.line.hidden = !target;
    this.parent.hidden = !target?.parent;
    if (!target) return;
    if (target.parent) positionOverlay(this.host, this.parent, target.parent);
    const scale = localScale(this.host);
    const depth = target.edges.length - 1;
    const start = target.edges[0]!;
    positionOverlay(this.host, this.line, {
      left: start,
      right: target.right,
      top: target.y - scale.y,
      bottom: target.y + scale.y,
    });
    Object.assign(this.line.dataset, {
      parent: String(target.intent.parentPos),
      index: String(target.intent.index),
      boundary: String(target.intent.boundary),
      depth: String(depth),
    });
    if (this.line.childElementCount !== target.edges.length) {
      this.line.replaceChildren(
        ...target.edges.map((_edge, index) => {
          const dom = this.host.ownerDocument.createElement('span');
          dom.className = index === depth ? 'md-block-drop-tail' : 'md-block-drop-indent';
          return dom;
        }),
      );
    }
    // The gap consumes the end of a segment without shifting the next indentation boundary.
    for (let index = 0; index < this.line.children.length; index++) {
      const part = this.line.children[index] as HTMLElement;
      const left = target.edges[index]!;
      const right = index < depth ? target.edges[index + 1]! : target.right;
      part.style.left = `${(left - start) / scale.x}px`;
      part.style.width = `${Math.max(0, (right - left) / scale.x - (index < depth ? 2 : 0))}px`;
      part.style.opacity = String((index + 1) / (depth + 1));
    }
  }

  destroy() {
    this.line.remove();
    this.parent.remove();
  }
}
