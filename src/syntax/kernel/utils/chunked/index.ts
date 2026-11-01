/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-FileCopyrightText: Titus Wormer <tituswormer@gmail.com>
 * SPDX-License-Identifier: MPL-2.0 AND MIT
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Derived from micromark, https://github.com/micromark/micromark. */

import { constants } from '../symbol/index.js';

/**
 * Like `Array#splice`, but smarter for giant arrays.
 *
 * `Array#splice` takes all items to be inserted as individual argument which
 * causes a stack overflow in V8 when trying to insert 100k items for instance.
 *
 * Otherwise, this does not return the removed items, and takes `items` as an
 * array instead of rest parameters.
 *
 * @param list
 *   List to operate on.
 * @param start
 *   Index to remove/insert at (can be negative).
 * @param remove
 *   Number of items to remove.
 * @param items
 *   Items to inject into `list`.
 */
export function splice<T>(list: Array<T>, start: number, remove: number, items: Array<T>): undefined {
  const end = list.length;
  let chunkStart = 0;
  let parameters: Array<unknown>;

  // Make start between zero and `end` (included).
  if (start < 0) {
    start = -start > end ? 0 : end + start;
  } else {
    start = start > end ? end : start;
  }

  remove = remove > 0 ? remove : 0;

  // No need to chunk the items if there’s only a couple (10k) items.
  if (items.length < constants.v8MaxSafeChunkSize) {
    parameters = Array.from(items);
    parameters.unshift(start, remove);
    // @ts-expect-error Hush, it’s fine.
    list.splice(...parameters);
  } else {
    // Delete `remove` items starting from `start`
    if (remove) list.splice(start, remove);

    // Insert the items in chunks to not cause stack overflows.
    while (chunkStart < items.length) {
      parameters = items.slice(
        chunkStart,
        chunkStart + constants.v8MaxSafeChunkSize
      );
      parameters.unshift(start, 0);
      // @ts-expect-error Hush, it’s fine.
      list.splice(...parameters);

      chunkStart += constants.v8MaxSafeChunkSize;
      start += constants.v8MaxSafeChunkSize;
    }
  }
}

/**
 * Append `items` (an array) at the end of `list` (another array).
 * When `list` was empty, returns `items` instead.
 *
 * This prevents a potentially expensive operation when `list` is empty,
 * and adds items in batches to prevent V8 from hanging.
 *
 * @param list
 *   List to operate on.
 * @param items
 *   Items to add to `list`.
 * @returns
 *   Either `list` or `items`.
 */
export function push<T>(list: Array<T>, items: Array<T>): Array<T> {
  if (list.length > 0) {
    splice(list, list.length, 0, items);
    return list;
  }

  return items;
}
