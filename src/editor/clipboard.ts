/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Bindings, InlineMathSyntax, parseBlocks, transduce } from '../syntax/index.js';
import {
  DOMParser, Fragment, Slice, type Node, type ParseOptions, type ResolvedPos, type Schema, type TagParseRule,
} from 'prosemirror-model';
import { Plugin, PluginKey, type EditorState, type Transaction } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { parse } from '../parse/parse.js';
import { bindings } from '../state/bindings.js';
import { history } from '../state/history.js';
import { annotatedBlockKinds, readAnnotation } from '../types/annotations.js';
import { schema } from '../types/schema.js';
import { HTMLSerializer } from '../unparse/html.js';
import { inlineSource } from '../unparse/inline.js';
import { tableText } from '../unparse/tabletext.js';
import { unparse } from '../unparse/unparse.js';
import { source } from '../source/index.js';
import type { DOMNode } from './dom.js';
import { paste } from './paste.js';

const clipboardKey = new PluginKey('clipboard');

/** The browser clipboard boundary. Reading, writing, and insertion have their own owners. */
export function clipboard(options: clipboard.Options = {}): Plugin {
  // clipboardSerializer has no view argument; each State creates its own plugins
  // and State.attachView allows one editor.
  let attached: EditorView | null = null;
  // prosemirror-tables' handlePaste dispatches through the view itself.
  let pending: EditorState | null = null;
  return new Plugin({
    key: clipboardKey,
    props: {
      handleDOMEvents: {
        // Markdown source is pasted as source, before ProseMirror prefers its highlighting HTML.
        paste(view, event) {
          const markdown = clipboard.markdownSource(event.clipboardData);
          if (markdown === null || !view.editable || view.composing || !view.pasteText(markdown, event)) return false;
          event.preventDefault();
          return true;
        },
      },
      clipboardSerializer: new HTMLSerializer(schema, () => attached!.state.doc),
      clipboardParser: new clipboard.Parser(schema, () => bindings.get(attached!.state)),
      transformPastedText: clipboard.readText,
      clipboardTextParser: paste.text,
      clipboardTextSerializer: (slice, view) => {
        const { options } = source.get(view.state);
        return tableText(slice, view.state.selection.$from, options) ??
          unparse.slice(slice, view.state.selection.$from, options);
      },
      handlePaste(view, event, slice) {
        pending = view.state;
        try {
          for (const handler of options.paste ?? []) if (handler(view, event, slice)) return true;
          const content = slice.content.size ? slice : paste.text(
            clipboard.readText(event.clipboardData?.getData('text/plain') ?? ''), view.state.selection.$from);
          const transaction = paste(view.state, content, event.clipboardData?.getData('text/html') ?? '');
          if (transaction) view.dispatch(transaction);
          return true;
        } finally {
          pending = null;
        }
      },
    },
    view(view) {
      attached = view;
      return { destroy() { attached = null; } };
    },
    prepare(state: EditorState, transaction: Transaction) {
      if (pending !== state) return;
      pending = null;
      if (transaction.docChanged) history.isolate(transaction).setMeta('paste', true).setMeta('uiEvent', 'paste');
    },
  });
}

export namespace clipboard {
  export interface Options {
    readonly paste?: readonly ((view: EditorView, event: ClipboardEvent, slice: Slice) => boolean)[];
  }

  /**
   * Pasted or dropped plain text as the file would read it: a NUL character is read as U+FFFD
   * (CommonMark, "Insecure characters"), so text that holds one is a tree no file says.
   */
  export function readText(text: string): string {
    return text.replace(/\u0000/g, '\uFFFD');
  }

  /**
   * The plain text a clipboard carries when its metadata says that text is Markdown source
   * (private-docs/rules/markdown-paste.md). VS Code says so with `mode: "markdown"` in
   * `vscode-editor-data`; its HTML is only that source, highlighted.
   */
  export function markdownSource(data: DataTransfer | null): string | null {
    const text = data?.getData('text/plain');
    const metadata = data?.getData('vscode-editor-data');
    if (!text || !metadata) return null;
    try {
      const value: unknown = JSON.parse(metadata);
      return typeof value === 'object' && value !== null && 'mode' in value && value.mode === 'markdown' ? text : null;
    } catch {
      return null;
    }
  }

  /** Read HTML through the schema, then write its inline formatting as source.
   * ProseMirror restores the slice's declared open edges after this method returns. */
  export class Parser extends DOMParser {
    constructor(schema: Schema, readonly bindings: () => Bindings = () => Bindings.none) {
      super(schema, DOMParser.fromSchema(schema).rules);
    }

    override parseSlice(dom: DOMNode, options: ParseOptions & { context: ResolvedPos }): Slice {
      const carried = readAnnotation.tree(dom, this.schema);
      let field: Node | null = null;
      if (carried) {
        if (!readAnnotation.insideField(carried.fragment, carried.carrier)) return Slice.maxOpen(carried.fragment);
        field = carried.fragment.firstChild!;
        if (field.type === options.context?.parent.type) return new Slice(field.content, 0, 0);
        const content = carried.carrier.ownerDocument.createElement('div');
        for (const child of carried.carrier.childNodes) content.appendChild(child.cloneNode(true));
        dom = content;
      }
      const annotations: TagParseRule[] = [];
      if (dom.nodeType === 1 || dom.nodeType === 11) {
        for (const element of (dom as Element | DocumentFragment).querySelectorAll<HTMLElement>(
          '[data-markdown-source], [data-math-source]')) {
          const rule = this.annotation(element);
          if (rule) annotations.push({ ...rule, tag: '[data-markdown-source], [data-math-source]',
            getAttrs: candidate => candidate === element ? rule.attrs ?? null : false });
        }
      }
      const parser = annotations.length ? new DOMParser(this.schema, [...annotations, ...this.rules]) : this;
      const slice = parser === this ? super.parseSlice(dom, options) : parser.parseSlice(dom, options);
      const source = inlineSource(slice, options.context.doc, this.bindings(), options.context);
      if (field && source.content.childCount === 1 && source.content.firstChild!.isTextblock)
        return Slice.maxOpen(Fragment.from(field.copy(source.content.firstChild!.content)), false);
      return source;
    }

    private annotation(element: HTMLElement): Omit<TagParseRule, 'tag'> | null {
      const source = element.getAttribute('data-markdown-source') ?? element.getAttribute('data-math-source');
      if (source === null) return null;
      const kind = element.getAttribute('data-markdown-kind');
      const math = element.getAttribute('data-math-display');
      if (kind && annotatedBlockKinds.has(kind) || math === 'block') {
        const content = parse.blocks(parseBlocks(source, { target: 'editor' }), source, this.schema);
        const node = content.firstChild;
        if (content.childCount !== 1 || node!.type.name !== (math === 'block' ? 'mathBlock' : kind)) return null;
        return { node: node!.type.name, attrs: node!.attrs, getContent: () => node!.content };
      }
      if (math === 'inline') {
        const reading = transduce(source, { phrasing: 'atxHeading' }, Bindings.none);
        if (reading.kind !== 'inline' || reading.children.length !== 1 ||
          !(reading.children[0] instanceof InlineMathSyntax)) return null;
        return { mark: 'inlineMath', attrs: { math: reading.children[0].math },
          getContent: () => Fragment.from(this.schema.text(source)) };
      }
      const identifier = element.getAttribute('data-markdown-identifier') ?? undefined;
      if (!kind || !readAnnotation(source, kind, 'atxHeading', identifier)) return null;
      return { mark: kind === 'footnoteLabel' ? 'footnoteReference' : kind,
        attrs: kind === 'footnoteLabel' ? { identifier } : undefined,
        getContent: () => Fragment.from(this.schema.text(source)) };
    }
  }

  /** Consume the native paste origin before applying a transaction or invoking host callbacks. */
  export function prepare(state: EditorState, transaction: Transaction): void {
    clipboardKey.get(state)?.spec.prepare(state, transaction);
  }
}
