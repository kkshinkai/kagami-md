/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-FileCopyrightText: Microsoft Corporation
 * SPDX-License-Identifier: MPL-2.0 AND MIT
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Derived from Visual Studio Code, https://github.com/microsoft/vscode. */

import { reportError } from './errors.js';
import { Destroyable, DestroyableStore, type IDestroyable, toDestroyable } from './lifecycle.js';

/** An event with zero or one parameters that can be subscribed to. */
export interface Event<T> {
  (listener: (event: T) => unknown, context?: unknown, destroyables?: IDestroyable[] | DestroyableStore): IDestroyable;
}

/** A registration has its own identity even when callbacks are equal. */
class Listener<T> {
  readonly kind = 'single';
  constructor(readonly value: (event: T) => unknown) {}
}

/** Removed entries stay empty until at least half the list can be compacted. */
class ListenerList<T> extends Array<Listener<T> | undefined> {
  readonly kind = 'list';
}

/** The two forms of a nonempty listener collection. */
type Listeners<T> = Listener<T> | ListenerList<T>;

/** The cursor is shared by nested deliveries on one emitter. */
class Delivery<T> {
  index = -1;
  end = 0;
  active = false;
  value: T | undefined;
  listeners: ListenerList<T> | undefined;

  /** Starts delivery of the listeners present when an event is fired. */
  start(value: T, listeners: ListenerList<T>): void {
    this.index = 0;
    this.end = listeners.length;
    this.active = true;
    this.value = value;
    this.listeners = listeners;
  }

  /** Ends every active loop that shares this cursor. */
  reset(): void {
    this.index = this.end;
    this.active = false;
    this.value = undefined;
    this.listeners = undefined;
  }
}

/** Publishes synchronous events in registration order, including reentrant delivery. */
export class Emitter<T> implements IDestroyable {
  private listeners: Listeners<T> | undefined;
  private delivery: Delivery<T> | undefined;
  private size = 0;
  private destroyed = false;
  private subscription: Event<T> | undefined;

  /** The function callers use to subscribe. */
  get event(): Event<T> {
    if (!this.subscription) this.subscription = (callback, context, destroyables) => this.add(callback, context, destroyables);
    return this.subscription;
  }

  /** Stops delivery and makes future subscriptions inert. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.delivery?.active) this.delivery.reset();
    this.listeners = undefined;
    this.size = 0;
  }

  /** Delivers an event before returning. */
  fire(event: T): void {
    if (this.delivery?.active) this.deliverQueue(this.delivery);
    const listeners = this.listeners;
    if (!listeners) return;
    switch (listeners.kind) {
      case 'single':
        this.deliver(listeners, event);
        return;
      case 'list': {
        const delivery = this.delivery!;
        delivery.start(event, listeners);
        this.deliverQueue(delivery);
        return;
      }
    }
    listeners satisfies never;
  }

  /** Whether at least one listener is subscribed. */
  hasListeners(): boolean { return this.size > 0; }

  private add(callback: (event: T) => unknown, context?: unknown, destroyables?: IDestroyable[] | DestroyableStore): IDestroyable {
    if (this.destroyed) return Destroyable.None;
    const listener = new Listener(context ? callback.bind(context) : callback);
    const listeners = this.listeners;
    if (!listeners) {
      this.listeners = listener;
    } else {
      this.listeners = this.append(listeners, listener);
    }
    this.size++;
    const subscription = toDestroyable(() => this.remove(listener));
    if (destroyables instanceof DestroyableStore) destroyables.add(subscription);
    else if (Array.isArray(destroyables)) destroyables.push(subscription);
    return subscription;
  }

  /** Keeps the single-listener representation until a second subscription arrives. */
  private append(listeners: Listeners<T>, listener: Listener<T>): Listeners<T> {
    switch (listeners.kind) {
      case 'single':
        if (!this.delivery) this.delivery = new Delivery();
        return new ListenerList(listeners, listener);
      case 'list':
        listeners.push(listener);
        return listeners;
    }
  }

  /** Removes a registration, adjusting a running cursor when the list is compacted. */
  private remove(listener: Listener<T>): void {
    const entries = this.listeners;
    if (!entries) return;
    if (entries.kind === 'single') {
      this.listeners = undefined;
      this.size = 0;
      return;
    }

    // A delivery under way reads this same list, so an emptied entry is skipped there too.
    const index = entries.indexOf(listener);
    if (index < 0) return;
    entries[index] = undefined;
    if (--this.size === 0) {
      this.listeners = undefined;
      return;
    }

    if (this.size * 2 <= entries.length) {
      const delivery = this.delivery!;
      let next = 0;
      for (let index = 0; index < entries.length; index++) {
        if (entries[index]) {
          entries[next++] = entries[index];
        } else if (delivery.active && next < delivery.end) {
          delivery.end--;
          if (next < delivery.index) delivery.index--;
        }
      }
      entries.length = next;
    }
  }

  /** Listener failures reach the host while later listeners still receive the event. */
  private deliver(listener: Listener<T> | undefined, value: T): void {
    if (!listener) return;
    try {
      listener.value(value);
    } catch (error) {
      reportError(error);
    }
  }

  /** Drains the current event before a nested fire starts its own delivery. */
  private deliverQueue(delivery: Delivery<T>): void {
    while (delivery.index < delivery.end) {
      // Advance before invoking the callback, which may reenter this loop.
      const index = delivery.index++;
      this.deliver(delivery.listeners![index], delivery.value as T);
    }
    delivery.reset();
  }
}
