/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Destroyable, Emitter, type Event } from '../event/index.js';
import { check, createIcon } from './icon.js';
import { Popup } from './popup.js';

/** One rendered action and its element. */
interface Row {
  readonly element: HTMLElement;
  readonly action: Menu.Action;
}

/**
 * A list of actions to choose one from. The focus is on one item at a time and moves with the
 * arrow keys; Enter or Space runs the focused item, and so does a click. A menu does not open
 * or close itself: it says that an item was run and its owner decides what follows.
 */
export class Menu extends Destroyable {
  readonly element: HTMLElement;
  private readonly ran = this._register(new Emitter<Menu.Action>());
  /** After an item's `run` has returned. */
  readonly onDidRun: Event<Menu.Action> = this.ran.event;
  private readonly rows: Row[] = [];

  constructor(document: Document, items: readonly Menu.Item[], label: string) {
    super();
    this.element = document.createElement('div');
    this.element.className = 'kagami-menu';
    this.element.setAttribute('role', 'menu');
    this.element.setAttribute('aria-label', label);
    for (const item of items) this.append(item);
    this.element.addEventListener('keydown', this.keyDown);
    this.element.addEventListener('click', this.click);
    this.element.addEventListener('pointermove', this.pointerMove);
  }

  /** Puts the focus on the checked item, or on the first one that can be run. */
  focus(): void {
    const enabled = this.rows.filter(row => !row.action.disabled);
    const current = enabled.find(row => row.action.checked) ?? enabled[0];
    current?.element.focus();
  }

  private append(item: Menu.Item): void {
    const document = this.element.ownerDocument;
    const element = this.element.appendChild(document.createElement('div'));
    switch (item.type) {
      case 'separator':
        element.className = 'kagami-menu-separator';
        element.setAttribute('role', 'separator');
        return;
      case 'heading':
        element.className = 'kagami-menu-heading';
        element.textContent = item.label;
        return;
      case 'action':
        this.appendAction(element, item);
        return;
      default:
        item satisfies never;
    }
  }

  private appendAction(element: HTMLElement, action: Menu.Action): void {
    const document = element.ownerDocument;
    element.className = 'kagami-menu-item';
    element.tabIndex = -1;
    element.setAttribute('role', action.checked === undefined ? 'menuitem' : 'menuitemradio');
    if (action.checked !== undefined) element.setAttribute('aria-checked', String(action.checked));
    if (action.disabled) element.setAttribute('aria-disabled', 'true');
    if (action.destructive) element.dataset.destructive = 'true';
    if (action.icon) element.append(createIcon(document, action.icon));
    element.appendChild(document.createElement('span')).textContent = action.label;
    // An item that can be checked keeps the place of the mark, so that checking another
    // item moves no label.
    if (action.checked !== undefined) {
      const mark = element.appendChild(createIcon(document, check));
      mark.classList.add('kagami-menu-check');
    }
    this.rows.push({ element, action });
  }

  private findRow(target: EventTarget | null): Row | undefined {
    return this.rows.find(row => target instanceof Node && row.element.contains(target));
  }

  private run(action: Menu.Action): void {
    if (action.disabled) return;
    action.run();
    this.ran.fire(action);
  }

  private move(enabled: readonly Row[], index: number): void {
    enabled[(index + enabled.length) % enabled.length]?.element.focus();
  }

  private readonly click = (event: MouseEvent): void => {
    const row = this.findRow(event.target);
    if (row) this.run(row.action);
  };

  /** The pointer and the keyboard move one focus, so that there is never a second highlighted item. */
  private readonly pointerMove = (event: PointerEvent): void => {
    const row = this.findRow(event.target);
    if (row && !row.action.disabled) row.element.focus();
  };

  private readonly keyDown = (event: KeyboardEvent): void => {
    if (event.altKey || event.metaKey || event.ctrlKey) return;
    const enabled = this.rows.filter(row => !row.action.disabled);
    const current = enabled.findIndex(row => row.element === this.element.ownerDocument.activeElement);
    switch (event.key) {
      case 'ArrowDown':
        this.move(enabled, current + 1);
        break;
      case 'ArrowUp':
        this.move(enabled, current < 0 ? -1 : current - 1);
        break;
      case 'Home':
        this.move(enabled, 0);
        break;
      case 'End':
        this.move(enabled, -1);
        break;
      case 'Enter':
      case ' ':
        if (current >= 0) this.run(enabled[current]!.action);
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  override destroy(): void {
    this.element.removeEventListener('keydown', this.keyDown);
    this.element.removeEventListener('click', this.click);
    this.element.removeEventListener('pointermove', this.pointerMove);
    this.element.remove();
    super.destroy();
  }
}

export namespace Menu {
  /** An action the user can run. */
  export interface Action {
    readonly type: 'action';
    readonly label: string;
    /** The content of a 24 by 24 SVG, drawn before the label. */
    readonly icon?: string;
    /** Marks the item as the current one of a group of alternatives. */
    readonly checked?: boolean;
    /** An action that takes something away. */
    readonly destructive?: boolean;
    readonly disabled?: boolean;
    run(): void;
  }

  /** A line between groups of actions. */
  export interface Separator {
    readonly type: 'separator';
  }

  /** The name of the group that follows. */
  export interface Heading {
    readonly type: 'heading';
    readonly label: string;
  }

  /** One entry in a menu. */
  export type Item = Action | Separator | Heading;

  /** Opens a menu beside a rectangle. Running an item closes it. */
  export function open(document: Document, host: Popup.Host, label: string, items: readonly Item[], options: Popup.Options = {}): Popup.Open {
    const menu = new Menu(document, items, label);
    const shown = Popup.show(host, menu, options);
    menu.onDidRun(() => shown.close());
    return shown;
  }
}
