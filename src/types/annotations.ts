/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { DOMNode } from '../editor/dom.js';
import {
  BackslashEscapeSyntax, CharacterReferenceSyntax, FootnoteReferenceSyntax,
  TagSyntax, WikilinkSyntax, transduce,
  type Frontier, type Syntax,
} from '../syntax/index.js';
import { Fragment, type Schema, type MarkType } from 'prosemirror-model';

/** The tree carried beside clipboard HTML preserves open slice edges. */
export const treeAttribute = 'data-kagami-tree';

/** Blocks whose rendered HTML carries their complete Markdown source. */
export const annotatedBlockKinds: ReadonlySet<string> = new Set([
  'callout', 'linkReferenceDefinition', 'footnoteDefinition',
]);

/** Read complete source annotations, or find the complete annotations in copied inline text. */
export function readAnnotation(
  source: string, kind: string, mode: readAnnotation.Mode = 'atxHeading', identifier?: string,
): Syntax | undefined {
  const reading = transduce(source, {
    phrasing: mode, firstInListItem: false, firstInBlockQuote: false,
  }, { definition: () => undefined, footnote: label => label === identifier });
  if (reading.kind !== 'inline' || reading.children.length !== 1) return;
  const node = reading.children[0]!;
  if (node.start !== 0 || node.end !== source.length || annotationKind(node) !== kind) return;
  if (node instanceof FootnoteReferenceSyntax && node.identifier !== identifier) return;
  return node;
}

export namespace readAnnotation {
  export type Mode = 'atxHeading' | 'tableCell';
  export type Kind = 'footnoteLabel' | 'wikilink' | 'tag';
  export type Value = {
    from: number;
    to: number;
    source: string;
    display: string;
  } & ({ kind: 'footnoteLabel'; identifier: string } | { kind: 'wikilink' | 'tag' });

  /** A copied mark may be truncated. The reader proves a complete construct in the selected
   * characters; the original frontier marks prove that it had semantic presentation there. */
  export function fragment(content: Fragment, mode: Mode): Map<number, Value> {
    return new AnnotationContext(content, mode).read();
  }

  /** Source and structure carried beside rendered HTML. */
  export interface CarriedTree {
    fragment: Fragment;
    carrier: globalThis.Element;
  }

  /** A tree from an incompatible schema falls back to the HTML beside it. */
  export function tree(dom: DOMNode, schema: Schema): CarriedTree | null {
    if (dom.nodeType !== 1 && dom.nodeType !== 11) return null;
    let carrier = dom.nodeType === 1
      ? (dom as globalThis.Element).closest(`[${treeAttribute}]`) : null;
    if (!carrier) carrier = (dom as globalThis.Element | DocumentFragment).querySelector(`[${treeAttribute}]`);
    const json = carrier?.getAttribute(treeAttribute);
    if (!carrier || !json) return null;
    try {
      const fragment = Fragment.fromJSON(schema, JSON.parse(json));
      fragment.forEach(node => node.check());
      return { fragment, carrier };
    } catch {
      return null;
    }
  }

  /** Complete formula selections keep their defining frame. */
  export function insideField(fragment: Fragment, carrier: globalThis.Element): boolean {
    if (fragment.childCount !== 1 || !fragment.firstChild!.isTextblock) return false;
    if (carrier.getAttribute('data-math-display') === 'block') return false;
    const depths = /^(\d+) (\d+)/.exec(carrier.closest('[data-pm-slice]')?.getAttribute('data-pm-slice') ?? '');
    return depths !== null && Number(depths[1]) > 0 && Number(depths[2]) > 0;
  }

  /** Recognize PM's explicit clipboard envelope, never infer a copied slice from its node types.
   * The native view still owns parsing/restoring the declared depths and ancestor context. */
  export function hasSlice(dom: DOMNode): boolean {
    if (dom.nodeType !== 1) return false;
    const element = dom as globalThis.Element;
    const carrier = element.closest('[data-pm-slice]') ?? element.querySelector('[data-pm-slice]');
    const metadata = carrier?.getAttribute('data-pm-slice');
    return Boolean(metadata && /^(\d+) (\d+)(?: -(\d+))? (.*)/.test(metadata));
  }
}

interface Piece {
  from: number;
  to: number;
  marks: readonly MarkType[];
}

class AnnotationContext {
  source = '';
  boundaries = new Set([0]);
  pieces: Piece[] = [];
  footnotes = new Set<string>();

  constructor(readonly content: Fragment, readonly mode: readAnnotation.Mode) {}

  read(): Map<number, readAnnotation.Value> {
    const result = new Map<number, readAnnotation.Value>();
    if (!this.content.firstChild?.isInline) return result;
    this.content.forEach((node, offset) => {
      this.source += node.isText ? node.text! : '\n';
      this.boundaries.add(this.source.length);
      this.pieces.push({ from: offset, to: offset + node.nodeSize, marks: node.marks.map(mark => mark.type) });
      for (const mark of node.marks)
        if (mark.type === node.type.schema.marks.footnoteReference) this.footnotes.add(mark.attrs.identifier);
    });
    const reading = transduce(this.source, {
      phrasing: this.mode, firstInListItem: false, firstInBlockQuote: false,
    }, { definition: () => undefined, footnote: label => this.footnotes.has(label) });
    if (reading.kind !== 'inline') return result;
    const marks = this.content.firstChild.type.schema.marks;
    for (const node of new Set(reading.frontier.flatMap(piece => piece.nodes))) {
      if (!(node instanceof FootnoteReferenceSyntax || node instanceof WikilinkSyntax || node instanceof TagSyntax))
        continue;
      if (!this.boundaries.has(node.start) || !this.boundaries.has(node.end)) continue;
      const kind = annotationKind(node)!;
      const mark = kind === 'footnoteLabel' ? marks.footnoteReference : marks[kind];
      if (!this.pieces.some(piece => piece.to > node.start && piece.from < node.end && piece.marks.includes(mark)))
        continue;
      const value = {
        from: node.start, to: node.end,
        source: this.portable(node, reading.frontier), display: this.display(node),
      };
      if (node instanceof FootnoteReferenceSyntax)
        result.set(node.start, { ...value, kind: 'footnoteLabel', identifier: node.identifier });
      else result.set(node.start, { ...value, kind: node.type });
    }
    return result;
  }

  portable(node: Syntax, frontier: Frontier): string {
    if (this.mode !== 'tableCell') return this.source.slice(node.start, node.end);
    let from = node.start;
    let text = '';
    for (const piece of frontier) {
      if (piece.start < node.start || piece.end > node.end) continue;
      if (piece.nodes[piece.nodes.length - 1].type !== 'tablePipeEscape') continue;
      text += this.source.slice(from, piece.start);
      from = piece.end;
    }
    return text + this.source.slice(from, node.end);
  }

  display(node: FootnoteReferenceSyntax | WikilinkSyntax | TagSyntax): string {
    if (node instanceof WikilinkSyntax) return node.displayText ?? node.destination;
    if (!(node instanceof FootnoteReferenceSyntax)) return this.source.slice(node.start, node.end);
    return node.children.map(part => {
      if (part instanceof BackslashEscapeSyntax) return this.source.slice(part.character.start, part.character.end);
      if (part instanceof CharacterReferenceSyntax) return part.character;
      return this.source.slice(part.start, part.end);
    }).join('');
  }
}

function annotationKind(node: Syntax): readAnnotation.Kind | null {
  if (node instanceof FootnoteReferenceSyntax) return 'footnoteLabel';
  if (node instanceof WikilinkSyntax || node instanceof TagSyntax) return node.type;
  return null;
}
