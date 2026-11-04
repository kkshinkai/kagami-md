/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { history } from '../state/history.js';
import type { Plugin } from 'prosemirror-state';
import { source } from '../source/index.js';
import { bindings } from '../state/bindings.js';
import { schema } from '../types/schema.js';
import { correction } from '../state/correction.js';
import { trailingWhitespace } from '../state/trailingwhitespace.js';
import { input } from '../editor/input.js';
import { reveal } from '../editor/reveal.js';
import { clipboard } from '../editor/clipboard.js';
import { completion } from '../editor/completion.js';
import { drawSelection } from '../editor/drawselection.js';
import { blockDrag } from '../editor/blockdrag.js';
import { layout } from '../editor/layout.js';
import { blockView } from '../editor/blockview.js';
import { tables } from '../table/table.js';
import { tablePaste } from '../table/tablepaste.js';
import { heading } from './heading.js';
import { link } from './link.js';
import { list } from './list.js';
import { mark } from './mark.js';
import { codeBlock } from './code.js';
import { frontmatter } from './frontmatter.js';
import { callout } from './callout.js';
import { html } from './html.js';
import { image } from './image.js';
import { math } from './math.js';
import { tag } from './tag.js';
import { codeSpan } from './codespan.js';
import { wikilink } from './wikilink.js';
import { baseKeymap } from './keymap.js';
import { blockPreview } from './blockpreview.js';

/** The complete document and view features, in correction and event order. */
export function fullSchema(): Plugin[] {
  return [
    source(),
    bindings(),
    history(),
    layout(),
    ...input(),
    ...mark(),
    ...frontmatter(),
    trailingWhitespace(),
    correction(),
    ...list(),
    ...input.pointer(),
    blockDrag(blockPreview),
    ...callout(),
    completion([tag.source, wikilink.source, callout.source]),
    clipboard({ paste: [frontmatter.pasteText, tablePaste] }),
    reveal(),
    ...tag(),
    ...codeSpan(),
    ...wikilink(),
    html.presentation(),
    ...image(),
    ...codeBlock(),
    link.views(),
    link.keymap(),
    link.input(),
    baseKeymap(),
    ...heading(),
    ...tables(),
    ...math(),
    blockView(schema),
    drawSelection(),
  ];
}
