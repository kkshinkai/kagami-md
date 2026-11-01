/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Node } from 'prosemirror-model';
import { Plugin } from 'prosemirror-state';
import type { Decoration, DecorationSource, EditorView, NodeView, ViewMutationRecord } from 'prosemirror-view';
import * as command from '../command/command.js';
import {
  registerBlockView, registerNodeView, nodeView, type BlockView, type HandleTarget,
  type ChildSequence
} from '../editor/blockview.js';
import { findEditor, type DOMNode } from '../editor/dom.js';
import { input } from '../editor/input.js';
import { canRunCommand } from '../state/input.js';
import { schema } from '../types/schema.js';
import { Frontmatter, frontmatter } from './frontmatter.js';
import { FrontmatterView } from './frontmatterview.js';

/** Property views own their DOM; the plugin updates view-dependent presentation. */
export function propertyViews(): Plugin {
  const nodes = new Set<PropertyView>();
  const forget = (node: PropertyView) => { nodes.delete(node); };
  const remember = <T extends PropertyView>(node: T): T => {
    nodes.add(node);
    return node;
  };
  return new Plugin<command.Command.RequestState>({
    key: Frontmatter.choosePropertyType.key,
    state: {
      init: () => ({ hold(view, pos) {
        for (const node of nodes) {
          if (!(node instanceof EntryView) || node.view !== view) continue;
          const held = command.keepRequest(node.request(), pos,
            () => nodes.has(node) && !view.isDestroyed);
          if (held) return held;
        }
        return null;
      } }),
      apply: (_tr, value) => value,
    },
    props: { nodeViews: {
      yamlFrontMatter: (node, view, getPos) => remember(new FrontmatterView(node, view, getPos, forget)),
      yamlPair: (node, view, getPos) => remember(new EntryView(node, view, getPos, forget)),
      yamlScalar: (node, view, getPos) => valueView(node, view, getPos, remember, forget),
      yamlMapping: (node, view, getPos) => valueView(node, view, getPos, remember, forget),
      yamlSequence: (node, view, getPos) => valueView(node, view, getPos, remember, forget),
    } },
    view(view) {
      const detach = findEditor(view.dom)?.beforeDetach(() => {
        for (const node of nodes) if (node instanceof FrontmatterView && node.view === view) node.preserveSession();
      });
      let editable = view.editable;
      return {
        update(_view, previous) {
          const changed = editable !== view.editable;
          editable = view.editable;
          for (const node of nodes) {
            if (node.view !== view) continue;
            if (node instanceof FrontmatterView) node.refresh(previous, changed);
            else node.sync();
          }
        },
        destroy() { detach?.(); },
      };
    },
  });
}

/** The outline icon shared by the property controls and their frontmatter header. */
export function propertyIcon(document: Document, path: string, width = '1.65'): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', width);
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = path;
  return svg;
}

export interface PropertyView extends BlockView {
  readonly view: EditorView;
  sync(): void;
}

function valueView(node: Node, view: EditorView, getPos: () => number | undefined,
  remember: <T extends PropertyView>(node: T) => T, forget: (node: PropertyView) => void): NodeView {
  let value: NodeView;
  if (node.type === schema.nodes.yamlScalar && node.attrs.tag === 'boolean')
    value = remember(new BooleanView(node, view, getPos, forget));
  else if (node.type === schema.nodes.yamlMapping || node.type === schema.nodes.yamlSequence)
    value = remember(new CollectionView(node, view, getPos, forget));
  else {
    const dom = view.dom.ownerDocument.createElement('div');
    dom.className = `md-yaml-scalar md-yaml-${frontmatter.valueType(node)}`;
    dom.setAttribute('data-yaml-tag', node.attrs.tag);
    value = { dom, contentDOM: dom };
  }
  const pos = getPos();
  if (pos !== undefined) {
    const at = view.state.doc.resolve(pos);
    if (at.parent.type === schema.nodes.yamlPair && !at.index())
      (value.dom as HTMLElement).classList.add('md-yaml-key');
    if (at.parent.type === schema.nodes.yamlSequence) return remember(new EntryView(node, view, getPos, forget, value));
  }
  return value;
}

/** A property owns its type button and keeps the value's native editable view. */
class EntryView implements PropertyView {
  readonly dom: HTMLDivElement;
  private readonly button: HTMLButtonElement;
  readonly contentDOM?: HTMLElement;
  private readonly mount: HTMLSpanElement;
  private readonly entry: HTMLDivElement;
  private readonly icon: SVGSVGElement;

  constructor(private node: Node, readonly view: EditorView, private readonly getPos: () => number | undefined,
    private readonly forget: (node: PropertyView) => void, private readonly value?: NodeView) {
    const doc = view.dom.ownerDocument;
    this.dom = doc.createElement('div');
    this.dom.className = node.type === schema.nodes.yamlPair ? 'md-yaml-property' : 'md-yaml-item';
    this.mount = this.dom.appendChild(doc.createElement('span'));
    this.mount.className = 'md-yaml-type';
    this.mount.contentEditable = 'false';
    this.button = this.mount.appendChild(doc.createElement('button'));
    this.button.type = 'button';
    this.button.className = 'frontmatter-type-button';
    this.icon = this.button.appendChild(propertyIcon(doc, ''));
    this.entry = this.dom.appendChild(doc.createElement('div'));
    const content = this.entry;
    content.className = 'md-yaml-entry-content';
    this.contentDOM = value ? value.contentDOM ?? undefined : content;
    if (value) content.append(value.dom);
    this.button.onclick = () => {
      const pos = (!this.view.isDestroyed && canRunCommand(this.view.state, this.view)) ? this.getPos() : undefined;
      if (pos === undefined) return;
      const editor = findEditor(view.dom);
      if (!editor) return;
      command.Command.dispatch(editor, Frontmatter.choosePropertyType, {
        pos, rect: this.button.getBoundingClientRect(), type: this.valueType,
        conversions: {
          string: this.conversionEffect('string'), number: this.conversionEffect('number'),
          boolean: this.conversionEffect('boolean'), null: this.conversionEffect('null'),
          array: this.conversionEffect('array'), object: this.conversionEffect('object'),
        },
      });
    };
    this.button.onkeydown = event => {
      if (!view.isDestroyed && input.historyKey(view, event)) event.stopPropagation();
    };
    this.sync();
    registerBlockView(node, this);
  }

  get brush(): boolean { return this.node.type === schema.nodes.yamlPair; }
  get box(): HTMLElement { return this.dom; }
  get field(): HTMLElement | undefined {
    return this.node.type === schema.nodes.yamlPair ? this.entry.firstElementChild as HTMLElement : undefined;
  }
  get content(): HTMLElement {
    if (this.node.type !== schema.nodes.yamlPair) return this.dom;
    const value = this.entry.lastElementChild as HTMLElement;
    return nodeView(value)?.sequence?.content ?? value;
  }
  get handle(): HandleTarget | undefined {
    return this.field ? { kind: 'text', target: this.field } : undefined;
  }

  private get valueNode(): Node { return this.node.type === schema.nodes.yamlPair ? this.node.child(1) : this.node; }

  request(): command.CommandRequest {
    return {
      pos: () => this.getPos(),
      rect: () => this.button.getBoundingClientRect(),
      held: (on: boolean) => {
        if (on) this.button.setAttribute('aria-expanded', 'true');
        else this.button.removeAttribute('aria-expanded');
      },
    };
  }

  private get valueType(): Frontmatter.ValueType { return frontmatter.valueType(this.valueNode); }
  private get label(): string {
    return this.node.type === schema.nodes.yamlPair
      ? this.node.firstChild!.textContent || 'Unnamed property' : 'Array item';
  }
  private conversionEffect(type: Frontmatter.ValueType): 'convert' | 'reset' {
    return frontmatter.convertedValue(this.valueNode, type) ? 'convert' : 'reset';
  }


  update(node: Node, decorations: readonly Decoration[], inner: DecorationSource): boolean {
    if (node.type !== this.node.type || this.value?.update && !this.value.update(node, decorations, inner))
      return false;
    this.node = node;
    this.sync();
    return true;
  }

  sync(): void {
    this.button.disabled = !this.view.editable;
    const type = this.valueType;
    if (this.icon.dataset.type !== type) {
      this.icon.dataset.type = type;
      this.icon.innerHTML = frontmatter.typeIcons[type];
    }
    const label = `${this.label} type: ${type}`;
    if (this.button.getAttribute('aria-label') !== label) this.button.setAttribute('aria-label', label);
  }

  stopEvent(event: Event): boolean {
    return this.button.contains(event.target as DOMNode) ||
      this.value?.stopEvent?.(event) === true;
  }
  ignoreMutation(mutation: ViewMutationRecord): boolean {
    return this.mount.contains(mutation.target) ||
      this.value?.ignoreMutation?.(mutation) === true;
  }
  destroy(): void {
    this.value?.destroy?.();
    this.button.onclick = this.button.onkeydown = null;
    this.forget(this);
  }
}

/** An append button follows the ordered children without becoming one of them. */
class CollectionView implements PropertyView {
  readonly dom: HTMLDivElement;
  private readonly footer: HTMLDivElement;
  readonly contentDOM: HTMLDivElement;
  private readonly button: HTMLButtonElement;

  constructor(private node: Node, readonly view: EditorView, private readonly getPos: () => number | undefined,
    private readonly forget: (node: PropertyView) => void) {
    const doc = view.dom.ownerDocument;
    this.dom = doc.createElement('div');
    this.dom.className = node.type === schema.nodes.yamlMapping ? 'md-yaml-map' : 'md-yaml-array';
    this.contentDOM = this.dom.appendChild(doc.createElement('div'));
    this.contentDOM.className = 'md-yaml-entries';
    this.footer = this.dom.appendChild(doc.createElement('div'));
    this.footer.className = 'md-yaml-add';
    this.footer.contentEditable = 'false';
    this.button = this.footer.appendChild(doc.createElement('button'));
    this.button.type = 'button';
    this.button.className = 'frontmatter-add-button';
    this.button.append(propertyIcon(doc, '<path d="M12 5v14M5 12h14" />', '2'),
      this.node.type === schema.nodes.yamlMapping ? 'Add property' : 'Add item');
    this.button.onclick = () => {
      if ((this.view.isDestroyed || !canRunCommand(this.view.state, this.view))) return;
      this.add();
      this.view.focus();
    };
    this.button.onkeydown = event => {
      if (!view.isDestroyed && input.historyKey(view, event)) event.stopPropagation();
    };
    registerNodeView(this);
    this.sync();
  }

  get sequence(): ChildSequence { return { content: this.contentDOM, trailing: this.footer }; }

  private add(): void {
    const pos = this.getPos();
    if ((this.view.isDestroyed || !canRunCommand(this.view.state, this.view)) || pos === undefined) return;
    const tr = frontmatter.insertEntry(this.view.state, pos, this.node.childCount);
    if (tr) this.view.dispatch(tr);
  }
  update(node: Node): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.sync();
    return true;
  }
  sync(): void { this.button.disabled = !this.view.editable; }
  stopEvent(event: Event): boolean { return this.footer.contains(event.target as DOMNode); }
  ignoreMutation(mutation: ViewMutationRecord): boolean { return this.footer.contains(mutation.target); }
  destroy(): void {
    this.button.onclick = this.button.onkeydown = null;
    this.forget(this);
  }
}

/** A boolean is one atomic value. It has no hidden text field or separate UI state. */
class BooleanView implements PropertyView {
  readonly dom: HTMLDivElement;
  private readonly marker: HTMLSpanElement;
  private readonly checkbox: HTMLInputElement;

  constructor(private node: Node, readonly view: EditorView, private readonly getPos: () => number | undefined,
    private readonly forget: (node: PropertyView) => void) {
    const doc = view.dom.ownerDocument;
    this.dom = doc.createElement('div');
    this.dom.className = 'md-yaml-scalar md-yaml-boolean';
    this.dom.contentEditable = 'false';
    this.marker = this.dom.appendChild(doc.createElement('span'));
    this.marker.className = 'md-yaml-boolean-control';
    this.checkbox = this.marker.appendChild(doc.createElement('input'));
    this.checkbox.type = 'checkbox';
    this.checkbox.tabIndex = -1;
    this.checkbox.setAttribute('aria-label', 'Boolean value');
    this.checkbox.onpointerdown = event => event.preventDefault();
    this.checkbox.onmousedown = event => event.preventDefault();
    this.checkbox.onchange = () => {
      this.setChecked(this.checkbox.checked);
      this.sync();
    };
    this.checkbox.onkeydown = event => {
      if (!view.isDestroyed && input.historyKey(view, event)) event.stopPropagation();
    };
    registerNodeView(this);
    this.sync();
  }

  get selectionTarget(): HTMLElement { return this.marker; }

  private setChecked(checked: boolean): void {
    const pos = this.getPos();
    if ((this.view.isDestroyed || !canRunCommand(this.view.state, this.view)) || pos === undefined) return;
    const tr = frontmatter.setBoolean(this.view.state, pos, checked);
    if (tr) this.view.dispatch(tr);
    this.view.focus();
  }
  update(node: Node): boolean {
    if (node.type !== this.node.type || node.attrs.tag !== 'boolean') return false;
    this.node = node;
    this.sync();
    return true;
  }
  sync(): void {
    this.checkbox.checked = this.node.textContent.toLowerCase() === 'true';
    this.checkbox.disabled = !this.view.editable;
  }
  stopEvent(event: Event): boolean { return this.marker.contains(event.target as DOMNode); }
  ignoreMutation(): boolean { return true; }
  destroy(): void {
    this.checkbox.onchange = this.checkbox.onpointerdown = this.checkbox.onmousedown = this.checkbox.onkeydown = null;
    this.forget(this);
  }
}
