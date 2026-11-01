/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Mark, Node } from 'prosemirror-model';
import { fieldSource } from '../parse/field.js';

/** An attribute's name and optional value, relative to the token's input. */
interface HTMLAttribute {
  readonly nameFrom: number;
  readonly nameTo: number;
  readonly valueFrom?: number;
  readonly valueTo?: number;
}

/** One HTML token. No relation between opening and closing tokens is implied. */
export type HTMLToken = HTMLTag | HTMLSpecial;

interface HTMLTag {
  readonly kind: 'open' | 'close';
  readonly from: number;
  readonly to: number;
  readonly nameFrom: number;
  readonly nameTo: number;
  readonly name: string;
  readonly attributes: readonly HTMLAttribute[];
  readonly selfClosing: boolean;
}

type HTMLSpecialKind = 'comment' | 'instruction' | 'declaration' | 'cdata';

interface HTMLSpecial {
  readonly kind: HTMLSpecialKind;
  readonly from: number;
  readonly to: number;
}

/** An HTML token and the document position of the input it was read from. */
interface HTMLOccurrence {
  readonly token: HTMLToken;
  readonly base: number;
  readonly lineBreak: boolean;
}

const rawText = new Set(['pre', 'script', 'style', 'textarea']);

function letter(code: number): boolean {
  return code >= 65 && code <= 90 || code >= 97 && code <= 122;
}

function digit(code: number): boolean {
  return code >= 48 && code <= 57;
}

function whitespace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13;
}

class HTMLReader {
  constructor(readonly text: string, readonly from: number) {}

  space(at: number): number {
    while (whitespace(this.text.charCodeAt(at))) at++;
    return at;
  }

  name(at: number): number {
    if (!letter(this.text.charCodeAt(at))) return -1;
    for (at++; at < this.text.length; at++) {
      const code = this.text.charCodeAt(at);
      if (code !== 45 && !letter(code) && !digit(code)) break;
    }
    return at;
  }

  delimited(kind: HTMLSpecialKind, opening: string, closing: string): HTMLSpecial | null {
    if (!this.text.startsWith(opening, this.from)) return null;
    const end = this.text.indexOf(closing, this.from + opening.length);
    return end < 0 ? null : { kind, from: this.from, to: end + closing.length };
  }

  read(): HTMLToken | null {
    const { text, from } = this;
    if (text[from] !== '<') return null;
    if (text[from + 1] === '?') return this.delimited('instruction', '<?', '?>');
    if (text[from + 1] === '!') {
      if (text.startsWith('<!-->', from)) return { kind: 'comment', from, to: from + 5 };
      if (text.startsWith('<!--->', from)) return { kind: 'comment', from, to: from + 6 };
      if (text.startsWith('<!--', from)) return this.delimited('comment', '<!--', '-->');
      if (text.startsWith('<![CDATA[', from)) return this.delimited('cdata', '<![CDATA[', ']]>');
      if (letter(text.charCodeAt(from + 2))) return this.delimited('declaration', '<!', '>');
      return null;
    }
    const closing = text[from + 1] === '/';
    const nameFrom = from + (closing ? 2 : 1);
    const nameTo = this.name(nameFrom);
    if (nameTo < 0) return null;
    const attributes: HTMLAttribute[] = [];
    let at = nameTo;
    if (closing) {
      at = this.space(at);
      if (text[at] !== '>') return null;
      return { kind: 'close', from, to: at + 1, nameFrom, nameTo,
        name: text.slice(nameFrom, nameTo).toLowerCase(), attributes, selfClosing: false };
    }
    for (;;) {
      const before = at;
      at = this.space(at);
      if (text[at] === '>' || text[at] === '/' && text[at + 1] === '>') {
        const selfClosing = text[at] === '/';
        return { kind: 'open', from, to: at + (selfClosing ? 2 : 1), nameFrom, nameTo,
          name: text.slice(nameFrom, nameTo).toLowerCase(), attributes, selfClosing };
      }
      const code = text.charCodeAt(at);
      if (before === at || !letter(code) && code !== 58 && code !== 95) return null;
      const attributeFrom = at++;
      while (at < text.length) {
        const next = text.charCodeAt(at);
        if (!letter(next) && !digit(next) && next !== 45 && next !== 46 && next !== 58 && next !== 95) break;
        at++;
      }
      const attributeTo = at;
      const afterName = this.space(at);
      if (text[afterName] !== '=') {
        attributes.push({ nameFrom: attributeFrom, nameTo: attributeTo });
        continue;
      }
      at = this.space(afterName + 1);
      const quote = text[at];
      if (quote === '"' || quote === "'") {
        const end = text.indexOf(quote, at + 1);
        if (end < 0) return null;
        attributes.push({ nameFrom: attributeFrom, nameTo: attributeTo, valueFrom: at + 1, valueTo: end });
        at = end + 1;
        if (text[at] !== '/' && text[at] !== '>' && !whitespace(text.charCodeAt(at))) return null;
      } else {
        const valueFrom = at;
        for (; at < text.length; at++) {
          const character = text[at];
          if (character === '"' || character === "'" || character === '<' || character === '=' || character === '`')
            return null;
          if (character === '>' || whitespace(text.charCodeAt(at))) break;
        }
        if (at === valueFrom || at === text.length) return null;
        attributes.push({ nameFrom: attributeFrom, nameTo: attributeTo, valueFrom, valueTo: at });
      }
    }
  }
}

/** Read the tokens in text the Markdown parser has classified as HTML. */
function readHTML(text: string): HTMLToken[] {
  const result: HTMLToken[] = [];
  for (let at = text.indexOf('<'); at >= 0;) {
    const token = readHTML.token(text, at);
    if (token) result.push(token);
    at = text.indexOf('<', token ? token.to : at + 1);
  }
  return result;
}

namespace readHTML {
  /** Read one token beginning at the given offset. */
  export function token(text: string, from: number): HTMLToken | null {
    return new HTMLReader(text, from).read();
  }

  /** Raw-text blocks expose their opening and closing tags only. */
  export function block(text: string): HTMLToken[] {
    const from = text.search(/\S/);
    const first = from < 0 ? null : token(text, from);
    if (!first || first.kind !== 'open' || !rawText.has(first.name)) return readHTML(text);
    const result = [first];
    for (let at = text.indexOf('</', first.to); at >= 0; at = text.indexOf('</', at + 2)) {
      const closing = token(text, at);
      if (closing?.kind === 'close' && rawText.has(closing.name)) {
        result.push(closing);
        break;
      }
    }
    return result;
  }
}

/** Read a textblock's parser-marked HTML runs at its document position. */
export function htmlTokens(textblock: Node, position: number): HTMLOccurrence[] {
  const result: HTMLOccurrence[] = [];
  const { nodes, marks } = textblock.type.schema;
  if (textblock.type === nodes.htmlBlock || textblock.type === nodes.htmlTagBlock) {
    const text = fieldSource(textblock);
    for (const token of readHTML.block(text)) {
      result.push({
        token, base: position + 1,
        lineBreak: textblock.type === nodes.htmlTagBlock && textblock.attrs.tag === 'htmlLineBreak'
      });
    }
    return result;
  }
  let text = '';
  let base = 0;
  let offset = 0;
  let previous: Mark | undefined;
  for (let index = 0; index <= textblock.childCount; index++) {
    const child = textblock.maybeChild(index);
    const marked = child?.marks.find(mark =>
      mark.type === marks.rawHTML || mark.type === marks.htmlComment ||
      mark.type === marks.htmlLineBreak || mark.type === marks.htmlImage);
    if (text && (!marked || !previous?.eq(marked))) {
      for (const token of readHTML(text))
        result.push({ token, base, lineBreak: previous?.type === marks.htmlLineBreak });
      text = '';
    }
    if (marked) {
      if (!text) base = position + 1 + offset;
      text += child!.isText ? child!.text! : '\n';
    }
    previous = marked;
    if (child) offset += child.nodeSize;
  }
  return result;
}

export namespace htmlTokens {
  export function isLineBreak(occurrence: HTMLOccurrence): boolean {
    return occurrence.lineBreak;
  }
}
