/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Syntax, SourceRange } from './syntax.js';

/** The frontier of a field: its pieces, in the order of the text. */
export type Frontier = Array<FrontierPiece>;

/**
 * A piece of a field's text, given by a tagged leaf of the tree.
 */
export interface FrontierPiece extends SourceRange {
  /**
   * The nodes the piece is in, outermost first. The first is the constituent the piece belongs
   * to (private-docs/rules/whole-constituents.md); a piece of the field's own text, a text node
   * at the top, is its own constituent. Each entry is the actual ancestor node, followed by the leaf itself.
   */
  nodes: Array<Syntax>;
  /**
   * The leaf's classification, read directly from the syntax tree.
   */
  tag: 'Text' | 'Delimiter' | 'Trivia';
}
