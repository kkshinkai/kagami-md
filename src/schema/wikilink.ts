/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { WikilinkSyntax } from '../syntax/index.js';
import {
  queryCompletionProviders,
  type CompletionActions,
  type CompletionPrompt,
  type CompletionSnapshot,
  type CompletionSource,
} from '../editor/completion.js';
import type { KagamiMD } from '../editor/editor.js';
import { CompletionField } from './completionfield.js';

export interface WikilinkPrompt extends CompletionPrompt {
  readonly alias: string | null;
}

/** A page target is completed while the user's alias stays in the prompt. */
export const wikilinkCompletionSource: CompletionSource<KagamiMD.CompletionCandidate, WikilinkPrompt> = {
  kind: 'wikilink',
  match(state) {
    const field = CompletionField.read(state);
    if (!field) return null;
    const before = field.source.slice(0, field.caret);
    const from = before.lastIndexOf('[[');
    if (!field.starts(from)) return null;
    const link = field.syntax.find(token => token instanceof WikilinkSyntax && token.start === from);
    if (!(link instanceof WikilinkSyntax) && from < before.lastIndexOf('#')) return null;
    const queryFrom = from + 2;
    const query = field.source.slice(queryFrom, field.caret);
    if (link instanceof WikilinkSyntax) {
      if (field.caret > (link.aliasDelimiter?.start ?? link.closingBrackets.start)) return null;
      const alias = link.aliasDelimiter
        ? field.source.slice(link.aliasDelimiter.end, link.closingBrackets.start) : null;
      return { query, from: field.start + from, to: field.start + link.end, alias };
    }
    if (field.tokens.some(token => token.end > from && token.start < field.caret)) return null;
    if (query.includes('[') || query.includes('|') || query.includes(']')) return null;
    // Reuse an existing empty closing frame on the same line, such as [[]].
    const closing = field.source.indexOf(']]', field.caret);
    if (closing >= 0 && /^[ \t]*$/.test(field.source.slice(queryFrom, closing)) &&
        !field.tokens.some(token => token.end > from && token.start < closing + 2)) {
      return { query, from: field.start + from, to: field.start + closing + 2, alias: null };
    }
    return { query, from: field.start + from, to: field.start + field.caret, alias: null };
  },
  enabled: editor => (editor?.getWikilinkCompletionProviders().length ?? 0) > 0,
  candidates: (query, signal, editor) =>
    queryCompletionProviders(editor?.getWikilinkCompletionProviders() ?? [], query, signal, editor),
  apply(candidate, prompt, state) {
    const field = CompletionField.read(state);
    const value = candidate.value;
    if (!field || !value || /[\r\n]/u.test(value) || value.includes('|') || value.includes(']]')) return null;
    const alias = prompt.alias === null ? '' : `|${prompt.alias}`;
    const replacement = `[[${value}${alias}]]`;
    const source = field.replace(prompt.from, prompt.to, replacement);
    if (source === null) return null;
    const from = prompt.from - field.start;
    // The completed target must preserve the user's alias and introduce no second one.
    const valid = field.parse(source).some(token => token instanceof WikilinkSyntax && token.start === from &&
      token.end === from + replacement.length &&
      source.slice(token.openingBrackets.end, token.closingBrackets.start) === replacement.slice(2, -2));
    return valid ? replacement : null;
  },
  same: (a, b) => a.alias === b.alias,
  publish: (
    state: CompletionSnapshot<KagamiMD.CompletionCandidate>,
    prompt: WikilinkPrompt,
    actions: CompletionActions,
  ): KagamiMD.WikilinkCompletion => ({ kind: 'wikilink', alias: prompt.alias, ...state, ...actions }),
};
