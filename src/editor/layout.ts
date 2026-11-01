/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { DOMNode } from './dom.js';
import { Plugin, type PluginView } from 'prosemirror-state';

interface LayoutRoot extends HTMLElement { layoutView?: LayoutView; }

/** Install the observer owner before plugins that subscribe to layout changes. */
export function layout(): Plugin {
  return new Plugin({ view: view => new LayoutView(view.dom as LayoutRoot) });
}

class LayoutView implements PluginView {
  private observer?: LayoutObserver;

  constructor(private readonly dom: LayoutRoot) { dom.layoutView = this; }

  subscribe(paint: () => void): LayoutSubscription {
    this.observer ??= new LayoutObserver(this.dom, () => { this.observer = undefined; });
    return this.observer.subscribe(paint);
  }

  destroy(): void {
    this.observer?.destroy();
    this.observer = undefined;
    delete this.dom.layoutView;
  }
}

export interface LayoutSubscription {
  /** Queue only this subscriber for the next frame. Calls after destruction do nothing. */
  schedule(): void;
  /** Rebind inherited styles after the editor moves to another container. */
  refreshAncestors(): void;
  /** Cancel this subscriber's pending work; the last subscriber releases observation. */
  destroy(): void;
}

/** One observer per editable root tracks block sizes, fonts and inherited styles. Subscribers
 * share layout invalidations and a frame, but retain independent scheduling and teardown.
 * An inactive painter releases its subscription; the last one releases observation. */
export function observeLayout(dom: HTMLElement, paint: () => void): LayoutSubscription {
  return (dom as LayoutRoot).layoutView!.subscribe(paint);
}

interface LayoutSubscriber {
  readonly paint: () => void;
}

class LayoutObserver {
  private document: Document;
  private win: Window;
  private readonly resize?: ResizeObserver;
  private readonly mutations: MutationObserver;
  private readonly themes: MutationObserver;
  private readonly sizes = new Set<Element>();
  private readonly subscribers = new Set<LayoutSubscriber>();
  private readonly pending = new Set<LayoutSubscriber>();
  private frame = 0;

  constructor(private readonly dom: HTMLElement, private readonly released: () => void) {
    this.document = dom.ownerDocument;
    this.win = this.document.defaultView!;
    // Nonvisual hosts have mutation invalidation but no layout engine or size observer.
    this.resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(this.invalidate);
    this.mutations = new MutationObserver(records => {
      for (const record of records) {
        if (record.type === 'childList') {
          for (const node of record.removedNodes) this.updateSubtree(node);
          for (const node of record.addedNodes) this.updateSubtree(node);
        } else if (record.attributeName === 'data-block-box') {
          this.updateSize(record.target as Element);
        }
      }
      this.invalidate();
    });
    this.mutations.observe(dom, { subtree: true, childList: true, attributes: true, characterData: true });
    this.themes = new MutationObserver(this.invalidate);
    this.refreshAncestors();
    dom.addEventListener('load', this.invalidate, true);
    this.document.fonts?.addEventListener('loadingdone', this.invalidate);
    this.updateSubtree(dom);
  }

  subscribe(paint: () => void): LayoutSubscription {
    const subscriber = { paint };
    this.subscribers.add(subscriber);
    return {
      schedule: () => {
        if (!this.subscribers.has(subscriber)) return;
        this.pending.add(subscriber);
        this.schedule();
      },
      refreshAncestors: () => {
        if (this.subscribers.has(subscriber)) this.refreshAncestors();
      },
      destroy: () => this.unsubscribe(subscriber),
    };
  }

  private unsubscribe(subscriber: LayoutSubscriber) {
    if (!this.subscribers.delete(subscriber)) return;
    this.pending.delete(subscriber);
    if (!this.pending.size) {
      this.win.cancelAnimationFrame(this.frame);
      this.frame = 0;
    }
    if (this.subscribers.size) return;
    this.destroy();
    this.released();
  }

  destroy(): void {
    this.win.cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.pending.clear();
    this.subscribers.clear();
    this.resize?.disconnect();
    this.mutations.disconnect();
    this.themes.disconnect();
    this.dom.removeEventListener('load', this.invalidate, true);
    this.document.fonts?.removeEventListener('loadingdone', this.invalidate);
  }

  private refreshAncestors() {
    const document = this.dom.ownerDocument;
    if (document !== this.document) {
      this.win.cancelAnimationFrame(this.frame);
      this.frame = 0;
      this.document.fonts?.removeEventListener('loadingdone', this.invalidate);
      this.document = document;
      this.win = document.defaultView!;
      document.fonts?.addEventListener('loadingdone', this.invalidate);
      this.schedule();
    }
    this.themes.disconnect();
    for (let ancestor = this.dom.parentElement; ancestor; ancestor = ancestor.parentElement) {
      this.themes.observe(ancestor, { attributes: true, attributeFilter: ['class', 'style'] });
    }
    this.themes.observe(document.head, { subtree: true, childList: true, characterData: true, attributes: true });
  }

  private updateSubtree(node: DOMNode) {
    if (node.nodeType !== 1) return;
    const element = node as Element;
    this.updateSize(element);
    for (const block of element.querySelectorAll('[data-block-box]')) this.updateSize(block);
  }

  private updateSize(element: Element) {
    const present = element === this.dom || this.dom.contains(element) && element.hasAttribute('data-block-box');
    if (present && !this.sizes.has(element)) {
      this.sizes.add(element);
      this.resize?.observe(element);
    } else if (!present && this.sizes.delete(element)) {
      this.resize?.unobserve(element);
    }
  }

  private invalidate = () => {
    for (const subscriber of this.subscribers) this.pending.add(subscriber);
    this.schedule();
  };

  private schedule() {
    if (!this.pending.size || this.frame) return;
    this.frame = this.win.requestAnimationFrame(() => {
      this.frame = 0;
      const pending = [...this.pending];
      this.pending.clear();
      for (const subscriber of pending) {
        if (!this.subscribers.has(subscriber)) continue;
        try {
          subscriber.paint();
        } catch (error) {
          this.win.reportError(error);
        }
      }
    });
  }
}
