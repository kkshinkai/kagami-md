/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { routeHistoryKey } from '../editor/input.js';
import { canRunCommand } from '../state/input.js';
import type { Node } from 'prosemirror-model';
import { Plugin, Selection, TextSelection, type Command as PMCommand, type EditorState, type Transaction } from 'prosemirror-state';
import type { EditorView, ViewMutationRecord } from 'prosemirror-view';
import { CalloutDeclarationSyntax, type Parser } from '../syntax/index.js';
import { CompletionField } from './completionfield.js';
import type { DOMNode } from '../editor/dom.js';
import type { KagamiMD } from '../editor/editor.js';
import { PluginDesc } from '../editor/plugin.js';
import { ControlHold } from '../editor/hold.js';
import type { EditorLoc } from '../source/index.js';
import { insert, keptShape, remove, reshape, split, update, type Shape } from '../transform/transform.js';
import type { CompletionActions, CompletionSnapshot, CompletionSource } from '../editor/completion.js';
import {
  nodeView, registerNodeView, registerBlockView, type BlockView,
  type HandleTarget
} from '../editor/blockview.js';
import { BindingState } from '../state/bindings.js';
import { getParser } from '../state/parser.js';
import { readField } from '../parse/field.js';
import { type CorrectionFields } from '../state/correction.js';
import { realizeCalloutTitle } from '../transform/realize.js';
import { mapTextSelection } from '../state/selection.js';
import { schema } from '../types/schema.js';

/** Callout frames, editable titles, and declaration completion. */
export function callout(): PluginDesc[] {
  return [PluginDesc.view(calloutView)];
}

/** Mounted callout frames and title controls kept in sync with document edits. */
function calloutView(editor?: KagamiMD): Plugin {
  const titles = new Set<TitleView>();
  return new Plugin({
    props: {
      nodeViews: {
        callout: calloutFrameView,
        calloutTitle(node, view, getPos) {
          const title = new TitleView(node, view, getPos, () => titles.delete(title), editor);
          titles.add(title);
          return registerNodeView(title);
        },
      },
    },
    view(view) {
      return {
        update() {
          for (const title of titles) {
            if (title.view === view) title.sync();
          }
        },
      };
    },
  });
}

/** Settle the separator on edited callout titles. */
export function correctCallout(tr: Transaction, fields: CorrectionFields): void {
  for (const position of fields.textblocks(tr)) {
    if (tr.doc.nodeAt(position)?.type === schema.nodes.calloutTitle) realizeCalloutTitle(tr, position);
  }
}

/** Supported callout declarations, ordered as published in completion and type menus. */
const calloutTypeOrder: readonly KagamiMD.CalloutType[] = ['note', 'tip', 'important', 'warning', 'caution'];

/** Default localized placeholder title for each callout declaration. */
export const calloutLabels: Record<KagamiMD.CalloutType, string> = {
  note: 'Note',
  tip: 'Tip',
  important: 'Important',
  warning: 'Warning',
  caution: 'Caution',
};

/** 24x24 SVG stroke path data rendered inside each callout heading button and menu item. */
export const calloutIcons: Record<KagamiMD.CalloutType, string> = {
  note:
    '<rect width="18" height="18" x="3" y="3" rx="2" /><path d="M9 8h7" /><path d="M8 12h6" /><path d="M11 16h5" />',
  tip: '<path d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z" /><path d="M20 2v4" /><path d="M22 4h-4" /><circle cx="4" cy="20" r="2" />',
  important: '<path d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z" /><path d="M12 15h.01" /><path d="M12 7v4" />',
  warning: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" /><path d="M12 9v4" /><path d="M12 17h.01" />',
  caution: '<path d="M12 16h.01" /><path d="M12 8v4" /><path d="M15.312 2a2 2 0 0 1 1.414.586l4.688 4.688A2 2 0 0 1 22 8.688v6.624a2 2 0 0 1-.586 1.414l-4.688 4.688a2 2 0 0 1-1.414.586H8.688a2 2 0 0 1-1.414-.586l-4.688-4.688A2 2 0 0 1 2 15.312V8.688a2 2 0 0 1 .586-1.414l4.688-4.688A2 2 0 0 1 8.688 2z" />',
};

/** Frozen choice objects shared with every callout type-picker event payload. */
const calloutTypeChoices: readonly KagamiMD.CalloutTypeChoice[] = Object.freeze(
  calloutTypeOrder.map(value => Object.freeze({ value, label: calloutLabels[value] })),
);

/** Complete `[!` in the first paragraph of a quote using the parser's declaration grammar. */
export const calloutCompletionSource: CompletionSource<KagamiMD.CalloutCompletionCandidate> = {
  kind: 'callout',
  match(state) {
    const field = CompletionField.read(state);
    if (!field) return null;
    const { head, caret } = field;
    const before = field.source.slice(0, caret);
    // `[!` opens callout completion only in the first paragraph of a block quote.
    if (
      head.parent.type !== schema.nodes.paragraph ||
      head.depth <= 1 ||
      head.node(-1).type !== schema.nodes.blockQuote ||
      head.index(-1) !== 0 ||
      !before.startsWith('[!') ||
      /[\s\[\]!]/u.test(before.slice(2))
    ) {
      return null;
    }
    const declaration = field.parse(field.source, true).find(node => node instanceof CalloutDeclarationSyntax);
    const closing = declaration instanceof CalloutDeclarationSyntax
      ? declaration.closing.start
      : field.source.indexOf(']', caret);
    // Consume an existing `]` right after the typed prefix (such as `[!]`) so completion does not leave `[!TIP]]`.
    let to = caret;
    if (closing >= caret && !/[\s\[!]/u.test(field.source.slice(caret, closing))) to = closing + 1;
    return { query: before.slice(2), from: field.start, to: field.start + to };
  },
  enabled: () => true,
  candidates(query) {
    const lower = query.toLowerCase();
    return calloutTypeOrder
      .filter(type => type.startsWith(lower) || calloutLabels[type].startsWith(lower))
      .map(type => ({ id: type, value: type, label: calloutLabels[type] }));
  },
  apply(candidate, prompt, state) {
    const field = CompletionField.read(state);
    if (!field || !candidate.value || /[\r\n]/u.test(candidate.value)) return null;
    const marker = `[!${candidate.value.toUpperCase()}]`;
    const tail = field.source.slice(prompt.to - field.start);
    // A callout declaration must end the line or precede horizontal whitespace, so `[!]Title` needs one space.
    const separator = tail && !/^[ \t\r\n]/.test(tail) ? ' ' : '';
    const replacement = marker + separator;
    const source = field.replace(prompt.from, prompt.to, replacement);
    if (source === null) return null;
    const declaration = field.parse(source, true).find(node => node instanceof CalloutDeclarationSyntax);
    const valid =
      prompt.from === field.start &&
      declaration instanceof CalloutDeclarationSyntax &&
      declaration.calloutType === candidate.value &&
      source.slice(declaration.start, declaration.closing.end) === marker;
    return valid ? replacement : null;
  },
  same: () => true,
  publish: (
    state: CompletionSnapshot<KagamiMD.CalloutCompletionCandidate>,
    _prompt,
    actions: CompletionActions,
  ): KagamiMD.CalloutCompletion => ({ kind: 'callout', ...state, ...actions }),
};

/** Set a callout declaration at `position` or the selection, converting a quote when needed. */
export function setCalloutType(type: KagamiMD.CalloutType, position?: number): PMCommand {
  return (state, dispatch) => {
    if (!calloutTypeOrder.includes(type)) return false;
    const pos = position ?? nearestQuoteOrCalloutPos(state);
    if (pos === undefined || pos < 0 || pos > state.doc.content.size) return false;
    const node = state.doc.nodeAt(pos);
    if (!node || (node.type !== schema.nodes.callout && node.type !== schema.nodes.blockQuote)) return false;
    if (node.type === schema.nodes.callout) {
      if (node.attrs.calloutType !== type && dispatch) {
        const tr = state.tr;
        update(tr, pos, { calloutType: type });
        dispatch(tr);
      }
      return true;
    }
    if (!dispatch) return true;
    dispatch(convertQuoteToCallout(state, pos, type).scrollIntoView());
    return true;
  };
}

/** Convert the callout at `position` or the selection into an ordinary quote block. */
export function calloutToQuote(position?: number): PMCommand {
  return (state, dispatch) => {
    const pos = position ?? selectedCalloutPos(state);
    if (pos === undefined || pos < 0 || pos > state.doc.content.size) return false;
    const node = state.doc.nodeAt(pos);
    if (node?.type !== schema.nodes.callout) return false;
    if (!dispatch) return true;
    dispatch(convertCalloutToQuote(state, pos).scrollIntoView());
    return true;
  };
}

/** Backspace at the start of a callout title converts it to a quote; body blocks defer to shared deletion. */
export const calloutBackspace: PMCommand = (state, dispatch) => {
  const { selection } = state;
  if (!(selection instanceof TextSelection) || !selection.empty || selection.$from.parentOffset !== 0) {
    return false;
  }
  if (selection.$from.parent.type !== schema.nodes.calloutTitle) return false;
  // Schema allows `calloutTitle` only as child 0 of `callout`, so `$from.before(-1)` is the callout.
  return calloutToQuote(selection.$from.before(-1))(state, dispatch);
};

/** Enter splits a callout title into a body paragraph, splits a body paragraph, or exits its final empty body. */
export const enterCallout: PMCommand = (state, dispatch) => {
  const { selection } = state;
  if (!(selection instanceof TextSelection)) return false;
  const { $from } = selection;
  if ($from.parent.type === schema.nodes.calloutTitle) {
    if (!dispatch) return true;
    const tr = splitCalloutTitle(state);
    if (!tr) return false;
    dispatch(tr.scrollIntoView());
    return true;
  }
  if (!selection.empty || $from.depth < 2 || $from.parent.type !== schema.nodes.paragraph ||
      $from.node(-1).type !== schema.nodes.callout) {
    return false;
  }
  if (!dispatch) return true;
  const callout = $from.node(-1);
  if ($from.parent.content.size === 0 && $from.index(-1) === callout.childCount - 1) {
    dispatch(exitTrailingBodyParagraph(state).scrollIntoView());
    return true;
  }
  const tr = state.tr;
  split(tr, selection.from, 1);
  dispatch(tr);
  return true;
};

/** Position of the innermost enclosing `callout` or `blockQuote` around `$from`, or `undefined`. */
function nearestQuoteOrCalloutPos(state: EditorState): number | undefined {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    const type = $from.node(depth).type;
    if (type === schema.nodes.callout || type === schema.nodes.blockQuote) return $from.before(depth);
  }
  return undefined;
}

/** Position of the enclosing `callout` when the whole selection stays inside it, or `undefined`. */
function selectedCalloutPos(state: EditorState): number | undefined {
  const { $from, $to } = state.selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    if ($from.node(depth).type !== schema.nodes.callout) continue;
    return $to.pos > $from.after(depth) ? undefined : $from.before(depth);
  }
  return undefined;
}

/** Retained source shapes for every body block after child 0 (`calloutTitle`) of `callout`. */
function keptCalloutBody(callout: Node, calloutPos: number): Shape[] {
  const body: Shape[] = [];
  // Child positions inside `callout` start at `calloutPos + 1`, and index 0 is always `calloutTitle`.
  callout.forEach((child, offset, index) => {
    if (index > 0) body.push(keptShape(child, calloutPos + 1 + offset));
  });
  return body;
}

/** Reshape `quotePos` into a `callout` with an empty title while preserving authored body blocks and caret. */
function convertQuoteToCallout(state: EditorState, quotePos: number, type: KagamiMD.CalloutType): Transaction {
  const quote = state.doc.nodeAt(quotePos)!;
  const firstChild = quote.firstChild!;
  const isEmptyQuote =
    quote.childCount === 1 &&
    firstChild.type === schema.nodes.paragraph &&
    firstChild.content.size === 0;
  // On an empty `>` quote (`quotePos + 1` paragraph start, `+ 1` text start), adopt that single
  // empty range as the title's carrier instead of leaving an extra empty body paragraph behind.
  const emptyTextPos = quotePos + 2;
  const children: Shape[] = [{
    kind: 'text',
    type: schema.nodes.calloutTitle,
    meaning: {},
    text: isEmptyQuote ? [{ kind: 'range', from: emptyTextPos, to: emptyTextPos }] : [],
  }];
  if (!isEmptyQuote) {
    quote.forEach((child, offset) => children.push(keptShape(child, quotePos + 1 + offset)));
  }
  const tr = state.tr;
  mapTextSelection(tr, range => reshape(tr, quotePos, quotePos + quote.nodeSize, [{
    kind: 'children',
    type: schema.nodes.callout,
    meaning: { calloutType: type },
    children,
  }], range));
  return tr;
}

/** Reshape `calloutPos` into a `blockQuote`, escaping any declaration newly exposed at its start. */
function convertCalloutToQuote(state: EditorState, calloutPos: number): Transaction {
  const callout = state.doc.nodeAt(calloutPos)!;
  const title = callout.firstChild!;
  const emptyTitle = title.content.size === 0;
  const collapsedInEmptyTitle =
    emptyTitle &&
    state.selection instanceof TextSelection &&
    state.selection.empty &&
    state.selection.from === calloutPos + 2;
  const children: Shape[] = [];
  if (!emptyTitle) {
    // `calloutPos + 1` opens child 0 (`calloutTitle`) and `+ 1` enters its inline text.
    const titleTextStart = calloutPos + 2;
    children.push({
      kind: 'text',
      type: schema.nodes.paragraph,
      meaning: {},
      text: [{ kind: 'range', from: titleTextStart, to: titleTextStart + title.content.size }],
    });
  }
  children.push(...keptCalloutBody(callout, calloutPos));
  if (children.length === 0) {
    children.push({ kind: 'text', type: schema.nodes.paragraph, meaning: {}, text: [] });
  }
  const tr = state.tr;
  mapTextSelection(tr, range =>
    reshape(tr, calloutPos, calloutPos + callout.nodeSize, [{
      kind: 'children',
      type: schema.nodes.blockQuote,
      meaning: {},
      children,
    }], range),
  );
  // If the first remaining body node is an atomic block (for example `thematicBreak`), `map`
  // jumps to a later kept range or leaves the caret before it; select nearest valid position forward.
  if (collapsedInEmptyTitle) tr.setSelection(Selection.near(tr.doc.resolve(calloutPos + 1), 1));
  escapeExposedDeclaration(tr, calloutPos, getParser(state), BindingState.get(state));
  return tr;
}

/** Escape a declaration newly exposed at the start of a converted quote's first paragraph so it stays ordinary text. */
function escapeExposedDeclaration(tr: Transaction, quotePos: number, parser: Parser, before: BindingState): void {
  const quote = tr.doc.nodeAt(quotePos);
  // Only child 0 when it is a paragraph can re-parse `[!TYPE]` as a callout declaration.
  if (quote?.type !== schema.nodes.blockQuote || quote.firstChild?.type !== schema.nodes.paragraph) return;
  const field = tr.doc.resolve(quotePos + 2);
  const result = readField(field, parser, BindingState.after(before, tr));
  if (result.kind !== 'inline') return;
  const declaration = result.children.find(node => node.type === 'calloutDeclaration');
  if (!declaration) return;
  const escapePos = field.start() + declaration.start;
  const selection = tr.selection;
  const step = tr.steps.length;
  tr.insertText('\\', escapePos);
  // Keep a caret at the start of the exposed declaration before the inserted escape backslash.
  if (selection instanceof TextSelection) {
    const mapping = tr.mapping.slice(step);
    const anchor = mapping.map(selection.anchor, selection.anchor === escapePos ? -1 : 1);
    const head = mapping.map(selection.head, selection.head === escapePos ? -1 : 1);
    tr.setSelection(TextSelection.create(tr.doc, anchor, head));
  }
}

/** Split the active `calloutTitle` (after collapsing any cross-field selection) into title + first body paragraph. */
function splitCalloutTitle(state: EditorState): Transaction | null {
  const { $from, $to } = state.selection;
  if ($from.parent.type !== schema.nodes.calloutTitle) return null;
  const tr = state.tr;
  const removed = !$from.sameParent($to) ? remove(tr, $from.pos, $to.pos) : null;
  const seam = removed !== null ? tr.doc.resolve(removed) : null;
  const start = seam ?? tr.selection.$from;
  const end = seam ?? tr.selection.$to;
  if (start.parent.type !== schema.nodes.calloutTitle || !start.sameParent(end)) return null;
  const calloutPos = start.before(-1);
  const callout = start.node(-1);
  const children: Shape[] = [
    {
      kind: 'text',
      type: schema.nodes.calloutTitle,
      meaning: {},
      text: [{ kind: 'range', from: start.start(), to: start.pos }],
    },
    {
      kind: 'text',
      type: schema.nodes.paragraph,
      meaning: {},
      text: [{ kind: 'range', from: end.pos, to: end.end() }],
    },
    ...keptCalloutBody(callout, calloutPos),
  ];
  mapTextSelection(tr, range => reshape(tr, calloutPos, calloutPos + callout.nodeSize, [{
    kind: 'children',
    type: schema.nodes.callout,
    meaning: { calloutType: callout.attrs.calloutType },
    children,
  }], range));
  const updated = tr.doc.nodeAt(calloutPos)!;
  // Place the caret at the start of child 1 (the newly created first body paragraph) right after child 0.
  const firstBodyStart = calloutPos + 1 + updated.firstChild!.nodeSize + 1;
  return tr.setSelection(TextSelection.create(tr.doc, firstBodyStart));
}

/** Exit a trailing empty body paragraph by inserting a sibling paragraph after the callout and removing the empty one. */
function exitTrailingBodyParagraph(state: EditorState): Transaction {
  const { $from } = state.selection;
  const afterCallout = $from.after(-1);
  const tr = state.tr;
  // Insert outside first and delete the empty body rather than `lift`, so leaving a callout's sole body block
  // retains a valid header-only `callout(calloutTitle)` node.
  insert(tr, afterCallout, schema.nodes.paragraph, {});
  remove(tr, $from.before(), $from.after());
  return tr.setSelection(TextSelection.near(tr.doc.resolve(tr.mapping.map(afterCallout, -1)), 1));
}

/** Heading DOM for a `calloutTitle`: stable `contentDOM` paired with an uneditable type-picker button. */
class TitleView implements BlockView {
  readonly dom: HTMLDivElement;
  readonly contentDOM: HTMLSpanElement;
  private readonly mount: HTMLSpanElement;
  private readonly button: HTMLButtonElement;
  private readonly icon: SVGSVGElement;
  private readonly controlHold: ControlHold;
  private destroyed = false;

  constructor(
    private node: Node,
    readonly view: EditorView,
    private readonly getPos: () => number | undefined,
    private readonly remove: () => void,
    private readonly editor?: KagamiMD,
  ) {
    const document = view.dom.ownerDocument;
    this.dom = document.createElement('div');
    this.dom.className = 'md-callout-heading';
    // The control follows the title in the DOM and is drawn first by CSS: Chrome loses a
    // composition at the start of text that an uneditable element precedes.
    const mount = this.mount = document.createElement('span');
    mount.className = 'md-callout-type-control';
    mount.contentEditable = 'false';
    this.button = mount.appendChild(document.createElement('button'));
    this.button.type = 'button';
    this.button.className = 'callout-type-button';
    this.button.setAttribute('aria-label', 'Callout type');
    this.button.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"></svg>';
    this.icon = this.button.firstElementChild as SVGSVGElement;
    this.contentDOM = this.dom.appendChild(document.createElement('span'));
    this.contentDOM.className = 'md-callout-title';
    this.contentDOM.dataset.calloutTitle = 'true';
    this.contentDOM.setAttribute('role', 'group');
    this.contentDOM.setAttribute('aria-label', 'Callout title');
    this.dom.appendChild(mount);
    this.controlHold = new ControlHold({
      element: () => this.button,
      pos: () => this.calloutPos(),
      held: value => {
        if (value) this.button.setAttribute('aria-expanded', 'true');
        else this.button.removeAttribute('aria-expanded');
      },
    });
    this.button.onclick = () => this.requestTypeMenu();
    this.button.onkeydown = event => {
      if (!view.isDestroyed && routeHistoryKey(view, event)) event.stopPropagation();
    };
    this.sync();
  }

  /** Emit `_onDidClickCalloutType` with the live position, geometry, hold token, and mutation callbacks. */
  private requestTypeMenu(): void {
    const { editor, view } = this;
    if (this.destroyed || view.isDestroyed || !canRunCommand(view.state, view)) return;
    const pos = this.calloutPos();
    if (!editor || editor.isDestroyed() || pos === undefined) return;
    const alive = (): boolean => !this.destroyed && !view.isDestroyed && !editor.isDestroyed();
    editor._onDidClickCalloutType.fire({
      pos: pos as EditorLoc,
      rect: this.button.getBoundingClientRect(),
      type: this.calloutType,
      types: calloutTypeChoices,
      hold: () => this.controlHold.acquire(alive),
      setType: type => {
        if (!alive()) return false;
        const current = this.calloutPos();
        return current !== undefined && editor.state.runCommand(setCalloutType(type, current));
      },
      toQuote: () => {
        if (!alive()) return false;
        const current = this.calloutPos();
        return current !== undefined && editor.state.runCommand(calloutToQuote(current));
      },
    });
  }

  /** Position of the owning `callout` node, or `undefined` when detached or view-destroyed. */
  private calloutPos(): number | undefined {
    if (this.view.isDestroyed) return undefined;
    const titlePos = this.getPos();
    // Schema guarantees `calloutTitle` is child 0 of `callout`, so the parent opens at `titlePos - 1`.
    if (titlePos === undefined || titlePos === 0) return undefined;
    const parentPos = titlePos - 1;
    return this.view.state.doc.nodeAt(parentPos)?.type === schema.nodes.callout ? parentPos : undefined;
  }

  /** Declared callout type read from the owning node, defaulting to `'note'` before attachment. */
  private get calloutType(): KagamiMD.CalloutType {
    const pos = this.calloutPos();
    return pos === undefined ? 'note' : this.view.state.doc.nodeAt(pos)!.attrs.calloutType;
  }

  /** Refresh child framing, button state, icon SVG path, and empty-title placeholder. */
  sync(): void {
    if (
      this.dom.childNodes.length !== 2 ||
      this.dom.firstChild !== this.contentDOM ||
      this.dom.lastChild !== this.mount
    ) {
      this.dom.replaceChildren(this.contentDOM, this.mount);
    }
    const type = this.calloutType;
    this.button.disabled = !this.view.editable;
    if (this.icon.dataset.kind !== type) {
      this.icon.dataset.kind = type;
      this.icon.innerHTML = calloutIcons[type];
    }
    const placeholder = this.node.content.size > 0 ? '' : calloutLabels[type];
    if (this.contentDOM.dataset.placeholder !== placeholder) this.contentDOM.dataset.placeholder = placeholder;
  }

  /** Reuse the DOM wrapper when updates affect only the `calloutTitle` node or enclosing `callout` type. */
  update(node: Node): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.sync();
    return true;
  }

  /** Isolate button events from ProseMirror's editor surface; Undo/Redo keys route through `button.onkeydown`. */
  stopEvent(event: Event): boolean {
    return this.button.contains(event.target as DOMNode);
  }

  /** Ignore heading-chrome and attribute mutations outside the editable title text. */
  ignoreMutation(mutation: ViewMutationRecord): boolean {
    if (mutation.type === 'selection') return false;
    if (mutation.type === 'childList' && mutation.target === this.dom) return false;
    return (
      !this.contentDOM.contains(mutation.target) ||
      (mutation.type === 'attributes' && mutation.target === this.contentDOM)
    );
  }

  /** Release listener callbacks and unregister this heading view from `calloutView`. */
  destroy(): void {
    this.destroyed = true;
    this.remove();
    this.button.onclick = null;
    this.button.onkeydown = null;
  }
}

/** Attribute changes update the `<aside>` frame in place without replacing editable title or body DOM. */
function calloutFrameView(initial: Node, view: EditorView): BlockView {
  const dom = view.dom.ownerDocument.createElement('div');
  dom.className = 'md-callout-frame';
  const contentDOM = dom.appendChild(view.dom.ownerDocument.createElement('aside'));
  const draw = (node: Node): void => {
    contentDOM.className = `md-callout md-callout-${node.attrs.calloutType}`;
    contentDOM.dataset.callout = node.attrs.calloutType;
  };
  draw(initial);
  return registerBlockView(initial, {
    dom,
    contentDOM,
    box: dom,
    content: contentDOM,
    brush: true,
    get field() {
      return contentDOM.firstElementChild as HTMLElement;
    },
    get handle(): HandleTarget {
      return { kind: 'text', target: nodeView(contentDOM.firstElementChild!)!.contentDOM! };
    },
    update(node) {
      if (node.type !== initial.type) return false;
      draw(node);
      return true;
    },
    ignoreMutation: mutation => mutation.type === 'attributes' && mutation.target === contentDOM,
  });
}
