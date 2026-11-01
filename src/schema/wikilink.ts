/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { WikilinkSyntax } from '../syntax/index.js';
import type { Plugin } from 'prosemirror-state';
import type { Completion as Completions } from '../editor/completion.js';
import { CompletionField } from './completionfield.js';

/** Wikilinks use the shared inline and completion plugins. */
export function wikilink(): Plugin[] {
  return [];
}

export namespace wikilink {
  export interface Prompt extends Completions.Prompt {
    readonly alias: string | null;
  }

  /** A page target is completed while the user's alias stays in the prompt. */
  export const source: Completions.Source<Completions.Candidate, Prompt> = {
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
      if (query.includes('|') || query.includes(']') || query.includes('[[')) return null;
      // Keep a same-line closing frame for an unfinished target such as [[|alias]].
      const closing = field.source.indexOf(']]', field.caret);
      const nextLine = field.source.slice(field.caret).search(/[\r\n]/u);
      if (closing >= 0 && (nextLine < 0 || closing < field.caret + nextLine)) {
        const divider = field.source.indexOf('|', queryFrom);
        const alias = divider >= field.caret && divider < closing ? field.source.slice(divider + 1, closing) : null;
        return { query, from: field.start + from, to: field.start + closing + 2, alias };
      }
      return { query, from: field.start + from, to: field.start + field.caret, alias: null };
    },
    enabled: editor => !!editor?.spec.completeWikilink,
    candidates: (query, signal, editor) => editor?.spec.completeWikilink?.(query, signal) ?? [],
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
    publish: (state, prompt) => ({ kind: 'wikilink', alias: prompt.alias, ...state }),
  };
}

/** Completion data for a page link written as `[[name]]`. */
export namespace Wikilink {
  /** A page-link completion is distinguished from the other feature presentations. */
  export interface Completion extends Completions.State<Completions.Candidate> {
    readonly kind: 'wikilink';
    readonly alias: string | null;
  }

  /** Answer a page query until its request is cancelled. */
  export type Completer = (query: string,
    signal: AbortSignal) => readonly Completions.Candidate[] | Promise<readonly Completions.Candidate[]>;
}
