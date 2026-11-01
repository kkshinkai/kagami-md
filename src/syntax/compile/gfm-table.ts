/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-FileCopyrightText: Titus Wormer <tituswormer@gmail.com>
 * SPDX-License-Identifier: MPL-2.0 AND MIT
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Derived from mdast-util-gfm-table, https://github.com/syntax-tree/mdast-util-gfm-table. */

import {
  TableCellSyntax,
  TableDelimiterRowSyntax,
  TableRowSyntax,
  TableSyntax,
} from '../syntax/block.js';
import { DelimiterTokenSyntax } from '../syntax/inline.js';
import type { Point, Token } from '../types/index.js';

import type { CompileContext, Extension } from './types.js';
import { assert } from '../kernel/assert.js';
// ZWSP edge mark: finish candidate ownership with each complete cell.
import { exitEdgeMark } from './edge-mark.js';
import { blockSpelling } from './spelling.js';
import { measureWidth } from './width.js';

declare module './types.js' {
  interface CompileData {
    /**
     * Whether we’re in a table.
     */
    inTable?: boolean | undefined;
    /**
     * Whether we’re in the head of a table.
     */
    inTableHead?: boolean | undefined;
    /**
     * The rows of the table being made, as written, delimiter row included.
     */
    tableRows?: Array<Row> | undefined;
    /**
     * Whether a cell of the table being made has spaces beside its pipes.
     */
    tableCellPadding?: boolean | undefined;
    /**
     * Whether the cell being made has content.
     */
    tableCellContent?: boolean | undefined;
    /** Empty content after the most recent cell divider. */
    tableCellStart?: number | undefined;
  }
}

/**
 * A row as written: where it starts, where its pipes are, and whether it
 * starts with one.
 */
interface Row {
  start: Point;
  dividers: Array<Point>;
  enclosed: boolean;
}

/**
 * Create an extension to enable GFM tables.
 *
 * @returns
 *   Extension to enable GFM tables.
 */
export function gfmTableFromMarkdown(): Extension {
  return {
    enter: {
      table: enterTable,
      tableContent: enterContent,
      tableData: enterCell,
      tableDelimiterRow: enterDelimiterRow,
      tableHead: enterHead,
      tableHeader: enterCell,
      tableRow: enterRow,
    },
    exit: {
      table: exitTable,
      tableCellDivider: exitDivider,
      tableContent: exitContent,
      tableData: exitCell,
      tableHead: exitHead,
      tableHeader: exitCell,
      tableRow: exitRow,
      tableDelimiterRow: exitRow,
    },
  };
}

function enterTable(this: CompileContext, token: Token): undefined {
  const align = token._align;
  assert(align, 'expected `_align` on table');
  const table = new TableSyntax();
  table.alignments = align.map(function (d) {
    return d === 'none' ? null : d;
  });
  table.spelling = { ...blockSpelling(token), cellPadding: 'oneSpace', enclosedInPipes: true };
  this.enter(table, token);
  this.data.inTable = true;
  this.data.tableRows = [];
}

function exitTable(this: CompileContext, token: Token): undefined {
  const node = this.stack[this.stack.length - 1];
  assert(node, 'expected node on stack');
  assert(node instanceof TableSyntax, 'expected table on stack');
  const rows = this.data.tableRows;
  assert(rows, 'expected rows');
  let enclosed = 0;
  let index = -1;

  while (++index < rows.length) {
    if (rows[index]!.enclosed) {
      enclosed++;
    }
  }

  // As most rows are written; on a tie, as the first is.
  node.spelling.enclosedInPipes =
    enclosed * 2 === rows.length ? rows[0]!.enclosed : enclosed * 2 > rows.length;
  if (this.data.tableCellPadding) {
    node.spelling.cellPadding = aligned(this, rows) ? 'aligned' : 'oneSpace';
  } else {
    node.spelling.cellPadding = 'none';
  }
  this.exit(token);
  this.data.inTable = undefined;
  this.data.tableRows = undefined;
  this.data.tableCellPadding = undefined;
}

/**
 * Whether the pipes of every column stand at the same width in every row,
 * within what the uncertain characters before them could be off by
 * (private-docs/design/syntax/alignment.md).
 *
 * @param context
 *   Context.
 * @param rows
 *   Rows as written.
 * @returns
 *   Whether they do.
 */
function aligned(context: CompileContext, rows: Array<Row>): boolean {
  let columns = Infinity;
  let index = -1;

  while (++index < rows.length) {
    columns = Math.min(columns, rows[index]!.dividers.length);
  }

  let column = -1;

  while (++column < columns) {
    let least = Infinity;
    let most = 0;
    let allowed = 0;
    index = -1;

    while (++index < rows.length) {
      const row = rows[index]!;
      const width = measureWidth(
        context.sliceSerialize({ start: row.start, end: row.dividers[column]! })
      );
      least = Math.min(least, width.width);
      most = Math.max(most, width.width);
      allowed = Math.max(allowed, width.uncertain);
    }

    if (most - least > allowed) {
      return false;
    }
  }

  return true;
}

function enterHead(this: CompileContext): undefined {
  this.data.inTableHead = true;
}

function exitHead(this: CompileContext): undefined {
  this.data.inTableHead = undefined;
}

function enterRow(this: CompileContext, token: Token): undefined {
  this.enter(new TableRowSyntax(), token);
  enterWrittenRow.call(this, token);
}

function exitRow(this: CompileContext, token: Token): undefined {
  const row = this.stack[this.stack.length - 1];
  const table = this.stack[this.stack.length - 2];
  assert(
    row && (row instanceof TableRowSyntax || row instanceof TableDelimiterRowSyntax),
    'expected row'
  );
  assert(table && table instanceof TableSyntax, 'expected table');

  if (row instanceof TableRowSyntax) {
    const columns = table.alignments.length;
    // A cell beyond the columns is in no record; a missing one is empty.
    row.children.length = Math.min(row.children.length, columns);
    while (row.children.length < columns) {
      const tableCell = new TableCellSyntax();
      tableCell.start = token.end.offset;
      tableCell.end = token.end.offset;
      row.children.push(tableCell);
    }
  }
  this.exit(token);
}

function enterDelimiterRow(this: CompileContext, token: Token): undefined {
  this.enter(new TableDelimiterRowSyntax(), token);
  enterWrittenRow.call(this, token);
}

function enterWrittenRow(this: CompileContext, token: Token): undefined {
  const rows = this.data.tableRows;
  assert(rows, 'expected rows');
  rows.push({ start: token.start, dividers: [], enclosed: false });
}

function exitDivider(this: CompileContext, token: Token): undefined {
  const rows = this.data.tableRows;
  assert(rows, 'expected rows');
  const row = rows[rows.length - 1]!;
  const node = this.stack[this.stack.length - 1];

  if (row.dividers.length === 0 && token.start.offset === row.start.offset) {
    row.enclosed = true;
  }

  row.dividers.push(token.start);

  // A cell with no content is empty after its pipe.
  if (node && node instanceof TableRowSyntax && !this.data.tableCellContent) {
    this.data.tableCellStart = token.end.offset;
  }
}

function enterCell(this: CompileContext, token: Token): undefined {
  this.data.tableCellStart = token.start.offset;
  this.data.tableCellContent = undefined;
}

function exitCell(this: CompileContext, token: Token): undefined {
  const row = this.stack[this.stack.length - 1];
  assert(row && row instanceof TableRowSyntax, 'expected row');
  const whitespace = this.data.whitespace;
  let start = this.data.tableCellStart;
  assert(start !== undefined, 'expected cell start');

  if (whitespace && whitespace.start.offset >= token.start.offset) {
    this.data.tableCellPadding = true;
    start = whitespace.end.offset;
  }

  if (!this.data.tableCellContent) {
    const tableCell = new TableCellSyntax();
    tableCell.start = start;
    tableCell.end = start;
    row.children.push(tableCell);
  }
  this.data.tableCellStart = undefined;
}

function enterContent(this: CompileContext, token: Token): undefined {
  const row = this.stack[this.stack.length - 1];
  assert(
    row && (row instanceof TableRowSyntax || row instanceof TableDelimiterRowSyntax),
    'expected row'
  );
  if (row instanceof TableDelimiterRowSyntax) return;
  this.enter(new TableCellSyntax(), token);
  this.data.tableCellContent = true;
}

function exitContent(this: CompileContext, token: Token): undefined {
  const node = this.stack[this.stack.length - 1];
  assert(node, 'expected node');
  if (node instanceof TableDelimiterRowSyntax) {
    node.children.push(
      new DelimiterTokenSyntax('tableDelimiter', token.start.offset, token.end.offset)
    );
  } else {
    assert(node instanceof TableCellSyntax, 'expected cell content');
    // ZWSP edge mark: the mark belongs to the cell's leading, even if it is empty.
    exitEdgeMark.call(this, node, token, 'tableCell');
    this.exit(token);
  }
}
