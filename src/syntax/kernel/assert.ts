/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Local dependency removal: check tokenizer and compiler invariants in every build. */
export function assert(value: unknown, message?: string): asserts value {
  if (!value) throw new Error(message ?? 'Assertion failed');
}
