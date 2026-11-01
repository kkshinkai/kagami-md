/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-FileCopyrightText: Titus Wormer <tituswormer@gmail.com>
 * SPDX-License-Identifier: MPL-2.0 AND MIT
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Derived from micromark-extension-gfm-table, https://github.com/micromark/micromark-extension-gfm-table. */

import type { Event, Token } from '../../types/index.js';
import { assert } from '../../kernel/assert.js'

/**
 * Figure out the alignment of a GFM table.
 *
 * @param events
 *   List of events.
 * @param index
 *   Table enter event.
 * @returns
 *   List of aligns.
 */
export function gfmTableAlign(events: Readonly<Array<Event>>, index: number): Array<Token.Align> {
  assert(events[index][1].type === 'table', 'expected table')
  let inDelimiterRow = false
  const align: Array<Token.Align> = []

  while (index < events.length) {
    const event = events[index]

    if (inDelimiterRow) {
      if (event[0] === 'enter') {
        // Start of alignment value: set a new column.
        // To do: `markdown-rs` uses `tableDelimiterCellValue`.
        if (event[1].type === 'tableContent') {
          align.push(
            events[index + 1][1].type === 'tableDelimiterMarker'
              ? 'left'
              : 'none'
          )
        }
      }
      // Exits:
      // End of alignment value: change the column.
      // To do: `markdown-rs` uses `tableDelimiterCellValue`.
      else if (event[1].type === 'tableContent') {
        if (events[index - 1][1].type === 'tableDelimiterMarker') {
          const alignIndex = align.length - 1

          align[alignIndex] = align[alignIndex] === 'left' ? 'center' : 'right'
        }
      }
      // Done!
      else if (event[1].type === 'tableDelimiterRow') {
        break
      }
    } else if (event[0] === 'enter' && event[1].type === 'tableDelimiterRow') {
      inDelimiterRow = true
    }

    index += 1
  }

  return align
}
