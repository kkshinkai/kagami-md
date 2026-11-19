/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export type DOMNode = globalThis.Node;

export const connectionEvent = 'kagami-editor-connection';
const elementName = 'kagami-markdown-editor';

/** A native element reports movement without owning the editor it contains. */
export function createEditorElement(document: Document): HTMLElement {
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
  const element = document.createElement(elementName);
  element.className = 'markdown-editor';
  element.style.display = 'block';
  return element;
}

interface SelectionRoot extends ShadowRoot {
  getSelection?: () => Selection | null;
}

/** Browsers without shadow-root selection access expose it on the owning document. */
export function getSelection(root: Document | ShadowRoot): Selection | null {
  const target: Document | SelectionRoot = root;
  return typeof target.getSelection === 'function' ? target.getSelection() : root.ownerDocument!.getSelection();
}
