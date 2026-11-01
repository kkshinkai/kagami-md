/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  BlockSyntax, CalloutDeclarationSyntax, CalloutSyntax, CodeBlockSyntax, LinkReferenceDefinitionSyntax,
  LinkTitleStartSyntax, MathBlockSyntax, TaskMarkerSyntax, parseBlocks, type Transduction,
} from '../syntax/index.js';
import { Fragment, type Node } from 'prosemirror-model';
import { TextSelection, type Transaction } from 'prosemirror-state';
import { readBindings, type BindingSet } from '../parse/bindings.js';
import { fieldSource } from '../parse/field.js';
import { keepOuterFrames } from '../transform/frames.js';
import {
  definitionReading, definitionShapes, quoteReading, readingShapes,
  type ReadingShapes
} from '../transform/reading.js';
import { reshapeBlocks } from '../transform/reshape.js';
import { insert, keptShape, realize, update, type Shape } from '../transform/transform.js';
import { phrasing } from './correction.js';
import { setContent } from './field.js';
import { meaning } from './meaning.js';
import { mapTextSelection } from './selection.js';

/** Settle a field's block reading, then place its selection on the retained authored text. */
export function replaceParagraph(tr: Transaction, position: number, node: Node, text: string,
                                 blocks: BlockSyntax[], trailingBreak = false): void {
  new BlockSettlement(tr, position, node, text, blocks, trailingBreak).apply();
}

/** A replacement shares its old field and reading through shape and selection conversion. */
class BlockSettlement {
  constructor(readonly tr: Transaction, readonly position: number, readonly node: Node, readonly text: string,
              readonly blocks: readonly BlockSyntax[], readonly trailingBreak = false) {}

  apply(): void {
    if (!this.blocks.length) return;
    const { tr, position, node, text, blocks } = this;
    if (node.isTextblock && node.type !== tr.doc.type.schema.nodes.heading) {
      this.realize();
      return;
    }
    const authored = new Map<Shape, Node>();
    this.reshape(readingShapes(blocks, text, tr.doc.type.schema, [{ start: 0, end: text.length, origin: position + 1 }],
      authored), authored);
  }

  realize(): void {
    const { tr, position, node, text, blocks } = this;
    const start = tr.steps.length;
    mapTextSelection(tr, range => realize(tr, position, blocks, text, 0, range));
    if (!this.retainsBreak()) return;
    const end = tr.mapping.slice(start).map(position + node.nodeSize, 1);
    const types = tr.doc.type.schema.nodes;
    if (tr.doc.resolve(end).nodeBefore?.type === types.paragraph) tr.insert(end - 1, types.lineEnding.create());
    else insert(tr, end, types.paragraph, {});
    tr.setSelection(TextSelection.near(tr.doc.resolve(end + 1), -1));
  }

  reshape(reading: ReadingShapes, authored: Map<Shape, Node>): void {
    if (!reading.shapes.length) return;
    const { tr, position, node, text } = this;
    const selection = tr.selection;
    const parsedSize = reading.shapes.reduce((size, shape) => size + authored.get(shape)!.nodeSize, 0);
    const inside = selection instanceof TextSelection && selection.from >= position + 1 &&
      selection.to <= position + node.nodeSize - 1;
    const anchor = inside ? reading.input(selection.anchor) : null;
    const head = inside ? reading.input(selection.head) : null;
    const shapes = [...reading.shapes];
    this.heading(shapes, authored);
    const retainsBreak = this.retainsBreak();
    const extra = retainsBreak ? this.appendBreak(shapes, authored) : 0;
    const start = tr.steps.length;
    const originalSize = tr.doc.content.size;
    keepOuterFrames(shapes, node, authored);
    mapTextSelection(tr, range => reshapeBlocks(tr, position, position + node.nodeSize, shapes, authored, range).map);
    if (anchor === null || head === null) return;
    if (retainsBreak && anchor === text.length && head === text.length) {
      tr.setSelection(TextSelection.near(tr.doc.resolve(tr.mapping.slice(start).map(position + node.nodeSize, 1)), -1));
    } else if (tr.doc.content.size === originalSize - node.nodeSize + parsedSize + extra) {
      tr.setSelection(TextSelection.between(tr.doc.resolve(position + reading.locate(anchor)),
        tr.doc.resolve(position + reading.locate(head))));
    }
  }

  heading(shapes: Shape[], authored: Map<Shape, Node>): void {
    const first = shapes[0];
    const types = this.tr.doc.type.schema.nodes;
    if (this.node.type !== types.heading || first.type !== types.paragraph) return;
    const heading: Shape = { ...first, type: types.heading, meaning: meaning(this.node), read: undefined };
    const content = authored.get(first)!.content;
    authored.delete(first);
    authored.set(heading, this.node.type.createChecked(this.node.attrs, content));
    shapes[0] = heading;
  }

  appendBreak(shapes: Shape[], authored: Map<Shape, Node>): number {
    const last = shapes.at(-1)!;
    const types = this.tr.doc.type.schema.nodes;
    if (last.kind !== 'text' || last.type !== types.paragraph) {
      shapes.push({ kind: 'text', type: types.paragraph, meaning: {}, text: [] });
      return 2;
    }
    const from = this.position + this.node.content.size;
    const reading = authored.get(last)!;
    const extended: Shape = { ...last, text: [...last.text, { kind: 'range', from, to: from + 1 }] };
    authored.delete(last);
    authored.set(extended, reading.copy(reading.content.append(Fragment.from(types.lineEnding.create()))));
    shapes[shapes.length - 1] = extended;
    return 1;
  }

  retainsBreak(): boolean {
    const last = this.blocks.at(-1);
    return this.trailingBreak && !!last && endsBeforeBreak(last, this.text.length);
  }
}

/** A container's final line ending can belong to its last descendant's framing. */
function endsBeforeBreak(block: BlockSyntax, end: number): boolean {
  return block.resolve(end - 1).contentEnd < end ||
    (block instanceof CodeBlockSyntax || block instanceof MathBlockSyntax) && block.content === '';
}

/** Re-read definition frames after their fields have established their string meaning. */
export function rereadDefinition(tr: Transaction, position: number, bindings: BindingSet,
  blurred: boolean): phrasing.Update | null {
  const node = tr.doc.nodeAt(position);
  if (!node?.firstChild) return null;
  // The keys rule keeps an empty label while the user is still editing it.
  // B3d item 1 applies the same waiting period to a footnote's label.
  if (!blurred && tr.selection.$head.parent === node.firstChild && !fieldSource(node.firstChild)) {
    if (node.attrs.identifier !== '') update(tr, position, { identifier: '' });
    return null;
  }
  const start = tr.steps.length;
  const reading = definitionReading(tr, position, bindings);
  if (!reading) {
    refreshDefinitionMeaning(tr, position);
    return null;
  }
  const authored = new Map<Shape, Node>();
  const retained = new Set<Node>();
  const mapped = definitionShapes(reading, tr.doc.type.schema, authored);
  if (node.type === tr.doc.type.schema.nodes.footnoteDefinition) {
    keepOuterFrames(mapped.shapes, node, authored);
    const firstKept = node.child(1).type === tr.doc.type.schema.nodes.paragraph ? 2 : 1;
    node.forEach((child, offset, index) => {
      if (index < firstKept) return;
      mapped.shapes.push(keptShape(child, position + offset + 1, authored));
      retainPhrasings(child, retained);
    });
    const selection = tr.selection;
    const points = [selection.anchor, selection.head].map(point => {
      const origin = reading.origins.find(range => point >= range.origin &&
        point <= range.origin + range.end - range.start);
      return origin ? position + mapped.locate(origin.start + point - origin.origin) : null;
    });
    mapTextSelection(tr,
      range => reshapeBlocks(tr, position, position + node.nodeSize, mapped.shapes, authored, range).map);
    if (selection instanceof TextSelection && points.some(point => point !== null)) {
      tr.setSelection(TextSelection.between(tr.doc.resolve(points[0] ?? tr.selection.anchor),
        tr.doc.resolve(points[1] ?? tr.selection.head)));
    }
  } else new BlockSettlement(tr, position, node, reading.text, reading.blocks).reshape(mapped, authored);
  const changed = tr.mapping.slice(start);
  return { bindings: readBindings.blocks(reading.blocks, bindings),
    completed: phrasing.completed(tr.doc, changed.map(position, -1), changed.map(position + node.nodeSize, 1),
      retained) };
}

/** Replay restores the frame, while its current marked strings determine its meaning. */
export function refreshDefinitionMeaning(tr: Transaction, position: number): void {
  const node = tr.doc.nodeAt(position)!;
  const identifier: string = node.attrs.identifier;
  const types = node.type.schema.nodes;
  if (node.type === types.footnoteDefinition) update(tr, position, { identifier });
  else if (node.type === types.linkReferenceDefinition) update(tr, position, {
    identifier, destination: stringMeaning(node.child(1)),
    title: node.childCount === 3 ? stringMeaning(node.child(2)) : null,
  });
  else throw new RangeError('Expected a definition frame');
}

/** Read semantic characters from the marks already produced by string transduction. */
function stringMeaning(node: Node): string {
  let value = '';
  let entity: number | null = null;
  const { nodes, marks } = node.type.schema;
  node.forEach(piece => {
    const reference = piece.marks.find(mark => mark.type === marks.characterReference);
    if (reference) {
      if (entity !== reference.attrs.occurrence) value += reference.attrs.character;
      entity = reference.attrs.occurrence;
    } else {
      entity = null;
      if (piece.type === nodes.lineEnding) value += '\n';
      else if (!piece.marks.some(mark => mark.type === marks.meta)) value += piece.text!;
    }
  });
  return value;
}

/** A field reading whose opening can change its enclosing frame. */
type ConditionalReading = Exclude<Transduction, { kind: 'blocks' }>;

/** Apply syntax whose meaning depends on the field's enclosing frame. */
export function conditional(tr: Transaction, position: number, reading: ConditionalReading,
  bindings: BindingSet): phrasing.Update | null {
  const field = tr.doc.resolve(position + 1);
  const types = tr.doc.type.schema.nodes;
  if (field.depth < 2) return null;
  // The field reader recognizes these only at its opening, possibly after
  // whitespace. Those leading characters are taken with the construct.
  const first = reading.children.find(child => child instanceof TaskMarkerSyntax ||
    child instanceof CalloutDeclarationSyntax);
  const context = new ConditionalSettlement(tr, position, reading, bindings);
  if (first instanceof TaskMarkerSyntax && field.node(-1).type === types.listItem) return context.task(first);
  if (first instanceof CalloutDeclarationSyntax && field.node(-1).type === types.blockQuote)
    return context.callout(first);
  const last = reading.children.at(-1);
  return last instanceof LinkTitleStartSyntax && field.parent.type === types.linkDestination
    ? context.title(last) : null;
}

/** Conditional readings share the same source coordinates and binding environment. */
class ConditionalSettlement {
  constructor(readonly tr: Transaction, readonly position: number, readonly reading: ConditionalReading,
    readonly bindings: BindingSet) {}

  task(marker: TaskMarkerSyntax): phrasing.Update {
    const { tr, position, reading, bindings } = this;
    const field = tr.doc.resolve(position + 1);
    const text = fieldSource(field.parent);
    const next = reading.children[reading.children.indexOf(marker) + 1]?.start ?? text.length;
    tr.insertText('', position + 1, position + next + 1);
    update(tr, field.before(field.depth - 1), { checked: marker.checked });
    setContent(tr, position, reading.frontier.filter(piece => piece.start >= next), text, reading.references, next);
    return { bindings, completed: new Set([tr.doc.nodeAt(position)!]) };
  }

  callout(marker: CalloutDeclarationSyntax): phrasing.Update {
    const { tr, position, bindings } = this;
    const field = tr.doc.resolve(position + 1);
    const container = field.before(field.depth - 1);
    if (marker.start) tr.insertText('', position + 1, position + marker.start + 1);
    const quote = tr.doc.nodeAt(container);
    if (!quote) throw new RangeError('The callout declaration lost its quote');
    // The authored first field is read in quote context. Its origin is already
    // known; later body blocks remain native ranges in the reshape.
    const { text, blocks, origins } = quoteReading(quote, fieldSource(quote.child(0)), container + 2, bindings);
    if (!(blocks[0] instanceof CalloutSyntax)) throw new RangeError('The declaration must read as a callout');
    const authored = new Map<Shape, Node>();
    const mapped = readingShapes(blocks, text, tr.doc.type.schema, origins, authored);
    const shape = mapped.shapes[0];
    if (!shape || shape.kind !== 'children') throw new RangeError('A callout must have children');
    const children = [...shape.children];
    const retained = new Set<Node>();
    quote.forEach((child, offset, index) => {
      if (!index) return;
      children.push(keptShape(child, container + offset + 1, authored));
      retainPhrasings(child, retained);
    });
    // The old quote supplies the shared outer frame. Its read title and body
    // retain their already-computed content through the same authored map.
    authored.delete(shape);
    mapTextSelection(tr,
      range => reshapeBlocks(tr, container, container + quote.nodeSize, [{ ...shape, children }], authored, range).map);
    return { bindings: readBindings.blocks(blocks, bindings),
      completed: phrasing.completed(tr.doc, container, container + tr.doc.nodeAt(container)!.nodeSize, retained) };
  }

  title(marker: LinkTitleStartSyntax): phrasing.Update {
    const { tr, position, reading, bindings } = this;
    const field = tr.doc.resolve(position + 1);
    const definition = field.node(-1);
    const text = fieldSource(field.parent);
    const delimiter = marker.delimiter ? text.slice(marker.delimiter.start, marker.delimiter.end) : '"';
    // Complete the recognized opening in source, then take the field from the
    // reader. Commands supply a reading, never a constructed syntax node.
    const source = '[r]: /u ' + delimiter + (delimiter === '(' ? ')' : delimiter);
    const parsed = parseBlocks(source, { target: 'editor' }, bindings)[0];
    if (!(parsed instanceof LinkReferenceDefinitionSyntax) || !parsed.titleField)
      throw new RangeError('The title opening must read as a title');
    tr.insertText('', position + marker.start + 1, position + marker.end + 1);
    setContent(tr, position, reading.frontier.filter(piece => piece.end <= marker.start), text, reading.references);
    const destination = tr.doc.nodeAt(position);
    if (!destination) throw new RangeError('Missing destination');
    const titlePosition = position + destination.nodeSize;
    if (definition.childCount === 2)
      insert(tr, titlePosition, tr.doc.type.schema.nodes.linkTitle, {}, Fragment.empty, parsed.titleField);
    tr.setSelection(TextSelection.near(tr.doc.resolve(titlePosition + 1)));
    return { bindings, completed: new Set([tr.doc.nodeAt(position)!]) };
  }
}

/** Native fields kept by a reshape retain their previous reading. */
function retainPhrasings(node: Node, retained: Set<Node>): void {
  if (node.type.isInGroup('field')) retained.add(node);
  node.descendants(child => {
    if (child.type.isInGroup('field')) retained.add(child);
    return !child.isTextblock;
  });
}
