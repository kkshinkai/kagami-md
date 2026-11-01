/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { DOMSerializer, type Node, type ResolvedPos } from 'prosemirror-model';
import { chainCommands } from 'prosemirror-commands';
import { keymap as definitionKeymap } from 'prosemirror-keymap';
import { Plugin, Selection, TextSelection, type Command, type EditorState, type Transaction } from 'prosemirror-state';
import type { EditorView, NodeView, ViewMutationRecord } from 'prosemirror-view';
import { fieldSource } from '../parse/field.js';
import { schema } from '../types/schema.js';
import { registerBlockView, type BlockView, type HandleTarget } from '../editor/blockview.js';
import { mapTextSelection } from '../state/selection.js';
import { definitionFrames } from '../unparse/frames.js';
import { insert, remove, reshape, unwrap, type Shape } from '../transform/transform.js';
import { applyTransaction, cursorContext, liftOut, ownsTextblock, type TextblockContext } from './textblockcontext.js';

/** Definition fields, their keys, and readings that depend on their bindings. */
export function link(): Plugin[] {
  return [link.views(), link.keymap(), link.input()];
}

export namespace link {
  /** Definition frames and punctuation declare their own editable and measurable DOM. */
  export function views(): Plugin {
    return new Plugin({ props: { nodeViews: {
      linkReferenceDefinition: definitionView,
      footnoteDefinition: definitionView,
      linkLabel: (node, view, getPos) => new DefinitionFieldView(node, view, getPos),
      linkDestination: (node, view, getPos) => new DefinitionFieldView(node, view, getPos),
      linkTitle: (node, view, getPos) => new DefinitionFieldView(node, view, getPos),
      footnoteLabel: (node, view, getPos) => new DefinitionFieldView(node, view, getPos),
    } } });
  }

  /** Backspace at the start of a footnote's body, or in its empty label: the footnote becomes its
   * body, with the caret at the body's start. A body with no text gets a paragraph for the caret. */
  export function dissolveFootnote(state: EditorState, context: TextblockContext): Transaction | null {
    const depth = context.footnoteDefinition;
    if (depth === undefined) return null;
    const owner = context.$from.node(depth);
    const start = context.$from.before(depth);
    const label = owner.firstChild;
    if (!label) return null;
    const tr = state.tr;
    const bodyFrom = start + 1 + label.nodeSize;
    let caret: number | null = null;
    let pos = bodyFrom;
    for (let index = 1; index < owner.childCount; index++) {
      const child = owner.child(index);
      caret = firstTextblock(child, pos);
      if (caret !== null) break;
      pos += child.nodeSize;
    }
    if (caret === null) {
      insert(tr, bodyFrom, tr.doc.type.schema.nodes.paragraph, {});
      caret = bodyFrom + 1;
    }
    const step = tr.mapping.maps.length;
    unwrap(tr, start);
    return tr.setSelection(TextSelection.near(tr.doc.resolve(tr.mapping.slice(step).map(caret, 1))));
  }

  function firstTextblock(node: Node, pos: number): number | null {
    if (node.isTextblock) return pos + 1;
    let childPos = pos + 1;
    for (let index = 0; index < node.childCount; index++) {
      const child = node.child(index);
      const found = firstTextblock(child, childPos);
      if (found !== null) return found;
      childPos += child.nodeSize;
    }
    return null;
  }

  /** Enter moves from a footnote label into its body, or lifts an empty last body paragraph. */
  export const enterFootnote: Command = (state, dispatch) => {
    const context = cursorContext(state);
    if (!context || context.footnoteDefinition === undefined) return false;
    const { $from, textblock, footnoteDefinition: footnote } = context;
    if (textblock.type === state.schema.nodes.footnoteLabel) {
      // The caret goes into the body; a body with no text, a rule alone, gets a paragraph first.
      const pos = $from.after();
      const first = $from.node(footnote).maybeChild(1);
      const tr = state.tr;
      if (!first || firstTextblock(first, pos) === null) insert(tr, pos, tr.doc.type.schema.nodes.paragraph, {});
      return applyTransaction(state, dispatch, tr.setSelection(TextSelection.near(tr.doc.resolve(pos + 1))));
    }
    if (ownsTextblock(context, footnote) && textblock.type === state.schema.nodes.paragraph &&
        !textblock.content.size && $from.node(footnote).childCount > 2 &&
        $from.index(footnote) === $from.node(footnote).childCount - 1) {
      return applyTransaction(state, dispatch, liftOut(state, context, footnote));
    }
    return false;
  };

  /** One editable string field in a definition. */
  interface Field {
    start: number;
    end: number;
  }

  /** A position directly inside a link definition's label, destination, or title. */
  class DefinitionPosition {
    readonly from: number;
    readonly to: number;
    readonly fields: readonly Field[];
    readonly index: number;

    constructor(position: ResolvedPos) {
      const depth = position.depth - 1;
      const definition = position.node(depth);
      this.from = position.before(depth);
      this.to = this.from + definition.nodeSize;
      this.index = position.index(depth);
      const fields: Field[] = [];
      definition.forEach((field, offset) => {
        const start = this.from + offset + 2;
        fields.push({ start, end: start + field.content.size });
      });
      this.fields = fields;
    }

    static at(position: ResolvedPos): DefinitionPosition | null {
      const depth = position.depth - 1;
      if (depth < 1 || position.node(depth).type !== position.doc.type.schema.nodes.linkReferenceDefinition)
        return null;
      return new DefinitionPosition(position);
    }

    static cursor(state: EditorState): DefinitionPosition | null {
      const selection = state.selection;
      return selection instanceof TextSelection && selection.empty ? DefinitionPosition.at(selection.$head) : null;
    }
  }

  /** Left and Right at a field edge step across the definition's drawn punctuation. */
  export function moveByField(direction: -1 | 1): Command {
    return (state, dispatch) => {
      const position = DefinitionPosition.cursor(state);
      if (!position) return false;
      const field = position.fields[position.index]!;
      if (state.selection.head !== (direction < 0 ? field.start : field.end)) return false;
      const beside = position.fields[position.index + direction];
      let selection: Selection | null;
      if (beside) selection = TextSelection.create(state.doc, direction < 0 ? beside.end : beside.start);
      else selection = Selection.findFrom(state.doc.resolve(direction < 0 ? position.from : position.to), direction,
        true);
      // Without a neighboring text position the caret stays out of the punctuation.
      if (selection) dispatch?.(state.tr.setSelection(selection).scrollIntoView());
      return true;
    };
  }

  /** Home and End address the whole definition line, optionally extending the selection. */
  export function moveToLineSide(side: -1 | 1, extend = false): Command {
    return (state, dispatch) => {
      const selection = state.selection;
      const position = selection instanceof TextSelection ? DefinitionPosition.at(selection.$head) : null;
      if (!position) return false;
      const edge = side < 0 ? position.fields[0]!.start : position.fields.at(-1)!.end;
      dispatch?.(state.tr.setSelection(TextSelection.create(state.doc, extend ? selection.anchor : edge,
        edge)).scrollIntoView());
      return true;
    };
  }

  /** Delete each selected part in its own field, preserving the fields and their delimiters. */
  export function deleteFields(state: EditorState): Transaction | null {
    const selection = state.selection;
    if (!(selection instanceof TextSelection) || selection.empty) return null;
    const first = DefinitionPosition.at(selection.$from);
    const last = DefinitionPosition.at(selection.$to);
    if (!first || !last || first.from !== last.from || first.index === last.index) return null;
    const tr = state.tr;
    // Descending edits leave the positions of the remaining fields unchanged.
    for (let index = last.index; index >= first.index; index--) {
      const field = first.fields[index]!;
      const from = index === first.index ? selection.from : field.start;
      const to = index === last.index ? selection.to : field.end;
      if (to > from) tr.insertText('', from, to);
    }
    return tr.setSelection(TextSelection.create(tr.doc, selection.from)).scrollIntoView();
  }

  /** Apply deletion across definition fields as a ProseMirror command. */
  export const deleteSelection: Command = (state, dispatch) => {
    const tr = deleteFields(state);
    if (!tr) return false;
    dispatch?.(tr);
    return true;
  };

  /** Remove a field's final character before the browser changes its empty DOM shape. */
  export function emptyField(direction: -1 | 1): Command {
    return (state, dispatch) => {
      const position = DefinitionPosition.cursor(state);
      if (!position) return false;
      const field = position.fields[position.index]!;
      if (field.end - field.start !== 1 || state.selection.head !== (direction < 0 ? field.end : field.start))
        return false;
      dispatch?.(state.tr.insertText('', field.start, field.end).scrollIntoView());
      return true;
    };
  }

  /** Put a caret into a field, bounding a requested source offset by its current content. */
  function caret(tr: Transaction, pos: number, offset: number): Transaction {
    const node = tr.doc.nodeAt(pos);
    if (!node?.isTextblock) throw new RangeError('A caret needs a textblock');
    return tr.setSelection(TextSelection.create(tr.doc, pos + 1 + Math.max(0, Math.min(offset, node.content.size))));
  }

  /** The structural context narrowed to a definition's direct editable field. */
  interface DefinitionContext extends TextblockContext {
    linkDefinition: number;
  }

  /** Whether the caret's field is directly inside the definition. */
  function inField(context: TextblockContext): context is DefinitionContext {
    return context.linkDefinition !== undefined && context.$from.depth === context.linkDefinition + 1;
  }

  /** The opening position of one of the current definition's fields. */
  function fieldPosition(context: DefinitionContext, index: number): number {
    const depth = context.linkDefinition;
    const definition = context.$from.node(depth);
    let position = context.$from.before(depth) + 1;
    for (let child = 0; child < index; child++) position += definition.child(child).nodeSize;
    return position;
  }

  /** Backspace at a field start changes fields; an empty label dissolves the definition. */
  export function joinBackward(state: EditorState, context: TextblockContext): Transaction | null {
    if (!inField(context)) return null;
    const depth = context.linkDefinition;
    const node = context.$from.node(depth);
    const index = context.$from.index(depth);
    if (index === 0) {
      if (context.textblock.content.size) return state.tr;
      return dissolve(state, context.$from.before(depth), node);
    }
    const tr = state.tr;
    if (context.textblock.type === state.schema.nodes.linkTitle && context.textblock.content.size === 0) {
      const from = context.$from.before();
      remove(tr, from, from + context.textblock.nodeSize);
    }
    return caret(tr, fieldPosition(context, index - 1), fieldSource(node.child(index - 1)).length);
  }

  /** Delete at a field end advances to the next field and never joins their text. */
  export function joinForward(state: EditorState, context: TextblockContext): Transaction | null {
    if (!inField(context)) return null;
    const index = context.$from.index(context.linkDefinition);
    if (index + 1 === context.$from.node(context.linkDefinition).childCount) return state.tr;
    return caret(state.tr, fieldPosition(context, index + 1), 0);
  }

  /** A definition adjacent to the caret's paragraph. */
  interface Neighbor {
    node: Node;
    pos: number;
  }

  /** Find the sibling definition before or after the paragraph. */
  function beside(context: TextblockContext, direction: -1 | 1): Neighbor | null {
    const nodes = context.textblock.type.schema.nodes;
    if (context.textblock.type !== nodes.paragraph) return null;
    const from = context.$from;
    const boundary = from.doc.resolve(direction < 0 ? from.before() : from.after());
    const node = direction < 0 ? boundary.nodeBefore : boundary.nodeAfter;
    if (node?.type !== nodes.linkReferenceDefinition) return null;
    return { node, pos: direction < 0 ? boundary.pos - node.nodeSize : boundary.pos };
  }

  /** Backspace before paragraph text moves to the preceding definition's final field. */
  export function joinAfter(state: EditorState, context: TextblockContext): Transaction | null {
    const neighbor = context.textblock.content.size ? beside(context, -1) : null;
    if (!neighbor) return null;
    const last = neighbor.node.lastChild!;
    return caret(state.tr, neighbor.pos + neighbor.node.nodeSize - last.nodeSize - 1, fieldSource(last).length);
  }

  /** Delete after paragraph text moves to the following definition's label. */
  export function joinBefore(state: EditorState, context: TextblockContext): Transaction | null {
    const neighbor = context.textblock.content.size ? beside(context, 1) : null;
    return neighbor ? caret(state.tr, neighbor.pos + 1, 0) : null;
  }

  /** Enter at a nonempty label's start opens a paragraph above and keeps the label's caret. */
  export function breakBefore(state: EditorState, context: TextblockContext): Transaction | null {
    if (!inField(context) || context.$from.index(context.linkDefinition) !== 0 ||
        !context.isAtStart || context.textblock.content.size === 0) return null;
    const position = context.$from.before(context.linkDefinition);
    const tr = state.tr;
    insert(tr, position, state.schema.nodes.paragraph, {});
    return caret(tr, tr.mapping.map(position, 1) + 1, 0);
  }

  /** Remove an empty label's frame, retaining the destination and title source as paragraph text. */
  function dissolve(state: EditorState, pos: number, node: Node): Transaction {
    const destination = node.child(1);
    const start = pos + node.child(0).nodeSize + 2;
    const frames = definitionFrames(node);
    const text: Shape.Piece[] = [
      { kind: 'text', text: frames[1]!.before.trimStart() },
      { kind: 'range', from: start, to: start + destination.content.size },
      { kind: 'text', text: frames[1]!.after },
    ];
    const title = node.maybeChild(2);
    if (title) {
      text.push({ kind: 'text', text: frames[2]!.before },
        { kind: 'range', from: start + destination.nodeSize, to: start + destination.nodeSize + title.content.size },
        { kind: 'text', text: frames[2]!.after });
    }
    const tr = state.tr;
    mapTextSelection(tr,
      range => reshape(tr, pos, pos + node.nodeSize,
        [{ kind: 'text', type: state.schema.nodes.paragraph, meaning: {}, text }], range));
    return caret(tr, pos, 0);
  }

  /** Enter opens a paragraph before or after a link definition without splitting its fields. */
  export const enter: Command = (state, dispatch) => {
    const context = cursorContext(state);
    if (!context || context.linkDefinition === undefined) return false;
    const before = breakBefore(state, context);
    if (before) return applyTransaction(state, dispatch, before);
    const pos = context.$from.after(context.linkDefinition);
    const tr = state.tr;
    insert(tr, pos, tr.doc.type.schema.nodes.paragraph, {});
    return applyTransaction(state, dispatch, tr.setSelection(TextSelection.create(tr.doc, pos + 1)));
  };

  /** Move to the beginning of the current definition field line. */
  export const lineStart = moveToLineSide(-1);
  /** Move to the end of the current definition field line. */
  export const lineEnd = moveToLineSide(1);
  /** Delete across fields, or consume the boundary of an empty field. */
  export const deleteBackward = chainCommands(deleteSelection, emptyField(-1));
  /** Delete across fields, or consume the boundary of an empty field. */
  export const deleteForward = chainCommands(deleteSelection, emptyField(1));

  /** Field navigation preserves the definition's punctuation and source-line order. */
  export function keymap(): Plugin {
    const extendStart = moveToLineSide(-1, true);
    const extendEnd = moveToLineSide(1, true);
    return definitionKeymap({
      ArrowLeft: moveByField(-1),
      ArrowRight: moveByField(1),
      Home: lineStart,
      End: lineEnd,
      'Meta-ArrowLeft': lineStart,
      'Meta-ArrowRight': lineEnd,
      'Shift-Home': extendStart,
      'Shift-End': extendEnd,
      'Shift-Meta-ArrowLeft': extendStart,
      'Shift-Meta-ArrowRight': extendEnd,
    });
  }

  /** Typing across fields replaces the selection as a deletion followed by text input. */
  export function input(): Plugin {
    return new Plugin({ props: {
      handleTextInput(view, _from, _to, text) {
        const tr = deleteFields(view.state);
        if (!tr) return false;
        view.dispatch(tr.insertText(text));
        return true;
      },
    } });
  }
}

/** A definition keeps its native fields mounted while source attributes change. */
function definitionView(node: Node, view: EditorView): BlockView {
  const output = DOMSerializer.renderSpec(view.dom.ownerDocument, node.type.spec.toDOM!(node));
  const dom = output.dom as HTMLElement;
  return registerBlockView(node, {
    dom,
    contentDOM: output.contentDOM as HTMLElement,
    box: dom,
    content: dom,
    get field() {
      return node.type === schema.nodes.footnoteDefinition ? dom.firstElementChild as HTMLElement : undefined;
    },
    get handle(): HandleTarget {
      return { kind: 'text', target: dom.firstElementChild as HTMLElement };
    },
    update: next => next.type === node.type,
  });
}

/** Definition punctuation is the unparser's frame around its editable fields. Showing that
 * frame does not make it part of the field, and the view never needs a spelling attribute. */
class DefinitionFieldView implements NodeView {
  readonly dom: HTMLElement;
  readonly contentDOM: HTMLElement;
  private readonly opening: HTMLElement;
  private readonly closing: HTMLElement;
  private readonly footnote: boolean;
  private readonly role: 'head' | 'destination' | 'title';
  private readonly base: string;

  constructor(
    readonly node: Node,
    readonly view: EditorView,
    readonly getPos: () => number | undefined,
  ) {
    this.footnote = node.type === schema.nodes.footnoteLabel;
    this.role = 'title';
    if (node.type === schema.nodes.linkLabel) this.role = 'head';
    else if (node.type === schema.nodes.linkDestination) this.role = 'destination';
    this.base = this.footnote ? 'footnote-definition' : 'link-definition';
    const document = view.dom.ownerDocument;
    this.dom = document.createElement('span');
    const role = this.footnote ? 'head' : this.role;
    this.dom.className = `md-${this.base}-${role}`;
    this.dom.setAttribute(`data-${this.base}-${role}`, '');
    const opening = this.role === 'head' ? 'prefix' : 'open';
    const closing = this.role === 'head' ? 'suffix' : 'close';
    this.opening = this.shell(this.footnote ? 'prefix' : `${this.role}-${opening}`);
    this.closing = this.shell(this.footnote ? 'suffix' : `${this.role}-${closing}`);
    this.contentDOM = document.createElement('span');
    const content = this.footnote ? 'identifier' : `${this.role}-content`;
    this.contentDOM.className = `md-${this.base}-${content}`;
    this.contentDOM.setAttribute(`data-${this.base}-${content}`, '');
    this.dom.append(this.opening, this.contentDOM, this.closing);
    this.render();
  }

  private shell(name: string): HTMLElement {
    const dom = this.view.dom.ownerDocument.createElement('span');
    dom.className = `md-${this.base}-${name} md-link-definition-shell`;
    dom.setAttribute(`data-${this.base}-${name}`, '');
    dom.setAttribute('contenteditable', 'false');
    return dom;
  }

  private render(): void {
    const position = this.getPos();
    if (position === undefined) return;
    if (this.footnote || this.role === 'head') {
      this.opening.textContent = this.footnote ? '[^' : '[';
      this.closing.textContent = ']:';
    } else {
      const at = this.view.state.doc.resolve(position);
      const frame = definitionFrames(at.parent)[at.index()]!;
      this.opening.textContent = frame.before;
      this.closing.textContent = frame.after;
      if (this.role === 'destination') {
        this.dom.setAttribute('data-link-definition-wrapper', frame.after === '>' ? 'angle' : 'bare');
      }
    }
  }

  update(node: Node): boolean {
    if (node.type !== this.node.type) return false;
    this.render();
    return true;
  }

  ignoreMutation(mutation: ViewMutationRecord): boolean {
    return mutation.type !== 'selection' && !this.contentDOM.contains(mutation.target);
  }
}
