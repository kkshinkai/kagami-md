/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { EditorView } from 'prosemirror-view';
import type { BlockRange } from '../state/selection.js';

import { localScale } from './coords.js';

/** Mount a model-rendered drag image outside the editor's scroll and layout ancestry. */
export function mountDragImage(
  view: EditorView,
  source: BlockRange,
  render: DragImage,
): HTMLElement {
  const document = view.dom.ownerDocument;
  const container = document.createElement('div');
  container.className = 'markdown-editor md-block-drag-image';
  container.contentEditable = 'false';
  container.inert = true;
  container.setAttribute('aria-hidden', 'true');
  const style = document.defaultView!.getComputedStyle(view.dom);
  for (const property of style) {
    if (property.startsWith('--editor-') || property.startsWith('--block-')) {
      container.style.setProperty(property, style.getPropertyValue(property));
    }
  }
  const content = render(view, source);
  container.append(content);
  const popover = typeof container.showPopover === 'function';
  if (popover) container.popover = 'manual';
  document.body.append(container);
  if (popover) container.showPopover();
  // Fixed-width descendants keep their wrapping. Include full nested tables in the capture
  // bounds without widening the surrounding paragraphs or changing the live scroll position.
  const width = `${Math.max(content.getBoundingClientRect().width, content.scrollWidth)}px`;
  content.style.width = container.style.width = width;
  const scale = localScale(view.dom);
  container.style.transform = `scale(${scale.x}, ${scale.y})`;
  return container;
}

/** Position the rendered preview for native capture. */
export function positionDragImage(container: HTMLElement): void {
  const agent = container.ownerDocument.defaultView!.navigator.userAgent;
  // PDD's Safari workaround avoids translucent background capture (WebKit 266025).
  if (agent.includes('AppleWebKit') && !agent.includes('Chrome')) {
    container.style.left = `${-(container.getBoundingClientRect().width - 0.0001)}px`;
  }
}

/** A renderer for the selected blocks in an HTML drag image. */
export interface DragImage {
  (view: EditorView, range: BlockRange): HTMLElement;
}
