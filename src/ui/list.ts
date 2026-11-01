/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Destroyable, Emitter, type Event } from '../event/index.js';
import { check, createIcon } from './icon.js';

/**
 * A list of options with one of them active. The list never has the focus: the keyboard stays
 * where the user is typing, and its owner tells the list which option is active. A click
 * chooses an option without taking the focus away.
 */
export class List extends Destroyable {
  readonly element: HTMLElement;
  private readonly chosen = this._register(new Emitter<number>());
  /** The index of the option that was clicked. */
  readonly onDidChoose: Event<number> = this.chosen.event;
  private readonly pointed = this._register(new Emitter<number>());
  /** The index of the option the pointer moved onto. The owner decides whether it becomes active. */
  readonly onDidPoint: Event<number> = this.pointed.event;
  private active = -1;

  constructor(document: Document, id: string, label: string) {
    super();
    this.element = document.createElement('div');
    this.element.className = 'kagami-list';
    this.element.id = id;
    this.element.setAttribute('role', 'listbox');
    this.element.setAttribute('aria-label', label);
    this.element.addEventListener('mousedown', this.mouseDown);
    this.element.addEventListener('click', this.click);
    this.element.addEventListener('pointermove', this.pointerMove);
  }

  setItems(items: readonly List.Item[], active: number): void {
    this.element.replaceChildren(...items.map(item => this.drawItem(item)));
    this.active = -1;
    this.setActive(active);
  }

  setActive(index: number): void {
    this.element.children[this.active]?.setAttribute('aria-selected', 'false');
    this.active = index;
    const option = this.element.children[index];
    option?.setAttribute('aria-selected', 'true');
    option?.scrollIntoView({ block: 'nearest' });
  }

  private drawItem(item: List.Item): HTMLElement {
    const document = this.element.ownerDocument;
    const option = document.createElement('div');
    option.className = 'kagami-list-item';
    option.id = item.id;
    option.setAttribute('role', 'option');
    if (item.icon) option.append(createIcon(document, item.icon));
    const text = option.appendChild(document.createElement('span'));
    text.className = 'kagami-list-text';
    text.appendChild(document.createElement('span')).textContent = item.label;
    if (item.description) {
      const description = text.appendChild(document.createElement('span'));
      description.className = 'kagami-list-description';
      description.textContent = item.description;
    }
    if (item.current) {
      option.setAttribute('aria-description', 'Currently selected');
      option.appendChild(createIcon(document, check)).classList.add('kagami-list-check');
    }
    return option;
  }

  private findIndex(target: EventTarget | null): number {
    const option = target instanceof Element ? target.closest('.kagami-list-item') : null;
    return option ? [...this.element.children].indexOf(option) : -1;
  }

  /** Pressing the mouse on an option must not move the focus out of the editor or the input. */
  private readonly mouseDown = (event: MouseEvent): void => event.preventDefault();

  private readonly click = (event: MouseEvent): void => {
    const index = this.findIndex(event.target);
    if (index >= 0) this.chosen.fire(index);
  };

  /** The pointer and the keyboard move one active option, so that two are never highlighted. */
  private readonly pointerMove = (event: PointerEvent): void => {
    const index = this.findIndex(event.target);
    if (index >= 0 && index !== this.active) this.pointed.fire(index);
  };

  override destroy(): void {
    this.element.removeEventListener('pointermove', this.pointerMove);
    this.element.removeEventListener('mousedown', this.mouseDown);
    this.element.removeEventListener('click', this.click);
    this.element.remove();
    super.destroy();
  }
}

export namespace List {
  /** An option drawn in the list. */
  export interface Item {
    /** The id of the item's element, which whatever owns the keyboard names as its active descendant. */
    readonly id: string;
    readonly label: string;
    /** A second, quieter line under the label. */
    readonly description?: string;
    /** The content of a 24 by 24 SVG, drawn before the label. */
    readonly icon?: string;
    /** Marks the option that is the present value of what is being chosen. */
    readonly current?: boolean;
  }
}
