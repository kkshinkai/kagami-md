/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { DOMNode } from '../editor/dom.js';
import { Bindings,
  CharacterReferenceSyntax, InlineMathSyntax, transduce, emojiForShortcode, type Syntax,
} from '../syntax/index.js';
import {
  DOMSerializer, Fragment, Slice, type DOMOutputSpec, type Mark, type Node,
  type ResolvedPos, type Schema,
} from 'prosemirror-model';
import { schema } from '../types/schema.js';
import { annotatedBlockKinds, treeAttribute, readAnnotation } from '../types/annotations.js';
import { unparse } from './unparse.js';

const annotatedBlocks = new Set([...annotatedBlockKinds].map(name => schema.nodes[name]));
const images = new Set([schema.marks.inlineImage, schema.marks.fullReferenceImage,
  schema.marks.collapsedReferenceImage, schema.marks.shortcutReferenceImage, schema.marks.htmlImage,
  schema.marks.wikiEmbed]);
const visibleMeta = new Set([schema.marks.rawHTML, schema.marks.htmlComment, schema.marks.htmlLineBreak,
  schema.marks.characterReference, schema.marks.emojiShortcode]);
const annotatedMarks = new Map([
  [schema.marks.wikilink, 'wikilink'], [schema.marks.tag, 'tag'], [schema.marks.footnoteReference, 'footnoteLabel'],
]);

/** Portable slice HTML with source annotations for Kagami constructs. */
export class HTMLSerializer extends DOMSerializer {
  constructor(schema: Schema, readonly document?: () => Node) {
    super({
      ...DOMSerializer.nodesFromSchema(schema),
      lineEnding: () => ['br'],
      codeBlock: node => ['pre', ['code', node.attrs.language ? { class: `language-${node.attrs.language}` } : {}, 0]],
      listItem: node => node.attrs.checked === null ? ['li', 0] : ['li', { class: 'task-list-item' },
        ['input', { type: 'checkbox', disabled: '', ...(node.attrs.checked ? { checked: '' } : {}) }], ['div', 0]],
    }, {
      strongEmphasis: () => ['strong', 0],
      emphasis: () => ['em', 0],
      strikethrough: () => ['del', 0],
      highlight: () => ['mark', 0],
      codeSpan: () => ['code', 0],
      inlineLink: link,
      fullReferenceLink: link,
      collapsedReferenceLink: link,
      shortcutReferenceLink: link,
      autolink: link,
      literalAutolink: link,
      footnoteReference: () => ['sup', 0],
    });
  }

  override serializeFragment(fragment: Fragment, options: { document?: Document } = {},
    target?: HTMLElement | DocumentFragment): HTMLElement | DocumentFragment {
    const document = options.document ?? globalThis.document;
    const output = target ?? document.createDocumentFragment();
    const context = new SerializeContext(this, document, this.document?.());
    context.fragment(fragment, output);
    if (fragment.firstChild?.isBlock && output.firstChild?.nodeType === 1) {
      (output.firstChild as HTMLElement).setAttribute(treeAttribute, JSON.stringify(selectedTree(fragment).toJSON()));
    }
    context.tableAlignment(fragment, output);
    return output;
  }
}

interface OpenMark {
  readonly mark: Mark;
  readonly content: HTMLElement;
}

/** The document and serializer shared by a single HTML walk. */
class SerializeContext {
  readonly math = new Map<Node, ResolvedPos>();

  constructor(readonly serializer: DOMSerializer, readonly dom: Document, readonly document?: Node) {
    document?.descendants((node, position) => {
      if (node.type === schema.nodes.mathBlock) this.math.set(node, document.resolve(position));
    });
  }

  fragment(fragment: Fragment, output: HTMLElement | DocumentFragment, owner?: Node, tight?: boolean): void {
    const active: OpenMark[] = [];
    const annotations = readAnnotation.fragment(fragment,
      owner?.type === schema.nodes.tableParagraph ? 'tableCell' : 'atxHeading');
    let previousImage: Mark | undefined;
    let consumed = 0;
    fragment.forEach((node, offset, index) => {
      if (offset < consumed) return;
      const annotation = annotations.get(offset);
      if (annotation) {
        const element = this.dom.createElement('span');
        element.setAttribute('data-markdown-kind', annotation.kind);
        element.setAttribute('data-markdown-source', annotation.source);
        if (annotation.kind === 'footnoteLabel')
          element.setAttribute('data-markdown-identifier', annotation.identifier);
        element.textContent = annotation.display;
        this.inline(output, active, node.marks, element);
        consumed = annotation.to;
        previousImage = undefined;
      } else if (!node.isInline) {
        active.length = 0;
        previousImage = undefined;
        this.block(node, output, owner, tight);
      } else {
        const image = node.marks.find(mark => images.has(mark.type));
        if (image) {
          if (!previousImage?.eq(image)) {
            const element = this.dom.createElement('img');
            element.setAttribute('src', image.attrs.destination ?? '');
            element.setAttribute('alt', image.attrs.alt ?? image.attrs.displayText ?? '');
            if (image.attrs.title) element.setAttribute('title', image.attrs.title);
            if (image.attrs.width !== null) element.setAttribute('width', String(image.attrs.width));
            if (image.attrs.height !== null) element.setAttribute('height', String(image.attrs.height));
            this.inline(output, active, node.marks, element);
          }
          previousImage = image;
          return;
        }
        previousImage = undefined;
        const math = node.marks.find(mark => mark.type === schema.marks.inlineMath);
        if (math) {
          let source = '';
          let size = 0;
          for (let part = index; part < fragment.childCount; part++) {
            const piece = fragment.child(part);
            if (!piece.marks.some(mark => mark.eq(math))) break;
            source += piece.isText ? piece.text : '\n';
            size += piece.nodeSize;
          }
          const syntax = singleSyntax(source);
          const element = syntax instanceof InlineMathSyntax
            ? this.formula('inline', source, syntax.math) : this.dom.createTextNode(source);
          this.inline(output, active, node.marks, element);
          consumed = offset + size;
        } else if (!node.marks.some(mark => mark.type === schema.marks.meta) ||
            node.marks.some(mark => visibleMeta.has(mark.type))) {
          this.inline(output, active, node.marks, this.text(node));
        }
      }
    });
  }

  block(node: Node, output: HTMLElement | DocumentFragment, owner?: Node, tight?: boolean): void {
    if (node.type === schema.nodes.htmlTagBlock) {
      const element = this.dom.createElement(node.attrs.tag === 'htmlImage' ? 'img' : 'br');
      if (node.attrs.tag === 'htmlImage') {
        element.setAttribute('src', node.attrs.destination);
        element.setAttribute('alt', node.attrs.alt);
        if (node.attrs.title) element.setAttribute('title', node.attrs.title);
        if (node.attrs.width !== null) element.setAttribute('width', String(node.attrs.width));
        if (node.attrs.height !== null) element.setAttribute('height', String(node.attrs.height));
      }
      output.appendChild(element);
      return;
    }
    if (node.type === schema.nodes.mathBlock) {
      const origin = this.math.get(node);
      if (origin)
        // A math block has no edge mark, so the options do not reach it.
        output.appendChild(this.formula('block', unparse.slice(new Slice(Fragment.from(node), 0, 0), origin, unparse.defaults),
          node.textContent));
      else {
        const paragraph = this.dom.createElement('p');
        paragraph.textContent = node.textContent;
        output.appendChild(paragraph);
      }
      return;
    }
    if (node.type === schema.nodes.paragraph && owner?.type === schema.nodes.listItem && tight) {
      this.fragment(node.content, output, node);
      return;
    }
    const rendered = DOMSerializer.renderSpec(this.dom, this.serializer.nodes[node.type.name]!(node));
    if (annotatedBlocks.has(node.type) && node.type.validContent(node.content) && rendered.dom.nodeType === 1) {
      const element = rendered.dom as HTMLElement;
      element.setAttribute('data-markdown-kind', node.type.name);
      element.setAttribute('data-markdown-source', unparse.alone(node).body);
    }
    output.appendChild(rendered.dom);
    if (!rendered.contentDOM) return;
    let childTightness: boolean | undefined;
    if (node.type.isInGroup('list')) childTightness = true;
    else if (node.type === schema.nodes.listItem) childTightness = tight ?? true;
    this.fragment(node.content, rendered.contentDOM, node, childTightness);
  }

  text(node: Node): DOMNode {
    if (!node.isText) {
      const rendered = DOMSerializer.renderSpec(this.dom, this.serializer.nodes[node.type.name]!(node));
      if (rendered.contentDOM) this.fragment(node.content, rendered.contentDOM, node);
      return rendered.dom;
    }
    let value = node.text!;
    if (node.marks.some(mark => mark.type === schema.marks.characterReference ||
        mark.type === schema.marks.emojiShortcode)) {
      const syntax = singleSyntax(value);
      if (syntax?.type === 'emojiShortcode') value = emojiForShortcode(value) ?? value;
      else if (syntax instanceof CharacterReferenceSyntax) value = syntax.character;
    }
    return this.dom.createTextNode(value);
  }

  inline(output: HTMLElement | DocumentFragment, active: OpenMark[], marks: readonly Mark[],
    node: DOMNode): void {
    const semantic = marks.filter(mark => this.serializer.marks[mark.type.name]);
    // PM schema order is not HTML nesting intent. Preserve already-open compatible styles
    // before adding new inner styles, so a highlight remains one span across nested bold text.
    const order = semantic.map(mark => ({
      mark,
      position: active.findLastIndex(open => sameStyle(open.mark, mark)),
    }));
    order.sort((a, b) => (a.position < 0 ? active.length : a.position) - (b.position < 0 ? active.length : b.position));
    let shared = 0;
    while (shared < active.length && shared < order.length && sameStyle(active[shared]!.mark, order[shared]!.mark))
      shared++;
    active.length = shared;
    let parent = active.at(-1)?.content ?? output;
    for (const { mark } of order.slice(shared)) {
      const rendered = DOMSerializer.renderSpec(this.dom, this.serializer.marks[mark.type.name]!(mark, true));
      parent.appendChild(rendered.dom);
      const content = rendered.contentDOM ?? rendered.dom;
      active.push({ mark, content });
      parent = content;
    }
    parent.appendChild(node);
  }

  formula(display: 'inline' | 'block', source: string, body: string): HTMLElement {
    const element = this.dom.createElement(display === 'block' ? 'div' : 'span');
    element.setAttribute('data-math-display', display);
    element.setAttribute('data-math-source', source);
    // Dollar edges also keep HTML whitespace collapsing from merging TeX body padding with
    // surrounding prose. Consumers without math support receive a useful literal TeX fallback.
    element.textContent = display === 'inline' ? source : body;
    return element;
  }

  tableAlignment(fragment: Fragment, output: HTMLElement | DocumentFragment): void {
    const first = fragment.firstChild;
    if (first?.type !== schema.nodes.tableRow || output.firstChild?.nodeType !== 1 || !this.document) return;
    this.document.descendants(table => {
      if (table.type !== schema.nodes.table) return;
      table.forEach(row => row.forEach((cell, _offset, column) => {
        if (cell !== first.firstChild) return;
        const alignments = table.attrs.alignments.slice(column, column + first.childCount);
        (output.firstChild as HTMLElement).setAttribute('data-kagami-table-alignments', JSON.stringify(alignments));
        for (const child of Array.from(output.childNodes)) {
          if (child.nodeType !== 1 || (child as HTMLElement).tagName !== 'TR') continue;
          Array.from((child as HTMLTableRowElement).cells).forEach((cell, index) => {
            if (alignments[index]) cell.style.textAlign = alignments[index];
          });
        }
      }));
      return false;
    });
  }
}

/** HTML style nesting ignores syntax occurrence numbers and compares resolved link meaning. */
function sameStyle(a: Mark, b: Mark): boolean {
  return a.type === b.type && (a.attrs.destination ?? null) === (b.attrs.destination ?? null) &&
    (a.attrs.title ?? null) === (b.attrs.title ?? null);
}

/** Native slicing keeps marks for partly selected occurrences; carry only complete annotations. */
function selectedTree(fragment: Fragment, owner?: Node): Fragment {
  const annotations = [...readAnnotation.fragment(fragment,
    owner?.type === schema.nodes.tableParagraph ? 'tableCell' : 'atxHeading').values()];
  const children: Node[] = [];
  fragment.forEach((node, offset) => {
    if (!node.isInline) children.push(node.copy(selectedTree(node.content, node)));
    else children.push(node.mark(node.marks.filter(mark => {
      const kind = annotatedMarks.get(mark.type);
      return !kind || annotations.some(annotation => annotation.kind === kind &&
        annotation.from <= offset && annotation.to >= offset + node.nodeSize);
    })));
  });
  return Fragment.fromArray(children);
}

function singleSyntax(source: string): Syntax | undefined {
  const reading = transduce(source, { phrasing: 'atxHeading', firstInListItem: false, firstInBlockQuote: false },
    Bindings.none);
  return reading.kind === 'inline' && reading.children.length === 1 ? reading.children[0] : undefined;
}

/** Source link labels already carry the resolved destination; exporting must not re-resolve it. */
function link(mark: Mark): DOMOutputSpec {
  return ['a', { href: mark.attrs.destination ?? '', ...(mark.attrs.title ? { title: mark.attrs.title } : {}) }, 0];
}
