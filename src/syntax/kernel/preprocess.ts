/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-FileCopyrightText: Titus Wormer <tituswormer@gmail.com>
 * SPDX-License-Identifier: MPL-2.0 AND MIT
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Derived from micromark, https://github.com/micromark/micromark. */

import type { Chunk, Code, Encoding, Value } from '../types/index.js';
import { codes, constants } from './utils/symbol/index.js';

/**
 * Preprocess a value.
 *
 * @param value
 *   Value.
 * @param encoding
 *   Encoding when `value` is a typed array (optional).
 * @param end
 *   Whether this is the last chunk (default: `false`).
 * @returns
 *   Chunks.
 */
type Preprocessor = (
  value: Value,
  encoding?: Encoding | null | undefined,
  end?: boolean | null | undefined
) => Array<Chunk>;

const search = /[\0\t\n\r]/g;

/** The document boundary and physical start column of the input lines. */
export interface PreprocessOptions {
  atDocumentStart?: boolean;
  column?: number;
}

/**
 * @param options
 *   Whether this stream begins a Markdown document (default: true). Embedded text fields
 *   use false: a leading BOM there is an ordinary source character, not a document preamble.
 *   `column` is the zero-based physical column at which every owned line starts (default: 0).
 * @returns
 *   Preprocess a value.
 */
export function preprocess(options: PreprocessOptions = {}): Preprocessor {
  // A field's lines can begin after a container prefix; tabs use that physical column.
  const lineColumn = (options.column || 0) + 1;
  let column = lineColumn;
  let buffer = '';
  let start: boolean | undefined = options.atDocumentStart !== false;
  let atCarriageReturn: boolean | undefined;

  return preprocessor;

  // eslint-disable-next-line complexity
  function preprocessor(
    value: Value,
    encoding?: Encoding | null | undefined,
    end?: boolean | null | undefined
  ): Array<Chunk> {
    const chunks: Array<Chunk> = [];
    let match: RegExpMatchArray | null;
    let next: number;
    let startPosition: number;
    let endPosition: number;
    let code: Code;

    value =
      buffer +
      (typeof value === 'string'
        ? value.toString()
        : new TextDecoder(encoding || undefined).decode(value));

    startPosition = 0;
    buffer = '';

    if (start && value.length > 0) {
      // To do: `markdown-rs` actually parses BOMs (byte order mark).
      if (value.charCodeAt(0) === codes.byteOrderMarker) {
        startPosition++;
      }

      start = undefined;
    }

    while (startPosition < value.length) {
      search.lastIndex = startPosition;
      match = search.exec(value);
      endPosition =
        match && match.index !== undefined ? match.index : value.length;
      code = value.charCodeAt(endPosition);

      if (!match) {
        buffer = value.slice(startPosition);
        break;
      }

      if (
        code === codes.lf &&
        startPosition === endPosition &&
        atCarriageReturn
      ) {
        chunks.push(codes.carriageReturnLineFeed);
        atCarriageReturn = undefined;
      } else {
        if (atCarriageReturn) {
          chunks.push(codes.carriageReturn);
          atCarriageReturn = undefined;
        }

        if (startPosition < endPosition) {
          chunks.push(value.slice(startPosition, endPosition));
          column += endPosition - startPosition;
        }

        switch (code) {
          case codes.nul: {
            chunks.push(codes.replacementCharacter);
            column++;

            break;
          }

          case codes.ht: {
            next = Math.ceil(column / constants.tabSize) * constants.tabSize;
            chunks.push(codes.horizontalTab);
            while (column++ < next) chunks.push(codes.virtualSpace);

            break;
          }

          case codes.lf: {
            chunks.push(codes.lineFeed);
            column = lineColumn;

            break;
          }

          default: {
            atCarriageReturn = true;
            column = lineColumn;
          }
        }
      }

      startPosition = endPosition + 1;
    }

    if (end) {
      if (atCarriageReturn) chunks.push(codes.carriageReturn);
      if (buffer) chunks.push(buffer);
      chunks.push(codes.eof);
    }

    return chunks;
  }
}
