/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-FileCopyrightText: Microsoft Corporation
 * SPDX-License-Identifier: MPL-2.0 AND MIT
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Derived from Visual Studio Code, https://github.com/microsoft/vscode. */

/** An object that performs a cleanup operation when `.destroy()` is called. */
export interface IDestroyable {
  destroy(): void;
}

/** Turns a cleanup function into a registration that can be destroyed only once. */
export function toDestroyable(cleanup: () => void): IDestroyable {
  let destroyed = false;
  return {
    destroy() {
      if (destroyed) return;
      destroyed = true;
      cleanup();
    },
  };
}

/** Owns a set of registrations and destroys all of them, including when one throws. */
export class DestroyableStore implements IDestroyable {
  private readonly children = new Set<IDestroyable>();
  private destroyed = false;

  /** Destroys registered values once and closes the store. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clear();
  }

  /** Destroys registered values while leaving the store open. */
  clear(): void {
    const errors: unknown[] = [];
    try {
      for (const child of this.children) {
        try {
          child.destroy();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, 'Encountered errors while destroying store');
    } finally {
      this.children.clear();
    }
  }

  /** Adds a value. A closed store warns and leaves ownership with the caller. */
  add<T extends IDestroyable>(value: T): T {
    if (value === Destroyable.None) return value;
    if (value === (this as IDestroyable)) throw new Error('Cannot register a destroyable on itself!');
    if (this.destroyed) {
      console.warn(new Error('Trying to add a destroyable to a DestroyableStore that has already been destroyed. The added object will be leaked!').stack);
    } else {
      this.children.add(value);
    }
    return value;
  }
}

/** Base class for an object that owns cleanup registrations. */
export abstract class Destroyable implements IDestroyable {
  /** A registration that does nothing when destroyed. */
  static readonly None = Object.freeze<IDestroyable>({ destroy() {} });

  protected readonly _store = new DestroyableStore();

  /** Destroys the registrations owned by this object. */
  destroy(): void { this._store.destroy(); }

  /** Registers a value to be destroyed with this object. */
  protected _register<T extends IDestroyable>(value: T): T {
    if (value === (this as IDestroyable)) throw new Error('Cannot register a destroyable on itself!');
    return this._store.add(value);
  }
}
