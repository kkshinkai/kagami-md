/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Destroyable, Emitter, type Event } from '../event/index.js';
import { List } from './list.js';
import { Popup } from './popup.js';

let pickers = 0;

/**
 * A field to type in and the items that match what was typed. The focus stays in the field;
 * the arrow keys move through the list and Enter chooses.
 */
export class Picker extends Destroyable {
  readonly element: HTMLElement;
  private readonly chosen = this._register(new Emitter<string>());
  /** The value that was chosen. */
  readonly onDidChoose: Event<string> = this.chosen.event;
  private readonly input: HTMLInputElement;
  private readonly list: List;
  private readonly empty: HTMLElement;
  private choices: readonly Picker.Item[] = [];
  private active = 0;

  constructor(document: Document, private readonly options: Picker.Options) {
    super();
    const id = `kagami-picker-${++pickers}`;
    this.element = document.createElement('div');
    this.element.className = 'kagami-picker';
    this.input = this.element.appendChild(document.createElement('input'));
    this.input.className = 'kagami-picker-input';
    this.input.type = 'text';
    this.input.placeholder = options.placeholder;
    this.input.spellcheck = false;
    this.input.autocomplete = 'off';
    this.input.setAttribute('role', 'combobox');
    this.input.setAttribute('aria-label', options.label);
    this.input.setAttribute('aria-expanded', 'true');
    this.input.setAttribute('aria-controls', id);
    this.input.setAttribute('aria-autocomplete', 'list');
    this.list = this._register(new List(document, id, options.label));
    this.empty = document.createElement('div');
    this.empty.className = 'kagami-list-status';
    this.empty.textContent = 'No results.';
    this.element.append(this.list.element, this.empty);
    this._register(this.list.onDidChoose(index => this.choose(index)));
    this._register(this.list.onDidPoint(index => this.activate(index)));
    this.input.addEventListener('input', this.filter);
    this.input.addEventListener('keydown', this.keyDown);
    this.filter();
  }

  focus(): void {
    this.input.focus();
    // The list was filled before it was in the page; bring the active option into view now.
    this.activate(this.active);
  }

  private readonly filter = (): void => {
    const { items, current, custom } = this.options;
    const query = this.input.value.trim();
    const wanted = query.toLowerCase();
    const matches = items.filter(item =>
      item.label.toLowerCase().includes(wanted) || item.value.toLowerCase().includes(wanted));
    const named = items.some(item => item.label.toLowerCase() === wanted || item.value.toLowerCase() === wanted);
    this.choices = custom && query && !named ? [...matches, { value: query, label: custom(query) }] : matches;
    // With nothing typed the present value is the active one; otherwise the best match is.
    const present = query ? 0 : this.choices.findIndex(choice => choice.value === current);
    const active = Math.max(0, present);
    const options = this.choices.map((choice, index): List.Item => ({
      id: `${this.list.element.id}-${index}`,
      label: choice.label,
      current: choice.value === current,
    }));
    this.list.setItems(options, active);
    this.empty.hidden = this.choices.length > 0;
    this.activate(active);
  };

  private activate(index: number): void {
    this.active = index;
    this.list.setActive(index);
    const option = this.list.element.children[index];
    if (option) this.input.setAttribute('aria-activedescendant', option.id);
    else this.input.removeAttribute('aria-activedescendant');
  }

  private choose(index: number): void {
    const choice = this.choices[index];
    if (choice) this.chosen.fire(choice.value);
  }

  private readonly keyDown = (event: KeyboardEvent): void => {
    if (event.isComposing) return;
    // Undo in the field undoes typing in the field, and nothing outside it.
    if ((event.metaKey || event.ctrlKey) && ['z', 'y'].includes(event.key.toLowerCase())) {
      event.stopPropagation();
      return;
    }
    const count = this.choices.length;
    switch (event.key) {
      case 'ArrowDown':
        if (count) this.activate((this.active + 1) % count);
        break;
      case 'ArrowUp':
        if (count) this.activate((this.active - 1 + count) % count);
        break;
      case 'Enter':
        this.choose(this.active);
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  override destroy(): void {
    this.input.removeEventListener('input', this.filter);
    this.input.removeEventListener('keydown', this.keyDown);
    this.element.remove();
    super.destroy();
  }
}

export namespace Picker {
  /** A searchable value and its label. */
  export interface Item {
    readonly value: string;
    /** What is shown, and what is searched along with the value. */
    readonly label: string;
  }

  /** The values and input shown in a picker. */
  export interface Options {
    /** What the field is for, said to a screen reader. */
    readonly label: string;
    readonly placeholder: string;
    readonly items: readonly Item[];
    /** The value that is chosen at present, if any. */
    readonly current?: string;
    /**
     * Given, what was typed can be chosen as it stands when it is none of the items. The
     * function answers the label of that choice.
     */
    readonly custom?: (typed: string) => string;
  }

  /** A picker that reports its choice to the host. */
  export interface OpenOptions extends Options {
    choose(value: string): void;
  }

  /** Opens a searchable list beside a rectangle. Choosing an item closes it. */
  export function open(document: Document, host: Popup.Host, options: OpenOptions, popupOptions: Popup.Options = {}): Popup.Open {
    const field = new Picker(document, options);
    const shown = Popup.show(host, field, popupOptions);
    field.onDidChoose(value => {
      options.choose(value);
      shown.close();
    });
    return shown;
  }
}
