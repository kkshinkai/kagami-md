/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import * as Syntax from '../syntax/index.js';
import { Closing, type ListPattern, type Opening, type Unparsed } from '../unparse/unparsed.js';
import { after } from '../unparse/frames.js';
import { frontMatterFence, opensAfterMarker } from '../unparse/markers.js';

/** Edges belong to the body read from the file, before editor spelling can change. */
export function readBody(node: Syntax.BlockSyntax | Syntax.FrontMatterSyntax, text: string,
  pattern: ListPattern | null = null): Unparsed {
  const body = text.slice(node.bodyStart, node.bodyEnd);
  const edges = readEdges(node, 0, pattern);
  // A first line that can stand at the start of a file records the front matter fence it is.
  if (edges.opening && (node instanceof Syntax.ThematicBreakSyntax || node instanceof Syntax.ParagraphSyntax ||
    node instanceof Syntax.SetextHeadingSyntax))
    edges.opening = { ...edges.opening, frontMatter: frontMatterFence(body) };
  return { body, ...edges };
}

/** The exposed opening and closing of a source block. */
interface Edges {
  opening: Opening | null;
  closing: Closing;
}

/** Follow the first and last children of containers to their exposed edges. */
function readEdges(node: Syntax.BlockSyntax | Syntax.FrontMatterSyntax, column: number,
  pattern: ListPattern | null = null): Edges {
  if (node instanceof Syntax.FrontMatterSyntax)
    return { opening: opening('thematicBreak', true, column), closing: Closing.none };
  const at = column + node.spelling.spacesBeforeBlock;
  if (node instanceof Syntax.ParagraphSyntax || node instanceof Syntax.SetextHeadingSyntax) {
    const empty = node.bodyStart === node.bodyEnd;
    return {
      opening: empty ? null : opening(node.startsLinkTitle ? 'linkTitle' : 'text', false, at),
      closing: node instanceof Syntax.ParagraphSyntax && !empty ? { ...Closing.none, leaf: 'paragraph' } : Closing.none,
    };
  }
  if (node instanceof Syntax.ATXHeadingSyntax)
    return { opening: opening('atxHeading', true, at), closing: Closing.none };
  if (node instanceof Syntax.ThematicBreakSyntax)
    return { opening: opening('thematicBreak', !node.canSetext, at), closing: Closing.none };
  if (node instanceof Syntax.FencedCodeBlockSyntax || node instanceof Syntax.MathBlockSyntax) {
    const fence = node instanceof Syntax.FencedCodeBlockSyntax ? node.spelling.fence : node.spelling;
    return {
      opening: opening('fence', true, at),
      closing: { ...Closing.none, leaf: fence.closingFence === null ? 'fence' : 'none' }
    };
  }
  if (node instanceof Syntax.IndentedCodeBlockSyntax)
    return { opening: opening('indentedCode', false, column + 4), closing: { ...Closing.none, leaf: 'indentedCode' } };
  if (node instanceof Syntax.HTMLBlockSyntax)
    return {
      opening: opening('html', node.startCondition !== 7, at),
      closing: { ...Closing.none, leaf: node.closed ? 'none' : 'html' }
    };
  if (node instanceof Syntax.HTMLTagBlockSyntax)
    return { opening: opening('html', false, at), closing: { ...Closing.none, leaf: 'html' } };
  if (node instanceof Syntax.LinkReferenceDefinitionSyntax)
    return {
      opening: opening('definition', false, at),
      closing: { ...Closing.none, leaf: node.titleField === null ? 'definition' : 'definitionComplete' }
    };
  if (node instanceof Syntax.TableSyntax)
    return { opening: opening('table', true, at), closing: { ...Closing.none, leaf: 'table' } };
  if (node instanceof Syntax.BulletListSyntax || node instanceof Syntax.OrderedListSyntax) {
    return {
      opening: readEdges(node.children[0], column, node.spelling.pattern).opening,
      closing: readEdges(node.children[node.children.length - 1], column, node.spelling.pattern).closing,
    };
  }
  if (node instanceof Syntax.BlockQuoteSyntax || node instanceof Syntax.CalloutSyntax) {
    const childColumn = after(node.spelling.whitespaceAfterMarker, at + 1);
    const tail = lastClosing(node.children, childColumn, node.spelling.end);
    return {
      opening: opening('blockQuote',
        node instanceof Syntax.CalloutSyntax || childrenOpenAfterMarker(node.children, node.spelling.start), at),
      closing: { ...Closing.none, leaf: Closing.paragraph(tail.leaf), openQuote: true },
    };
  }
  if (node instanceof Syntax.ListItemSyntax) return itemEdges(node, at, pattern);
  if (node instanceof Syntax.FootnoteDefinitionSyntax) {
    const continuation = column + 4;
    return {
      opening: opening('footnoteDefinition',
        !node.spelling.startsOnLabelLine || childrenOpenAfterMarker(node.children, node.spelling.start), at),
      closing: {
        ...lastClosing(node.children, continuation, node.spelling.end), continuation, openList: null,
        openQuote: false
      },
    };
  }
  throw new RangeError('No reading edges for ' + node.type);
}

function itemEdges(node: Syntax.ListItemSyntax, at: number, pattern: ListPattern | null): Edges {
  const spelling = node.spelling;
  const markerEnd = at + spelling.marker.length;
  const whitespace = after(spelling.whitespaceAfterMarker, markerEnd) - markerEnd;
  const continuation = markerEnd + (spelling.startsOnMarkerLine && whitespace <= 4 ? Math.max(1, whitespace) : 1);
  const tail = lastClosing(node.children, continuation, spelling.end);
  const first = node.children[0];
  const empty = node.checked === null && (!first || node.children.length === 1 &&
    first instanceof Syntax.ParagraphSyntax && first.bodyStart === first.bodyEnd);
  const interrupts = spelling.startsOnMarkerLine && !empty &&
    (spelling.marker.length === 1 || spelling.marker.slice(0, -1) === '1') &&
      childrenOpenAfterMarker(node.children, spelling.start);
  return {
    opening: opening('listItem', interrupts, at),
    closing: { ...tail, leaf: node.checked !== null && node.children.length === 1 ? 'paragraph' : tail.leaf,
      continuation, openList: pattern, openQuote: false },
  };
}

function lastClosing(children: readonly Syntax.BlockSyntax[], column: number, trailing: number): Closing {
  return trailing > 0 || !children.length ? Closing.none : readEdges(children[children.length - 1], column).closing;
}

/** Paragraph interruption follows nested markers down to their first content. */
function childrenOpenAfterMarker(children: readonly Syntax.BlockSyntax[], leading: number): boolean {
  return leading > 0 || !children.length || opensAfterMarker(readEdges(children[0], 0).opening);
}

function opening(kind: Opening.Kind, interruptsParagraph: boolean, column: number): Opening {
  return { kind, interruptsParagraph, column, frontMatter: null };
}
