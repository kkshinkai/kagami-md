/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Node } from 'prosemirror-model';
import { schema } from '../types/schema.js';
import { markerPattern } from './markers.js';
import { Closing, type Opening } from './unparsed.js';

/** The blank-line range in which neighboring blocks keep their reading. */
interface BlankRange {
  readonly min: number;
  readonly max: number;
}

/** The list relationship whose tightness a boundary must preserve. */
export interface BoundaryParent {
  readonly sameList: boolean;
  readonly loose: boolean;
  readonly marker?: string;
}

/** The blank counts at which the next body opens outside the preceding block. */
export function boundaryRange(preceding: Closing | null, opening: Opening | null,
  parent: BoundaryParent | null = null): BlankRange | null {
  const max = parent && !parent.loose ? 0 : Infinity;
  if (!preceding || !opening) return { min: 0, max };
  // An indented continuation remains in its container across blank lines.
  if (preceding.continuation !== null && opening.column >= preceding.continuation) return null;
  if (parent?.sameList) return { min: 0, max };
  if (opening.kind === 'listItem' && parent?.marker && preceding.openList === markerPattern(parent.marker)) return null;
  const min = requiredBlanks(preceding, opening);
  return min === null || min > max ? null : { min, max };
}

/** The least separation permitted by the exposed grammar edges. */
function requiredBlanks(preceding: Closing, opening: Opening): number | null {
  if (preceding.openQuote && opening.kind === 'blockQuote') return 1;
  if (preceding.continuation !== null || preceding.openQuote) {
    // With the ancestor prefix absent, only paragraph content can continue lazily.
    // A new flow block ends that continuation before its own interruption rules run.
    return Number(Closing.paragraph(preceding.leaf) !== 'none' && !opensFlow(opening));
  }
  switch (preceding.leaf) {
    case 'none': return 0;
    case 'paragraph': return Number(!opening.interruptsParagraph);
    case 'definition':
    case 'definitionComplete':
      return Number(!opening.interruptsParagraph && opening.kind !== 'text' &&
        opening.kind !== 'definition' && opening.kind !== 'table' && opening.kind !== 'thematicBreak' &&
        !(preceding.leaf === 'definitionComplete' && opening.kind === 'linkTitle'));
    case 'table':
      // Indented code ends a GFM table even though it cannot interrupt a paragraph.
      return Number(opening.kind !== 'indentedCode' && (!opensFlow(opening) || opening.kind === 'table'));
    case 'indentedCode': return opening.kind === 'indentedCode' ? null : 0;
    case 'fence': return null;
    case 'html': return 1;
    default: {
      const exhaustive: never = preceding.leaf;
      return exhaustive;
    }
  }
}

/** Type-7 HTML cannot interrupt lazy paragraph content (CommonMark 4.6 and 5.1).
 * A blank line ends that paragraph before an intended following HTML block. */
export function blockBoundary(next: Node, preceding: Closing | null, opening: Opening | null,
  parent: BoundaryParent | null = null): BlankRange | null {
  const range = boundaryRange(preceding, opening, parent);
  const completeHTML = next.type === schema.nodes.htmlTagBlock ||
    next.type === schema.nodes.htmlBlock && next.attrs.startCondition === 7;
  if (!range || !preceding || !completeHTML ||
    Closing.paragraph(preceding.leaf) === 'none' || !preceding.openQuote && preceding.continuation === null)
    return range;
  return range.max < 1 ? null : { min: Math.max(1, range.min), max: range.max };
}

/** Keep the requested count within the grammar's permitted interval. */
export function constrainBoundary(requested: number, range: BlankRange): number {
  if (requested < range.min) return range.min;
  return Math.min(requested, range.max);
}

/** The two owners' recorded blank lines, or the surrounding default when either is unwritten. */
export function requestedBoundary(left: Node, right: Node, fallback: number): number {
  const trailing: number | undefined = left.attrs.spelling?.trailingBlankLines;
  const leading: number | undefined = right.attrs.spelling?.leadingBlankLines;
  return Math.max((trailing ?? 0) + (leading ?? 0), trailing === undefined || leading === undefined ? fallback : 0);
}

/** Flow opening is distinct from interrupting an already open paragraph. */
function opensFlow(opening: Opening): boolean {
  switch (opening.kind) {
    case 'text':
    case 'linkTitle':
    case 'definition':
    case 'indentedCode':
    // A table's header remains paragraph text until its later delimiter row.
    case 'table': return false;
    case 'atxHeading':
    case 'fence':
    case 'thematicBreak':
    case 'blockQuote':
    case 'listItem':
    case 'html':
    case 'footnoteDefinition': return true;
    default: {
      const exhaustive: never = opening.kind;
      return exhaustive;
    }
  }
}
