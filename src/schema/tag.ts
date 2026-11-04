/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Node } from 'prosemirror-model';
import { Plugin, PluginKey, TextSelection, type EditorState } from 'prosemirror-state';
import { Decoration } from 'prosemirror-view';
import { TagSyntax, WikilinkSyntax } from '../syntax/index.js';
import type { Completion as Completions } from '../editor/completion.js';
import { CompletionField } from './completionfield.js';
import { schema } from '../types/schema.js';
import { META, REVEALED, CAPSULE_START, reveal, type SourcePresentation } from '../editor/reveal.js';
import { isRevealed, type Revealing } from '../state/normalization.js';

/** Present tags as source capsules with native text editing. */
export function tag(): Plugin[] {
  return [tag.presentation()];
}

export namespace tag {
  /** Tags are recognized and checked by the parser before their spelling is inserted. */
  export const source: Completions.Source<Completions.Candidate> = {
    match(state) {
      const field = CompletionField.read(state);
      if (!field) return null;
      const before = field.source.slice(0, field.caret);
      const from = before.lastIndexOf('#');
      const wiki = before.lastIndexOf('[[');
      if (!field.starts(from) || wiki > from) return null;
      if (field.syntax.some(token => token instanceof WikilinkSyntax && token.start === wiki &&
          token.start <= field.caret && field.caret <= token.end)) return null;
      // A parser-owned name leaves a bare # and '# ' available to heading input.
      const tag = field.syntax.find(token => token instanceof TagSyntax && token.start === from);
      if (!(tag instanceof TagSyntax) || field.caret > tag.end) return null;
      if (field.tokens.some(token => token.end > from && token.start < field.caret && token.type !== schema.marks.tag))
        return null;
      const query = field.source.slice(from + 1, field.caret);
      if (!query) return null;
      const end = Math.max(field.caret, tag.end);
      // A space after the tag stays after the name: replace it with the one space the
      // replacement writes, so the caret ends after it and no second space is left.
      return { query, from: field.start + from, to: field.start + end + (field.source[end] === ' ' ? 1 : 0) };
    },
    enabled: editor => !!editor?.spec.completeTag,
    candidates: (query, signal, editor) => editor?.spec.completeTag?.(query, signal) ?? [],
    apply(candidate, prompt, state) {
      const field = CompletionField.read(state);
      if (!field || !candidate.value || /[\r\n]/u.test(candidate.value)) return null;
      const replacement = `#${candidate.value} `;
      const source = field.replace(prompt.from, prompt.to, replacement);
      if (source === null) return null;
      const from = prompt.from - field.start;
      const valid = field.parse(source).some(token => token instanceof TagSyntax && token.start === from &&
        source.slice(token.start, token.end) === `#${candidate.value}`);
      return valid ? replacement : null;
    },
    same: () => true,
    publish: state => ({ kind: 'tag', ...state }),
  };

  /** Source visibility follows the shared pointer and composition lifetime. */
  export function presentation(): Plugin<SourcePresentation> {
    return new Plugin({
      key: presentationKey,
      state: reveal.state(draw),
      props: {
        decorations(state) { return presentationKey.getState(state)?.decorations ?? null; },
        handleDoubleClick(view, position) {
          if (!view.editable) return false;
          const found = at(view.state, position).find(tag => tag.from <= position && tag.to >= position);
          if (!found) return false;
          view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, found.from, found.to)));
          return true;
        },
      },
    });
  }
}

/** Completion data for `#name`. */
export namespace Tag {
  /** A tag completion is distinguished from the other feature presentations. */
  export interface Completion extends Completions.State<Completions.Candidate> {
    readonly kind: 'tag';
  }

  /** Answer a tag query until its request is cancelled. */
  export type Completer = (query: string,
    signal: AbortSignal) => readonly Completions.Candidate[] | Promise<readonly Completions.Candidate[]>;
}

interface TagRange {
  from: number;
  to: number;
  nameFrom: number;
  /** The `/` and `-` of the name, by offset: text may break a line after them, a tag may not. */
  joints: { offset: number; slash: boolean }[];
}

const presentationKey = new PluginKey<SourcePresentation>('tag-interaction');

/** A parser occurrence keeps its identity across the text nodes split by nested marks. */
class TagReader {
  readonly tags: TagRange[] = [];

  read(node: Node, start: number): void {
    if (!node.isTextblock) {
      node.forEach((child, offset) => this.read(child, start + offset + 1));
      return;
    }
    const occurrences = new Map<number, TagRange>();
    const { tag, meta } = node.type.schema.marks;
    node.forEach((child, offset) => {
      const mark = tag!.isInSet(child.marks);
      if (!mark) return;
      let range = occurrences.get(mark.attrs.occurrence);
      if (!range) {
        range = { from: start + offset, to: start + offset, nameFrom: -1, joints: [] };
        occurrences.set(mark.attrs.occurrence, range);
      }
      range.to = start + offset + child.nodeSize;
      if (meta!.isInSet(child.marks)) return;
      const local = start + offset - range.from;
      if (range.nameFrom < 0) range.nameFrom = local;
      for (let index = 0; index < (child.text ?? '').length; index++) {
        const character = child.text![index];
        if (character === '/' || character === '-') range.joints.push({ offset: local + index, slash: character === '/' });
      }
    });
    for (const range of occurrences.values()) {
      if (range.nameFrom >= 0) this.tags.push(range);
    }
  }
}

function at(state: EditorState, position: number): readonly TagRange[] {
  const resolved = state.doc.resolve(position);
  const reader = new TagReader();
  if (resolved.parent.isTextblock) reader.read(resolved.parent, resolved.start());
  return reader.tags;
}

function draw(node: Node, position: number, _state: EditorState, _selection: TextSelection | null,
  visible: Revealing): Decoration[] {
  const reader = new TagReader();
  reader.read(node, position + 1);
  const decorations: Decoration[] = [];
  for (const range of reader.tags) {
    const { from, nameFrom } = range;
    const source = isRevealed(visible, range) ? `${META} ${REVEALED}` : META;
    decorations.push(Decoration.inline(from, from + nameFrom, { class: `${source} ${CAPSULE_START}` }));
    for (const { offset, slash } of range.joints) {
      const joint = slash ? 'md-tag-joint md-tag-slash' : 'md-tag-joint';
      decorations.push(Decoration.inline(from + offset, from + offset + 1, { class: joint }));
    }
  }
  return decorations;
}
