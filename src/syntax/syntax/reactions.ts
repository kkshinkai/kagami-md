/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { blockEvents, parseEvents } from '../compile/events.js';
import { inlinePhrasings, phrasingDocument } from '../constructs/bundle.js';
import type { Token } from '../types/index.js';
import type { SourceRange } from './syntax.js';
import type { Phrasing } from './reading.js';

export interface TextRepair extends SourceRange {
  insert: string;
}

/** Repairs use offsets in the supplied source, so callers can apply them from right to left. */
export function repairPhrasing(
  text: string,
  phrasing: Phrasing,
  options?: repairPhrasing.Options
): Array<TextRepair> {
  const repairs = characterRepairs(text, lineReplacement(phrasing));
  if (phrasing === 'tableCell' && text.includes('|')) {
    return [...repairs, ...pipeRepairs(applyRepairs(text, repairs), repairs)]
      .sort((left, right) => left.start - right.start);
  }
  if (phrasing === 'paragraph' && options?.escapeBlocks) {
    return blockRepairs(text, repairs);
  }
  return repairs;
}

export namespace repairPhrasing {
  export interface Options {
    escapeBlocks?: boolean;
  }
}

function lineReplacement(phrasing: Phrasing): string | null {
  switch (phrasing) {
    case 'atxHeading':
    case 'tableCell':
    case 'calloutTitle':
      return '<br/>';
    case 'linkDestination':
      return '';
    case 'paragraph':
    case 'setextHeading':
    case 'linkLabel':
    case 'linkTitle':
    case 'footnoteLabel':
      return null;
    default: {
      const exhaustive: never = phrasing;
      return exhaustive;
    }
  }
}

function characterRepairs(text: string, ending: string | null): Array<TextRepair> {
  const escapes = ending === '<br/>' ? hardBreakStarts(text) : new Map<number, number>();
  const repairs: TextRepair[] = [];
  for (const match of text.matchAll(/\u0000|\r\n|\r|\n/g)) {
    if (match[0] === '\u0000') {
      repairs.push({ start: match.index, end: match.index + 1, insert: '\ufffd' });
    } else if (ending !== null) {
      const escape = escapes.get(match.index);
      repairs.push({
        start: escape === undefined ? match.index : escape,
        end: match.index + match[0].length,
        insert: ending,
      });
    }
  }
  return repairs;
}

/** Only the inline tokenizer distinguishes a hard-break backslash from a literal one. */
function hardBreakStarts(text: string): Map<number, number> {
  const escapes = new Map<number, number>();
  if (!text.includes('\\') || !/[\r\n]/.test(text)) return escapes;
  const events = parseEvents(text, {
    target: 'editor',
    grammar: inlinePhrasings.paragraph,
    contentType: 'text',
  });
  for (const [kind, token] of events) {
    if (kind === 'enter' && token.type === 'hardBreakEscape') {
      escapes.set(token.end.offset, token.start.offset);
    }
  }
  return escapes;
}

/** The fixed header makes every unescaped pipe a divider, even past its one-column width. */
function pipeRepairs(text: string, previous: ReadonlyArray<TextRepair>): Array<TextRepair> {
  const prefix = '| x |\n| - |\n| ';
  const events = blockEvents(prefix + text + ' |', { target: 'editor' });
  const repairs: TextRepair[] = [];
  for (const [kind, token] of events) {
    if (kind !== 'enter' || token.type !== 'tableCellDivider') continue;
    const offset = token.start.offset - prefix.length;
    if (offset < 0 || offset >= text.length) continue;
    const start = originalOffset(offset, previous);
    repairs.push({ start, end: start, insert: '\\' });
  }
  return repairs;
}

/** Escaping an opening may expose another, so each reading consumes the changed source. */
function blockRepairs(source: string, initial: ReadonlyArray<TextRepair>): Array<TextRepair> {
  const repairs = [...initial];
  let text = applyRepairs(source, initial);
  for (;;) {
    const events = blockEvents(text, { target: 'editor', grammar: phrasingDocument });
    const opening = events.find(([kind, token]) => kind === 'enter' && blockOpening(token));
    if (!opening) return repairs;
    let offset = opening[1].start.offset;
    while (text[offset] === ' ' || text[offset] === '\t') offset++;
    const start = originalOffset(offset, repairs);
    repairs.push({ start, end: start, insert: '\\' });
    repairs.sort((left, right) => left.start - right.start);
    text = text.slice(0, offset) + '\\' + text.slice(offset);
  }
}

function blockOpening(token: Token): boolean {
  switch (token.type) {
    case 'setextHeadingLineSequence':
    case 'tableDelimiterRow':
    case 'blockQuoteMarker':
    case 'listItemMarker':
    case 'atxHeadingSequence':
    case 'codeFencedFenceSequence':
    case 'mathFlowFenceSequence':
    case 'thematicBreakSequence':
    case 'htmlFlow':
    case 'definitionLabelMarker':
    case 'gfmFootnoteDefinitionLabelMarker':
      return true;
    default:
      return false;
  }
}

/** Queried markers are retained source characters, outside the inserted replacement text. */
function originalOffset(offset: number, repairs: ReadonlyArray<TextRepair>): number {
  let delta = 0;
  for (const repair of repairs) {
    if (offset < repair.start + delta + repair.insert.length) break;
    delta += repair.insert.length - (repair.end - repair.start);
  }
  return offset - delta;
}

function applyRepairs(text: string, repairs: ReadonlyArray<TextRepair>): string {
  for (const repair of [...repairs].reverse()) {
    text = text.slice(0, repair.start) + repair.insert + text.slice(repair.end);
  }
  return text;
}
