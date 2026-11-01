/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { input } from '../editor/input.js';
import { canRunCommand } from '../state/input.js';
import type { Node } from 'prosemirror-model';
import { Plugin, TextSelection, type Command, type EditorState, type Transaction } from 'prosemirror-state';
import type { EditorView, ViewMutationRecord } from 'prosemirror-view';
import { CalloutDeclarationSyntax } from '../syntax/index.js';
import { CompletionField } from './completionfield.js';
import { findEditor, type DOMNode } from '../editor/dom.js';
import * as command from '../command/command.js';
import { insert, keptShape, remove, reshape, split, update, type Shape } from '../transform/transform.js';
import type { Completion as Completions } from '../editor/completion.js';
import {
  nodeView, registerNodeView, registerBlockView, type BlockView,
  type HandleTarget
} from '../editor/blockview.js';
import { bindings } from '../state/bindings.js';
import { readField } from '../parse/field.js';
import { type correction } from '../state/correction.js';
import { realizeCalloutTitle } from '../transform/realize.js';
import { mapTextSelection } from '../state/selection.js';
import { schema } from '../types/schema.js';

/** Callout frames, editable titles and declaration completion. */
export function callout(): Plugin[] {
  const titles = new Set<TitleView>();
  return [new Plugin<command.Command.RequestState>({
    key: Callout.chooseKind.key,
    state: {
      init: () => ({ hold(view, pos) {
        for (const title of titles) {
          if (title.view !== view) continue;
          const held = command.keepRequest(title.request(), pos, () => titles.has(title) && !view.isDestroyed);
          if (held) return held;
        }
        return null;
      } }),
      apply: (_transaction, state) => state,
    },
    props: {
      nodeViews: {
        callout: frame,
        calloutTitle(node, view, getPos) {
          const title = new TitleView(node, view, getPos, () => titles.delete(title));
          titles.add(title);
          return registerNodeView(title);
        },
      },
    },
    view: view => ({ update() {
      for (const title of titles) if (title.view === view) title.sync();
    } }),
  })];
}

export namespace callout {
  /** Settle the separator on edited callout titles. */
  export function correction(tr: Transaction, fields: correction.Fields): void {
    for (const position of fields.textblocks(tr)) {
      if (tr.doc.nodeAt(position)?.type === schema.nodes.calloutTitle) realizeCalloutTitle(tr, position);
    }
  }

  /** A title's opening whitespace belongs to the declaration's recorded separator. */
  /** Complete the first paragraph of a quote from the feature's supported declarations. */
  export const source: Completions.Source<Callout.Candidate> = {
    match(state) {
      const field = CompletionField.read(state);
      if (!field) return null;
      const { head, caret } = field;
      const before = field.source.slice(0, caret);
      // [! is an affordance only in the first paragraph of a quote.
      if (head.parent.type !== schema.nodes.paragraph || head.depth <= 1 ||
          head.node(-1).type !== schema.nodes.blockQuote || head.index(-1) !== 0 ||
          !before.startsWith('[!') || /[\s\[\]!]/u.test(before.slice(2))) return null;
      const declaration = field.parse(field.source, true).find(node => node instanceof CalloutDeclarationSyntax);
      const closing = declaration instanceof CalloutDeclarationSyntax
        ? declaration.closing.start : field.source.indexOf(']', caret);
      const to = closing >= caret && !/[\s\[!]/u.test(field.source.slice(caret, closing)) ? closing + 1 : caret;
      return { query: before.slice(2), from: field.start, to: field.start + to };
    },
    enabled: () => true,
    candidates(query) {
      const lower = query.toLowerCase();
      return kinds.filter(kind => kind.startsWith(lower) || labels[kind].startsWith(lower))
        .map(kind => ({ id: kind, value: kind, label: labels[kind] }));
    },
    apply(candidate, prompt, state) {
      const field = CompletionField.read(state);
      if (!field || !candidate.value || /[\r\n]/u.test(candidate.value)) return null;
      const marker = `[!${candidate.value.toUpperCase()}]`;
      const tail = field.source.slice(prompt.to - field.start);
      const replacement = marker + (tail && !/^[ \t\r\n]/.test(tail) ? ' ' : '');
      const source = field.replace(prompt.from, prompt.to, replacement);
      if (source === null) return null;
      const declaration = field.parse(source, true).find(node => node instanceof CalloutDeclarationSyntax);
      const valid = prompt.from === field.start && declaration instanceof CalloutDeclarationSyntax &&
        declaration.calloutType === candidate.value &&
          source.slice(declaration.start, declaration.closing.end) === marker;
      return valid ? replacement : null;
    },
    same: () => true,
    publish: state => ({ kind: 'callout', ...state }),
  };

  /** The supported declarations, in completion order. */
  export const kinds: readonly Callout.Kind[] = ['note', 'tip', 'important', 'warning', 'caution'];

  /** The default title for each declaration. */
  export const labels: Record<Callout.Kind, string> = {
    note: 'Note', tip: 'Tip', important: 'Important', warning: 'Warning', caution: 'Caution',
  };

  /** The icon displayed beside a callout's editable title. */
  export const icons: Record<Callout.Kind, string> = {
    note:
      '<rect width="18" height="18" x="3" y="3" rx="2" /><path d="M9 8h7" /><path d="M8 12h6" /><path d="M11 16h5" />',
    tip: '<path d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z" /><path d="M20 2v4" /><path d="M22 4h-4" /><circle cx="4" cy="20" r="2" />',
    important: '<path d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z" /><path d="M12 15h.01" /><path d="M12 7v4" />',
    warning: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" /><path d="M12 9v4" /><path d="M12 17h.01" />',
    caution: '<path d="M12 16h.01" /><path d="M12 8v4" /><path d="M15.312 2a2 2 0 0 1 1.414.586l4.688 4.688A2 2 0 0 1 22 8.688v6.624a2 2 0 0 1-.586 1.414l-4.688 4.688a2 2 0 0 1-1.414.586H8.688a2 2 0 0 1-1.414-.586l-4.688-4.688A2 2 0 0 1 2 15.312V8.688a2 2 0 0 1 .586-1.414l4.688-4.688A2 2 0 0 1 8.688 2z" />',
  };

  /** Set a callout declaration, converting a quote when needed. */
  export function setKind(kind: Callout.Kind, position?: number): Command {
    return (state, dispatch) => {
      if (!kinds.includes(kind)) return false;
      let pos = position;
      if (pos === undefined) {
        const from = state.selection.$from;
        for (let depth = from.depth; depth > 0; depth--) {
          const type = from.node(depth).type;
          if (type === schema.nodes.callout || type === schema.nodes.blockQuote) {
            pos = from.before(depth);
            break;
          }
        }
      }
      if (pos === undefined) return false;
      const node = state.doc.nodeAt(pos);
      if (!node || node.type !== schema.nodes.callout && node.type !== schema.nodes.blockQuote) return false;
      if (node.type === schema.nodes.callout) {
        if (node.attrs.calloutType !== kind && dispatch) {
          const tr = state.tr;
          update(tr, pos, { calloutType: kind });
          dispatch(tr);
        }
        return true;
      }
      if (!dispatch) return true;
      const empty = node.childCount === 1 && node.firstChild!.type === schema.nodes.paragraph &&
        !node.firstChild!.content.size;
      const children: Shape[] = [{
        kind: 'text', type: schema.nodes.calloutTitle, meaning: {},
        text: empty ? [{ kind: 'range', from: pos + 2, to: pos + 2 }] : [],
      }];
      if (!empty) node.forEach((child, offset) => children.push(keptShape(child, pos + 1 + offset)));
      const tr = state.tr;
      mapTextSelection(tr, range => reshape(tr, pos!, pos! + node.nodeSize, [{
        kind: 'children', type: schema.nodes.callout, meaning: { calloutType: kind }, children,
      }], range));
      dispatch(tr.scrollIntoView());
      return true;
    };
  }

  /** Make the authored title a paragraph and keep the ordinary body blocks. */
  export function toQuote(position?: number): Command {
    return (state, dispatch) => {
      const pos = position ?? selectedCallout(state)?.pos;
      if (pos === undefined) return false;
      const node = state.doc.nodeAt(pos);
      if (node?.type !== schema.nodes.callout) return false;
      if (!dispatch) return true;
      const title = node.firstChild!;
      const children: Shape[] = [];
      if (title.content.size) children.push({
        kind: 'text', type: schema.nodes.paragraph, meaning: {},
          text: [{ kind: 'range', from: pos + 2, to: pos + title.nodeSize }],
      });
      node.forEach((child, offset, index) => {
        if (index) children.push(keptShape(child, pos + 1 + offset));
      });
      if (!children.length) children.push({ kind: 'text', type: schema.nodes.paragraph, meaning: {}, text: [] });
      const tr = state.tr;
      mapTextSelection(tr,
        range => reshape(tr, pos!, pos! + node.nodeSize,
        [{ kind: 'children', type: schema.nodes.blockQuote, meaning: {}, children }], range));
      keepQuoteIntent(tr, pos + 2, bindings.get(state));
      if (!title.content.size && node.childCount === 1) tr.setSelection(TextSelection.create(tr.doc, pos + 2));
      dispatch(tr.scrollIntoView());
      return true;
    };
  }

  /** Only the title start removes the callout frame; body blocks use the shared deletion commands. */
  export const backspace: Command = (state, dispatch) => {
    const { selection } = state;
    if (!(selection instanceof TextSelection) || !selection.empty || selection.$from.parentOffset) return false;
    const found = selectedCallout(state);
    const field = selection.$from.parent;
    if (!found || field.type !== schema.nodes.calloutTitle) return false;
    return toQuote(found.pos)(state, dispatch);
  };

  /** Enter opens or splits the body, or leaves its final empty paragraph. */
  export const enter: Command = (state, dispatch) => {
    const { selection } = state;
    if (!(selection instanceof TextSelection)) return false;
    if (selection.$from.parent.type === schema.nodes.calloutTitle) return splitTitle(state, dispatch);
    if (!selection.empty) return false;
    const found = selectedCallout(state);
    if (!found || selection.$from.depth !== found.depth + 1 || selection.$from.parent.type !== schema.nodes.paragraph)
      return false;
    if (dispatch) {
      const tr = state.tr;
      if (!selection.$from.parent.content.size && found.index === found.node.childCount - 1) {
        const end = found.pos + found.node.nodeSize;
        insert(tr, end, schema.nodes.paragraph, {});
        remove(tr, selection.$from.before(), selection.$from.after());
        tr.setSelection(TextSelection.near(tr.doc.resolve(tr.mapping.map(end, -1)), 1));
        dispatch(tr.scrollIntoView());
      } else {
        split(tr, selection.from, 1);
        dispatch(tr);
      }
    }
    return true;
  };
}

/** Commands for a callout and the completion of its declaration. */
export namespace Callout {
  /** A supported callout declaration. */
  export type Kind = 'note' | 'tip' | 'important' | 'warning' | 'caution';

  /** Raised when the kind button is pressed. A host answers with setKind or toQuote. */
  export const chooseKind = command.requestCommand<{
    readonly pos: number; readonly rect: DOMRectReadOnly; readonly kind: Kind
  }>();

  /** Set the declaration at pos, or in the enclosing callout. */
  export const setKind: command.Command.Pure<{ readonly pos?: number; readonly kind: Kind }> = ({ state },
    { pos, kind }) => {
    const position = command.findTarget(state.editorState, pos, schema.nodes.callout);
    return position !== undefined && state.runCommand(callout.setKind(kind, position));
  };

  /** Convert the named callout, or the enclosing one, to an ordinary quote. */
  export const toQuote: command.Command.Pure<{ readonly pos?: number }> = ({ state }, { pos }) => {
    const position = command.findTarget(state.editorState, pos, schema.nodes.callout);
    return position !== undefined && state.runCommand(callout.toQuote(position));
  };

  /** A supported declaration offered by the callout source. */
  export interface Candidate extends Completions.Candidate {
    readonly value: Kind;
  }

  /** A callout completion carries the kind of every offered declaration. */
  export interface Completion extends Completions.State<Candidate> {
    readonly kind: 'callout';
  }

  /** The available kinds and their display names. */
  export const kinds: readonly { readonly value: Kind; readonly label: string }[] =
    Object.freeze(callout.kinds.map(value => Object.freeze({ value, label: callout.labels[value] })));
}

interface CalloutPosition {
  readonly node: Node;
  readonly pos: number;
  readonly depth: number;
  readonly index: number;
}

function selectedCallout(state: EditorState): CalloutPosition | null {
  const { $from, $to } = state.selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    if ($from.node(depth).type !== schema.nodes.callout) continue;
    if ($to.pos > $from.after(depth)) return null;
    return { node: $from.node(depth), pos: $from.before(depth), depth, index: $from.index(depth) };
  }
  return null;
}

/** An explicit quote conversion keeps a newly exposed declaration literal. The
 * reader identifies it; the escape is editable text in this history event. */
function keepQuoteIntent(tr: Transaction, position: number, before: bindings.State): void {
  const field = tr.doc.resolve(position);
  if (field.parent.type !== schema.nodes.paragraph || field.depth < 2 ||
      field.node(-1).type !== schema.nodes.blockQuote || field.index(-1)) return;
  const result = readField(field, bindings.after(before, tr));
  if (result.kind !== 'inline') return;
  const declaration = result.children.find(node => node.type === 'calloutDeclaration');
  if (declaration) tr.insertText('\\', field.start() + declaration.start);
}

const splitTitle: Command = (state, dispatch) => {
  const { $from, $to } = state.selection;
  if ($from.parent.type !== schema.nodes.calloutTitle) return false;
  if (!dispatch) return true;
  const tr = state.tr;
  if (!$from.sameParent($to)) remove(tr, $from.pos, $to.pos);
  const start = tr.selection.$from;
  const end = tr.selection.$to;
  if (start.parent.type !== schema.nodes.calloutTitle || !start.sameParent(end)) return false;
  const pos = start.before(start.depth - 1);
  const node = start.node(-1);
  const children: Shape[] = [
    {
      kind: 'text', type: schema.nodes.calloutTitle, meaning: {},
      text: [{ kind: 'range', from: start.start(), to: start.pos }]
    },
    {
      kind: 'text', type: schema.nodes.paragraph, meaning: {},
      text: [{ kind: 'range', from: end.pos, to: end.end() }]
    },
  ];
  node.forEach((child, offset, index) => {
    if (index) children.push(keptShape(child, pos + 1 + offset));
  });
  mapTextSelection(tr, range => reshape(tr, pos!, pos! + node.nodeSize, [{
    kind: 'children', type: schema.nodes.callout, meaning: { calloutType: node.attrs.calloutType }, children,
  }], range));
  dispatch(tr.setSelection(TextSelection.create(tr.doc, start.before() + start.parentOffset + 3)).scrollIntoView());
  return true;
};

/** A default title is presentation, separate from the stable editable title DOM. */
class TitleView implements BlockView {
  readonly dom: HTMLDivElement;
  readonly contentDOM: HTMLSpanElement;
  private readonly button: HTMLButtonElement;
  private readonly icon: SVGSVGElement;

  constructor(private node: Node, readonly view: EditorView,
    private readonly getPos: () => number | undefined, private readonly remove: () => void) {
    const document = view.dom.ownerDocument;
    this.dom = document.createElement('div');
    this.dom.className = 'md-callout-heading';
    // The control follows the title in the DOM and is drawn first by CSS: Chrome loses a
    // composition at the start of text that an uneditable element precedes.
    const mount = document.createElement('span');
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
    this.button.onclick = () => {
      if (view.isDestroyed || !canRunCommand(view.state, view)) return;
      const pos = this.position();
      const editor = findEditor(view.dom);
      if (editor && pos !== undefined) command.Command.dispatch(editor, Callout.chooseKind,
        { pos, rect: this.button.getBoundingClientRect(), kind: this.kind });
    };
    this.button.onkeydown = event => {
      if (!view.isDestroyed && input.historyKey(view, event)) event.stopPropagation();
    };
    this.sync();
  }

  private position(): number | undefined {
    if (this.view.isDestroyed) return undefined;
    const pos = this.getPos();
    return pos === undefined || pos === 0 || this.view.state.doc.nodeAt(pos - 1)?.type !== schema.nodes.callout
      ? undefined : pos - 1;
  }

  private get kind(): Callout.Kind {
    const pos = this.position();
    return pos === undefined ? 'note' : this.view.state.doc.nodeAt(pos)!.attrs.calloutType;
  }

  request(): command.CommandRequest {
    return {
      pos: () => this.position(),
      rect: () => this.button.getBoundingClientRect(),
      held: value => {
        if (value) this.button.setAttribute('aria-expanded', 'true');
        else this.button.removeAttribute('aria-expanded');
      },
    };
  }

  sync(): void {
    const kind = this.kind;
    this.button.disabled = !this.view.editable;
    if (this.icon.dataset.kind !== kind) {
      this.icon.dataset.kind = kind;
      this.icon.innerHTML = callout.icons[kind];
    }
    const placeholder = this.node.content.size ? '' : callout.labels[kind];
    if (this.contentDOM.dataset.placeholder !== placeholder) this.contentDOM.dataset.placeholder = placeholder;
  }

  update(node: Node): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.sync();
    return true;
  }

  stopEvent(event: Event): boolean {
    if (!this.button.contains(event.target as DOMNode)) return false;
    if (event.type === 'keydown') {
      const key = event as KeyboardEvent;
      if (!key.altKey && (key.metaKey || key.ctrlKey) && ['z', 'y'].includes(key.key.toLowerCase())) return false;
    }
    return true;
  }

  ignoreMutation(mutation: ViewMutationRecord): boolean {
    return mutation.type !== 'selection' && (!this.contentDOM.contains(mutation.target) ||
      mutation.type === 'attributes' && mutation.target === this.contentDOM);
  }

  destroy(): void {
    this.remove();
    this.button.onclick = this.button.onkeydown = null;
  }
}

/** Attribute changes update the frame without replacing the title or body DOM. */
function frame(initial: Node, view: EditorView): BlockView {
  const dom = view.dom.ownerDocument.createElement('div');
  dom.className = 'md-callout-frame';
  const contentDOM = dom.appendChild(view.dom.ownerDocument.createElement('aside'));
  const draw = (node: Node) => {
    contentDOM.className = `md-callout md-callout-${node.attrs.calloutType}`;
    contentDOM.dataset.callout = node.attrs.calloutType;
  };
  draw(initial);
  return registerBlockView(initial, {
    dom, contentDOM,
    box: dom,
    content: contentDOM,
    brush: true,
    get field() { return contentDOM.firstElementChild as HTMLElement; },
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
