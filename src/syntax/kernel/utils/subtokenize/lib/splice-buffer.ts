/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-FileCopyrightText: Titus Wormer <tituswormer@gmail.com>
 * SPDX-License-Identifier: MPL-2.0 AND MIT
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Derived from micromark, https://github.com/micromark/micromark. */

import { constants } from '../../symbol/index.js';

/**
 * Some of the internal operations of micromark do lots of editing
 * operations on very large arrays. This runs into problems with two
 * properties of most circa-2020 JavaScript interpreters:
 *
 *  - Array-length modifications at the high end of an array (push/pop) are
 *    expected to be common and are implemented in (amortized) time
 *    proportional to the number of elements added or removed, whereas
 *    other operations (shift/unshift and splice) are much less efficient.
 *  - Function arguments are passed on the stack, so adding tens of thousands
 *    of elements to an array with `arr.push(...newElements)` will frequently
 *    cause stack overflows.
 *    (see <https://stackoverflow.com/questions/22123769/rangeerror-maximum-call-stack-size-exceeded-why>)
 *
 * SpliceBuffers are an implementation of gap buffers, which are a
 * generalization of the "queue made of two stacks" idea. The splice buffer
 * maintains a cursor, and moving the cursor has cost proportional to the
 * distance the cursor moves, but inserting, deleting, or splicing in
 * new information at the cursor is as efficient as the push/pop operation.
 * This allows for an efficient sequence of splices (or pushes, pops, shifts,
 * or unshifts) as long such edits happen at the same part of the array or
 * generally sweep through the array from the beginning to the end.
 *
 * The interface for splice buffers also supports large numbers of inputs by
 * passing a single array argument rather passing multiple arguments on the
 * function call stack.
 */
export class SpliceBuffer<T> {
  left: Array<T>;
  right: Array<T>;

  /**
   * @param initial
   *   Initial items (optional).
   */
  constructor(initial?: ReadonlyArray<T> | null) {
    this.left = initial ? [...initial] : [];
    this.right = [];
  }

  /**
   * Array access;
   * does not move the cursor.
   *
   * @param index
   *   Index.
   * @returns
   *   Item.
   */
  get(index: number): T {
    if (index < 0 || index >= this.left.length + this.right.length) {
      throw new RangeError(
        'Cannot access index `' +
          index +
          '` in a splice buffer of size `' +
          (this.left.length + this.right.length) +
          '`'
      );
    }

    if (index < this.left.length) return this.left[index];
    return this.right[this.right.length - index + this.left.length - 1];
  }

  /**
   * The length of the splice buffer, one greater than the largest index in the
   * array.
   */
  get length(): number {
    return this.left.length + this.right.length;
  }

  /**
   * Remove and return `list[0]`;
   * moves the cursor to `0`.
   *
   * @returns
   *   Item, optional.
   */
  shift(): T | undefined {
    this.setCursor(0);
    return this.right.pop();
  }

  /**
   * Slice the buffer to get an array;
   * does not move the cursor.
   *
   * @param start
   *   Start.
   * @param end
   *   End (optional).
   * @returns
   *   Array of items.
   */
  slice(start: number, end?: number | null): Array<T> {
    const stop: number = end === null || end === undefined ? Number.POSITIVE_INFINITY : end;

    if (stop < this.left.length) {
      return this.left.slice(start, stop);
    }

    if (start > this.left.length) {
      return this.right
        .slice(
          this.right.length - stop + this.left.length,
          this.right.length - start + this.left.length
        )
        .reverse();
    }

    return this.left
      .slice(start)
      .concat(
        this.right.slice(this.right.length - stop + this.left.length).reverse()
      );
  }

  /**
   * Mimics the behavior of Array.prototype.splice() except for the change of
   * interface necessary to avoid segfaults when patching in very large arrays.
   *
   * This operation moves cursor is moved to `start` and results in the cursor
   * placed after any inserted items.
   *
   * @param start
   *   Start;
   *   zero-based index at which to start changing the array;
   *   negative numbers count backwards from the end of the array and values
   *   that are out-of bounds are clamped to the appropriate end of the array.
   * @param deleteCount
   *   Delete count (default: `0`);
   *   maximum number of elements to delete, starting from start.
   * @param items
   *   Items to include in place of the deleted items (default: `[]`).
   * @returns
   *   Any removed items.
   */
  splice(start: number, deleteCount?: number | null, items?: Array<T> | null): Array<T> {
    const count: number = deleteCount || 0;

    this.setCursor(Math.trunc(start));
    const removed = this.right.splice(
      this.right.length - count,
      Number.POSITIVE_INFINITY
    );
    if (items) chunkedPush(this.left, items);
    return removed.reverse();
  }

  /**
   * Remove and return the highest-numbered item in the array, so
   * `list[list.length - 1]`;
   * Moves the cursor to `length`.
   *
   * @returns
   *   Item, optional.
   */
  pop(): T | undefined {
    this.setCursor(Number.POSITIVE_INFINITY);
    return this.left.pop();
  }

  /**
   * Inserts a single item to the high-numbered side of the array;
   * moves the cursor to `length`.
   *
   * @param item
   *   Item.
   */
  push(item: T): undefined {
    this.setCursor(Number.POSITIVE_INFINITY);
    this.left.push(item);
  }

  /**
   * Inserts many items to the high-numbered side of the array.
   * Moves the cursor to `length`.
   *
   * @param items
   *   Items.
   */
  pushMany(items: Array<T>): undefined {
    this.setCursor(Number.POSITIVE_INFINITY);
    chunkedPush(this.left, items);
  }

  /**
   * Inserts a single item to the low-numbered side of the array;
   * Moves the cursor to `0`.
   *
   * @param item
   *   Item.
   */
  unshift(item: T): undefined {
    this.setCursor(0);
    this.right.push(item);
  }

  /**
   * Inserts many items to the low-numbered side of the array;
   * moves the cursor to `0`.
   *
   * @param items
   *   Items.
   */
  unshiftMany(items: Array<T>): undefined {
    this.setCursor(0);
    chunkedPush(this.right, items.reverse());
  }

  /**
   * Move the cursor to a specific position in the array. Requires
   * time proportional to the distance moved.
   *
   * If `n < 0`, the cursor will end up at the beginning.
   * If `n > length`, the cursor will end up at the end.
   *
   * @param n
   *   Position.
   */
  setCursor(n: number): undefined {
    if (
      n === this.left.length ||
      (n > this.left.length && this.right.length === 0) ||
      (n < 0 && this.left.length === 0)
    )
      return;
    if (n < this.left.length) {
      // Move cursor to the this.left
      const removed = this.left.splice(n, Number.POSITIVE_INFINITY);
      chunkedPush(this.right, removed.reverse());
    } else {
      // Move cursor to the this.right
      const removed = this.right.splice(
        this.left.length + this.right.length - n,
        Number.POSITIVE_INFINITY
      );
      chunkedPush(this.left, removed.reverse());
    }
  }
}

/**
 * Avoid stack overflow by pushing items onto the stack in segments
 *
 * @param list
 *   List to inject into.
 * @param right
 *   Items to inject.
 */
function chunkedPush<T>(list: Array<T>, right: ReadonlyArray<T>): undefined {
  let chunkStart: number = 0;

  if (right.length < constants.v8MaxSafeChunkSize) {
    list.push(...right);
  } else {
    while (chunkStart < right.length) {
      list.push(
        ...right.slice(chunkStart, chunkStart + constants.v8MaxSafeChunkSize)
      );
      chunkStart += constants.v8MaxSafeChunkSize;
    }
  }
}
