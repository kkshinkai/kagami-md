/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  InlineMathSyntax, type Bindings, type Parser,
} from '../syntax/index.js';
import {
  DOMParser, Fragment, Slice, type Node, type ParseOptions, type ResolvedPos, type Schema, type TagParseRule,
} from 'prosemirror-model';
import { NodeSelection, Plugin, PluginKey, Selection, type EditorState, type Transaction } from 'prosemirror-state';
import { dropPoint } from 'prosemirror-transform';
import type { EditorView } from 'prosemirror-view';
import { parseBlocks } from '../parse/parse.js';
import { BindingState } from '../state/bindings.js';
import { defaultParser, getParser } from '../state/parser.js';
import { isolateHistory } from '../state/history.js';
import { BlockSelection } from '../state/selection.js';
import { replace, remove } from '../transform/transform.js';
import { annotatedBlockKinds, isInsideCarriedField, readAnnotation, readCarriedTree } from '../types/annotations.js';
import { schema } from '../types/schema.js';
import { HTMLSerializer } from '../unparse/html.js';
import { inlineSource } from '../unparse/inline.js';
import { tableText } from '../unparse/tabletext.js';
import { unparseAlone, unparseSlice } from '../unparse/unparse.js';
import {
  adaptToYAMLTarget, classifyYAMLSlice, isYAMLCodeBlock, peelOpenWrapperSlice, yamlSliceToBody,
} from '../unparse/yamltransfer.js';
import { Source } from '../source/index.js';
import { deleteSelection } from '../command/commands.js';
import type { DOMNode } from './dom.js';
import { closeSlice, paste, plainTextSlice } from './paste.js';

const clipboardKey = new PluginKey<ClipboardController>('clipboard');

/** Owns view attachment and pending native paste state for a single clipboard plugin instance. */
class ClipboardController {
  attached: EditorView | null = null;
  pending: EditorState | null = null;

  /** Attach `view` for serializer callbacks without closing over mutable module locals. */
  attach(view: EditorView): { destroy(): void } {
    this.attached = view;
    return {
      destroy: () => {
        if (this.attached === view) this.attached = null;
      },
    };
  }

  /** Consume a native paste transaction marker produced while `handlePaste` is active on `state`. */
  prepare(state: EditorState, transaction: Transaction): void {
    if (this.pending !== state) return;
    this.pending = null;
    if (transaction.docChanged) isolateHistory(transaction).setMeta('paste', true).setMeta('uiEvent', 'paste');
  }
}

/** The browser clipboard boundary. Reading, writing, and insertion have their own owners. */
export function clipboard(options: clipboard.Options = {}): Plugin {
  const controller = new ClipboardController();
  return new Plugin({
    key: clipboardKey,
    state: {
      init: () => controller,
      apply: () => controller,
    },
    props: {
      handleDOMEvents: {
        cut(view, event) {
          const { selection } = view.state;
          if (selection.empty || !view.editable || view.composing || !event.clipboardData) return false;
          const { dom, text } = view.serializeForClipboard(selection.content());
          event.preventDefault();
          event.clipboardData.clearData();
          event.clipboardData.setData('text/html', dom.innerHTML);
          event.clipboardData.setData('text/plain', text);
          return deleteSelection(view.state, tr => view.dispatch(tr.setMeta('uiEvent', 'cut')));
        },
        // Markdown source is pasted as source, before ProseMirror prefers its highlighting HTML.
        paste(view, event) {
          const markdown = markdownClipboardSource(event.clipboardData);
          if (markdown === null || !view.editable || view.composing || !view.pasteText(markdown, event)) return false;
          event.preventDefault();
          return true;
        },
      },
      transformCopied(slice, view) {
        const selection = view.state.selection;
        if (
          selection instanceof NodeSelection &&
          selection.node.type === schema.nodes.yamlScalar &&
          selection.node.attrs.tag === 'boolean' &&
          selection.$from.parent.type === schema.nodes.yamlSequence &&
          slice.openStart === 0 &&
          slice.openEnd === 0
        ) {
          // Retain the owning `yamlSequence` wrapper so HTML serialization matches plain text (`- true`).
          return new Slice(Fragment.from(selection.$from.parent.copy(slice.content)), 1, 1);
        }
        const classified = classifyYAMLSlice(slice);
        if (classified.kind === 'inline') {
          return new Slice(Fragment.from(classified.scalar), 1, 1);
        }
        return slice;
      },
      clipboardSerializer: new HTMLSerializer(
        schema, () => controller.attached!.state.doc, () => getParser(controller.attached!.state),
      ),
      clipboardParser: new ClipboardParser(
        schema, () => getParser(controller.attached!.state), () => BindingState.get(controller.attached!.state),
      ),
      transformPastedText: readClipboardText,
      clipboardTextParser: plainTextSlice,
      clipboardTextSerializer: (slice, view) => {
        const { options } = Source.get(view.state);
        return tableText(slice, view.state.selection.$from, options) ??
          unparseSlice(slice, view.state.selection.$from, options);
      },
      handlePaste(view, event, slice) {
        controller.pending = view.state;
        try {
          for (const handler of options.paste ?? []) if (handler(view, event, slice)) return true;
          const text = readClipboardText(event.clipboardData?.getData('text/plain') ?? '');
          const content = slice.content.size ? slice : plainTextSlice(text, view.state.selection.$from);
          const html = event.clipboardData?.getData('text/html') ?? '';
          const transaction = paste(view.state, content, html, text);
          if (transaction) view.dispatch(transaction);
          return true;
        } finally {
          controller.pending = null;
        }
      },
      handleDrop(view, event, slice, moved) {
        if (!slice.size) return false;
        const hasFrontmatter = view.state.doc.firstChild?.type === schema.nodes.yamlFrontMatter;
        const classified = classifyYAMLSlice(slice);
        const hasYAML = classified.kind !== 'none' && classified.kind !== 'inline';
        if (!hasFrontmatter && !hasYAML) return false;
        const hit = view.posAtCoords({ left: event.clientX, top: event.clientY });
        if (!hit) return false;
        const $mouse = view.state.doc.resolve(hit.pos);
        if ($mouse.depth >= 1 && $mouse.node(1).type === schema.nodes.yamlFrontMatter) {
          return dropInsideYAML(view, $mouse, slice, moved);
        }
        return hasYAML ? dropYAMLToBody(view, $mouse, slice, moved) : false;
      },
    },
    view: view => controller.attach(view),
  });
}

export namespace clipboard {
  export interface Options {
    readonly paste?: readonly ((view: EditorView, event: ClipboardEvent, slice: Slice) => boolean)[];
  }
}

/**
 * Pasted or dropped plain text as the file would read it: a NUL character is read as U+FFFD
 * (CommonMark, "Insecure characters"), so text that holds one is a tree no file says.
 */
function readClipboardText(text: string): string {
  return text.replace(/\u0000/g, '\uFFFD');
}

/**
 * The plain text a clipboard carries when its metadata says that text is Markdown source
 * (private-docs/rules/markdown-paste.md). VS Code says so with `mode: "markdown"` in
 * `vscode-editor-data`; its HTML is only that source, highlighted.
 */
function markdownClipboardSource(data: DataTransfer | null): string | null {
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
export class ClipboardParser extends DOMParser {
  constructor(
    schema: Schema,
    readonly parser: () => Parser = () => defaultParser,
    readonly bindings: () => Bindings = () => ({ definitions: new Map(), footnotes: new Set() }),
  ) {
    super(schema, DOMParser.fromSchema(schema).rules);
  }

  override parseSlice(dom: DOMNode, options: ParseOptions & { context: ResolvedPos }): Slice {
    const carried = readCarriedTree(dom, this.schema);
    let field: Node | null = null;
    if (carried && validCarriedFragment(carried.fragment)) {
      if (!isInsideCarriedField(carried.fragment, carried.carrier)) return Slice.maxOpen(carried.fragment);
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
    const source = inlineSource(slice, options.context.doc, this.parser(), this.bindings(), options.context);
    if (field && source.content.childCount === 1 && source.content.firstChild!.isTextblock)
      return Slice.maxOpen(Fragment.from(field.copy(source.content.firstChild!.content)), false);
    return source;
  }

  private annotation(element: HTMLElement): Omit<TagParseRule, 'tag'> | null {
    const source = element.getAttribute('data-markdown-source') ?? element.getAttribute('data-math-source');
    if (source === null) return null;
    const kind = element.getAttribute('data-markdown-kind');
    const math = element.getAttribute('data-math-display');
    const markdown = this.parser();
    if (kind && annotatedBlockKinds.has(kind) || math === 'block') {
      const content = parseBlocks(markdown.parseBlocks(source), source, this.schema);
      const node = content.firstChild;
      if (content.childCount !== 1 || node!.type.name !== (math === 'block' ? 'mathBlock' : kind)) return null;
      return { node: node!.type.name, attrs: node!.attrs, getContent: () => node!.content };
    }
    if (math === 'inline') {
      const reading = markdown.transduce(source, { phrasing: 'atxHeading' });
      if (reading.kind !== 'inline' || reading.children.length !== 1 ||
        !(reading.children[0] instanceof InlineMathSyntax)) return null;
      return { mark: 'inlineMath', attrs: { math: reading.children[0].math },
        getContent: () => Fragment.from(this.schema.text(source)) };
    }
    const identifier = element.getAttribute('data-markdown-identifier') ?? undefined;
    if (!kind || !readAnnotation(source, kind, markdown, 'atxHeading', identifier)) return null;
    return { mark: kind === 'footnoteLabel' ? 'footnoteReference' : kind,
      attrs: kind === 'footnoteLabel' ? { identifier } : undefined,
      getContent: () => Fragment.from(this.schema.text(source)) };
  }
}

function validCarriedFragment(fragment: Fragment): boolean {
  for (let index = 0; index < fragment.childCount; index++) {
    const child = fragment.child(index);
    if (!child.isInline && (!child.type.validContent(child.content) || !validCarriedFragment(child.content)))
      return false;
  }
  return true;
}

/** Consume the native paste origin before applying a transaction or invoking host callbacks. */
export function prepareClipboard(state: EditorState, transaction: Transaction): void {
  clipboardKey.getState(state)?.prepare(state, transaction);
}

/** Delete a moved selection from `tr` and map `target` across the removal. */
function deleteMovedSelection(tr: Transaction, sel: Selection, target: number): number {
  const start = tr.steps.length;
  if (sel instanceof BlockSelection) sel.replace(tr);
  else if (!sel.empty) remove(tr, sel.from, sel.to);
  return tr.mapping.slice(start).map(target, 1);
}

/** Find the YAML mapping or sequence container owning `$pos`, falling back to root mapping. */
function targetYAMLCollection($pos: ResolvedPos): Node {
  for (let depth = $pos.depth; depth >= 1; depth--) {
    const node = $pos.node(depth);
    if (node.type.isInGroup('yamlCollection')) return node;
  }
  return $pos.node(1).firstChild!;
}

/** Move `target` outside any enclosing list shell so dropped YAML code blocks follow Rule 11. */
function targetOutsideList(doc: Node, target: number): number {
  const clamped = Math.max(0, Math.min(doc.content.size, target));
  const $target = doc.resolve(clamped);
  for (let depth = 1; depth <= $target.depth; depth++) {
    if ($target.node(depth).type.isInGroup('list')) {
      return clamped < ($target.start(depth) + $target.end(depth)) / 2
        ? $target.before(depth)
        : $target.after(depth);
    }
  }
  return target;
}

/** Whether a dropped non-YAML slice represents plain inline text targeting an editable scalar field. */
function isInlineScalarDrop(slice: Slice, peeled: Slice, $mouse: ResolvedPos): boolean {
  if ($mouse.parent.type !== schema.nodes.yamlScalar || $mouse.parent.attrs.tag === 'boolean') return false;
  if (peeled.content.content.some(isYAMLCodeBlock)) return false;
  if (slice.content.content.every(node => node.isInline)) return true;
  return (
    slice.openStart > 0 &&
    peeled.content.childCount === 1 &&
    peeled.content.firstChild?.type === schema.nodes.paragraph
  );
}

/** Convert structured YAML selections dropped in the body into a `yaml` code block placed outside lists. */
function dropYAMLToBody(view: EditorView, $mouse: ResolvedPos, slice: Slice, moved: boolean): boolean {
  const sel = view.state.selection;
  if (moved && $mouse.pos >= sel.from && $mouse.pos <= sel.to) return true;
  const converted = yamlSliceToBody(slice, false).slice;
  if (!converted.size) return true;
  const point = dropPoint(view.state.doc, $mouse.pos, converted);
  let target = point === null ? $mouse.pos : point;
  const tr = isolateHistory(view.state.tr);
  if (moved) target = deleteMovedSelection(tr, sel, target);
  target = targetOutsideList(tr.doc, target);
  const before = tr.steps.length;
  replace(tr, target, target, converted);
  const start = tr.mapping.slice(before).map(target, 1);
  tr.setSelection(Selection.near(tr.doc.resolve(Math.min(start, tr.doc.content.size)), 1));
  view.focus();
  view.dispatch(tr.setMeta('uiEvent', 'drop').scrollIntoView());
  return true;
}

/** Insert or adapt any dropped slice targeting `yamlFrontMatter`, preserving post-drop caret order. */
function dropInsideYAML(
  view: EditorView,
  $mouse: ResolvedPos,
  slice: Slice,
  moved: boolean,
): boolean {
  const sel = view.state.selection;
  if (moved && $mouse.pos >= sel.from && $mouse.pos <= sel.to) return true;
  const classified = classifyYAMLSlice(slice);
  const peeled = closeSlice(peelOpenWrapperSlice(slice), 0, 0);
  if (classified.kind === 'inline' || (classified.kind === 'none' && isInlineScalarDrop(slice, peeled, $mouse))) {
    if ($mouse.parent.type === schema.nodes.yamlScalar && $mouse.parent.attrs.tag !== 'boolean') {
      const text = unparseSlice(slice, sel.$from, Source.get(view.state).options);
      const tr = isolateHistory(view.state.tr);
      const target = moved ? deleteMovedSelection(tr, sel, $mouse.pos) : $mouse.pos;
      if (tr.doc.resolve(Math.min(target, tr.doc.content.size)).parent.type === schema.nodes.yamlScalar) {
        tr.insertText(text, target, target);
        view.focus();
        view.dispatch(tr.setMeta('uiEvent', 'drop').scrollIntoView());
      }
    }
    return true;
  }
  const collection = targetYAMLCollection($mouse);
  const parser = getParser(view.state);
  const incoming = classified.kind === 'entries'
    ? classified.entries.content
    : classified.kind === 'document'
      ? classified.content.content
      : peeled.content.content;
  const targetSlot = collection.type === schema.nodes.yamlSequence ? 'sequence' : 'mapping';
  const converted = adaptToYAMLTarget(incoming, targetSlot, view.state.schema, {
    parser,
    blockText: sourceNode => unparseAlone(sourceNode).body,
  }).nodes;
  if (!converted.length) return true;
  const entrySlice = new Slice(Fragment.fromArray(converted), 0, 0);
  const targetPoint = dropPoint(view.state.doc, $mouse.pos, entrySlice);
  let target = targetPoint === null ? $mouse.pos : targetPoint;
  const tr = isolateHistory(view.state.tr);
  if (moved) target = deleteMovedSelection(tr, sel, target);
  const before = tr.doc;
  const beforeInsert = tr.steps.length;
  replace(tr, target, target, entrySlice);
  if (!tr.doc.eq(before)) {
    const pos = tr.mapping.slice(beforeInsert).map(target, 1);
    tr.setSelection(Selection.near(tr.doc.resolve(Math.min(pos, tr.doc.content.size)), -1));
    view.focus();
    view.dispatch(tr.setMeta('uiEvent', 'drop').scrollIntoView());
  }
  return true;
}
