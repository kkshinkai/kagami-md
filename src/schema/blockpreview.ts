/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { schema } from '../types/schema.js';
import { CONCEALED, presentationClasses } from '../editor/reveal.js';
import { DOMSerializer, type Mark, type Node } from 'prosemirror-model';
import type { EditorView } from 'prosemirror-view';
import { callout, type Callout } from './callout.js';
import { frontmatter } from './frontmatter.js';
import { math } from './math.js';
import { image } from './image.js';
import { selectedBlocks, type BlockRange } from '../state/selection.js';
import { localScale } from '../editor/coords.js';

/** A presentation DOM built from the selected model frontier. */
export function blockPreview(view: EditorView, range: BlockRange): HTMLElement {
  return new PreviewContext(view).draw(range);
}

/** One rendering walk shares its schema serializer, DOM document, and measured scale. */
class PreviewContext {
  readonly document: Document;
  readonly win: Window;
  readonly scale: { x: number; y: number };
  readonly serializer: DOMSerializer;
  readonly painted = new Set([
    ...presentationClasses,
    'md-yaml-literal-prefix',
    'md-code-block-token',
    'md-tag-slash',
    'md-tag-joint',
  ]);

  constructor(readonly view: EditorView) {
    this.document = view.dom.ownerDocument;
    this.win = this.document.defaultView!;
    this.scale = localScale(view.dom);
    this.serializer = DOMSerializer.fromSchema(view.state.schema);
  }

  element<K extends keyof HTMLElementTagNameMap>(tag: K, className = ''): HTMLElementTagNameMap[K] {
    const dom = this.document.createElement(tag);
    dom.className = className;
    return dom;
  }

  icon(paths: string): SVGSVGElement {
    const svg = this.document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [key, value] of Object.entries({
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': '1.65',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    }))
      svg.setAttribute(key, value);
    svg.innerHTML = paths;
    return svg;
  }

  checkbox(checked: boolean, className: string): HTMLElement {
    const mount = this.element('span', className);
    const input = this.element('input');
    input.type = 'checkbox';
    input.checked = checked;
    mount.append(input);
    return mount;
  }

  original(pos: number): HTMLElement | null {
    return this.view.nodeDOM(pos) as HTMLElement | null;
  }

  textPieces(node: Node, pos: number) {
    const pieces: { text: string; className: string; style: string }[] = [];
    for (let offset = 0; offset < node.nodeSize; ) {
      const at = this.view.domAtPos(pos + offset, 1);
      const length =
        at.node.nodeType === 3
          ? Math.min(node.nodeSize - offset, at.node.textContent!.length - at.offset)
          : node.nodeSize - offset;
      const classes = new Set<string>();
      let style = '';
      for (
        let dom = at.node.nodeType === 1 ? (at.node as HTMLElement) : at.node.parentElement;
        dom && dom !== this.view.dom;
        dom = dom.parentElement
      ) {
        for (const name of dom.classList) if (this.painted.has(name)) classes.add(name);
        if (dom.classList.contains('md-code-block-token')) style = dom.style.cssText;
      }
      const size = Math.max(1, length);
      pieces.push({
        text: node.text!.slice(offset, offset + size),
        className: [...classes].join(' '),
        style,
      });
      offset += size;
    }
    return pieces;
  }

  inline(node: Node, pos: number, target: HTMLElement) {
    const images = image.read(node, pos + 1);
    const formulas = math.formulas(node, pos + 1);
    const imageNodes = [
      ...(this.original(pos)?.querySelectorAll<HTMLImageElement>('img.md-image-object') ?? []),
    ];
    const active: { mark: Mark; parent: HTMLElement }[] = [];
    let container = target;
    let offset = 0;
    for (const child of node.content.content) {
      let keep = 0;
      while (
        keep < active.length &&
        keep < child.marks.length &&
        active[keep]!.mark.eq(child.marks[keep]!) &&
        child.marks[keep]!.type.spec.spanning !== false
      )
        keep++;
      while (active.length > keep) container = active.pop()!.parent;
      for (const mark of child.marks.slice(keep)) {
        const spec = this.serializer.marks[mark.type.name];
        if (!spec) continue;
        const output = DOMSerializer.renderSpec(this.document, spec(mark, child.isInline));
        container.append(output.dom);
        active.push({ mark, parent: container });
        container = (output.contentDOM ?? output.dom) as HTMLElement;
      }
      const start = pos + 1 + offset;
      if (child.isText) {
        for (const piece of this.textPieces(child, start)) {
          if (!piece.className) container.append(this.document.createTextNode(piece.text));
          else {
            const span = this.element('span', piece.className);
            span.style.cssText = piece.style;
            span.textContent = piece.text;
            container.append(span);
          }
        }
      } else container.append(this.serializer.serializeNode(child, { document: this.document }));
      for (const formula of formulas.filter((formula) => formula.to === start + child.nodeSize)) {
        while (active.length) container = active.pop()!.parent;
        const preview = math.preview(formula.value, false, this.document);
        const at = this.view.domAtPos(formula.from, 1).node;
        const source = at.nodeType === 1 ? (at as HTMLElement) : at.parentElement!;
        preview.classList.toggle('md-math-live-preview', !source.closest(`.${CONCEALED}`));
        target.append(preview);
      }
      for (const info of images.filter((image) => image.to === start + child.nodeSize)) {
        while (active.length) container = active.pop()!.parent;
        const widget = image.widget(this.document, info);
        const source = imageNodes[images.indexOf(info)];
        if (source) {
          const bounds = source.getBoundingClientRect();
          widget.style.width = `${bounds.width / this.scale.x}px`;
          widget.style.height = `${bounds.height / this.scale.y}px`;
        }
        target.append(widget);
      }
      offset += child.nodeSize;
    }
    if (
      !node.childCount ||
      node.lastChild?.type === schema.nodes.lineEnding ||
      (node.isTextblock && node.textContent.endsWith('\n'))
    )
      target.append(this.element('br'));
  }

  render(node: Node, pos: number, parent?: Node): HTMLElement {
    const output = DOMSerializer.renderSpec(this.document, node.type.spec.toDOM!(node));
    let dom = output.dom as HTMLElement;
    let content = output.contentDOM as HTMLElement | undefined;
    switch (node.type) {
      case schema.nodes.blockQuote:
        content = this.element('div', 'md-quote-content');
        dom.replaceChildren(content);
        break;
      case schema.nodes.thematicBreak: {
        const frame = this.element('div', 'md-divider');
        frame.append(dom);
        dom = frame;
        break;
      }
      case schema.nodes.listItem:
        if (node.attrs.checked !== null) {
          dom = this.element('li', 'task-list-item');
          dom.dataset.task = 'true';
          dom.dataset.checked = String(node.attrs.checked);
          content = this.element('div', 'md-list-item-content task-list-content');
          dom.append(this.checkbox(node.attrs.checked, 'task-list-checkbox'), content);
        }
        break;
      case schema.nodes.codeBlock: {
        const frame = this.element('div', 'md-code-block');
        frame.append(dom);
        dom = frame;
        break;
      }
      case schema.nodes.callout: {
        const frame = this.element('div', 'md-callout-frame');
        frame.append(dom);
        dom = frame;
        break;
      }
      case schema.nodes.calloutTitle: {
        dom = this.element('div', 'md-callout-heading');
        content = this.element('span', 'md-callout-title');
        content.dataset.calloutTitle = 'true';
        const kind = parent!.attrs.calloutType as Callout.Kind;
        if (!node.content.size) content.dataset.placeholder = callout.labels[kind];
        const mount = this.element('span', 'md-callout-type-control');
        const button = this.element('button', 'callout-type-button');
        button.append(this.icon(callout.icons[kind]));
        mount.append(button);
        dom.append(mount, content);
        break;
      }
      case schema.nodes.mathBlock: {
        dom = this.element('div', 'md-math-block');
        dom.dataset.mathBlock = 'true';
        dom.classList.toggle('md-math-editing', this.original(pos)!.classList.contains('md-math-editing'));
        const source = this.element('pre', 'md-math-source');
        content = this.element('code');
        source.append(content);
        dom.append(math.preview(node.textContent, true, this.document), source);
        break;
      }
      case schema.nodes.table: {
        dom = this.element('div', 'kagami-table-drag');
        const port = this.element('div', 'tableWrapper');
        const table = this.element('table');
        const colgroup = this.element('colgroup');
        const source = this.original(pos)!.querySelector('table')!;
        const rect = source.getBoundingClientRect();
        // A block drag represents the whole table, independently of its live scroll viewport.
        const sourcePort = this.win.getComputedStyle(source.parentElement!);
        dom.style.width = `${rect.width / this.scale.x + parseFloat(sourcePort.marginLeft)
          + parseFloat(sourcePort.marginRight)}px`;
        dom.style.maxWidth = 'none';
        port.style.width = `${rect.width / this.scale.x}px`;
        port.style.maxWidth = 'none';
        port.style.overflow = 'visible';
        table.style.width = `${rect.width / this.scale.x}px`;
        table.style.minWidth = '0';
        for (const cell of source.rows[0]!.cells) {
          const col = this.element('col');
          col.style.width = `${cell.getBoundingClientRect().width / this.scale.x}px`;
          colgroup.append(col);
        }
        content = this.element('tbody');
        table.append(colgroup, content);
        port.append(table);
        dom.append(port);
        break;
      }
      case schema.nodes.tableRow: {
        const source = this.original(pos);
        if (source) dom.style.height = `${source.getBoundingClientRect().height / this.scale.y}px`;
        break;
      }
      case schema.nodes.yamlPair: {
        const mount = this.element('span', 'md-yaml-type');
        const button = this.element('button', 'frontmatter-type-button');
        const value = node.lastChild!;
        const type = frontmatter.valueType(value);
        button.append(this.icon(frontmatter.typeIcons[type]));
        mount.append(button);
        content = this.element('div', 'md-yaml-entry-content');
        dom.replaceChildren(mount, content);
        break;
      }
      case schema.nodes.yamlMapping:
      case schema.nodes.yamlSequence: {
        content = this.element('div', 'md-yaml-entries');
        dom.replaceChildren(content, this.element('div', 'md-yaml-add'));
        break;
      }
      case schema.nodes.yamlScalar:
        if (node.attrs.tag === 'boolean')
          dom.replaceChildren(this.checkbox(node.textContent === 'true', 'md-yaml-boolean-control'));
        break;
    }
    if (content) {
      if (node.inlineContent) this.inline(node, pos, content);
      else node.forEach((child, offset) => content!.append(this.render(child, pos + 1 + offset, node)));
    }
    return dom;
  }

  draw(range: BlockRange): HTMLElement {
    const root = this.element('div', 'ProseMirror');
    root.contentEditable = 'false';
    root.inert = true;
    const computed = this.win.getComputedStyle(this.view.dom);
    for (const property of [
      'font-family',
      'font-size',
      'line-height',
      'font-weight',
      'letter-spacing',
      'color',
      'direction',
    ]) {
      root.style.setProperty(property, computed.getPropertyValue(property));
    }

    // Hidden source marks inherit a zero line box through the editor's unitless line-height.
    root.style.lineHeight = String(parseFloat(computed.lineHeight) / parseFloat(computed.fontSize));
    root.style.display = 'flex';
    root.style.flexDirection = 'column';

    // These classes are presentation, not interaction/selection state. Read their exact native
    // text extents so a gesture preserves what is already revealed and cached code highlighting.
    let carrier: number | undefined;
    let destination: HTMLElement = root;
    let width = 0;
    for (const block of selectedBlocks(this.view.state.doc, range)) {
      const source = this.original(block.from)!;
      const $pos = this.view.state.doc.resolve(block.from);
      const list = block.node.type === schema.nodes.listItem ? $pos.parent : undefined;
      const carrierPosition = list ? $pos.start() : undefined;
      if (carrierPosition !== carrier) {
        carrier = carrierPosition;
        destination = root;
        if (list) {
          const rendered = DOMSerializer.renderSpec(this.document, list.type.spec.toDOM!(list))
            .dom as HTMLElement;
          if (list.type === schema.nodes.orderedList)
            rendered.setAttribute('start', String(list.attrs.start + $pos.index()));
          destination = rendered;
          root.append(destination);
          destination.style.paddingLeft = this.win.getComputedStyle(source.parentElement!).paddingLeft;
        }
      }
      const dom = this.render(block.node, block.from, $pos.parent);
      const bounds = source.getBoundingClientRect();
      let blockWidth = bounds.width / this.scale.x;
      if (block.node.type === schema.nodes.table) {
        const table = source.querySelector('table')!;
        const port = source.querySelector('.tableWrapper')!;
        const style = this.win.getComputedStyle(port);
        blockWidth =
          table.getBoundingClientRect().width / this.scale.x +
          parseFloat(style.marginLeft) +
          parseFloat(style.marginRight);
      }
      dom.style.width = `${blockWidth}px`;
      dom.style.boxSizing = 'border-box';
      const style = this.win.getComputedStyle(source);
      for (const key of ['font-family', 'font-size', 'line-height', 'font-weight', 'letter-spacing', 'color'])
        dom.style.setProperty(key, style.getPropertyValue(key));
      dom.style.lineHeight = String(parseFloat(style.lineHeight) / parseFloat(style.fontSize));
      for (const property of [
        '--yaml-key-width',
        '--yaml-entry-gap',
        '--yaml-type-column',
        '--yaml-collection-inset',
        '--editor-paragraph-padding-block',
        '--editor-list-indent',
        '--editor-quote-indent',
        '--editor-block-padding-inline',
      ]) {
        const value = style.getPropertyValue(property);
        if (value) dom.style.setProperty(property, value);
      }
      destination.append(dom);
      width = Math.max(
        width,
        blockWidth + (list ? parseFloat(this.win.getComputedStyle(source.parentElement!).paddingLeft) : 0),
      );
    }
    root.style.width = `${width}px`;
    return root;
  }
}
