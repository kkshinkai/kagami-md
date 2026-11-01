/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { HTMLBlockSyntax, HTMLTagBlockSyntax, ParagraphSyntax, parseBlocks, transduce } from '../syntax/index.js';
import type { Node } from 'prosemirror-model';
import { Plugin, PluginKey, type EditorState, type TextSelection, type Transaction } from 'prosemirror-state';
import { Decoration, type EditorView } from 'prosemirror-view';
import { convert, outerMargin, realize, update } from '../transform/transform.js';
import { CONCEALED, standIn, reveal, type SourcePresentation } from '../editor/reveal.js';
import { readBindings } from '../parse/bindings.js';
import { bindings } from '../state/bindings.js';
import { fieldOptions, fieldSource } from '../parse/field.js';
import { htmlTokens, type HTMLToken } from './htmlcolor.js';
import { parse } from '../parse/parse.js';
import { phrasing, type correction } from '../state/correction.js';
import { mapTextSelection } from '../state/selection.js';
import { meaning } from '../state/meaning.js';
import { activePending, setContent } from '../state/field.js';
import { isRevealed, type Revealing } from '../state/normalization.js';
import { image } from './image.js';

/** Present parser-owned HTML and follow the block reading of edited HTML source. */
export function html(): Plugin[] {
  return [html.presentation()];
}

export namespace html {
  /** Follow the edited HTML fields in the shared reading plan. */
  export function correction(tr: Transaction, fields: correction.Fields, state: EditorState): void {
    const reading = new HTMLCorrection(tr, bindings.get(state));
    for (const position of fields.textblocks(tr)) reading.read(position);
    fields.updates.push(...reading.updates);
  }

  /** An edited HTML block keeps only a frame that its source still expresses. */
  /** Color HTML source, show line breaks, and conceal the source of displayed images. */
  export function presentation(): Plugin<SourcePresentation> {
    return new Plugin({
      key: presentationKey,
      state: reveal.state(draw),
      props: {
        decorations(state) {
          return presentationKey.getState(state)?.decorations ?? null;
        },
      },
    });
  }
}

const presentationKey = new PluginKey<SourcePresentation>('html-source');

class HTMLCorrection {
  readonly updates: phrasing.Update[] = [];

  constructor(readonly transaction: Transaction, readonly bindings: bindings.State) {}

  read(position: number): void {
    const tr = this.transaction;
    const node = tr.doc.nodeAt(position);
    const types = tr.doc.type.schema.nodes;
    if (!node || node.type !== types.htmlBlock && node.type !== types.htmlTagBlock) return;
    const margin = outerMargin(node);
    const text = margin + fieldSource(node);
    const current = bindings.after(this.bindings, tr);
    const blocks = parseBlocks(text, { target: 'editor' }, current);
    const first = blocks[0];
    if (blocks.length === 1 && node.type === types.htmlBlock && first instanceof HTMLBlockSyntax &&
        first.start + first.leading === margin.length && first.content === fieldSource(node)) return;
    if (blocks.length === 1 && node.type === types.htmlTagBlock && first instanceof HTMLTagBlockSyntax) {
      const parsed = parse.blocks(blocks, text, tr.doc.type.schema).firstChild!;
      if (fieldSource(parsed) === fieldSource(node)) {
        update(tr, position, meaning(parsed));
        return;
      }
    }
    const start = tr.mapping.maps.length;
    // An HTML frame that disappeared may have left an unfinished Markdown
    // opening. Its paragraph waits under the same Pending rule as other text.
    const at = tr.doc.resolve(position + 1);
    const options = fieldOptions(types.paragraph.create(), at.depth > 1 ? at.node(-1) : null, at.index(-1));
    const settled = blocks.length === 1 &&
      (first instanceof ParagraphSyntax || first instanceof HTMLBlockSyntax || first instanceof HTMLTagBlockSyntax);
    const pending = !settled &&
      activePending(tr.selection, position, fieldSource(node)) ? transduce(text, options, current) : null;
    if (pending?.kind === 'pending') {
      convert(tr, position, types.paragraph, {});
      if (margin) tr.insertText(margin, position + 1);
      setContent(tr, position, pending.frontier, text, pending.references);
    } else if (blocks.length) {
      mapTextSelection(tr, range => realize(tr, position, blocks, text, margin.length, range));
    } else convert(tr, position, types.paragraph, {});
    const mapping = tr.mapping.slice(start);
    this.updates.push({
      bindings: readBindings.blocks(blocks, current),
      completed: phrasing.completed(tr.doc, mapping.map(position, -1), mapping.map(position + node.nodeSize, 1)),
    });
  }
}

/** Collect colors from token offsets without recognizing HTML in unmarked text. */
class HTMLColors {
  readonly decorations: Decoration[] = [];
  constructor(readonly visible: Revealing) {}

  color(base: number, from: number, to: number, kind: string): void {
    if (from < to) this.decorations.push(Decoration.inline(base + from, base + to, { class: `md-html-${kind}` }));
  }

  token(token: HTMLToken, base: number): void {
    if (token.kind !== 'open' && token.kind !== 'close') {
      this.color(base, token.from, token.to, 'comment');
      return;
    }
    this.color(base, token.from, token.nameFrom, 'punctuation');
    this.color(base, token.nameFrom, token.nameTo, 'name');
    let position = token.nameTo;
    for (const attribute of token.attributes) {
      this.color(base, position, attribute.nameFrom, 'punctuation');
      this.color(base, attribute.nameFrom, attribute.nameTo, 'attribute');
      position = attribute.nameTo;
      if (attribute.valueFrom === undefined) continue;
      this.color(base, position, attribute.valueFrom, 'punctuation');
      this.color(base, attribute.valueFrom, attribute.valueTo!, 'value');
      position = attribute.valueTo!;
    }
    this.color(base, position, token.to, 'punctuation');
  }

  read(node: Node, position: number): void {
    if (!node.isTextblock) {
      node.forEach((child, offset) => this.read(child, position + 1 + offset));
      return;
    }
    for (const occurrence of image.html(node, position + 1)) {
      if (!isRevealed(this.visible, occurrence)) {
        this.decorations.push(Decoration.inline(occurrence.from, occurrence.to, { class: CONCEALED }));
      }
    }
    for (const occurrence of htmlTokens(node, position)) {
      const { token, base } = occurrence;
      if (htmlTokens.isLineBreak(occurrence)) {
        this.color(base, token.from, token.to, 'faint');
        this.decorations.push(standIn(base + token.to, lineBreak, {
          side: -1, ignoreSelection: true, key: 'md-html-line-break',
        }));
      } else {
        this.token(token, base);
      }
    }
  }
}

function lineBreak(view: EditorView): HTMLElement {
  const element = view.dom.ownerDocument.createElement('br');
  element.className = 'md-html-line-break';
  return element;
}

function draw(node: Node, position: number, _state: EditorState, _selection: TextSelection | null,
  visible: Revealing): Decoration[] {
  const colors = new HTMLColors(visible);
  colors.read(node, position);
  return colors.decorations;
}
