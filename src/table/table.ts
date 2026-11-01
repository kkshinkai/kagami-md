/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { TableSyntax, parseBlocks } from '../syntax/index.js';
import { Fragment, Slice, type Node } from 'prosemirror-model';
import { Plugin, TextSelection, type Command, type EditorState, type Transaction } from 'prosemirror-state';
import {
  CellSelection, TableMap, addColumnAfter, addColumnBefore, addRowAfter, addRowBefore,
  deleteCellSelection, deleteColumn, deleteRow, deleteTable as removeTable, goToNextCell,
  isInTable, moveTableColumn as moveColumn, moveTableRow as moveRow, selectedRect, tableEditing,
} from 'prosemirror-tables';
import * as command from '../command/command.js';
import { readingShapes } from '../transform/reading.js';
import { reshapeBlocks } from '../transform/reshape.js';
import { insert, remove, replace, update, type Shape } from '../transform/transform.js';
import { lineBreakTag } from '../schema/linebreak.js';
import { bindings as bindingState } from '../state/bindings.js';
import { fieldSource } from '../parse/field.js';
import { mapTextSelection } from '../state/selection.js';
import { phrasing } from '../state/correction.js';
import { tableHistory } from './history.js';
import { tableCorrection } from './correct.js';
import { tableView } from './tableview.js';
import { tableInput } from './tableinput.js';

/** Install table corrections, selection and edge interaction. */
export function tables(): Plugin[] {
  const native = tableEditing();
  return [
    tableView(),
    new Plugin({ appendTransaction: native.spec.appendTransaction }),
    tableInput(),
    tableCorrection(),
  ];
}

export namespace tables {
  /** Insert a table, counting the header among its rows, and enter its first cell. */
  export function insertTable({ rows = 3, columns = 3 }: insertTable.Options = {}): Command {
    return tableHistory((state, dispatch) => {
      if (isInTable(state) || !Number.isInteger(rows) || !Number.isInteger(columns) || rows < 1 || columns < 1)
        return false;
      if (!dispatch) return true;
      const nodes = state.schema.nodes;
      const content: Node[] = [];
      for (let row = 0; row < rows; row++) {
        const cells: Node[] = [];
        const type = row === 0 ? nodes.tableHeader : nodes.tableCell;
        for (let column = 0; column < columns; column++)
          cells.push(type.createChecked(null, nodes.tableParagraph.createChecked()));
        content.push(nodes.tableRow.createChecked(null, cells));
      }
      const table = nodes.table.createChecked({ alignments: Array.from({ length: columns }, () => null) }, content);
      const tr = state.tr;
      const from = state.selection.from;
      replace(tr, from, state.selection.to, new Slice(Fragment.from(table), 0, 0));
      const start = tr.mapping.map(from, -1);
      let position: number | undefined;
      tr.doc.nodesBetween(Math.max(0, from - 1), Math.min(tr.doc.content.size, from + table.nodeSize + 2),
        (node, pos) => {
          if (node.type !== nodes.table || pos < start) return;
          if (position === undefined) position = pos;
          return false;
        });
      if (position !== undefined) tr.setSelection(TextSelection.create(tr.doc, position + 4));
      dispatch(tr.scrollIntoView());
      return true;
    });
  }

  export namespace insertTable {
    export interface Options {
      /** Total rows, including the header. Defaults to three. */
      rows?: number;
      /** Columns in every row. Defaults to three. */
      columns?: number;
    }
  }

  /** Insert a row beside the selected rectangle, preserving its mapped selection. */
  export function addTableRow(side: 'before' | 'after'): Command {
    return tableHistory(side === 'before' ? addRowBefore : addRowAfter);
  }

  /** Insert a column and its alignment beside the selected rectangle. */
  export function addTableColumn(side: 'before' | 'after'): Command {
    return tableHistory(changeColumns(side === 'before' ? addColumnBefore : addColumnAfter, side));
  }

  /** Delete the selected rows, or the table when every row is selected. */
  export const deleteTableRow: Command = deleteDimension('row');

  /** Delete the selected columns, or the table when every column is selected. */
  export const deleteTableColumn: Command = deleteDimension('column');

  /** Delete the table containing the selection. */
  export const deleteTable: Command = tableHistory(removeTable);


  /** Set the alignment of each column touched by the selection. */
  export function alignTableColumns(align: Table.Align | null): Command {
    return tableHistory((state, dispatch) => {
      if (!isInTable(state)) return false;
      if (!dispatch) return true;
      const rect = selectedRect(state);
      const alignments = [...rect.table.attrs.alignments];
      for (let column = rect.left; column < rect.right; column++) alignments[column] = align;
      const tr = state.tr;
      update(tr, rect.tableStart - 1, { alignments });
      if (tr.docChanged) dispatch(tr);
      return true;
    });
  }

  /** Handles select the newly inserted axis in the transaction that inserts it. */
  export function insertTableAxis(axis: 'row' | 'column', side: 'before' | 'after'): Command {
    const command = axis === 'row' ? addTableRow(side) : addTableColumn(side);
    return (state, dispatch, view) => {
      if (!isInTable(state)) return false;
      if (!dispatch) return command(state, undefined, view);
      const rect = selectedRect(state);
      let index: number;
      if (axis === 'row') index = side === 'before' ? rect.top : rect.bottom;
      else index = side === 'before' ? rect.left : rect.right;
      return command(state, tr => {
        const start = tr.mapping.map(rect.tableStart - 1) + 1;
        const table = tr.doc.resolve(start).parent;
        const row = axis === 'row' ? index : 0;
        const column = axis === 'column' ? index : 0;
        const cell = tr.doc.resolve(start + TableMap.get(table).positionAt(row, column, table));
        tr.setSelection(axis === 'row' ? CellSelection.rowSelection(cell) : CellSelection.colSelection(cell));
        dispatch(tr.scrollIntoView());
      }, view);
    };
  }

  /** Read the map of a complete table grid. */
  export function tableGrid(node: Node | null): TableMap | null {
    if (!node || node.type !== node.type.schema.nodes.table) return null;
    const map = TableMap.get(node);
    return map.problems?.length ? null : map;
  }

  /** Move a row, counting the header, and select it from its first cell. */
  export function moveTableRow(from: number, to: number): Command {
    return tableHistory((state, dispatch) => {
      if (!canMove(state, 'row', from, to)) return false;
      return moveRow({ from, to })(state, dispatch && (tr => dispatch(selectMovedAxis(tr))));
    });
  }

  /** Move a column with its alignment, and select it from its first cell. */
  export function moveTableColumn(from: number, to: number): Command {
    return tableHistory((state, dispatch) => {
      if (!canMove(state, 'column', from, to)) return false;
      return moveColumn({ from, to })(state, dispatch && (tr => {
        const rect = selectedRect(state);
        const alignments = [...rect.table.attrs.alignments];
        alignments.splice(to, 0, ...alignments.splice(from, 1));
        update(tr, rect.tableStart - 1, { alignments });
        dispatch(selectMovedAxis(tr));
      }));
    });
  }


  /** Tab traverses cells in row order, adding a body row at the end. */
  export function navigateTableCell(direction: -1 | 1): Command {
    return (state, dispatch, view) => {
      if (!isInTable(state)) return false;
      if (goToNextCell(direction)(state, dispatch, view)) return true;
      if (direction < 0) return exitTable(-1)(state, dispatch, view);
      if (!dispatch) return true;
      const start = selectedRect(state).tableStart;
      return addTableRow('after')(state, tr => {
        const table = tr.doc.nodeAt(start - 1)!;
        const map = TableMap.get(table);
        tr.setSelection(TextSelection.create(tr.doc, start + map.map[(map.height - 1) * map.width]! + 2));
        dispatch(tr.scrollIntoView());
      }, view);
    };
  }

  /** Enter moves down a column; an empty final body row is removed before exiting. */
  export const enterTable: Command = (state, dispatch, view) => {
    if (!isInTable(state)) return false;
    const rect = selectedRect(state);
    if (rect.bottom < rect.map.height) {
      if (dispatch) {
        const pos = rect.tableStart + rect.map.map[rect.bottom * rect.map.width + rect.left]! + 2;
        dispatch(state.tr.setSelection(TextSelection.create(state.doc, pos)).scrollIntoView());
      }
      return true;
    }
    const last = rect.table.lastChild!;
    if (rect.map.height > 1 && last.content.content.every(cell => cell.textContent.length === 0)) {
      if (!dispatch) return true;
      const from = rect.tableStart + rect.table.content.size - last.nodeSize;
      const tr = state.tr;
      remove(tr, from, from + last.nodeSize);
      leaveTable(tr, rect.tableStart - 1, 1);
      dispatch(tr.scrollIntoView());
      return true;
    }
    if (!dispatch) return true;
    return addTableRow('after')(state, tr => {
      const table = tr.doc.nodeAt(rect.tableStart - 1)!;
      const map = TableMap.get(table);
      const pos = rect.tableStart + map.map[(map.height - 1) * map.width + rect.left]! + 2;
      tr.setSelection(TextSelection.create(tr.doc, pos));
      dispatch(tr.scrollIntoView());
    }, view);
  };

  /** Leave a table at its own parent level, retaining any enclosing quote or list. */
  export function exitTable(direction: -1 | 1 = 1): Command {
    return (state, dispatch) => {
      if (!isInTable(state)) return false;
      if (dispatch) {
        const tr = state.tr;
        leaveTable(tr, selectedRect(state).tableStart - 1, direction);
        dispatch(tr.scrollIntoView());
      }
      return true;
    };
  }

  /** A cell line break is editable tag text, since a line ending would end its row. */
  export const insertTableLineBreak: Command = (state, dispatch) => {
    if (!isInTable(state)) return false;
    if (state.selection instanceof TextSelection && state.selection.$from.sameParent(state.selection.$to) && dispatch)
      dispatch(state.tr.insertText(lineBreakTag).scrollIntoView());
    return true;
  };

  /** Delete selected cell contents, or keep a caret deletion inside the cell's field. */
  export function guardCellBoundary(direction: -1 | 1): Command {
    return (state, dispatch) => {
      if (!isInTable(state)) return false;
      if (state.selection instanceof CellSelection) return deleteCellSelection(state, dispatch);
      if (!state.selection.empty) return false;
      const { $from } = state.selection;
      return $from.parent.type === state.schema.nodes.tableParagraph &&
        $from.parentOffset === (direction < 0 ? 0 : $from.parent.content.size);
    };
  }

  /** Convert a typed header and delimiter before Enter's ordinary paragraph cases. */
  export const enterInTypedTable: Command = (state, dispatch) => {
    const tr = typedTable(state);
    if (!tr) return false;
    if (dispatch) dispatch(tr.scrollIntoView());
    return true;
  };

  /** Read two adjacent paragraphs as one table declaration and supply its first body row. */
  export function typedTable(state: EditorState): Transaction | null {
    const selection = state.selection;
    if (!(selection instanceof TextSelection) || !selection.empty) return null;
    const { $from } = selection;
    if ($from.parent.type !== state.schema.nodes.paragraph || $from.parentOffset !== $from.parent.content.size)
      return null;
    const header = state.doc.resolve($from.before()).nodeBefore;
    if (header?.type !== state.schema.nodes.paragraph) return null;
    const first = fieldSource(header);
    const second = fieldSource($from.parent);
    if (!first || first.includes('\n') || !second || second.includes('\n')) return null;
    const text = first + '\n' + second;
    const bindings = bindingState.get(state);
    const blocks = parseBlocks(text, { target: 'editor' }, bindings);
    if (blocks.length !== 1 || !(blocks[0] instanceof TableSyntax)) return null;
    const table = blocks[0];
    const start = $from.before() - header.nodeSize;
    const authored = new Map<Shape, Node>();
    const reading = readingShapes(blocks, text, state.schema, [
      { start: 0, end: first.length, origin: start + 1 },
      { start: first.length + 1, end: text.length, origin: $from.before() + 1 },
    ], authored);
    const parsed = reading.shapes[0]!;
    if (parsed.kind !== 'children') throw new RangeError('A table must contain rows');
    const cells: Shape[] = [];
    for (const _cell of table.headerRow.children) {
      cells.push({
        kind: 'children', type: state.schema.nodes.tableCell, meaning: {},
        children: [{ kind: 'text', type: state.schema.nodes.tableParagraph, meaning: {}, text: [] }],
      });
    }
    const shape: Shape = {
      kind: 'children', type: state.schema.nodes.table, meaning: { alignments: table.alignments },
      children: [parsed.children[0]!,
        { kind: 'children', type: state.schema.nodes.tableRow, meaning: {}, children: cells }],
    };
    // The header keeps its authored reading; the command supplies the table's frame.
    authored.delete(parsed);
    const tr = state.tr;
    mapTextSelection(tr, range => reshapeBlocks(tr, start, $from.after(), [shape], authored, range).map);
    const built = tr.doc.nodeAt(start)!;
    const completed = new Set<Node>();
    built.descendants(node => {
      if (node.type === state.schema.nodes.tableParagraph) completed.add(node);
      return !node.isTextblock;
    });
    const update: phrasing.Update = { bindings, completed };
    tr.setMeta(phrasing.key, [update]);
    return tr.setSelection(TextSelection.create(tr.doc, start + built.child(0).nodeSize + 4));
  }
}

/** The public commands for the selected table rows and columns. */
export namespace Table {
  export type Align = 'left' | 'center' | 'right';

  /** A request raised after a row or column handle selects its axis. */
  export interface Action {
    /** Where the table begins in the editor document. */
    readonly pos: number;
    /** Where the pressed handle is on screen. */
    readonly rect: DOMRectReadOnly;
    readonly axis: 'row' | 'column';
    /** The row or column index, counted from zero. */
    readonly index: number;
    /** The selected column's alignment, or the column in which a row was pressed. */
    readonly align: Align | null;
  }

  /** Ask the host to choose an action for the selected row or column. */
  export const chooseAction = command.requestCommand<Action>();

  /** Insert and select a row before the selection. */
  export const addRowBefore: command.Command.Pure = target =>
    target.state.runCommand(tables.insertTableAxis('row', 'before'));

  /** Insert and select a row after the selection. */
  export const addRowAfter: command.Command.Pure = target =>
    target.state.runCommand(tables.insertTableAxis('row', 'after'));

  /** Insert and select a column before the selection. */
  export const addColumnBefore: command.Command.Pure = target =>
    target.state.runCommand(tables.insertTableAxis('column', 'before'));

  /** Insert and select a column after the selection. */
  export const addColumnAfter: command.Command.Pure = target =>
    target.state.runCommand(tables.insertTableAxis('column', 'after'));

  /** Delete the selected rows, or the whole table when all rows are selected. */
  export const deleteRow: command.Command.Pure = target => target.state.runCommand(tables.deleteTableRow);

  /** Delete the selected columns, or the whole table when all columns are selected. */
  export const deleteColumn: command.Command.Pure = target => target.state.runCommand(tables.deleteTableColumn);

  /** Set the alignment of every column intersecting the selection. */
  export const setColumnAlign: command.Command.Pure<Align> = (target, align) =>
    target.state.runCommand(tables.alignTableColumns(align));
}

function deleteDimension(axis: 'row' | 'column'): Command {
  return tableHistory((state, dispatch, view) => {
    if (!isInTable(state)) return false;
    const rect = selectedRect(state);
    const complete = axis === 'row'
      ? rect.top === 0 && rect.bottom === rect.map.height
      : rect.left === 0 && rect.right === rect.map.width;
    if (complete) return removeTable(state, dispatch);
    const command = axis === 'row' ? deleteRow : changeColumns(deleteColumn, 'delete');
    return command(state, dispatch, view);
  });
}

/** Column topology belongs to the native command; its alignment vector belongs to GFM. */
function changeColumns(command: Command, operation: 'before' | 'after' | 'delete'): Command {
  return (state, dispatch, view) => command(state, dispatch && (tr => {
    const rect = selectedRect(state);
    const alignments = [...rect.table.attrs.alignments];
    const index = operation === 'after' ? rect.right : rect.left;
    if (operation === 'delete') alignments.splice(index, rect.right - rect.left);
    else alignments.splice(index, 0, null);
    update(tr, tr.mapping.map(rect.tableStart - 1), { alignments });
    dispatch(tr);
  }), view);
}

function canMove(state: EditorState, axis: 'row' | 'column', from: number, to: number): boolean {
  if (!isInTable(state) || from === to) return false;
  const { map } = selectedRect(state);
  const count = axis === 'row' ? map.height : map.width;
  return Number.isInteger(from) && from >= 0 && from < count && Number.isInteger(to) && to >= 0 && to < count;
}

function selectMovedAxis(tr: Transaction): Transaction {
  const selection = tr.selection as CellSelection;
  return tr.setSelection(selection.isRowSelection()
    ? CellSelection.rowSelection(selection.$anchorCell) : CellSelection.colSelection(selection.$anchorCell));
}

function leaveTable(tr: Transaction, pos: number, direction: -1 | 1): void {
  const table = tr.doc.nodeAt(pos)!;
  const boundary = direction < 0 ? pos : pos + table.nodeSize;
  const resolved = tr.doc.resolve(boundary);
  const beside = direction < 0 ? resolved.nodeBefore : resolved.nodeAfter;
  if (beside?.isTextblock) {
    tr.setSelection(TextSelection.create(tr.doc, direction < 0 ? boundary - 1 : boundary + 1));
  } else {
    insert(tr, boundary, tr.doc.type.schema.nodes.paragraph, {});
    tr.setSelection(TextSelection.create(tr.doc, boundary + 1));
  }
}
