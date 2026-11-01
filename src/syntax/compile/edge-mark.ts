/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { TextTokenSyntax } from '../syntax/inline.js';
import { HeadingSyntax, ParagraphSyntax, TableCellSyntax } from '../syntax/block.js';
import type { Token } from '../types/index.js';

import type { CompileContext, Extension } from './types.js';
import { needsEdgeMark, type EdgeMarkKind, type EdgeMarkPlace } from '../syntax/edge-mark.js';

declare module './types.js' {
  interface CompileData {
    /**
     * ZWSP edge mark: a candidate at the start of a field, waiting for the
     * field to be whole.
     */
    edgeMark?: Token | undefined;
  }
}

/**
 * ZWSP edge mark: create an extension to find the mark at the start of a
 * paragraph, a heading or a table cell
 * (private-docs/deviations/zwsp-edge-mark.md).
 *
 * @returns
 *   Extension.
 */
export function edgeMarkFromMarkdown(): Extension {
  return {
    exit: {
      edgeMarkCandidate: exitEdgeMarkCandidate,
    },
  };
}

function exitEdgeMarkCandidate(this: CompileContext, token: Token): undefined {
  this.data.edgeMark = token;
}

/**
 * ZWSP edge mark: when the text of `node`, which `field` spans, is whole, ask
 * the predicate whether the candidate at its start is the mark.
 * The mark is block syntax and a gap; anything else is the first character of
 * the text.
 * A paragraph or a heading of only spaces after the mark is read back with
 * them; the specification strips them at the end of a line, and so no other
 * token holds them as text.
 *
 * @param node
 *   Node whose text the field is.
 * @param field
 *   Start and end of the field.
 * @param kind
 *   What the field is.
 * @param also
 *   What the place of a paragraph offers.
 * @returns
 *   The mark, or nothing.
 */
export function exitEdgeMark(
  this: CompileContext,
  node: HeadingSyntax | ParagraphSyntax | TableCellSyntax,
  field: Token.Range,
  kind: EdgeMarkKind,
  also?: Required<EdgeMarkPlace> | undefined
): Token | undefined {
  const candidate = this.data.edgeMark;

  if (!candidate) {
    return undefined;
  }

  this.data.edgeMark = undefined;
  // ZWSP edge mark: on the first line, no container prefix lies between the
  // field and the candidate, so their physical distance is also their text
  // distance. Later-line candidates follow a multiline task check: both
  // points then belong to the paragraph's inline tokenizer, which removes
  // the intervening container prefixes. Heading frames instead belong to
  // the flow tokenizer and cannot be sliced with an inline token's indices.
  let value = '';
  if (candidate.end.offset !== field.end.offset) {
    if (candidate.start.line === field.start.line) {
      value = this.sliceSerialize(field).slice(candidate.end.offset - field.start.offset);
    } else {
      value = this.sliceSerialize({ start: candidate.end, end: field.end });
    }
  }

  if (!needsEdgeMark(value.replace(/\r\n?/g, '\n'), kind, also)) {
    const head = node.children[0];

    // The character is text, and text that touches it is one piece with it.
    if (head && head.type === 'text' && head.start === candidate.end.offset) {
      head.start = candidate.start.offset;
    } else {
      node.children.unshift(
        new TextTokenSyntax('text', candidate.start.offset, candidate.end.offset)
      );
    }

    return undefined;
  }

  // ZWSP edge mark: an empty field has no first child to establish its
  // content boundary when the node closes. Its insertion point follows
  // the recognized mark just as nonempty content does.
  node.leading = candidate.end.offset - node.start;

  // ZWSP edge mark: a suffix that is the whole field after the mark is
  // text, as the empty-children case below was before suffix trivia existed.
  const tail = node.children[0];
  if (
    node.children.length === 1 &&
    tail?.type === 'trailingWhitespace' &&
    tail.start === candidate.end.offset &&
    tail.end === field.end.offset &&
    kind !== 'tableCell'
  ) {
    node.children[0] = new TextTokenSyntax('text', tail.start, tail.end);
  }

  if (
    node.children.length === 0 &&
    field.end.offset > candidate.end.offset &&
    kind !== 'tableCell'
  ) {
    node.children.push(new TextTokenSyntax('text', candidate.end.offset, field.end.offset));
  }

  return candidate;
}
