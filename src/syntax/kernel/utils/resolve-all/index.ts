/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-FileCopyrightText: Titus Wormer <tituswormer@gmail.com>
 * SPDX-License-Identifier: MPL-2.0 AND MIT
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Derived from micromark, https://github.com/micromark/micromark. */

import type { Construct, Event, Resolver, TokenizeContext } from '../../../types/index.js';

/**
 * Call all `resolveAll`s.
 *
 * @param constructs
 *   List of constructs, optionally with `resolveAll`s.
 * @param events
 *   List of events.
 * @param context
 *   Context used by `tokenize`.
 * @returns
 *   Changed events.
 */
export function resolveAll(
  constructs: ReadonlyArray<Construct.Resolvable>,
  events: Array<Event>,
  context: TokenizeContext
): Array<Event> {
  const called: Array<Resolver> = [];
  let index = -1;

  while (++index < constructs.length) {
    const resolve = constructs[index].resolveAll;

    if (resolve && !called.includes(resolve)) {
      events = resolve(events, context);
      called.push(resolve);
    }
  }

  return events;
}
