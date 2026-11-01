/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-FileCopyrightText: Titus Wormer <tituswormer@gmail.com>
 * SPDX-License-Identifier: MPL-2.0 AND MIT
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Derived from micromark, https://github.com/micromark/micromark. */

import type {
  Extension,
  Handles,
  HTMLExtension
} from '../../../types/index.js';
import { splice } from '../chunked/index.js';

const hasOwnProperty = {}.hasOwnProperty;

/**
 * Combine multiple syntax extensions into one.
 *
 * @param extensions
 *   List of syntax extensions.
 * @returns
 *   A single combined extension.
 */
export function combineExtensions(extensions: ReadonlyArray<Extension>): Extension {
  const all: Extension = {};
  let index = -1;

  while (++index < extensions.length) {
    syntaxExtension(all, extensions[index]);
  }

  return all;
}

/**
 * Merge `extension` into `all`.
 *
 * @param all
 *   Extension to merge into.
 * @param extension
 *   Extension to merge.
 */
function syntaxExtension(all: Extension, extension: Extension): undefined {
  let hook: keyof Extension;

  for (hook in extension) {
    const maybe = hasOwnProperty.call(all, hook) ? all[hook] : undefined;
    const left: Record<string, unknown> = maybe || (all[hook] = {});
    const right: Record<string, unknown> | undefined = extension[hook];
    let code: string;

    if (right) {
      for (code in right) {
        if (!hasOwnProperty.call(left, code)) left[code] = [];
        const value = right[code];
        constructs(
          // @ts-expect-error Looks like a list.
          left[code],
          Array.isArray(value) ? value : value ? [value] : []
        );
      }
    }
  }
}

/**
 * Merge `list` into `existing` (both lists of constructs).
 * Mutates `existing`.
 *
 * @param existing
 *   List of constructs to merge into.
 * @param list
 *   List of constructs to merge.
 */
function constructs(existing: Array<unknown>, list: Array<unknown>): undefined {
  let index = -1;
  const before: Array<unknown> = [];

  while (++index < list.length) {
    // @ts-expect-error Looks like an object.
    (list[index].add === 'after' ? existing : before).push(list[index]);
  }

  splice(existing, 0, 0, before);
}

/**
 * Combine multiple HTML extensions into one.
 *
 * @param htmlExtensions
 *   List of HTML extensions.
 * @returns
 *   Single combined HTML extension.
 */
export function combineHTMLExtensions(htmlExtensions: ReadonlyArray<HTMLExtension>): HTMLExtension {
  const handlers: HTMLExtension = {};
  let index = -1;

  while (++index < htmlExtensions.length) {
    htmlExtension(handlers, htmlExtensions[index]);
  }

  return handlers;
}

/**
 * Merge `extension` into `all`.
 *
 * @param all
 *   Extension to merge into.
 * @param extension
 *   Extension to merge.
 */
function htmlExtension(all: HTMLExtension, extension: HTMLExtension): undefined {
  let hook: keyof HTMLExtension;

  for (hook in extension) {
    const maybe = hasOwnProperty.call(all, hook) ? all[hook] : undefined;
    const left = maybe || (all[hook] = {});
    const right = extension[hook];
    let type: keyof Handles;

    if (right) {
      for (type in right) {
        // @ts-expect-error assume document vs regular handler are managed correctly.
        left[type] = right[type];
      }
    }
  }
}
