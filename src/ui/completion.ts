/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { List } from './list.js';
import { Popup } from './popup.js';

/**
 * The list of completions at the caret. It never has the focus and closes only when it is told
 * to: whoever owns the keyboard decides what is active and when the list goes away.
 */
export class CompletionList {
  private readonly content: HTMLElement;
  private readonly status: HTMLElement;
  private list: List | null = null;
  private popup: Popup | null = null;
  private rect: Popup.Rect | null = null;

  constructor(document: Document, private readonly on: CompletionList.Handlers) {
    this.content = document.createElement('div');
    this.content.className = 'completion-list';
    this.status = document.createElement('div');
    this.status.className = 'kagami-list-status';
  }

  /** Shows these completions, or takes the list away when given null. */
  show(completions: CompletionList.Data | null): void {
    if (!completions) {
      this.popup?.destroy();
      this.popup = null;
      return;
    }
    if (this.list?.element.id !== completions.listId) {
      this.list?.destroy();
      this.list = new List(this.content.ownerDocument, completions.listId, completions.label);
      this.list.onDidChoose(index => this.on.choose(index));
      this.list.onDidPoint(index => this.on.point(index));
      this.content.replaceChildren(this.list.element, this.status);
    }
    const items = completions.items.map((item, index): List.Item => ({ ...item, id: completions.optionId(index) }));
    this.list.element.setAttribute('aria-label', completions.label);
    this.list.setItems(items, completions.active);
    this.content.dataset.kind = completions.kind;
    this.status.hidden = completions.items.length > 0;
    this.status.textContent = completions.status;
    this.rect = completions.rect;
    this.popup ??= new Popup({ getBoundingClientRect: () => this.rect! }, this.content, { dismiss: false });
    this.popup.layout();
  }

  destroy(): void {
    this.popup?.destroy();
    this.list?.destroy();
  }
}

export namespace CompletionList {
  /** One completion option. */
  export interface Item {
    readonly label: string;
    readonly description?: string;
    readonly icon?: string;
  }

  /** What owns the completion keyboard interaction. */
  export interface Handlers {
    choose(index: number): void;
    point(index: number): void;
  }

  /** What a list of completions shows. */
  export interface Data {
    /** Names the kind of thing completed, for the width of the list and for a screen reader. */
    readonly kind: string;
    readonly label: string;
    /** The id of the list's element, and of each option's: what owns the keyboard names them. */
    readonly listId: string;
    readonly optionId: (index: number) => string;
    readonly items: readonly Item[];
    readonly active: number;
    /** What to say when there are no items. */
    readonly status: string;
    readonly rect: Popup.Rect;
  }
}
