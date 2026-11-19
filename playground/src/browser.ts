/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-FileCopyrightText: Marijn Haverbeke <marijn@haverbeke.berlin>
 * SPDX-License-Identifier: MPL-2.0 AND MIT
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Derived from Wordgard, https://code.haverbeke.berlin/wordgard/wordgard. */

/** Wordgard's iOS (including iPadOS) and Android detection for the playground. */
export function isMobile(): boolean {
  const nav = navigator;
  const edge = /Edge\/(\d+)/.exec(nav.userAgent);
  const safari = !edge && /Apple Computer/.test(nav.vendor);
  const ios = safari && (/Mobile\/\w+/.test(nav.userAgent) || nav.maxTouchPoints > 2);
  const android = /Android\b/.test(nav.userAgent);
  return ios || android;
}
