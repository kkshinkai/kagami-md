/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { KagamiMD } from './editor.js';

export type DOMNode = globalThis.Node;

export const connectionEvent = 'kagami-editor-connection';
const elementName = 'kagami-markdown-editor';

export interface EditorElement extends HTMLElement {
  editor: KagamiMD | null;
}

/** A native element reports movement without owning the editor it contains. */
export function createEditorElement(document: Document, editor: KagamiMD): EditorElement {
  const window = document.defaultView!;
  if (!window.customElements.get(elementName)) {
    window.customElements.define(elementName, class extends window.HTMLElement {
      private changed() { this.dispatchEvent(new window.Event(connectionEvent)); }
      connectedCallback() { this.changed(); }
      disconnectedCallback() { this.changed(); }
      adoptedCallback() { this.changed(); }
      connectedMoveCallback() { this.changed(); }
    });
  }
  const element = document.createElement(elementName) as EditorElement;
  element.editor = editor;
  element.className = 'markdown-editor';
  element.style.display = 'block';
  return element;
}

/** Find the editor containing a DOM node, including a node inside a shadow root. */
export function findEditor(dom: DOMNode): KagamiMD | null {
  for (let node: DOMNode | null = dom; node; node = node.parentNode ||
    (node.nodeType === 11 ? (node as ShadowRoot).host : null)) {
    if (node.nodeType === 1 && (node as Element).localName === elementName) {
      return (node as EditorElement).editor;
    }
  }
  return null;
}

interface SelectionRoot extends ShadowRoot {
  getSelection?: () => Selection | null;
}

/** Browsers without shadow-root selection access expose it on the owning document. */
export function getSelection(root: Document | ShadowRoot): Selection | null {
  const target: Document | SelectionRoot = root;
  return typeof target.getSelection === 'function' ? target.getSelection() : root.ownerDocument!.getSelection();
}
