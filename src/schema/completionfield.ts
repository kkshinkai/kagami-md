/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { DelimitedSyntax, Syntax, transduce, type Phrasing } from '../syntax/index.js';
import type { MarkType, ResolvedPos } from 'prosemirror-model';
import { TextSelection, type EditorState } from 'prosemirror-state';
import { bindings } from '../state/bindings.js';
import { fieldSource } from '../parse/field.js';
import { walkInline } from '../parse/inline.js';
import { pendingMarks, schema } from '../types/schema.js';

interface Occurrence {
  readonly type: MarkType | null;
  readonly start: number;
  end: number;
}

const transparent = new Set([
  schema.marks.emphasis, schema.marks.strongEmphasis, schema.marks.strikethrough, schema.marks.highlight,
]);

/** One completion reading shares its field, parser mode, source offsets and marked occurrences. */
export class CompletionField {
  readonly source: string;
  readonly start: number;
  readonly end: number;
  readonly caret: number;
  readonly mode: Phrasing;
  readonly tokens: readonly Occurrence[];
  private parsed: readonly Syntax[] | null = null;

  private constructor(readonly state: EditorState, readonly head: ResolvedPos) {
    this.source = fieldSource(head.parent);
    this.start = head.start();
    this.end = head.end();
    this.caret = head.parentOffset;
    if (head.parent.type === schema.nodes.tableParagraph) this.mode = 'tableCell';
    else if (head.parent.type === schema.nodes.heading) {
      this.mode = head.parent.attrs.form === 'atx' ? 'atxHeading' : 'setextHeading';
    } else this.mode = 'paragraph';
    this.tokens = this.readTokens();
  }

  static read(state: EditorState): CompletionField | null {
    const selection = state.selection;
    if (!(selection instanceof TextSelection) || !selection.empty) return null;
    const type = selection.$head.parent.type;
    if (type !== schema.nodes.paragraph && type !== schema.nodes.heading && type !== schema.nodes.tableParagraph)
      return null;
    const field = new CompletionField(state, selection.$head);
    if (field.tokens.some(token => token.type && pendingMarks.has(token.type) && field.caret >= token.start))
      return null;
    return field;
  }

  get syntax(): readonly Syntax[] {
    return this.parsed ??= this.parse(this.source);
  }

  /** A prompt cannot cross a line or start at an escaped marker. */
  starts(from: number): boolean {
    const before = this.source.slice(0, this.caret);
    const lineStart = Math.max(before.lastIndexOf('\n'), before.lastIndexOf('\r')) + 1;
    return from >= lineStart &&
      !this.tokens.some(token => token.type === schema.marks.backslashEscape && token.start + 1 === from);
  }

  /** A replacement is checked in the same field and parser mode as its prompt. */
  parse(source: string, firstInBlockQuote = false): readonly Syntax[] {
    const analysis = transduce(source, {
      phrasing: this.mode, firstInListItem: false, firstInBlockQuote,
    }, bindings.get(this.state));
    if (analysis.kind !== 'inline') return [];
    const tokens: Syntax[] = [];
    walkInline(analysis.children, node => {
      if (node instanceof DelimitedSyntax) return;
      tokens.push(node);
      return false;
    });
    return tokens;
  }

  replace(from: number, to: number, value: string): string | null {
    if (from < this.start || to > this.end || !value || /[\r\n]/u.test(value)) return null;
    return this.source.slice(0, from - this.start) + value + this.source.slice(to - this.start);
  }

  private readTokens(): Occurrence[] {
    const occurrences = new Map<MarkType, Map<number, Occurrence>>();
    const found: Occurrence[] = [];
    this.head.parent.forEach((piece, start) => {
      const end = start + piece.nodeSize;
      const meta = piece.marks.some(mark => mark.type === schema.marks.meta);
      const marks = piece.marks.filter(mark => mark.type !== schema.marks.meta && !transparent.has(mark.type));
      if (meta && !marks.length) found.push({ type: null, start, end });
      for (const mark of marks) {
        let typed = occurrences.get(mark.type);
        if (!typed) {
          typed = new Map();
          occurrences.set(mark.type, typed);
        }
        let occurrence = typed.get(mark.attrs.occurrence);
        if (!occurrence) {
          occurrence = { type: mark.type, start, end };
          typed.set(mark.attrs.occurrence, occurrence);
          found.push(occurrence);
        }
        occurrence.end = end;
      }
    });
    const tokens: Occurrence[] = [];
    for (const occurrence of found.sort((a, b) => a.start - b.start || b.end - a.end)) {
      const previous = tokens.at(-1);
      if (!previous || occurrence.end > previous.end) tokens.push(occurrence);
    }
    return tokens;
  }
}
