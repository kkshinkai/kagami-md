/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Node } from 'prosemirror-model';
import { schema } from '../types/schema.js';

/** A line break where a physical line ending would end the enclosing block. */
export const lineBreakTag = '<br/>';

/** Spell a requested line break in the field that receives it. */
export function lineBreakText(node: Node): string {
  if (node.type === schema.nodes.tableParagraph || node.type === schema.nodes.calloutTitle) return lineBreakTag;
  if (node.type === schema.nodes.heading && !(node.attrs.form === 'setext' && Number(node.attrs.level) <= 2)) {
    return lineBreakTag;
  }
  return '\n';
}
