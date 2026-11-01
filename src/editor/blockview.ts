/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { DOMNode } from './dom.js';
import { schema } from '../types/schema.js';
import { DOMSerializer, type Node, type Schema } from 'prosemirror-model';
import { Plugin } from 'prosemirror-state';
import type { EditorView, NodeView, NodeViewConstructor } from 'prosemirror-view';
import type { SelectableBlock } from '../state/selection.js';

/** The DOM roles owned by a native node view, read after its children are mounted. */
export interface BlockView extends NodeView {
  readonly box?: HTMLElement;
  readonly content?: HTMLElement;
  readonly field?: HTMLElement;
  readonly handle?: HandleTarget;
  readonly sequence?: ChildSequence;
  readonly selectionTarget?: HTMLElement;
  readonly markerLane?: HTMLElement;
  readonly brush?: boolean;
}

export interface HandleTarget {
  readonly kind: 'text' | 'box' | 'child';
  readonly target: HTMLElement;
}

export interface ChildSequence {
  readonly content: HTMLElement;
  readonly trailing: HTMLElement;
}

interface ViewDOM extends HTMLElement { kagamiView?: BlockView; }

/** Read the native view that declared this DOM, including its child sequence. */
export function nodeView(dom: DOMNode): BlockView | undefined {
  return (dom as ViewDOM).kagamiView;
}

/** The DOM links to its owner, as it does to ProseMirror's view description. */
export function registerNodeView<T extends BlockView>(view: T): T {
  (view.dom as ViewDOM).kagamiView = view;
  if (view.sequence) (view.sequence.content as ViewDOM).kagamiView = view;
  return view;
}

/** Block frames advertise their measurable box before ProseMirror mounts their children. */
export function registerBlockView<T extends BlockView>(node: Node, view: T): T {
  view.dom.dataset.blockBox = node.type.name;
  return registerNodeView(view);
}

/** A schema-rendered block frame that keeps its editable DOM across source-attribute changes. */
function simpleView(node: Node, document: Document): BlockView {
  const output = DOMSerializer.renderSpec(document, node.type.spec.toDOM!(node));
  const rendered = output.dom as HTMLElement;
  let dom = rendered;
  let contentDOM = output.contentDOM as HTMLElement | undefined;
  if (node.type === schema.nodes.blockQuote) {
    contentDOM = document.createElement('div');
    contentDOM.className = 'md-quote-content';
    dom.append(contentDOM);
  } else if (node.type === schema.nodes.thematicBreak) {
    const frame = document.createElement('div');
    frame.className = 'md-divider';
    frame.append(dom);
    dom = frame;
  }
  return {
    dom,
    contentDOM,
    box: dom,
    content: node.type === schema.nodes.blockQuote ? contentDOM : dom,
    brush: node.type === schema.nodes.blockQuote,
    get handle(): HandleTarget | undefined {
      if (node.type === schema.nodes.blockQuote) return { kind: 'child', target: contentDOM! };
      if (node.type === schema.nodes.thematicBreak) return { kind: 'box', target: rendered };
      return undefined;
    },
    update(next) {
      return (
        next.type === node.type &&
        (next.type !== schema.nodes.heading || next.attrs.level === node.attrs.level)
      );
    },
  };
}

/** Owned frames for every block. Installed after the plugins with views of their own: the view
 * a plugin earlier in the list gives a node is the one ProseMirror uses. */
export function blockView(documentSchema: Schema): Plugin {
  const nodeViews: Record<string, NodeViewConstructor> = {};
  for (const type of Object.values(documentSchema.nodes)) {
    if (type.isInGroup('list')) continue;
    if (type !== documentSchema.nodes.listItem && type !== documentSchema.nodes.frontmatterSource &&
        !type.isInGroup('block'))
      continue;
    nodeViews[type.name] = (node, view) => registerBlockView(node, simpleView(node, view.dom.ownerDocument));
  }
  return new Plugin({ props: { nodeViews } });
}

/** The visible border box declared by a block's node view. */
export function measureBlockBox(view: EditorView, block: SelectableBlock): DOMRect | undefined {
  const dom = view.nodeDOM(block.from);
  const layout = dom && nodeView(dom);
  if (!layout?.box) return;
  const rect = layout.box.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 ? rect : undefined;
}
