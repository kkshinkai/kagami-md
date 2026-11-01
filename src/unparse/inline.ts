/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  Bindings, CodeSpanSyntax, HTMLTagBlockSyntax, repairPhrasing, transduce,
  type TransduceOptions
} from '../syntax/index.js';
import { Fragment, Slice, Mark, type Node, type ResolvedPos } from 'prosemirror-model';
import { parse } from '../parse/parse.js';
import { fieldOptions } from '../parse/field.js';

/** Write formatting read from HTML as editable source, keeping the native block structure. */
export function inlineSource(slice: Slice, document: Node, bindings: Bindings, context?: ResolvedPos): Slice {
  const writer = new SourceContext(bindings, context);
  if (slice.content.firstChild?.isInline) {
    const field = document.type.schema.nodes.paragraph.create(null, slice.content);
    return new Slice(writer.node(field, null, 0).content, slice.openStart, slice.openEnd);
  }
  return new Slice(writer.fragment(slice.content), slice.openStart, slice.openEnd);
}

/** The destination's phrasing and bindings shared by one imported slice. */
class SourceContext {
  readonly table: boolean;
  readonly oneLine: boolean;

  constructor(readonly bindings: Bindings, context?: ResolvedPos) {
    this.table = Boolean(context && Array.from({ length: context.depth + 1 }, (_, depth) =>
      context.node(depth)).some(node => node.type.spec.tableRole === 'table'));
    this.oneLine = this.table || context?.parent.type.name === 'calloutTitle' ||
      context?.parent.type.name === 'heading' && context.parent.attrs.form === 'atx';
  }

  fragment(content: Fragment, parent: Node | null = null): Fragment {
    return Fragment.fromArray(content.content.map((node, index) => this.node(node, parent, index)));
  }

  node(node: Node, parent: Node | null, index: number): Node {
    // Markdown annotations already contain source, including its occurrence marks.
    if (node.attrs.spelling != null || node.type.spec.code || node.isLeaf) return node;
    if (!node.isTextblock) return node.copy(this.fragment(node.content, node));
    const options = fieldOptions(node, parent, index);
    const table = this.table || options.phrasing === 'tableCell';
    const oneLine = this.oneLine || table || options.phrasing === 'atxHeading' || options.phrasing === 'calloutTitle';
    const writer = new InlineWriter(table, oneLine);
    const references = needsReferences(node.content.content);
    const protectedText = repairSource(writer.write(node.content.content, references ? 'references' : 'escaped'),
      options, false);
    const literalText = repairSource(writer.write(node.content.content, references ? 'references' : 'literal'), options,
      true);
    const protectedContent = this.read(protectedText, node, options);
    const literalContent = this.read(literalText, node, options);
    const blocks = transduce(protectedText, { ...options, settle: true }, this.bindings);
    if (blocks.kind === 'blocks' && blocks.blocks.length === 1 && blocks.blocks[0] instanceof HTMLTagBlockSyntax)
      return parse.block(blocks.blocks[0], protectedText, node.type.schema);
    if (!protectedContent) throw new RangeError('Imported formatting must write inline source');
    return node.copy(literalContent && rendered(literalContent).eq(rendered(protectedContent))
      ? literalContent : protectedContent);
  }

  read(source: string, node: Node, options: TransduceOptions): Fragment | null {
    const reading = transduce(source,
      { ...options, phrasing: options.phrasing === 'paragraph' ? 'atxHeading' : options.phrasing, settle: true },
      this.bindings);
    return reading.kind === 'inline' ? parse.content(reading.frontier, source, node.type.schema) : null;
  }
}

type Spelling = 'literal' | 'escaped' | 'references';

/** Write marked siblings, opening the longest enclosing mark first. */
class InlineWriter {
  constructor(readonly table: boolean, readonly oneLine: boolean) {}

  write(nodes: readonly Node[], spelling: Spelling): string {
    let result = '';
    for (let index = 0; index < nodes.length;) {
      const node = nodes[index]!;
      let mark: Mark | undefined;
      let end = index;
      for (const candidate of node.marks) {
        let limit = index + 1;
        while (limit < nodes.length && nodes[limit]!.marks.some(next => candidate.type.name === 'codeSpan'
          ? next.type === candidate.type && Mark.sameSet(candidate.type.removeFromSet(node.marks),
            candidate.type.removeFromSet(nodes[limit]!.marks)) : next.eq(candidate))) limit++;
        if (limit > end || limit === end && mark?.type.name === 'codeSpan') { mark = candidate; end = limit; }
      }
      if (!mark) {
        const text = node.isText ? node.text! : '\n';
        result += spelling === 'literal' ? text : spelling === 'references'
          ? Array.from(text, character => /\s/u.test(character) ? character : `&#${character.codePointAt(0)};`).join('')
          : text.replace(/[!-/:-@\[-`{-~]/g, '\\$&');
        index++;
        continue;
      }
      const marked = nodes.slice(index, end).map(child => child.mark(mark!.type.removeFromSet(child.marks)));
      const raw = marked.map(child => child.isText ? child.text! : '\n').join('');
      switch (mark.type.name) {
        case 'codeSpan': result += this.code(raw); break;
        case 'htmlImage': result += this.table ? repairTable(raw) : raw; break;
        case 'inlineMath': case 'wikilink': case 'tag': case 'footnoteReference':
          result += this.table ? repairTable(raw) : raw;
          break;
        case 'htmlLineBreak': result += this.oneLine ? raw : raw.replaceAll('<br/>', '\\\n'); break;
        case 'inlineLink': {
          const label = this.write(marked, spelling);
          result += '[' + label + ']' + this.target(mark);
          break;
        }
        case 'strongEmphasis': result += this.delimit(marked, spelling === 'references' ? '__' : '**', spelling); break;
        case 'emphasis': result += this.delimit(marked, '*', spelling); break;
        case 'strikethrough': result += this.delimit(marked, '~~', spelling); break;
        case 'highlight': result += this.delimit(marked, '==', spelling); break;
        default: result += this.write(marked, spelling);
      }
      index = end;
    }
    return this.table ? repairTable(result) : result;
  }

  target(mark: Mark): string {
    const destination = String(mark.attrs.destination).replace(/[\\<>&\n]/g, character =>
      character === '\n' ? '%0A' : '\\' + character);
    const title = mark.attrs.title === null ? '' : ' "' + String(mark.attrs.title).replace(/[\\"&]/g, '\\$&') + '"';
    return '(<' + destination + '>' + title + ')';
  }

  delimit(nodes: readonly Node[], delimiter: string, spelling: Spelling): string {
    const text = this.write(nodes, spelling);
    const start = text.match(/^\s*/u)![0];
    const end = text.slice(start.length).match(/\s*$/u)![0];
    const body = text.slice(start.length, text.length - end.length);
    return body ? start + delimiter + body + delimiter + end : text;
  }

  code(text: string): string {
    const longest = Math.max(0, ...Array.from(text.matchAll(/`+/g), match => match[0].length));
    const fence = '`'.repeat(longest + 1);
    const padding = /^`|`$/.test(text) || /^ .* $/.test(text) && /[^ ]/.test(text) ? ' ' : '';
    const source = fence + padding + text + padding + fence;
    if (!this.table) return source;
    const repaired = repairTable(source);
    const reading = transduce(repaired, { phrasing: 'tableCell' }, Bindings.none);
    const syntax = reading.kind === 'inline' && reading.children.length === 1 ? reading.children[0] : null;
    if (syntax instanceof CodeSpanSyntax && syntax.code === text) return repaired;
    return '<code>' + text.replace(/[!-/:-@\[-`{-~]/g, character => `&#${character.charCodeAt(0)};`) + '</code>';
  }
}

/** Keep the imported field's grammar without promoting its text into blocks. */
function repairSource(text: string, options: TransduceOptions, escapeBlocks: boolean): string {
  for (const repair of repairPhrasing(text, options.phrasing, { escapeBlocks }).reverse())
    text = text.slice(0, repair.start) + repair.insert + text.slice(repair.end);
  return text;
}

function repairTable(text: string): string {
  for (const repair of repairPhrasing(text, 'tableCell').reverse())
    text = text.slice(0, repair.start) + repair.insert + text.slice(repair.end);
  return text;
}

/** CommonMark delimiters cannot flank punctuation beside an unformatted letter. */
function needsReferences(nodes: readonly Node[]): boolean {
  const punctuation = (character: string) => /[\p{P}\p{S}]/u.test(character);
  const word = (character: string) => character !== '' && !/\s/u.test(character) && !punctuation(character);
  for (let index = 0; index < nodes.length; index++) {
    for (const mark of nodes[index]!.marks) {
      if (!['emphasis', 'strongEmphasis', 'strikethrough', 'highlight'].includes(mark.type.name) ||
          index > 0 && mark.isInSet(nodes[index - 1]!.marks)) continue;
      let end = index + 1;
      while (end < nodes.length && mark.isInSet(nodes[end]!.marks)) end++;
      const raw = nodes.slice(index, end).map(node => node.isText ? node.text! : '\n').join('');
      const characters = Array.from(raw);
      const before = Array.from(nodes[index - 1]?.text ?? '').at(-1) ?? '';
      const after = Array.from(nodes[end]?.text ?? '')[0] ?? '';
      if (punctuation(characters[0] ?? '') && word(before) || punctuation(characters.at(-1) ?? '') && word(after))
        return true;
    }
  }
  return false;
}

/** Compare character meaning without the spelling of escapes or occurrence identities. */
function rendered(content: Fragment): Fragment {
  const result: Node[] = [];
  content.forEach(node => {
    const types = node.type.schema.marks;
    if (node.marks.some(mark => mark.type === types.meta)) return;
    const marks = node.marks.filter(mark => mark.type !== types.backslashEscape).map(mark =>
      mark.type.create(Object.fromEntries(Object.entries(mark.attrs).filter(([name]) => name !== 'occurrence'))));
    result.push(node.mark(marks));
  });
  return Fragment.fromArray(result);
}
