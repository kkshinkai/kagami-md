/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-FileCopyrightText: Titus Wormer <tituswormer@gmail.com>
 * SPDX-License-Identifier: MPL-2.0 AND MIT
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Derived from micromark-extension-gfm-table, https://github.com/micromark/micromark-extension-gfm-table. */

import type {
  Code,
  Construct,
  Effects,
  Event,
  Extension,
  Point,
  State,
  Token,
  TokenizeContext
} from '../../types/index.js';
import { assert } from '../../kernel/assert.js'
import {factorySpace} from '../../kernel/factories/space/index.js'
import {
  markdownLineEnding,
  markdownLineEndingOrSpace,
  markdownSpace
} from '../../kernel/utils/character/index.js'
import {codes, constants, types} from '../../kernel/utils/symbol/index.js'
import {EditMap} from './gfm-table-edit-map.js'
import {gfmTableAlign} from './gfm-table-infer.js'

/**
 * Cell info.
 */
type Range = [number, number, number, number]

/**
 * Where we are: `1` for head row, `2` for delimiter row, `3` for body row.
 */
type RowKind = 0 | 1 | 2 | 3

export const table: Construct = {
  name: 'table',
  tokenize: tokenizeTable,
  resolveAll: resolveTable
}

/**
 * Create an HTML extension for `micromark` to support GitHub tables syntax.
 *
 * @returns
 *   Extension for `micromark` that can be passed in `extensions` to enable GFM
 *   table syntax.
 */
export function gfmTable(): Extension {
  return {
    flow: {
      null: table
    }
  }
}

function tokenizeTable(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
  const self = this
  let size = 0
  let sizeB = 0
  let seen: boolean | undefined

  return start

  /**
   * Start of a GFM table.
   *
   * If there is a valid table row or table head before, then we try to parse
   * another row.
   * Otherwise, we try to parse a head.
   *
   * ```markdown
   * > | | a |
   *     ^
   *   | | - |
   * > | | b |
   *     ^
   * ```
   */
  function start(code: Code): State | undefined {
    let index = self.events.length - 1

    while (index > -1) {
      const type = self.events[index][1].type
      if (
        type === types.lineEnding ||
        // Note: markdown-rs uses `whitespace` instead of `linePrefix`
        type === types.linePrefix
      )
        index--
      else break
    }

    const tail = index > -1 ? self.events[index][1].type : null

    const next =
      tail === 'tableHead' || tail === 'tableRow' ? bodyRowStart : headRowBefore

    // Don’t allow lazy body rows.
    if (next === bodyRowStart && self.parser.lazy[self.now().line]) {
      return nok(code)
    }

    return next(code)
  }

  /**
   * Before table head row.
   *
   * ```markdown
   * > | | a |
   *     ^
   *   | | - |
   *   | | b |
   * ```
   */
  function headRowBefore(code: Code): State | undefined {
    effects.enter('tableHead')
    effects.enter('tableRow')
    return headRowStart(code)
  }

  /**
   * Before table head row, after whitespace.
   *
   * ```markdown
   * > | | a |
   *     ^
   *   | | - |
   *   | | b |
   * ```
   */
  function headRowStart(code: Code): State | undefined {
    if (code === codes.verticalBar) {
      return headRowBreak(code)
    }

    // To do: micromark-js should let us parse our own whitespace in extensions,
    // like `markdown-rs`:
    //
    // ```js
    // // 4+ spaces.
    // if (markdownSpace(code)) {
    //   return nok(code)
    // }
    // ```

    seen = true
    // Count the first character, that isn’t a pipe, double.
    sizeB += 1
    return headRowBreak(code)
  }

  /**
   * At break in table head row.
   *
   * ```markdown
   * > | | a |
   *     ^
   *       ^
   *         ^
   *   | | - |
   *   | | b |
   * ```
   */
  function headRowBreak(code: Code): State | undefined {
    if (code === codes.eof) {
      // Note: in `markdown-rs`, we need to reset, in `micromark-js` we don‘t.
      return nok(code)
    }

    if (markdownLineEnding(code)) {
      // If anything other than one pipe (ignoring whitespace) was used, it’s fine.
      if (sizeB > 1) {
        sizeB = 0
        // To do: check if this works.
        // Feel free to interrupt:
        self.interrupt = true
        effects.exit('tableRow')
        effects.enter(types.lineEnding)
        effects.consume(code)
        effects.exit(types.lineEnding)
        return headDelimiterStart
      }

      // Note: in `markdown-rs`, we need to reset, in `micromark-js` we don‘t.
      return nok(code)
    }

    if (markdownSpace(code)) {
      // To do: check if this is fine.
      // effects.attempt(State::Next(StateName::GfmTableHeadRowBreak), State::Nok)
      // State::Retry(space_or_tab(tokenizer))
      return factorySpace(effects, headRowBreak, types.whitespace)(code)
    }

    sizeB += 1

    if (seen) {
      seen = false
      // Header cell count.
      size += 1
    }

    if (code === codes.verticalBar) {
      effects.enter('tableCellDivider')
      effects.consume(code)
      effects.exit('tableCellDivider')
      // Whether a delimiter was seen.
      seen = true
      return headRowBreak
    }

    // Anything else is cell data.
    effects.enter(types.data)
    return headRowData(code)
  }

  /**
   * In table head row data.
   *
   * ```markdown
   * > | | a |
   *       ^
   *   | | - |
   *   | | b |
   * ```
   */
  function headRowData(code: Code): State | undefined {
    if (
      code === codes.eof ||
      code === codes.verticalBar ||
      markdownLineEndingOrSpace(code)
    ) {
      effects.exit(types.data)
      return headRowBreak(code)
    }

    effects.consume(code)
    return code === codes.backslash ? headRowEscape : headRowData
  }

  /**
   * In table head row escape.
   *
   * ```markdown
   * > | | a\-b |
   *         ^
   *   | | ---- |
   *   | | c    |
   * ```
   */
  function headRowEscape(code: Code): State | undefined {
    if (code === codes.backslash || code === codes.verticalBar) {
      effects.consume(code)
      return headRowData
    }

    return headRowData(code)
  }

  /**
   * Before delimiter row.
   *
   * ```markdown
   *   | | a |
   * > | | - |
   *     ^
   *   | | b |
   * ```
   */
  function headDelimiterStart(code: Code): State | undefined {
    // Reset `interrupt`.
    self.interrupt = false

    // Note: in `markdown-rs`, we need to handle piercing here too.
    if (self.parser.lazy[self.now().line]) {
      return nok(code)
    }

    effects.enter('tableDelimiterRow')
    // Track if we’ve seen a `:` or `|`.
    seen = false

    if (markdownSpace(code)) {
      assert(self.parser.constructs.disable.null, 'expected `disabled.null`')
      return factorySpace(
        effects,
        headDelimiterBefore,
        types.linePrefix,
        self.parser.constructs.disable.null.includes('codeIndented')
          ? undefined
          : constants.tabSize
      )(code)
    }

    return headDelimiterBefore(code)
  }

  /**
   * Before delimiter row, after optional whitespace.
   *
   * Reused when a `|` is found later, to parse another cell.
   *
   * ```markdown
   *   | | a |
   * > | | - |
   *     ^
   *   | | b |
   * ```
   */
  function headDelimiterBefore(code: Code): State | undefined {
    if (code === codes.dash || code === codes.colon) {
      return headDelimiterValueBefore(code)
    }

    if (code === codes.verticalBar) {
      seen = true
      // If we start with a pipe, we open a cell marker.
      effects.enter('tableCellDivider')
      effects.consume(code)
      effects.exit('tableCellDivider')
      return headDelimiterCellBefore
    }

    // More whitespace / empty row not allowed at start.
    return headDelimiterNok(code)
  }

  /**
   * After `|`, before delimiter cell.
   *
   * ```markdown
   *   | | a |
   * > | | - |
   *      ^
   * ```
   */
  function headDelimiterCellBefore(code: Code): State | undefined {
    if (markdownSpace(code)) {
      return factorySpace(
        effects,
        headDelimiterValueBefore,
        types.whitespace
      )(code)
    }

    return headDelimiterValueBefore(code)
  }

  /**
   * Before delimiter cell value.
   *
   * ```markdown
   *   | | a |
   * > | | - |
   *       ^
   * ```
   */
  function headDelimiterValueBefore(code: Code): State | undefined {
    // Align: left.
    if (code === codes.colon) {
      sizeB += 1
      seen = true

      effects.enter('tableDelimiterMarker')
      effects.consume(code)
      effects.exit('tableDelimiterMarker')
      return headDelimiterLeftAlignmentAfter
    }

    // Align: none.
    if (code === codes.dash) {
      sizeB += 1
      // To do: seems weird that this *isn’t* left aligned, but that state is used?
      return headDelimiterLeftAlignmentAfter(code)
    }

    if (code === codes.eof || markdownLineEnding(code)) {
      return headDelimiterCellAfter(code)
    }

    return headDelimiterNok(code)
  }

  /**
   * After delimiter cell left alignment marker.
   *
   * ```markdown
   *   | | a  |
   * > | | :- |
   *        ^
   * ```
   */
  function headDelimiterLeftAlignmentAfter(code: Code): State | undefined {
    if (code === codes.dash) {
      effects.enter('tableDelimiterFiller')
      return headDelimiterFiller(code)
    }

    // Anything else is not ok after the left-align colon.
    return headDelimiterNok(code)
  }

  /**
   * In delimiter cell filler.
   *
   * ```markdown
   *   | | a |
   * > | | - |
   *       ^
   * ```
   */
  function headDelimiterFiller(code: Code): State | undefined {
    if (code === codes.dash) {
      effects.consume(code)
      return headDelimiterFiller
    }

    // Align is `center` if it was `left`, `right` otherwise.
    if (code === codes.colon) {
      seen = true
      effects.exit('tableDelimiterFiller')
      effects.enter('tableDelimiterMarker')
      effects.consume(code)
      effects.exit('tableDelimiterMarker')
      return headDelimiterRightAlignmentAfter
    }

    effects.exit('tableDelimiterFiller')
    return headDelimiterRightAlignmentAfter(code)
  }

  /**
   * After delimiter cell right alignment marker.
   *
   * ```markdown
   *   | |  a |
   * > | | -: |
   *         ^
   * ```
   */
  function headDelimiterRightAlignmentAfter(code: Code): State | undefined {
    if (markdownSpace(code)) {
      return factorySpace(
        effects,
        headDelimiterCellAfter,
        types.whitespace
      )(code)
    }

    return headDelimiterCellAfter(code)
  }

  /**
   * After delimiter cell.
   *
   * ```markdown
   *   | |  a |
   * > | | -: |
   *          ^
   * ```
   */
  function headDelimiterCellAfter(code: Code): State | undefined {
    if (code === codes.verticalBar) {
      return headDelimiterBefore(code)
    }

    if (code === codes.eof || markdownLineEnding(code)) {
      // Exit when:
      // * there was no `:` or `|` at all (it’s a thematic break or setext
      //   underline instead)
      // * the header cell count is not the delimiter cell count
      if (!seen || size !== sizeB) {
        return headDelimiterNok(code)
      }

      // Note: in markdown-rs`, a reset is needed here.
      effects.exit('tableDelimiterRow')
      effects.exit('tableHead')
      // To do: in `markdown-rs`, resolvers need to be registered manually.
      // effects.register_resolver(ResolveName::GfmTable)
      return ok(code)
    }

    return headDelimiterNok(code)
  }

  /**
   * In delimiter row, at a disallowed byte.
   *
   * ```markdown
   *   | | a |
   * > | | x |
   *       ^
   * ```
   */
  function headDelimiterNok(code: Code): State | undefined {
    // Note: in `markdown-rs`, we need to reset, in `micromark-js` we don‘t.
    return nok(code)
  }

  /**
   * Before table body row.
   *
   * ```markdown
   *   | | a |
   *   | | - |
   * > | | b |
   *     ^
   * ```
   */
  function bodyRowStart(code: Code): State | undefined {
    // Note: in `markdown-rs` we need to manually take care of a prefix,
    // but in `micromark-js` that is done for us, so if we’re here, we’re
    // never at whitespace.
    effects.enter('tableRow')
    return bodyRowBreak(code)
  }

  /**
   * At break in table body row.
   *
   * ```markdown
   *   | | a |
   *   | | - |
   * > | | b |
   *     ^
   *       ^
   *         ^
   * ```
   */
  function bodyRowBreak(code: Code): State | undefined {
    if (code === codes.verticalBar) {
      effects.enter('tableCellDivider')
      effects.consume(code)
      effects.exit('tableCellDivider')
      return bodyRowBreak
    }

    if (code === codes.eof || markdownLineEnding(code)) {
      effects.exit('tableRow')
      return ok(code)
    }

    if (markdownSpace(code)) {
      return factorySpace(effects, bodyRowBreak, types.whitespace)(code)
    }

    // Anything else is cell content.
    effects.enter(types.data)
    return bodyRowData(code)
  }

  /**
   * In table body row data.
   *
   * ```markdown
   *   | | a |
   *   | | - |
   * > | | b |
   *       ^
   * ```
   */
  function bodyRowData(code: Code): State | undefined {
    if (
      code === codes.eof ||
      code === codes.verticalBar ||
      markdownLineEndingOrSpace(code)
    ) {
      effects.exit(types.data)
      return bodyRowBreak(code)
    }

    effects.consume(code)
    return code === codes.backslash ? bodyRowEscape : bodyRowData
  }

  /**
   * In table body row escape.
   *
   * ```markdown
   *   | | a    |
   *   | | ---- |
   * > | | b\-c |
   *         ^
   * ```
   */
  function bodyRowEscape(code: Code): State | undefined {
    if (code === codes.backslash || code === codes.verticalBar) {
      effects.consume(code)
      return bodyRowData
    }

    return bodyRowData(code)
  }
}

function resolveTable(events: Array<Event>, context: TokenizeContext): Array<Event> {
  let index = -1
  let inFirstCellAwaitingPipe = true
  let rowKind: RowKind = 0
  let lastCell: Range = [0, 0, 0, 0]
  let cell: Range = [0, 0, 0, 0]
  let afterHeadAwaitingFirstBodyRow = false
  let lastTableEnd = 0
  let currentTable: Token | undefined
  let currentBody: Token | undefined
  let currentCell: Token | undefined

  const map = new EditMap()

  while (++index < events.length) {
    const event = events[index]
    const token = event[1]

    if (event[0] === 'enter') {
      // Start of head.
      if (token.type === 'tableHead') {
        afterHeadAwaitingFirstBodyRow = false

        // Inject previous (body end and) table end.
        if (lastTableEnd !== 0) {
          assert(currentTable, 'there should be a table opening')
          flushTableEnd(map, context, lastTableEnd, currentTable, currentBody)
          currentBody = undefined
          lastTableEnd = 0
        }

        // Inject table start.
        currentTable = {
          type: 'table',
          start: Object.assign({}, token.start),
          // Note: correct end is set later.
          end: Object.assign({}, token.end)
        }
        map.add(index, 0, [['enter', currentTable, context]])
      } else if (
        token.type === 'tableRow' ||
        token.type === 'tableDelimiterRow'
      ) {
        inFirstCellAwaitingPipe = true
        currentCell = undefined
        lastCell = [0, 0, 0, 0]
        cell = [0, index + 1, 0, 0]

        // Inject table body start.
        if (afterHeadAwaitingFirstBodyRow) {
          afterHeadAwaitingFirstBodyRow = false
          currentBody = {
            type: 'tableBody',
            start: Object.assign({}, token.start),
            // Note: correct end is set later.
            end: Object.assign({}, token.end)
          }
          map.add(index, 0, [['enter', currentBody, context]])
        }

        rowKind = token.type === 'tableDelimiterRow' ? 2 : currentBody ? 3 : 1
      }
      // Cell data.
      else if (
        rowKind &&
        (token.type === types.data ||
          token.type === 'tableDelimiterMarker' ||
          token.type === 'tableDelimiterFiller')
      ) {
        inFirstCellAwaitingPipe = false

        // First value in cell.
        if (cell[2] === 0) {
          if (lastCell[1] !== 0) {
            cell[0] = cell[1]
            currentCell = flushCell(
              map,
              context,
              lastCell,
              rowKind,
              undefined,
              currentCell
            )
            lastCell = [0, 0, 0, 0]
          }

          cell[2] = index
        }
      } else if (token.type === 'tableCellDivider') {
        if (inFirstCellAwaitingPipe) {
          inFirstCellAwaitingPipe = false
        } else {
          if (lastCell[1] !== 0) {
            cell[0] = cell[1]
            currentCell = flushCell(
              map,
              context,
              lastCell,
              rowKind,
              undefined,
              currentCell
            )
          }

          lastCell = cell
          cell = [lastCell[1], index, 0, 0]
        }
      }
    }
    // Exit events.
    else if (token.type === 'tableHead') {
      afterHeadAwaitingFirstBodyRow = true
      lastTableEnd = index
    } else if (
      token.type === 'tableRow' ||
      token.type === 'tableDelimiterRow'
    ) {
      lastTableEnd = index

      if (lastCell[1] !== 0) {
        cell[0] = cell[1]
        currentCell = flushCell(
          map,
          context,
          lastCell,
          rowKind,
          index,
          currentCell
        )
      } else if (cell[1] !== 0) {
        currentCell = flushCell(map, context, cell, rowKind, index, currentCell)
      }

      rowKind = 0
    } else if (
      rowKind &&
      (token.type === types.data ||
        token.type === 'tableDelimiterMarker' ||
        token.type === 'tableDelimiterFiller')
    ) {
      cell[3] = index
    }
  }

  if (lastTableEnd !== 0) {
    assert(currentTable, 'expected table opening')
    flushTableEnd(map, context, lastTableEnd, currentTable, currentBody)
  }

  map.consume(context.events)

  // To do: move this into `html`, when events are exposed there.
  // That’s what `markdown-rs` does.
  // That needs updates to `mdast-util-gfm-table`.
  index = -1
  while (++index < context.events.length) {
    const event = context.events[index]
    if (event[0] === 'enter' && event[1].type === 'table') {
      event[1]._align = gfmTableAlign(context.events, index)
    }
  }

  return events
}

/**
 * Generate a cell.
 */
// eslint-disable-next-line max-params
function flushCell(
  map: EditMap,
  context: Readonly<TokenizeContext>,
  range: Readonly<Range>,
  rowKind: RowKind,
  rowEnd: number | undefined,
  previousCell: Token | undefined
): Token | undefined {
  // `markdown-rs` uses:
  // rowKind === 2 ? 'tableDelimiterCell' : 'tableCell'
  const groupName =
    rowKind === 1
      ? 'tableHeader'
      : rowKind === 2
        ? 'tableDelimiter'
        : 'tableData'
  // `markdown-rs` uses:
  // rowKind === 2 ? 'tableDelimiterCellValue' : 'tableCellText'
  const valueName = 'tableContent'

  // Insert an exit for the previous cell, if there is one.
  //
  // ```markdown
  // > | | aa | bb | cc |
  //          ^-- exit
  //           ^^^^-- this cell
  // ```
  if (range[0] !== 0) {
    assert(previousCell, 'expected previous cell enter')
    previousCell.end = Object.assign({}, getPoint(context.events, range[0]))
    map.add(range[0], 0, [['exit', previousCell, context]])
  }

  // Insert enter of this cell.
  //
  // ```markdown
  // > | | aa | bb | cc |
  //           ^-- enter
  //           ^^^^-- this cell
  // ```
  const now = getPoint(context.events, range[1])
  previousCell = {
    type: groupName,
    start: Object.assign({}, now),
    // Note: correct end is set later.
    end: Object.assign({}, now)
  }
  map.add(range[1], 0, [['enter', previousCell, context]])

  // Insert text start at first data start and end at last data end, and
  // remove events between.
  //
  // ```markdown
  // > | | aa | bb | cc |
  //            ^-- enter
  //             ^-- exit
  //           ^^^^-- this cell
  // ```
  if (range[2] !== 0) {
    const relatedStart = getPoint(context.events, range[2])
    const relatedEnd = getPoint(context.events, range[3])
    const valueToken: Token = {
      type: valueName,
      start: Object.assign({}, relatedStart),
      end: Object.assign({}, relatedEnd)
    }
    map.add(range[2], 0, [['enter', valueToken, context]])
    assert(range[3] !== 0)

    if (rowKind !== 2) {
      // Fix positional info on remaining events
      const start = context.events[range[2]]
      const end = context.events[range[3]]
      start[1].end = Object.assign({}, end[1].end)
      start[1].type = types.chunkText
      start[1].contentType = constants.contentTypeText

      // Remove if needed.
      if (range[3] > range[2] + 1) {
        const a = range[2] + 1
        const b = range[3] - range[2] - 1
        map.add(a, b, [])
      }
    }

    map.add(range[3] + 1, 0, [['exit', valueToken, context]])
  }

  // Insert an exit for the last cell, if at the row end.
  //
  // ```markdown
  // > | | aa | bb | cc |
  //                    ^-- exit
  //               ^^^^^^-- this cell (the last one contains two “between” parts)
  // ```
  if (rowEnd !== undefined) {
    previousCell.end = Object.assign({}, getPoint(context.events, rowEnd))
    map.add(rowEnd, 0, [['exit', previousCell, context]])
    previousCell = undefined
  }

  return previousCell
}

/**
 * Generate table end (and table body end).
 */
// eslint-disable-next-line max-params
function flushTableEnd(
  map: Readonly<EditMap>,
  context: Readonly<TokenizeContext>,
  index: number,
  table: Token,
  tableBody: Token | undefined
): undefined {
  const exits: Array<Event> = []
  const related = getPoint(context.events, index)

  if (tableBody) {
    tableBody.end = Object.assign({}, related)
    exits.push(['exit', tableBody, context])
  }

  table.end = Object.assign({}, related)
  exits.push(['exit', table, context])

  map.add(index + 1, 0, exits)
}

/**
 * @param events
 * @param index
 */
function getPoint(events: Readonly<Array<Event>>, index: number): Readonly<Point> {
  const event = events[index]
  const side = event[0] === 'enter' ? 'start' : 'end'
  return event[1][side]
}

export const flow = gfmTable().flow
