/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TokenType } from '../types/index.js';
import { blockEvents } from '../compile/events.js';
import { partOfFile } from '../constructs/bundle.js';

/** Whether the complete source is accepted as a footnote label. */
export function isFootnoteLabel(text: string): boolean {
  return matchesToken('[^' + text + ']: ', 'gfmFootnoteDefinitionLabel', 0, text.length + 3);
}

/** Whether the complete source is accepted as a link definition label. */
export function isLinkLabel(text: string): boolean {
  return matchesToken('[' + text + ']: /u', 'definitionLabel', 0, text.length + 2);
}

/** Whether the complete source fits a link destination's chosen framing. */
export function isLinkDestination(text: string, inAngleBrackets = false): boolean {
  const prefix = '[r]: ';
  const framed = inAngleBrackets ? '<' + text + '>' : text;
  const type = inAngleBrackets ? 'definitionDestinationLiteral' : 'definitionDestinationRaw';
  return matchesToken(prefix + framed, type, prefix.length, prefix.length + framed.length);
}

/** Whether the complete source fits a link title's chosen delimiter. */
export function isLinkTitle(text: string, delimiter: '"' | "'" | '(' = '"'): boolean {
  const prefix = '[r]: /u ';
  const closing = delimiter === '(' ? ')' : delimiter;
  const source = prefix + delimiter + text + closing;
  return matchesToken(source, 'definitionTitle', prefix.length, source.length);
}

/** A valid frame must recognize exactly the supplied field, without consuming a prefix only. */
function matchesToken(source: string, type: TokenType, start: number, end: number): boolean {
  return blockEvents(source, { target: 'editor', grammar: partOfFile }).some(
    ([kind, token]) => kind === 'enter' && token.type === type &&
      token.start.offset === start && token.end.offset === end
  );
}
