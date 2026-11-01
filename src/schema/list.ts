/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { correction } from '../state/correction.js';
import type { DOMNode } from '../editor/dom.js';
import { input } from '../editor/input.js';
import { canRunCommand } from '../state/input.js';
import { DOMSerializer, NodeRange, type Node } from 'prosemirror-model';
import { Plugin, TextSelection, type Command, type EditorState, type Transaction } from 'prosemirror-state';
import type { EditorView, ViewMutationRecord } from 'prosemirror-view';
import { registerBlockView, type BlockView, type HandleTarget } from '../editor/blockview.js';
import {
  applyTransaction, canJoinTextblocks, isList, ownsTextblock, cursorContext, splitAt,
  type TextblockContext
} from './textblockcontext.js';
import { indentLines } from './indentation.js';
import { schema } from '../types/schema.js';
import { join, lift, normalize, split, update, wrap } from '../transform/transform.js';

/** List ownership, guardianship, and task-checkbox interaction. */
export function list(): Plugin[] {
  return [list.checkboxes()];
}

export namespace list {
  /** Restore the list frames reached by the shared reading plan. */
  export function correction(tr: Transaction, fields: correction.Fields): void {
    const start = tr.steps.length;
    for (const range of fields.ranges(tr)) {
      const mapping = tr.mapping.slice(start);
      const from = mapping.map(range.from, -1);
      const to = mapping.map(range.to, 1);
      clearInvalidTasks(tr, from, to);
      normalize(tr, from, to, tr.selection.$head.parent);
    }
  }

  /** A logical sibling: a block or an item inside a physical list shell. */
  interface ListEntry {
    node: Node;
    pos: number;
    item: boolean;
    index: number;
  }

  /**
   * Each child of a node, whose content starts at `start`, from the child before the one holding
   * `from` through the first child that starts after `to`.
   */
  function around(node: Node, start: number, from: number, to: number,
    f: (child: Node, pos: number, index: number) => void): void {
    let { index, offset } = node.childAfter(Math.min(Math.max(0, from - start), node.content.size));
    if (index > 0) offset -= node.child(--index).nodeSize;
    for (; index < node.childCount; index++) {
      const child = node.child(index);
      f(child, start + offset, index);
      if (start + offset > to) break;
      offset += child.nodeSize;
    }
  }

  /** The position before a block's owner, or -1 for the document. */
  function parentPosition(doc: Node, pos: number): number {
    const at = doc.resolve(pos);
    return at.depth === 0 ? -1 : at.before();
  }

  /** Move the selected lines by one ownership level. @internal */
  export function moveItems(state: EditorState, direction: 'indent' | 'dedent'): Transaction | null {
    return indentLines(state, direction === 'indent' ? 1 : -1);
  }

  /** The item's marker goes: its blocks are lifted out of it, into the list's parent. */
  export function unwrapItem(state: EditorState, context: TextblockContext): Transaction | null {
    const depth = context.listItem;
    if (!ownsTextblock(context, depth)) return null;
    const from = context.$from.before(depth) + 1;
    const tr = state.tr;
    lift(tr, new NodeRange(tr.doc.resolve(from),
      tr.doc.resolve(from + context.$from.node(depth).content.size), depth));
    return tr;
  }

  /** Delete at the end of an item's first block joins the next item's head into it. */
  export function joinForward(state: EditorState, textblock: TextblockContext): Transaction | null {
    const context = new JoinContext(state);
    const depth = textblock.listItem;
    if (!ownsTextblock(textblock, depth)) return null;
    const { $from } = textblock;
    const doc = state.doc;
    const nested = $from.node(depth).maybeChild($from.index(depth) + 1);
    if (nested && !isList(nested)) return null;
    let nextPos: number;
    if (nested) nextPos = $from.after() + 1;
    else {
      const records = context.sequence(parentPosition(doc, $from.before(depth - 1)), $from.before(depth),
        $from.after(depth));
      const next = records[records.findIndex(record => record.pos === $from.before(depth)) + 1];
      if (!next?.item) return null;
      nextPos = next.pos;
    }
    const next = doc.nodeAt(nextPos);
    if (!next?.firstChild || !canJoinTextblocks(textblock.textblock, next.firstChild)) return null;
    const originalLeft = $from.before();
    const first = nextPos + 1;
    const end = nextPos + next.nodeSize - 1;
    const tr = context.tr;
    lift(tr, context.range(first, end, doc.resolve(nextPos).depth + 1));
    const from = tr.mapping.map(first, 1);
    const to = tr.mapping.map(end, -1);
    const left = tr.mapping.map(originalLeft, 1);
    if (!tr.doc.resolve(from).sameParent(tr.doc.resolve(left))) {
      context.append(from, to, left + textblock.textblock.nodeSize);
    }
    const leftStart = tr.mapping.map(originalLeft, 1);
    join(tr, leftStart + textblock.textblock.nodeSize);
    return tr.setSelection(TextSelection.create(tr.doc, leftStart + 1 + textblock.textblock.content.size));
  }

  /** The original sibling positions and transaction shared by a forward join. */
  class JoinContext {
    readonly tr: Transaction;

    constructor(readonly state: EditorState) {
      this.tr = state.tr;
    }

    /**
     * An owner's sequence of blocks and list items around a range: from the one before `from` through
     * the first after `to`. These are the records an operation there acts on, the one before them it
     * may move into, and the one after them that it leaves behind.
     */
    sequence(parent: number, from: number, to: number): ListEntry[] {
      const state = this.state;
      const owner = parent < 0 ? state.doc : state.doc.nodeAt(parent);
      if (!owner) return [];
      const records: ListEntry[] = [];
      around(owner, parent + 1, from, to, (node, pos, index) => {
        if (isList(node)) around(node, pos + 1, from, to, (item, itemPos) => {
          records.push({ node: item, pos: itemPos, item: true, index });
        });
        else records.push({ node, pos, item: false, index });
      });
      return records;
    }

    range(from: number, to: number, depth: number): NodeRange {
      const tr = this.tr;
      return new NodeRange(tr.doc.resolve(from), tr.doc.resolve(to), depth);
    }

    append(from: number, to: number, end: number): void {
      const tr = this.tr;
      const at = tr.doc.resolve(from);
      const owner = tr.doc.resolve(end);
      const depth = owner.depth - at.depth;
      if (depth < 1 || from !== end + depth) throw new RangeError('The range must follow its indentation owner');
      // A preceding lift can join the range's last shell with the untouched suffix.
      // Reopen that cut so wrapping still addresses exactly the original gap.
      const open = tr.doc.resolve(to).depth - at.depth;
      if (open > 0) {
        split(tr, to, open);
        to += open;
      }
      const outer = owner.node(at.depth + 1);
      if (depth === 1 && outer.type === schema.nodes.blockQuote) {
        // Quotes already at this level join directly. Only the intervening blocks
        // need a new quote frame, so a sibling quote never becomes a nested one.
        const anchor = owner.start();
        const start = tr.steps.length;
        while (from < to) {
          const step = tr.steps.length;
          let end = from;
          for (let node = tr.doc.nodeAt(end); end < to && node && node.type !== outer.type; node = tr.doc.nodeAt(end))
            end += node.nodeSize;
          if (end > from) wrap(tr, this.range(from, end, at.depth), tr.doc.type.schema.nodes.blockQuote, {});
          join(tr, from);
          to = tr.mapping.slice(step).map(to, -1);
          from = tr.doc.resolve(tr.mapping.slice(start).map(anchor, 1)).after(at.depth + 1);
        }
        return;
      }
      const blocks = this.range(from, to, at.depth);
      if (outer.type === schema.nodes.orderedList)
        wrap(tr, blocks, tr.doc.type.schema.nodes.orderedList, { startNumber: outer.attrs.startNumber });
      else if (outer.type === schema.nodes.bulletList) wrap(tr, blocks, tr.doc.type.schema.nodes.bulletList, {});
      else if (outer.type === schema.nodes.blockQuote) wrap(tr, blocks, tr.doc.type.schema.nodes.blockQuote, {});
      else throw new RangeError('The indentation owner cannot wrap blocks');
      let boundary = from;
      for (let level = 0; level < depth; level++) {
        const step = tr.steps.length;
        join(tr, boundary);
        boundary = tr.mapping.slice(step).map(boundary + 1, 1);
      }
    }
  }

  /** Split a list item's head, or remove one level of an empty item's ownership. */
  export const splitItem: Command = (state, dispatch) => {
    const context = cursorContext(state);
    if (!context || !ownsTextblock(context, context.listItem) || context.$from.index(context.listItem) !== 0)
      return false;
    const { $from, textblock, listItem: item } = context;
    if (textblock.content.size) {
      const tr = state.tr;
      if (!splitAt(tr, $from, 2)) return false;
      return applyTransaction(state, dispatch, tr);
    }
    const list = $from.node(item - 1);
    if ($from.node(item).childCount === 1 && $from.node(item - 2).type === state.schema.nodes.listItem &&
        $from.index(item - 1) > 0 && $from.index(item - 1) === list.childCount - 1) {
      return applyTransaction(state, dispatch, moveItems(state, 'dedent'));
    }
    return applyTransaction(state, dispatch, unwrapItem(state, context));
  };

  /** Tab adds one ownership level to the selected lines. */
  export const indent: Command = indentation('indent');
  /** Shift-Tab removes one ownership level from the selected lines. */
  export const dedent: Command = indentation('dedent');

  /** Restore list frames on native changed ranges after composition has committed. */
  /** A list item keeps a stable marker mount while its body remains editable. */
  export function checkboxes(): Plugin {
    const tasks = new Set<TaskView>();
    return new Plugin({
      props: { nodeViews: { listItem(node, view, getPos) {
        if (node.attrs.checked !== null) {
          const task = new TaskView(node, view, getPos, () => tasks.delete(task));
          tasks.add(task);
          return registerBlockView(node, task);
        }
        const { dom, contentDOM } = DOMSerializer.renderSpec(view.dom.ownerDocument, node.type.spec.toDOM!(node));
        const content = contentDOM as HTMLElement;
        return registerBlockView(node, { dom: dom as HTMLElement, contentDOM: content, box: dom as HTMLElement,
          content, markerLane: content, brush: true, handle: { kind: 'child', target: content } });
      } } },
      view: view => ({ update() {
        for (const task of tasks) if (task.view === view) task.sync();
      } }),
    });
  }
}


/** GFM can express a task marker only before an item's first paragraph. */
function clearInvalidTasks(tr: Transaction, from: number, to: number): void {
  const types = tr.doc.type.schema.nodes;
  tr.doc.nodesBetween(from, to, (node, position) => {
    if (node.type === types.listItem && node.attrs.checked !== null && node.firstChild?.type !== types.paragraph) {
      update(tr, position, { checked: null });
    }
  });
}

/** Indentation is one user operation across the selected lines. */
function indentation(direction: 'indent' | 'dedent'): Command {
  return (state, dispatch) => {
    return applyTransaction(state, dispatch, list.moveItems(state, direction));
  };
}

/** The checkbox and its native list-item frame share one lifetime. */
class TaskView implements BlockView {
  readonly dom: HTMLLIElement;
  readonly contentDOM: HTMLDivElement;
  readonly brush = true;
  get box(): HTMLElement { return this.dom; }
  get content(): HTMLElement { return this.contentDOM; }
  get markerLane(): HTMLElement { return this.contentDOM; }
  get handle(): HandleTarget { return { kind: 'child', target: this.contentDOM }; }
  private readonly marker: HTMLSpanElement;
  private readonly checkbox: HTMLInputElement;

  constructor(private node: Node, readonly view: EditorView,
    getPos: () => number | undefined, private readonly remove: () => void) {
    const document = view.dom.ownerDocument;
    this.dom = document.createElement('li');
    this.dom.className = 'task-list-item';
    this.dom.dataset.task = 'true';
    this.marker = this.dom.appendChild(document.createElement('span'));
    this.marker.className = 'task-list-checkbox';
    this.marker.contentEditable = 'false';
    this.checkbox = this.marker.appendChild(document.createElement('input'));
    this.checkbox.type = 'checkbox';
    this.checkbox.tabIndex = -1;
    this.checkbox.setAttribute('aria-label', 'Toggle task');
    this.checkbox.onpointerdown = this.checkbox.onmousedown = event => event.preventDefault();
    this.checkbox.onchange = () => {
      const pos = getPos();
      if (!view.isDestroyed && canRunCommand(view.state, view) && pos !== undefined) {
        const item = view.state.doc.nodeAt(pos);
        const checked = this.checkbox.checked;
        if (item?.type === this.node.type && item.attrs.checked !== null && item.attrs.checked !== checked) {
          const tr = view.state.tr;
          update(tr, pos, { checked });
          view.dispatch(tr);
          view.focus();
        }
      }
      this.sync();
    };
    this.checkbox.onkeydown = event => {
      if (!view.isDestroyed && input.historyKey(view, event)) event.stopPropagation();
    };
    this.contentDOM = this.dom.appendChild(document.createElement('div'));
    this.contentDOM.className = 'md-list-item-content task-list-content';
    this.sync();
  }

  sync(): void {
    const checked = !!this.node.attrs.checked;
    this.dom.dataset.checked = String(checked);
    this.checkbox.checked = checked;
    this.checkbox.disabled = !this.view.editable;
  }

  update(node: Node): boolean {
    if (node.type !== this.node.type || node.attrs.checked === null) return false;
    this.node = node;
    this.sync();
    return true;
  }

  stopEvent(event: Event): boolean {
    return this.marker.contains(event.target as DOMNode);
  }
  ignoreMutation(record: ViewMutationRecord): boolean {
    return this.marker.contains(record.target) || record.type === 'attributes' && record.target === this.dom;
  }
  destroy(): void {
    this.remove();
    this.checkbox.onchange = this.checkbox.onpointerdown = this.checkbox.onmousedown = this.checkbox.onkeydown = null;
  }
}
