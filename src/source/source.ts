/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  BulletListSyntax, OrderedListSyntax, parseFile,
  type ReferenceLabels, type BlockSyntax, type DocumentSyntax, type FrontMatterSyntax, type VirtualFile,
} from '../syntax/index.js';
import type { Node, Schema } from 'prosemirror-model';
import { Plugin, PluginKey, type EditorState, type EditorStateConfig, type Transaction } from 'prosemirror-state';
import { Mapping, type Step } from 'prosemirror-transform';
import { parse } from '../parse/parse.js';
import { readBody } from '../parse/edges.js';
import { Closing } from '../unparse/unparsed.js';
import { schema } from '../types/schema.js';
import type { EditorLoc, SourceLoc } from './location.js';
import { SourceMap } from './map.js';
import { RetainedBlock, RetainedDoc, RetainedList } from './retained.js';
import { Sequence } from './sequence.js';
import { sweep } from './sweep.js';

/** The immutable physical conventions of a file. */
export type FileProperties = Readonly<Omit<VirtualFile, 'document' | 'text'>>;

/** A document and the original source from which it was read. */
interface InitializedDocument {
  readonly doc: Node;
  readonly source: Source;
  readonly readings: ReadonlyMap<Node, ReferenceLabels>;
}

/**
 * A state's source: the file as the document's units, current after every settled edit. An edit
 * is a dispatched transaction with the corrections appended to it; a document between them can be
 * one those corrections remove, so its transactions are kept until the state owner settles the
 * edit, and nothing is written for them.
 */
export class Source {
  private constructor(
    readonly doc: Node,
    readonly properties: FileProperties,
    /** Current after every settled edit; never computed on reading. */
    readonly tree: RetainedDoc,
    private readonly revision: object,
    private readonly edits: readonly Transaction[],
  ) {}

  static create(doc: Node, properties: FileProperties, tree: RetainedDoc): Source {
    return new Source(doc, properties, tree, {}, []);
  }

  /** The source of a document that has no file, written once. */
  static write(doc: Node, properties: FileProperties): Source {
    return Source.create(doc, properties, sweep.write(doc, properties).tree);
  }

  /** Whether every transaction of the edit has been swept. */
  get settled(): boolean { return !this.edits.length; }

  get length(): number {
    this.checkSettled();
    return this.tree.length;
  }

  /** Keep a document-changing transaction for the edit's settlement. */
  update(tr: Transaction): Source {
    return tr.docChanged ? new Source(this.doc, this.properties, this.tree, this.revision, this.edits.concat(tr))
      : this;
  }

  /** Sweep the edit's transactions together ([the sweep](private-docs/design/propagation.md)). */
  settle(): Source {
    if (this.settled) return this;
    const mapping = new Mapping();
    const steps: Step[] = [];
    for (const tr of this.edits) {
      mapping.appendMapping(tr.mapping);
      steps.push(...tr.steps);
    }
    const doc = this.edits[this.edits.length - 1]!.doc;
    const swept = sweep(this, doc, steps, mapping);
    return new Source(doc, this.properties, swept.tree, swept.textChanged ? {} : this.revision, []);
  }

  /** Whether no edit between the two changed the file's text. */
  sameText(other: Source): boolean { return this.revision === other.revision; }

  /** The file: its parts in order. Decides nothing. */
  text(): string {
    this.checkSettled();
    return this.tree.text();
  }

  /** Expensive, and for the outside only (private-docs/concepts/near-red-green.md). */
  sourceToEditor(location: SourceLoc): EditorLoc {
    this.checkSettled();
    return new SourceMap(this.tree).sourceToEditor(location);
  }

  /** Expensive, and for the outside only (private-docs/concepts/near-red-green.md). */
  editorToSource(location: EditorLoc): SourceLoc {
    this.checkSettled();
    return new SourceMap(this.tree).editorToSource(location);
  }

  private checkSettled(): void {
    if (!this.settled) throw new RangeError('The source is read before its edit is settled');
  }
}

const sourceKey = new PluginKey<Source>('source');

/** Install the source as a field updated by native transactions. */
export function source(): Plugin<Source> {
  return new Plugin({
    key: sourceKey,
    state: {
      init(config) {
        const initial = (config as source.Config).source;
        if (!initial) throw new RangeError('The state needs its initial source');
        return initial;
      },
      apply: (tr, previous) => tr.getMeta(sourceKey) ? previous.settle() : previous.update(tr),
    },
  });
}

export namespace source {
  /** The original file accompanies its parsed document through native state initialization. */
  export interface Config extends EditorStateConfig { readonly source: Source; }

  /**
   * Settle the source once every correction of an edit has run. Correction hooks run in
   * rounds and only the state owner knows when the last has run, so it settles the source after
   * the native loop, as `history.finish` closes the edit's event.
   */
  export function settle(state: EditorState): EditorState {
    if (get(state).settled) return state;
    const settled = state.apply(state.tr.setMeta(sourceKey, true).setMeta('addToHistory', false));
    if (!get(settled).settled) throw new RangeError('The document changed while its edit was settled');
    return settled;
  }

  /** Read the source field of an editor state. */
  export function get(state: EditorState): Source {
    const value = sourceKey.getState(state);
    if (!value) throw new RangeError('The state has no source');
    return value;
  }
}

/** Read a file once, constructing its editor nodes and retained units together. */
export function read(markdown: string): InitializedDocument {
  const file = parseFile(markdown, { target: 'editor' });
  return read.syntax(file.document, file.text, schema, Object.freeze({
    byteOrderMark: file.byteOrderMark,
    lineEnding: file.lineEnding,
    endsWithLineEnding: file.endsWithLineEnding,
  }));
}

export namespace read {
  /** Construct source and editor content from an existing file reading. */
  export function syntax(syntax: DocumentSyntax, text: string, schema: Schema,
    properties: FileProperties): InitializedDocument {
    return new ReadContext(text, schema).document(syntax, properties);
  }
}

/** The paired source and editor construction shares the syntax's ownership cuts. */
class ReadContext {
  constructor(readonly text: string, readonly schema: Schema) {}

  document(syntax: DocumentSyntax, properties: FileProperties): InitializedDocument {
    const fields = new Map<Node, ReferenceLabels>();
    const readings: (BlockSyntax | FrontMatterSyntax | null)[] = [];
    const children: Node[] = [];
    if (syntax.frontMatter) {
      readings.push(syntax.frontMatter);
      children.push(parse.frontMatter(syntax.frontMatter, this.schema));
    }
    for (const block of syntax.children) {
      readings.push(block);
      children.push(parse.block(block, this.text, this.schema, fields));
    }
    if (!syntax.children.length) {
      readings.push(null);
      children.push(this.schema.nodes.paragraph.createChecked());
    }
    const doc = parse.node(syntax, children, this.schema);
    const units: (RetainedBlock | RetainedList)[] = [];
    for (let element = 0; element < readings.length; element++) {
      const block = readings[element]!;
      const node = children[element]!;
      units.push(block instanceof BulletListSyntax || block instanceof OrderedListSyntax
        ? this.list(block, node) : this.block(block, node));
    }
    const from = syntax.firstChild?.start ?? syntax.end - syntax.trailing;
    const to = syntax.lastChild?.end ?? from;
    const tree = new RetainedDoc(this.text.slice(0, from), Sequence.of(units), this.text.slice(to));
    const source = Source.create(doc, properties, tree);
    return { doc, source, readings: fields };
  }

  list(syntax: BulletListSyntax | OrderedListSyntax, node: Node): RetainedList {
    const from = syntax.firstChild?.start ?? syntax.end;
    const to = syntax.lastChild?.end ?? from;
    const items: RetainedBlock[] = [];
    for (let item = 0; item < syntax.children.length; item++) {
      const reading = syntax.children[item]!;
      const body = readBody(reading, this.text, syntax.spelling.pattern);
      items.push(new RetainedBlock(node.child(item), this.text.slice(reading.start, reading.bodyStart), body.body,
        this.text.slice(reading.bodyEnd, reading.end), body.opening, body.closing));
    }
    return new RetainedList(node, this.text.slice(syntax.start, from), Sequence.of(items),
      this.text.slice(to, syntax.end));
  }

  block(syntax: BlockSyntax | FrontMatterSyntax | null, node: Node): RetainedBlock {
    const body = syntax ? readBody(syntax, this.text) : { body: '', opening: null, closing: Closing.none };
    return new RetainedBlock(node, syntax ? this.text.slice(syntax.start, syntax.bodyStart) : '', body.body,
      syntax ? this.text.slice(syntax.bodyEnd, syntax.end) : '', body.opening, body.closing);
  }
}
