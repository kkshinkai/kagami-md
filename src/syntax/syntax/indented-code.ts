/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Indented code keeps its field exactly when neither edge is a blank line. */
export function fitsIndentedCode(text: string): boolean {
  const lines = text.split(/\r?\n|\r/);
  return /[^ \t]/.test(lines[0]) && /[^ \t]/.test(lines[lines.length - 1]);
}
