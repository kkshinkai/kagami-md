/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import katex from 'katex';
import type { Node } from 'prosemirror-model';
import { Plugin, PluginKey, TextSelection, type Command, type EditorState } from 'prosemirror-state';
import { Decoration, DecorationSet, type ViewMutationRecord } from 'prosemirror-view';
import { convert, insert } from '../transform/transform.js';
import { decorateBlocks } from '../editor/decoration.js';
import { registerBlockView, type BlockView, type HandleTarget } from '../editor/blockview.js';
import { renderedSourceInteraction, registerRenderedSource } from '../editor/renderedsource.js';
import { CONCEALED, REVEALED, standIn, reveal, type SourcePresentation } from '../editor/reveal.js';
import { isRevealed, type Revealing } from '../state/normalization.js';

/** Render TeX beside its editable source and provide math-block editing commands. */
export function math(): Plugin[] {
  return [math.presentation()];
}

export namespace math {
  export interface Formula {
    readonly from: number;
    readonly to: number;
    readonly bodyFrom: number;
    readonly bodyTo: number;
    readonly delimiter: string;
    readonly value: string;
  }

  /** The formula occurrences in a node whose content starts at the given position. */
  export function formulas(node: Node, start: number): Formula[] {
    const result: Formula[] = [];
    readFormulas(node, start, result);
    return result;
  }

  /** Create a noneditable preview; untrusted TeX never becomes raw HTML. */
  export function preview(value: string, display: boolean, document: Document): HTMLElement {
    const element = document.createElement(display ? 'div' : 'span');
    element.className = 'md-math-preview';
    element.contentEditable = 'false';
    render(element, value, display);
    return element;
  }

  /** Present formulas without replacing their source positions in the document. */
  export function presentation(): Plugin<MathPresentation> {
    const source = reveal.state(drawSource, selectedBlocks);
    const interaction = renderedSourceInteraction();
    return new Plugin({
      key: presentationKey,
      state: {
        init(config, state) {
          const value = source.init(config, state);
          const previews = decorateBlocks(state.doc,
            (node, position) => drawPreviews(node, position, value.decorations));
          return { ...value, previews };
        },
        apply(tr, value, before, state) {
          const next = source.apply(tr, value, before, state);
          const refresh: decorateBlocks.Range[] = [];
          if (value.decorations !== next.decorations || value.selection?.from !== next.selection?.from ||
              value.selection?.to !== next.selection?.to) {
            if (value.selection) {
              const from = tr.mapping.map(value.selection.from, -1);
              const to = tr.mapping.map(value.selection.to, 1);
              refresh.push({ from, to: from }, { from: to, to });
            }
            if (next.selection) {
              refresh.push({ from: next.selection.from, to: next.selection.from });
              refresh.push({ from: next.selection.to, to: next.selection.to });
            }
          }
          const previews = decorateBlocks.update(value.previews, tr,
            (node, position) => drawPreviews(node, position, next.decorations), refresh);
          return { ...next, previews };
        },
      },
      view: interaction.view,
      props: {
        handleDOMEvents: { mousedown: interaction.mousedown },
        decorations(state) {
          const value = presentationKey.getState(state);
          return value ? value.decorations.add(state.doc, value.previews.find()) : DecorationSet.empty;
        },
        nodeViews: {
          mathBlock(node, view, getPos) {
            return registerBlockView(node, new MathView(node, view.dom.ownerDocument, getPos));
          },
        },
      },
    });
  }

  /** Insert literal text in one math block. */
  export function insertText(text: string): Command {
    return (state, dispatch) => {
      if (!inMath(state)) return false;
      if (dispatch) dispatch(state.tr.insertText(text).scrollIntoView());
      return true;
    };
  }

  /** Enter adds a line, or leaves an empty last line of a math block. */
  export const enter: Command = (state, dispatch, view) => {
    if (!inMath(state)) return false;
    const selection = state.selection;
    const parent = selection.$from.parent;
    if (selection.empty && selection.$from.parentOffset === parent.content.size &&
        (!parent.content.size || parent.textContent.endsWith('\n'))) return exit(state, dispatch, view);
    return insertText('\n')(state, dispatch, view);
  };

  /** Leave math for a following empty paragraph without consuming authored following text. */
  export const exit: Command = (state, dispatch) => {
    if (!inMath(state)) return false;
    if (!dispatch) return true;
    const from = state.selection.$from;
    const transaction = state.tr;
    if (from.parent.content.size === 0) {
      convert(transaction, from.before(), state.schema.nodes.paragraph!, {});
    } else {
      if (from.parent.textContent.endsWith('\n')) transaction.insertText('', from.end() - 1, from.end());
      const after = transaction.mapping.map(from.after());
      const next = transaction.doc.resolve(after).nodeAfter;
      if (next?.type !== state.schema.nodes.paragraph || next.content.size) {
        insert(transaction, after, state.schema.nodes.paragraph!, {});
      }
      transaction.setSelection(TextSelection.create(transaction.doc, after + 1));
    }
    dispatch(transaction.scrollIntoView());
    return true;
  };

  /** Remove one indentation unit from the current math line. */
  export const dedent: Command = (state, dispatch) => {
    if (!inMath(state)) return false;
    const from = state.selection.$from;
    const text = from.parent.textContent;
    const start = text.slice(0, from.parentOffset).lastIndexOf('\n') + 1;
    let length = 0;
    if (text[start] === '\t') length = 1;
    else if (text[start] === ' ') length = text[start + 1] === ' ' ? 2 : 1;
    if (length && dispatch) dispatch(state.tr.insertText('', from.start() + start, from.start() + start + length));
    return true;
  };
}

interface ReadingFormula {
  from: number;
  to: number;
  bodyFrom: number;
  bodyTo: number;
  value: string;
}

interface MathPresentation extends SourcePresentation {
  readonly previews: DecorationSet;
}

const presentationKey = new PluginKey<MathPresentation>('math-presentation');

function readFormulas(node: Node, start: number, result: math.Formula[]): void {
  if (!node.isTextblock) {
    node.forEach((child, offset) => readFormulas(child, start + offset + 1, result));
    return;
  }
  if (node.type.spec.code) return;
  const occurrences = new Map<number, ReadingFormula>();
  const { inlineMath, meta } = node.type.schema.marks;
  node.forEach((child, offset) => {
    const mark = inlineMath!.isInSet(child.marks);
    if (!mark) return;
    let value = occurrences.get(mark.attrs.occurrence);
    if (!value) {
      value = { from: offset, to: offset, bodyFrom: -1, bodyTo: -1, value: mark.attrs.math };
      occurrences.set(mark.attrs.occurrence, value);
    }
    value.to = offset + child.nodeSize;
    if (meta!.isInSet(child.marks)) return;
    if (value.bodyFrom < 0) value.bodyFrom = offset;
    value.bodyTo = offset + child.nodeSize;
  });
  for (const value of occurrences.values()) {
    const bodyFrom = value.bodyFrom < 0 ? value.to : value.bodyFrom;
    const bodyTo = value.bodyTo < 0 ? bodyFrom : value.bodyTo;
    result.push({
      from: start + value.from, to: start + value.to,
      bodyFrom: start + bodyFrom, bodyTo: start + bodyTo,
      delimiter: node.textBetween(value.from, bodyFrom, '', '\n'), value: value.value,
    });
  }
}

function inMath(state: EditorState): boolean {
  const selection = state.selection;
  return selection instanceof TextSelection && selection.$from.sameParent(selection.$to) &&
    selection.$from.parent.type === state.schema.nodes.mathBlock;
}

function render(element: HTMLElement, value: string, displayMode: boolean): void {
  katex.render(value, element, { displayMode, throwOnError: false, trust: false, strict: 'ignore' });
  element.setAttribute('role', 'math');
  element.setAttribute('aria-label', value || 'Empty formula');
}

/** The node view owns a preview beside ProseMirror's editable code content. */
class MathView implements BlockView {
  readonly dom: HTMLElement;
  readonly contentDOM: HTMLElement;
  readonly preview: HTMLElement;
  private retired = false;

  constructor(private node: Node, document: Document, getPos: () => number | undefined) {
    const dom = this.dom = document.createElement('div');
    dom.className = 'md-math-block';
    dom.dataset.mathBlock = 'true';
    const preview = this.preview = math.preview(node.textContent, true, document);
    const source = document.createElement('pre');
    source.className = 'md-math-source';
    this.contentDOM = source.appendChild(document.createElement('code'));
    dom.append(preview, source);
    registerRenderedSource(preview, () => {
      if (this.retired) return undefined;
      const position = getPos();
      if (position === undefined) return undefined;
      return { from: position, to: position + this.node.nodeSize, entry: position + 1 };
    }, true);
  }

  get box(): HTMLElement { return this.dom; }
  get content(): HTMLElement { return this.dom; }
  get handle(): HandleTarget { return { kind: 'box', target: this.preview }; }

  update(node: Node): boolean {
    if (node.type !== this.node.type) return false;
    if (this.node.textContent !== node.textContent) render(this.preview, node.textContent, true);
    this.node = node;
    return true;
  }

  ignoreMutation(mutation: ViewMutationRecord): boolean {
    return this.preview.contains(mutation.target);
  }

  destroy(): void { this.retired = true; }
}

class MathSource {
  readonly decorations: Decoration[] = [];
  constructor(readonly selection: TextSelection | null, readonly visible: Revealing) {}

  read(node: Node, position: number): void {
    if (node.type === node.type.schema.nodes.mathBlock) {
      const end = position + node.nodeSize;
      if (this.selection && this.selection.from <= end - 1 && this.selection.to >= position + 1) {
        this.decorations.push(Decoration.node(position, end, { class: 'md-math-editing' }));
      }
    } else if (node.isTextblock) {
      for (const formula of math.formulas(node, position + 1)) {
        if (isRevealed(this.visible, formula)) {
          this.decorations.push(Decoration.inline(formula.from, formula.bodyFrom, { class: REVEALED }));
          this.decorations.push(Decoration.inline(formula.bodyTo, formula.to, { class: REVEALED }));
        } else {
          this.decorations.push(Decoration.inline(formula.from, formula.to, { class: CONCEALED }, { concealed: true }));
        }
      }
    } else {
      node.forEach((child, offset) => this.read(child, position + offset + 1));
    }
  }
}

/** Block source is visible throughout a selected range; only its changed coverage is redrawn. */
function selectedBlocks(before: decorateBlocks.Range | null,
  after: decorateBlocks.Range | null): readonly decorateBlocks.Range[] {
  if (!before) return after ? [after] : [];
  if (!after) return [before];
  return [
    { from: Math.min(before.from, after.from), to: Math.max(before.from, after.from) },
    { from: Math.min(before.to, after.to), to: Math.max(before.to, after.to) },
  ];
}

function drawSource(node: Node, position: number, _state: EditorState, selection: TextSelection | null,
  visible: Revealing): Decoration[] {
  const source = new MathSource(selection, visible);
  source.read(node, position);
  return source.decorations;
}

function drawPreviews(node: Node, position: number, source: DecorationSet): Decoration[] {
  return math.formulas(node, position + 1).map(formula => {
    const { from, to, bodyFrom, delimiter, value } = formula;
    const revealed = !source.find(from, to, spec => spec.concealed === true)
      .some(range => range.from <= from && range.to >= to);
    // A gesture may freeze source visibility; preview glyphs still follow the current TeX.
    return standIn(to, (view, getPos) => {
      const element = math.preview(value, false, view.dom.ownerDocument);
      element.classList.toggle('md-math-live-preview', revealed);
      registerRenderedSource(element, () => {
        const at = getPos();
        if (at === undefined) return undefined;
        return { from: at - (to - from), to: at, entry: at - (to - bodyFrom) };
      }, true);
      return element;
    }, { side: 1, ignoreSelection: true, key: `math:${from}:${delimiter}:${value}:${revealed}` });
  });
}
