/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { DOMNode } from '../editor/dom.js';
import type { KagamiMD } from '../editor/editor.js';
import type { Node } from 'prosemirror-model';
import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView, type ViewMutationRecord } from 'prosemirror-view';
import { registerBlockView, type BlockView, type HandleTarget } from '../editor/blockview.js';
import { changedRanges } from '../state/changes.js';
import { schema } from '../types/schema.js';
import { TableHandles } from './tablehandles.js';

const alignmentKey = new PluginKey<DecorationSet>('table-alignment');

/** Keep cell alignment decorations in view-state while an editor view is mounted. */
export function tableAlignment(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: alignmentKey,
    state: {
      init(_config, state) {
        return DecorationSet.create(state.doc, columnAlignment(state.doc, 0, state.doc.content.size));
      },
      apply(tr, decorations) {
        if (!tr.docChanged) return decorations;
        const changes = changedRanges(tr.steps, tr.mapping);
        // Remove the cells of the blocks a change reached before mapping. A moved block can change
        // parent, while decoration subtree mapping assumes unchanged ownership.
        let next = decorations;
        for (const change of changes) {
          const span = blockSpan(tr.before, change.from, change.to);
          next = next.remove(next.find(span.from, span.to));
        }
        const added: Decoration[] = [];
        const drawn = new Set<number>();
        for (const change of changes) {
          const span = blockSpan(tr.doc, change.start, change.end);
          if (!drawn.has(span.from)) added.push(...columnAlignment(tr.doc, span.from, span.to));
          drawn.add(span.from);
        }
        return next.map(tr.mapping, tr.doc).add(tr.doc, added);
      },
    },
    props: {
      decorations: state => alignmentKey.getState(state) ?? null,
    },
  });
}

/**
 * Draw table overflow surfaces and row and column handles. Native tableEditing
 * retains cell gestures, keyboard navigation and rectangular paste.
 */
export function tableView(editor?: KagamiMD): Plugin {
  const tables = new Set<TableView>();
  return new Plugin({
    view(view) {
      let editable = view.editable;
      return {
        update(_view, previous) {
          const changed = editable !== view.editable;
          editable = view.editable;
          for (const table of tables) if (table.view === view) table.handles.refresh(previous, changed);
        },
      };
    },
    props: {
      handleScrollToSelection() {
        for (const table of tables) if (table.handles.scrollRowSelectionIntoView()) return true;
        return false;
      },
      nodeViews: {
        table(node, view, getPos) {
          const table = new TableView(node, view, getPos, () => tables.delete(table), editor);
          tables.add(table);
          return registerBlockView(node, table);
        },
      },
    },
  });
}

/** A cell's alignment is its column's, which the table holds. */
/** The top-level blocks a range reaches, as one span; an empty span where it reaches none. */
function blockSpan(doc: Node, from: number, to: number): { from: number; to: number } {
  let start = -1;
  let end = from;
  doc.nodesBetween(from, to, (block, position) => {
    if (start < 0) start = position;
    end = position + block.nodeSize;
    return false;
  });
  return start < 0 ? { from, to: from } : { from: start, to: end };
}

function columnAlignment(doc: Node, from: number, to: number): Decoration[] {
  const result: Decoration[] = [];
  if (from === to) return result;
  doc.nodesBetween(from, to, (table, pos) => {
    if (table.type !== schema.nodes.table) return !table.isTextblock;
    table.forEach((row, rowOffset) => {
      row.forEach((cell, cellOffset, column) => {
        const align = table.attrs.alignments[column];
        if (!align) return;
        const start = pos + rowOffset + cellOffset + 2;
        result.push(Decoration.node(start, start + cell.nodeSize, { style: `text-align: ${align}` }));
      });
    });
    return false;
  });
  return result;
}

/** The native table DOM, with its edge controls owned by one controller. */
export class TableView implements BlockView {
  readonly dom: HTMLDivElement;
  readonly contentDOM: HTMLTableSectionElement;
  readonly scrollDOM: HTMLDivElement;
  readonly table: HTMLTableElement;
  readonly handles: TableHandles;

  constructor(public node: Node, readonly view: EditorView, readonly getPos: () => number | undefined,
    private readonly remove: () => void, readonly editor?: KagamiMD) {
    const document = view.dom.ownerDocument;
    this.dom = document.createElement('div');
    this.dom.className = 'kagami-table-drag';
    this.scrollDOM = this.dom.appendChild(document.createElement('div'));
    this.scrollDOM.className = 'tableWrapper';
    this.table = this.scrollDOM.appendChild(document.createElement('table'));
    this.contentDOM = this.table.appendChild(document.createElement('tbody'));
    this.handles = new TableHandles(this);
  }

  get box(): HTMLElement { return this.dom; }
  get content(): HTMLElement { return this.dom; }
  get handle(): HandleTarget | undefined {
    const row = this.contentDOM.rows[0];
    return row ? { kind: 'box', target: row } : undefined;
  }

  update(node: Node): boolean {
    if (node.type !== this.node.type) return false;
    if (node !== this.node) {
      this.handles.drag.cancel();
      this.node = node;
      this.handles.render();
    }
    this.handles.scheduleLayout();
    return true;
  }

  rects(axis: TableHandles.Axis): DOMRect[] {
    if (axis === 'row') return Array.from(this.contentDOM.rows, row => row.getBoundingClientRect());
    return Array.from(this.contentDOM.rows[0]?.cells ?? [], cell => cell.getBoundingClientRect());
  }

  stopEvent(event: Event): boolean {
    return this.handles.controls.contains(event.target as DOMNode);
  }

  ignoreMutation(record: ViewMutationRecord): boolean {
    if (record.type === 'selection') return this.handles.controls.contains(record.target);
    return this.handles.controls.contains(record.target) || record.type === 'attributes' && record.target === this.dom;
  }

  destroy(): void {
    this.remove();
    this.handles.destroy();
  }
}
