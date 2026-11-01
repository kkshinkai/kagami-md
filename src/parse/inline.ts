/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Syntax } from '../syntax/index.js';

/** Visit inline syntax together with its ancestors, allowing a visitor to prune a branch. */
export function walkInline(nodes: readonly Syntax[],
  visit: (node: Syntax, ancestors: readonly Syntax[]) => boolean | void,
  ancestors: readonly Syntax[] = []): void {
  for (const node of nodes) {
    if (visit(node, ancestors) !== false) walkInline(node.getChildren(), visit, [...ancestors, node]);
  }
}
