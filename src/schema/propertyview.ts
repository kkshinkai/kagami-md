/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Node } from 'prosemirror-model';
import { Plugin, type EditorState, type Transaction } from 'prosemirror-state';
import type { PluginView } from 'prosemirror-state';
import type { Decoration, DecorationSource, EditorView, NodeView, ViewMutationRecord } from 'prosemirror-view';
import { ControlHold } from '../editor/hold.js';
import type { EditorLoc } from '../source/index.js';
import {
  registerBlockView, registerNodeView, syncNodeViewSequence, nodeView, type BlockView, type HandleTarget,
  type ChildSequence
} from '../editor/blockview.js';
import type { DOMNode } from '../editor/dom.js';
import type { KagamiMD } from '../editor/editor.js';
import { routeHistoryKey } from '../editor/input.js';
import { canRunCommand } from '../state/input.js';
import { schema } from '../types/schema.js';
import {
  activeScalarPos, changeFrontmatterType, convertedFrontmatterValue, frontmatterTypeIcons, frontmatterValueType,
  insertFrontmatterEntry, isFlowCollection, isYAMLCollection, removeFrontmatterEntry,
  setFrontmatterBoolean, setFrontmatterFlow,
} from './frontmatter.js';
import { FrontmatterView } from './frontmatterview.js';

/** Plugin view coordinating property view synchronization, editable toggles, and scalar focus markers. */
class PropertyViewsController implements PluginView {
  private editable: boolean;
  private focused: HTMLElement | null = null;
  private keyboardFocus = false;

  constructor(
    private readonly view: EditorView,
    private readonly nodes: ReadonlySet<PropertyView>,
  ) {
    this.editable = view.editable;
    view.dom.addEventListener('pointerdown', this.onPointer, true);
    view.dom.addEventListener('mousedown', this.onPointer, true);
    view.dom.addEventListener('keydown', this.onKeyDown, true);
    view.dom.addEventListener('focus', this.syncFocus, true);
    view.dom.addEventListener('blur', this.syncFocus, true);
    this.syncFocus();
  }

  /** Sync mounted property views and focus indicators after an editor update. */
  update(_view: EditorView, previous: EditorState): void {
    const editableChanged = this.editable !== this.view.editable;
    this.editable = this.view.editable;
    for (const node of this.nodes) {
      if (node.view !== this.view) continue;
      if (node instanceof FrontmatterView) node.refresh(previous, editableChanged);
      else node.sync();
    }
    this.syncFocus();
  }

  /** Detach DOM focus listeners and clear active scalar focus markers. */
  destroy(): void {
    this.view.dom.removeEventListener('pointerdown', this.onPointer, true);
    this.view.dom.removeEventListener('mousedown', this.onPointer, true);
    this.view.dom.removeEventListener('keydown', this.onKeyDown, true);
    this.view.dom.removeEventListener('focus', this.syncFocus, true);
    this.view.dom.removeEventListener('blur', this.syncFocus, true);
    if (this.focused) {
      delete this.focused.dataset.focused;
      delete this.focused.dataset.focusVisible;
    }
    this.focused = null;
  }

  /** Clear keyboard-visible ring when focus changes originate from pointer presses. */
  private onPointer = (): void => {
    this.keyboardFocus = false;
    this.syncFocus();
  };

  /** Reveal keyboard focus ring when non-modifier navigation enters or moves inside front matter. */
  private onKeyDown = (event: KeyboardEvent): void => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === 'Shift' || event.key === 'Meta' || event.key === 'Control' || event.key === 'Alt') return;
    this.keyboardFocus = true;
    this.syncFocus();
  };

  /** Mirror active scalar focus onto `data-focused` and keyboard modality onto `data-focus-visible`. */
  private syncFocus = (): void => {
    const next = focusedScalarElement(this.view);
    if (next !== this.focused) {
      if (this.focused) {
        delete this.focused.dataset.focused;
        delete this.focused.dataset.focusVisible;
      }
      this.focused = next;
      if (this.focused) this.focused.dataset.focused = 'true';
    }
    if (this.focused) {
      if (this.keyboardFocus) this.focused.dataset.focusVisible = 'true';
      else delete this.focused.dataset.focusVisible;
    }
  };
}

/** Property views own their DOM; the plugin updates view-dependent presentation. */
export function propertyViews(editor?: KagamiMD): Plugin {
  const nodes = new Set<PropertyView>();
  const forget = (node: PropertyView): void => {
    nodes.delete(node);
  };
  const remember = <T extends PropertyView>(node: T): T => {
    nodes.add(node);
    return node;
  };
  return new Plugin({
    props: {
      nodeViews: {
        yamlFrontMatter: (node, view, getPos) => remember(new FrontmatterView(node, view, getPos, forget)),
        yamlPair: (node, view, getPos) => remember(new EntryView(node, view, getPos, forget, editor)),
        yamlScalar: (node, view, getPos) => valueView(node, view, getPos, remember, forget, editor),
        yamlMapping: (node, view, getPos) => valueView(node, view, getPos, remember, forget, editor),
        yamlSequence: (node, view, getPos) => valueView(node, view, getPos, remember, forget, editor),
      },
    },
    view: view => new PropertyViewsController(view, nodes),
  });
}

/** Return the mounted scalar element for the `yamlScalar` node at `pos`. */
export function scalarDOM(view: EditorView, pos: number): HTMLElement | null {
  const dom = view.nodeDOM(pos);
  if (!dom || dom.nodeType !== 1) return null;
  const registered = nodeView(dom);
  // Sequence items mount `EntryView` at `pos` wrapping the inner `ScalarView` or `BooleanView`, whereas map
  // properties mount the key and value views directly at their scalar positions.
  if (registered instanceof EntryView) return registered.scalarDOM;
  if (registered instanceof ScalarView || registered instanceof BooleanView) return dom as HTMLElement;
  if (registered) return null;
  return dom as HTMLElement;
}

/** Return the currently focused YAML scalar DOM element when the editor holds focus, or `null`. */
function focusedScalarElement(view: EditorView): HTMLElement | null {
  if (view.isDestroyed || !view.hasFocus()) return null;
  const pos = activeScalarPos(view.state);
  return pos !== null ? scalarDOM(view, pos) : null;
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

/** Placeholder text for an empty scalar slot, or null when content is present. */
export function scalarPlaceholder(node: Node, isKey: boolean): string | null {
  if (node.content.size > 0) return null;
  if (isKey) return 'Property';
  if (node.attrs.tag === 'null') return 'null';
  return 'Empty';
}

/** Classification of an entry's value for layout and capsule styling. */
export function entryValueKind(value: Node): 'scalar' | 'flow' | 'block' {
  if (!isYAMLCollection(value)) return 'scalar';
  return isFlowCollection(value) ? 'flow' : 'block';
}

/** Digit count string ('1', '2', ...) sizing the index column of a block sequence. */
export function sequenceIndexDigits(childCount: number): string {
  return String(String(Math.max(1, childCount)).length);
}

export interface SequenceIndexBadge {
  readonly dom: HTMLSpanElement;
  readonly label: HTMLSpanElement;
}

/** Build one bent half-bracket SVG flanking a block-sequence item's index badge. */
function indexBracketIcon(document: Document, pathData: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'md-yaml-index-bracket');
  svg.setAttribute('viewBox', '0 0 3.2 14');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'miter');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', pathData);
  svg.append(path);
  return svg;
}

/** Narrow bent-tick SVG bracketed 1-based index badge for an item in a block sequence. */
export function createSequenceIndexBadge(document: Document, index = 1): SequenceIndexBadge {
  const dom = document.createElement('span');
  dom.className = 'md-yaml-index';
  dom.contentEditable = 'false';
  const label = document.createElement('span');
  label.className = 'md-yaml-index-number';
  label.textContent = String(index);
  dom.append(
    indexBracketIcon(document, 'M2.45 2.1.85 3.05v7.9l1.6.95'),
    label,
    indexBracketIcon(document, 'M.75 2.1l1.6.95v7.9l-1.6.95'),
  );
  return { dom, label };
}

/** Mount a property view for a scalar or collection, wrapping sequence items in an indexed `EntryView`. */
function valueView(node: Node, view: EditorView, getPos: () => number | undefined,
  remember: <T extends PropertyView>(node: T) => T, forget: (node: PropertyView) => void,
  editor?: KagamiMD): NodeView {
  let value: PropertyView;
  if (node.type === schema.nodes.yamlScalar && node.attrs.tag === 'boolean')
    value = remember(new BooleanView(node, view, getPos, forget));
  else if (isYAMLCollection(node))
    value = remember(new CollectionView(node, view, getPos, forget));
  else
    value = remember(new ScalarView(node, view, getPos, forget));
  const pos = getPos();
  if (pos !== undefined) {
    const at = view.state.doc.resolve(pos);
    if (at.parent.type === schema.nodes.yamlSequence)
      return remember(new EntryView(node, view, getPos, forget, editor, value));
  }
  return value;
}

/** Editable scalar field keeping its element, type class, and empty placeholder synchronized. */
class ScalarView implements PropertyView {
  readonly dom: HTMLDivElement;
  readonly contentDOM: HTMLDivElement;
  readonly brush = false;

  constructor(private node: Node, readonly view: EditorView, private readonly getPos: () => number | undefined,
    private readonly forget: (node: PropertyView) => void) {
    this.dom = view.dom.ownerDocument.createElement('div');
    this.contentDOM = this.dom;
    registerNodeView(this);
    this.sync();
  }

  nodePosition(): number | undefined {
    return this.getPos();
  }

  update(node: Node): boolean {
    if (node.type !== schema.nodes.yamlScalar || node.attrs.tag === 'boolean') return false;
    this.node = node;
    this.sync();
    return true;
  }

  sync(): void {
    const pos = this.getPos();
    let isKey = false;
    if (pos !== undefined && pos <= this.view.state.doc.content.size) {
      const at = this.view.state.doc.resolve(pos);
      isKey = at.parent.type === schema.nodes.yamlPair && at.index() === 0;
    }
    const base = `md-yaml-scalar md-yaml-${frontmatterValueType(this.node)}`;
    const className = isKey ? `${base} md-yaml-key` : base;
    if (this.dom.className !== className) this.dom.className = className;
    const tag = String(this.node.attrs.tag);
    if (this.dom.getAttribute('data-yaml-tag') !== tag) this.dom.setAttribute('data-yaml-tag', tag);
    const placeholder = scalarPlaceholder(this.node, isKey);
    if (placeholder === null) delete this.dom.dataset.placeholder;
    else if (this.dom.dataset.placeholder !== placeholder) this.dom.dataset.placeholder = placeholder;
  }

  ignoreMutation(mutation: ViewMutationRecord): boolean {
    return mutation.type === 'attributes' && mutation.target === this.dom;
  }

  destroy(): void {
    this.forget(this);
  }
}

/** A property owns its type button and keeps the value's native editable view. */
class EntryView implements PropertyView {
  readonly dom: HTMLDivElement;
  private readonly button: HTMLButtonElement;
  readonly contentDOM?: HTMLElement;
  private readonly mount: HTMLSpanElement;
  private readonly entry: HTMLDivElement;
  private readonly icon: SVGSVGElement;
  private readonly indexBadge?: SequenceIndexBadge;
  private readonly controlHold: ControlHold;
  private inFlowState = false;
  private destroyed = false;

  constructor(private node: Node, readonly view: EditorView, private readonly getPos: () => number | undefined,
    private readonly forget: (node: PropertyView) => void, editor?: KagamiMD, private readonly value?: PropertyView) {
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
    this.contentDOM = value ? value.contentDOM || undefined : content;
    if (value) {
      this.indexBadge = createSequenceIndexBadge(doc);
      content.append(this.indexBadge.dom, value.dom);
    }
    this.controlHold = new ControlHold({
      element: () => this.button,
      pos: () => this.getPos(),
      held: on => {
        if (on) this.button.setAttribute('aria-expanded', 'true');
        else this.button.removeAttribute('aria-expanded');
      },
    });
    this.button.onclick = () => {
      const pos = (!this.destroyed && !this.view.isDestroyed && canRunCommand(this.view.state, this.view))
        ? this.getPos() : undefined;
      if (pos === undefined || !editor || editor.isDestroyed()) return;
      const alive = () => !this.destroyed && !this.view.isDestroyed && !editor.isDestroyed();
      const runEntry = (change: (state: EditorState, at: number) => Transaction | null): boolean => {
        if (!alive()) return false;
        const current = this.getPos();
        if (current === undefined) return false;
        return editor.state.runCommand((state, dispatch) => {
          const tr = change(state, current);
          if (!tr) return false;
          dispatch?.(tr);
          return true;
        });
      };
      const valueNode = this.valueNode;
      const canToggleFlow = isYAMLCollection(valueNode) && valueNode.childCount > 0;
      editor._onDidClickFrontmatterPropertyType.fire({
        pos: pos as EditorLoc,
        rect: this.button.getBoundingClientRect(),
        type: this.valueType,
        flow: canToggleFlow ? isFlowCollection(valueNode) : null,
        conversions: {
          string: this.conversionEffect('string'), number: this.conversionEffect('number'),
          boolean: this.conversionEffect('boolean'), null: this.conversionEffect('null'),
          array: this.conversionEffect('array'), object: this.conversionEffect('object'),
        },
        hold: () => this.controlHold.acquire(alive),
        setType: type => runEntry((state, at) => changeFrontmatterType(state, at, type)),
        setFlow: flow => runEntry((state, at) => setFrontmatterFlow(state, at, flow)),
        insertProperty: side => runEntry((state, at) => {
          const position = state.doc.resolve(at);
          return insertFrontmatterEntry(state, position.before(), position.index() + (side === 'below' ? 1 : 0));
        }),
        deleteProperty: () => runEntry(removeFrontmatterEntry),
      });
    };
    this.button.onkeydown = event => {
      if (!view.isDestroyed && routeHistoryKey(view, event)) event.stopPropagation();
    };
    registerBlockView(node, this);
    this.sync();
  }

  get brush(): boolean {
    if (this.inFlowState && this.valueNode.type === schema.nodes.yamlScalar) return false;
    return !this.inFlowState;
  }
  get box(): HTMLElement | undefined {
    return this.inFlowState ? undefined : this.dom;
  }

  /** Return the entry capsule DOM element for `BlockSelection` masks even when wrapping a flow boolean. */
  get selectionTarget(): HTMLElement {
    return this.dom;
  }
  /** Wrapped scalar or boolean DOM element when this entry wraps a sequence scalar, or `null` for pairs and collections. */
  get scalarDOM(): HTMLElement | null {
    if (this.value instanceof ScalarView || this.value instanceof BooleanView) return this.value.dom;
    return null;
  }
  nodePosition(): number | undefined { return this.getPos(); }
  get field(): HTMLElement | undefined {
    return this.node.type === schema.nodes.yamlPair ? this.entry.firstElementChild as HTMLElement : undefined;
  }
  get content(): HTMLElement {
    if (this.node.type !== schema.nodes.yamlPair) {
      const inner = this.value?.dom;
      return (inner && nodeView(inner)?.sequence?.content) ?? this.dom;
    }
    const value = this.entry.lastElementChild as HTMLElement;
    return nodeView(value)?.sequence?.content ?? value;
  }
  get handle(): HandleTarget | undefined {
    if (this.field) return { kind: 'text', target: this.field };
    if (isYAMLCollection(this.valueNode)) return { kind: 'box', target: this.button };
    return undefined;
  }

  private get valueNode(): Node { return this.node.type === schema.nodes.yamlPair ? this.node.child(1) : this.node; }

  private get valueType(): KagamiMD.FrontmatterValueType { return frontmatterValueType(this.valueNode); }
  private get label(): string {
    return this.node.type === schema.nodes.yamlPair
      ? this.node.firstChild!.textContent || 'Unnamed property' : 'Array item';
  }
  private conversionEffect(type: KagamiMD.FrontmatterValueType): 'convert' | 'reset' {
    return convertedFrontmatterValue(this.valueNode, type) ? 'convert' : 'reset';
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
    const pos = this.getPos();
    const resolved = pos !== undefined && pos <= this.view.state.doc.content.size
      ? this.view.state.doc.resolve(pos)
      : null;
    const inFlow = resolved !== null && isFlowCollection(resolved.parent);
    this.inFlowState = inFlow;
    if (inFlow) delete this.dom.dataset.blockBox;
    else this.dom.dataset.blockBox = this.node.type.name;
    this.dom.dataset.inFlow = String(inFlow);
    if (this.indexBadge) {
      this.indexBadge.dom.hidden = inFlow;
      if (!inFlow && resolved !== null) {
        const numberText = String(resolved.index() + 1);
        if (this.indexBadge.label.textContent !== numberText) {
          this.indexBadge.label.textContent = numberText;
        }
      }
    }
    const kind = entryValueKind(this.valueNode);
    this.dom.dataset.valueKind = kind;
    const type = this.valueType;
    this.dom.dataset.valueType = type;
    if (this.icon.dataset.type !== type) {
      this.icon.dataset.type = type;
      this.icon.innerHTML = frontmatterTypeIcons[type];
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
      (this.indexBadge !== undefined && this.indexBadge.dom.contains(mutation.target)) ||
      (mutation.type === 'attributes' && mutation.target === this.dom) ||
      this.value?.ignoreMutation?.(mutation) === true;
  }
  destroy(): void {
    this.destroyed = true;
    this.value?.destroy?.();
    this.button.onclick = null;
    this.button.onkeydown = null;
    this.forget(this);
  }
}

/** An append button follows the ordered children without becoming one of them. */
class CollectionView implements PropertyView {
  readonly dom: HTMLDivElement;
  private readonly footer: HTMLDivElement;
  readonly contentDOM: HTMLDivElement;
  private readonly button: HTMLButtonElement;
  private readonly seq: ChildSequence;

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
    const actionLabel = this.node.type === schema.nodes.yamlMapping ? 'Add property' : 'Add item';
    this.button.setAttribute('aria-label', actionLabel);
    this.button.title = actionLabel;
    const textSpan = doc.createElement('span');
    textSpan.className = 'frontmatter-add-label';
    textSpan.textContent = actionLabel;
    this.button.append(propertyIcon(doc, '<path d="M12 5v14M5 12h14" />', '2'), textSpan);
    this.button.onclick = () => {
      if ((this.view.isDestroyed || !canRunCommand(this.view.state, this.view))) return;
      this.add();
      this.view.focus();
    };
    this.button.onkeydown = event => {
      if (!view.isDestroyed && routeHistoryKey(view, event)) event.stopPropagation();
    };
    this.seq = { content: this.contentDOM, trailing: this.footer };
    registerNodeView(this);
    this.sync();
  }

  get sequence(): ChildSequence | undefined {
    return isFlowCollection(this.node) ? undefined : this.seq;
  }

  private add(): void {
    const pos = this.getPos();
    if ((this.view.isDestroyed || !canRunCommand(this.view.state, this.view)) || pos === undefined) return;
    const tr = insertFrontmatterEntry(this.view.state, pos, this.node.childCount);
    if (tr) this.view.dispatch(tr);
  }
  update(node: Node): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.sync();
    return true;
  }
  sync(): void {
    this.button.disabled = !this.view.editable;
    const flow = isFlowCollection(this.node);
    this.dom.dataset.flow = String(flow);
    this.dom.dataset.empty = String(this.node.childCount === 0);
    syncNodeViewSequence(this, this.contentDOM);
    if (this.node.type === schema.nodes.yamlSequence) {
      const digits = sequenceIndexDigits(this.node.childCount);
      if (this.dom.style.getPropertyValue('--yaml-index-digits') !== digits) {
        this.dom.style.setProperty('--yaml-index-digits', digits);
      }
    }
  }

  /** Ignore clicks inside the collection's add-entry footer. */
  stopEvent(event: Event): boolean {
    return this.footer.contains(event.target as DOMNode);
  }

  /** Ignore DOM mutations from the footer button or container styling attributes. */
  ignoreMutation(mutation: ViewMutationRecord): boolean {
    return this.footer.contains(mutation.target) ||
      (mutation.type === 'attributes' && mutation.target === this.dom);
  }

  /** Clear button handlers and unregister this collection view on teardown. */
  destroy(): void {
    this.button.onclick = null;
    this.button.onkeydown = null;
    this.forget(this);
  }
}

/** A boolean is one atomic value. It has no hidden text field or separate UI state. */
class BooleanView implements PropertyView {
  readonly dom: HTMLDivElement;
  readonly selectionTarget = null;
  readonly brush = false;
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
      if (!view.isDestroyed && routeHistoryKey(view, event)) event.stopPropagation();
    };
    registerNodeView(this);
    this.sync();
  }

  nodePosition(): number | undefined { return this.getPos(); }

  private setChecked(checked: boolean): void {
    const pos = this.getPos();
    if ((this.view.isDestroyed || !canRunCommand(this.view.state, this.view)) || pos === undefined) return;
    const tr = setFrontmatterBoolean(this.view.state, pos, checked);
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
