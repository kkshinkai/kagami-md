/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Source } from '../source/index.js';
import { BindingState } from '../state/bindings.js';
import { correction } from '../state/correction.js';
import { historyPlugin } from '../state/history.js';
import { parserPlugin } from '../state/parser.js';
import { trailingWhitespace } from '../state/trailingwhitespace.js';
import { blockPreview } from '../schema/blockpreview.js';
import { callout, calloutCompletionSource } from '../schema/callout.js';
import { codeBlock } from '../schema/code.js';
import { codeSpan } from '../schema/codespan.js';
import { frontmatter } from '../schema/frontmatter.js';
import { heading } from '../schema/heading.js';
import { html } from '../schema/html.js';
import { image } from '../schema/image.js';
import { baseKeymap } from '../schema/keymap.js';
import { link } from '../schema/link.js';
import { list } from '../schema/list.js';
import { mark } from '../schema/mark.js';
import { math } from '../schema/math.js';
import { tag, tagCompletionSource } from '../schema/tag.js';
import { wikilinkCompletionSource } from '../schema/wikilink.js';
import { tables } from '../table/table.js';
import { tablePaste } from '../table/tablepaste.js';
import { blockDrag } from './blockdrag.js';
import { blockView } from './blockview.js';
import { clipboard } from './clipboard.js';
import { completion, type CompletionSource } from './completion.js';
import { drawSelection } from './drawselection.js';
import { input } from './input.js';
import { layout } from './layout.js';
import type { KagamiMD } from './editor.js';
import type { KagamiState } from '../state/state.js';
import { PluginDesc, PluginRank, type CompiledPlugins } from './plugin.js';
import { reveal } from './reveal.js';

/** Compile the editor's document, view-state, and view plugins for the given state options. */
export function compilePlugins(spec: KagamiState.Spec = {}): CompiledPlugins {
  const sources: CompletionSource<KagamiMD.CompletionCandidate>[] = [];
  const tagPlugins: PluginDesc[] = [];
  if (spec.tag != null) {
    sources.push(tagCompletionSource);
    tagPlugins.push(...tag());
  }
  if (spec.wikilink != null) {
    sources.push(wikilinkCompletionSource);
  }
  sources.push(calloutCompletionSource);
  return PluginDesc.compile([
    PluginDesc.state(Source.plugin, PluginRank.Highest),
    PluginDesc.state(state => parserPlugin(state?.parser), PluginRank.Highest),
    PluginDesc.state(BindingState.plugin, PluginRank.Highest),
    PluginDesc.state(historyPlugin, PluginRank.Highest),
    PluginDesc.view(layout, PluginRank.Highest),
    ...mark(),
    ...frontmatter(),
    PluginDesc.state(trailingWhitespace),
    PluginDesc.state(correction),
    ...input(),
    ...list(),
    PluginDesc.viewState(() => blockDrag(blockPreview)),
    ...callout(),
    PluginDesc.viewState(editor => completion(sources, editor)),
    PluginDesc.viewState(() => clipboard({ paste: [tablePaste] })),
    PluginDesc.viewState(reveal),
    ...tagPlugins,
    ...codeSpan(),
    ...html(),
    ...image(),
    ...codeBlock(),
    ...link(),
    PluginDesc.viewState(baseKeymap),
    ...heading(),
    ...tables(),
    ...math(),
    PluginDesc.view(() => blockView(), PluginRank.Lowest),
    PluginDesc.view(editor => editor?.drawnSelection ? drawSelection() : null, PluginRank.Lowest),
  ]);
}
