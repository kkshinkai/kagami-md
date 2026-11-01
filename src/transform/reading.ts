/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  BlockSyntax, BlockQuoteSyntax, FootnoteDefinitionSyntax, HTMLTagBlockSyntax, InlineFieldClauseSyntax,
  ListItemSyntax, LiteralBlockSyntax, ParagraphSyntax, StringFieldClauseSyntax, TableCellSyntax, TableSyntax,
  TextBlockSyntax, isFootnoteLabel, isLinkDestination, isLinkLabel, isLinkTitle, parseBlocks, type Bindings,
} from '../syntax/index.js';
import { Fragment, type Node, type Schema } from 'prosemirror-model';
import type { Transform } from 'prosemirror-transform';
import { fieldSource } from '../parse/field.js';
import { parse } from '../parse/parse.js';
import {
  children, Correspondence, frontierPieces, sourcePieces, type Relabeled,
  type SourcePiece
} from '../parse/tree.js';
import { indentation, quoteMarker } from '../unparse/frames.js';
import { setAttributes } from './frames.js';
import type { Shape } from './transform.js';

/** A reading and the original editor ranges of its authored fields. */
interface Reading {
  text: string;
  blocks: BlockSyntax[];
  origins: Origin[];
}
interface Origin {
  start: number;
  end: number;
  origin: number;
}
interface Field {
  reading: Correspondence;
  node: Node;
  at: number;
  pieces: readonly SourcePiece[];
}
interface ReadNode {
  shape: Shape;
  node: Node;
  fields: Field[];
}
interface AuthoredField {
  text: string;
  origin: number;
}
interface TitleField extends AuthoredField {
  delimiter: '"' | "'" | '(';
}

/** The structural shapes read from source and their coordinate conversion. */
export class ReadingShapes {
  constructor(readonly shapes: Shape[], private readonly fields: readonly Field[],
    private readonly origins: readonly Origin[]) {}

  input(position: number): number {
    const origin = this.origins.find(range => position >= range.origin &&
      position <= range.origin + range.end - range.start);
    if (origin) return origin.start + position - origin.origin;
    return position < (this.origins[0]?.origin ?? 0) ? 0 : this.origins.at(-1)?.end ?? 0;
  }

  locate(point: number): number {
    let previous = 0;
    for (const { reading, node, at, pieces } of this.fields) {
      if (reading.emptyAt !== null && point < reading.syntax.end) return at + 1;
      let position = at + 1;
      for (const piece of pieces) {
        if (point <= piece.start) return position;
        if (point === piece.end) return position + piece.length;
        if (point < piece.end) return position + (piece.end - piece.start === piece.length ? point - piece.start : 0);
        position += piece.length;
      }
      previous = at + 1 + node.content.size;
    }
    return previous;
  }
}

/** Keep valid definition fields in their frame; only invalid fields need a block reading. */
export function definitionReading(tr: Transform, position: number, bindings: Bindings): Reading | null {
  const node = tr.doc.nodeAt(position)!;
  const label = fieldSource(node.child(0));
  if (node.type === node.type.schema.nodes.footnoteDefinition) {
    if (isFootnoteLabel(label)) return null;
    const paragraph = node.child(1).type === node.type.schema.nodes.paragraph ? node.child(1) : null;
    const reading = readDefinitionLine(node, { text: '^' + label, origin: position + 1 },
      { text: paragraph ? fieldSource(paragraph) : '', origin: position + node.child(0).nodeSize + 2 }, null, bindings);
    // The caret is framing, not a character from the editor's label.
    reading.origins[0]!.start++;
    reading.origins[0]!.origin++;
    if (!paragraph) reading.origins.pop();
    return reading;
  }
  const destination = fieldSource(node.child(1));
  const title = node.maybeChild(2);
  const preferred = title?.attrs.spelling?.delimiter ?? '"';
  const alternatives = ['"', "'", '('] as const;
  const titleText = title ? fieldSource(title) : null;
  const delimiter = titleText === null ? undefined : [preferred, ...alternatives.filter(value => value !== preferred)]
    .find(value => isLinkTitle(titleText, value));
  if (isLinkLabel(label) && isLinkDestination(destination, node.child(1).attrs.spelling?.inAngleBrackets) &&
      (!title || delimiter)) {
    if (title && delimiter !== preferred)
      setAttributes(tr, position + node.child(0).nodeSize + node.child(1).nodeSize + 1,
        { spelling: { ...title.attrs.spelling, delimiter } });
    return null;
  }
  const destinationOrigin = position + node.child(0).nodeSize + 2;
  return readDefinitionLine(node, { text: label, origin: position + 2 },
    { text: destination, origin: destinationOrigin },
    titleText === null
      ? null : {
        text: titleText, origin: destinationOrigin + node.child(1).nodeSize,
        delimiter: delimiter ?? preferred
      }, bindings);
}

/** Assemble authored fields with their recorded framing (B3e item 1, B3i item 1). */
function readDefinitionLine(node: Node, label: AuthoredField, destination: AuthoredField, title: TitleField | null,
  bindings: Bindings): Reading {
  const field = node.child(1);
  const angle = field.type === node.type.schema.nodes.linkDestination && field.attrs.spelling?.inAngleBrackets;
  let text = '[' + label.text + ']:' + (node.attrs.spelling?.whitespaceAfterLabel ?? ' ') + (angle ? '<' : '');
  const origins: Origin[] = [
    { start: 1, end: label.text.length + 1, origin: label.origin },
    { start: text.length, end: text.length + destination.text.length, origin: destination.origin },
  ];
  text += destination.text + (angle ? '>' : '');
  if (title) {
    text += (node.attrs.spelling?.whitespaceBeforeTitle ?? ' ') + title.delimiter;
    origins.push({ start: text.length, end: text.length + title.text.length, origin: title.origin });
    text += title.text + (title.delimiter === '(' ? ')' : title.delimiter);
  }
  return { text, blocks: parseBlocks(text, { target: 'editor' }, bindings), origins };
}

/** Read a declaration field with its quote's framing and its existing editor origin. */
export function quoteReading(node: Node, field: string, origin: number, bindings: Bindings): Reading {
  const margin = indentation(node);
  const marker = margin + quoteMarker(node.attrs.spelling?.whitespaceAfterMarker ?? ' ', margin.length);
  const origins: Origin[] = [];
  const lines = field.split('\n');
  let text = '';
  let offset = 0;
  for (let index = 0; index < lines.length; index++) {
    text += marker;
    const start = text.length;
    const value = lines[index]! + (index < lines.length - 1 ? '\n' : '');
    text += value;
    origins.push({ start, end: text.length, origin: origin + offset });
    offset += value.length;
  }
  return { text, blocks: parseBlocks(text, { target: 'editor' }, bindings), origins };
}

/**
 * A dissolved definition owns its former framing characters as paragraph input. What its reading
 * leaves out at the opening and terminal edges stays input, under those edges' own rules; an
 * interior gap is layout, such as continuation indentation, and leaves, as `setContent` has it.
 */
export function definitionShapes(reading: Reading, schema: Schema, authored: Map<Shape, Node>): ReadingShapes {
  const { blocks, text, origins } = reading;
  const paragraph = blocks[0];
  if (blocks.length !== 1 || !(paragraph instanceof ParagraphSyntax))
    return readingShapes(blocks, text, schema, origins, authored);
  const frontier = paragraph.frontier;
  const parsed = parse.content(frontier, text, schema);
  const read = frontierPieces(frontier, paragraph.contentStart);
  const first = read[0]!;
  const last = read[read.length - 1]!;
  const opening = text.slice(0, first.start);
  const terminal = text.slice(last.end);
  const content = inputContent(opening, schema).append(parsed).append(inputContent(terminal, schema));
  const pieces: SourcePiece[] = [{ start: 0, end: first.start, length: opening.length }, ...read,
    { start: last.end, end: text.length, length: terminal.length }];
  const node = parse.node(paragraph, content, schema);
  const correspondence = new Correspondence(paragraph);
  const converted = new ReadContext(text, schema, origins, authored).text(node, correspondence, paragraph, pieces, 0);
  return new ReadingShapes([converted.shape], converted.fields, origins);
}

function inputContent(text: string, schema: Schema): Fragment {
  const nodes: Node[] = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index++) {
    if (index) nodes.push(schema.nodes.lineEnding.createChecked());
    if (lines[index]) nodes.push(schema.text(lines[index]!));
  }
  return Fragment.fromArray(nodes);
}

/** Build shapes and source correspondence in one traversal of the reader's blocks. */
export function readingShapes(readings: readonly BlockSyntax[], text: string, schema: Schema,
                              origins: readonly Origin[], authored: Map<Shape, Node>): ReadingShapes {
  return new ReadContext(text, schema, origins, authored).readAll(readings);
}

/** Shared source and authored nodes for one structural reading. */
class ReadContext {
  constructor(readonly source: string, readonly schema: Schema, readonly origins: readonly Origin[],
    readonly authored: Map<Shape, Node>) {}

  readAll(readings: readonly BlockSyntax[]): ReadingShapes {
    const shapes: Shape[] = [];
    const fields: Field[] = [];
    let position = 0;
    for (const reading of readings) {
      const result = this.read(reading, position, false);
      shapes.push(result.shape);
      fields.push(...result.fields);
      position += result.node.nodeSize;
    }
    return new ReadingShapes(shapes, fields, this.origins);
  }

  read(syntax: Relabeled, at: number, header: boolean): ReadNode {
    const { source, schema } = this;
    const reading = new Correspondence(syntax);
    if (syntax instanceof TextBlockSyntax || syntax instanceof InlineFieldClauseSyntax ||
        syntax instanceof StringFieldClauseSyntax) {
      const frontier = syntax.frontier;
      const content = parse.content(frontier, source, schema);
      const pieces = frontierPieces(frontier, syntax.contentStart);
      if (syntax instanceof TableCellSyntax) {
        const paragraph = schema.nodes.tableParagraph.createChecked(null, content);
        const inner = this.text(paragraph, reading, undefined, pieces, at + 1);
        const node = (header ? schema.nodes.tableHeader : schema.nodes.tableCell).createChecked(null, paragraph);
        return { shape: this.container(node, header ? undefined : syntax, [inner.shape]), node, fields: inner.fields };
      }
      return this.text(parse.node(syntax, content, schema), reading, syntax, pieces, at);
    }
    if (syntax instanceof HTMLTagBlockSyntax) {
      const frontier = syntax.tag.frontier;
      const text = frontier.map(piece => piece.nodes.at(-1)?.type === 'lineEnding'
        ? '\n' : source.slice(piece.start, piece.end)).join('');
      return this.text(parse.node(syntax, this.literal(text), schema), reading, syntax,
        frontierPieces(frontier, syntax.tag.start), at);
    }
    if (syntax instanceof LiteralBlockSyntax)
      return this.text(parse.node(syntax, this.literal(syntax.content), schema), reading, syntax, sourcePieces(syntax)!,
        at);
    const nodes: Node[] = [];
    const shapes: Shape[] = [];
    const fields: Field[] = [];
    let offset = at + 1;
    let index = 0;
    for (const child of children(syntax)) {
      const result = this.read(child, offset, syntax instanceof TableSyntax ? index === 0 : header);
      nodes.push(result.node);
      shapes.push(result.shape);
      fields.push(...result.fields);
      offset += result.node.nodeSize;
      index++;
    }
    if ((syntax instanceof BlockQuoteSyntax || syntax instanceof ListItemSyntax ||
        syntax instanceof FootnoteDefinitionSyntax) && !syntax.children.length) {
      const point = syntax instanceof FootnoteDefinitionSyntax ? syntax.label.end : syntax.contentStart;
      const node = schema.nodes.paragraph.createChecked();
      const result = this.text(node, new Correspondence(syntax, point), undefined,
        [{ start: point, end: point, length: 0 }], offset);
      nodes.push(node);
      shapes.push(result.shape);
      fields.push(...result.fields);
    }
    const node = parse.node(syntax, nodes, schema);
    return { shape: this.container(node, syntax, shapes), node, fields };
  }

  literal(text: string): Fragment {
    return text ? Fragment.from(this.schema.text(text)) : Fragment.empty;
  }

  text(node: Node, reading: Correspondence, read: Relabeled | undefined, pieces: readonly SourcePiece[],
    at: number): ReadNode {
    const { spelling: _spelling, ...meaning } = node.attrs;
    const syntax = reading.syntax;
    const references = syntax instanceof TextBlockSyntax || syntax instanceof InlineFieldClauseSyntax ||
      syntax instanceof StringFieldClauseSyntax ? syntax.references : undefined;
    const shape: Shape = { kind: 'text', type: node.type, meaning, read, references, text: this.pieces(node, pieces) };
    this.authored.set(shape, node);
    return { shape, node, fields: [{ reading, node, at, pieces }] };
  }

  container(node: Node, read: Relabeled | undefined, children: Shape[]): Shape {
    const { spelling: _spelling, ...meaning } = node.attrs;
    const shape: Shape = { kind: 'children', type: node.type, meaning, read, children };
    this.authored.set(shape, node);
    return shape;
  }

  pieces(node: Node, pieces: readonly SourcePiece[]): Shape.Piece[] {
    const value = node.textBetween(0, node.content.size, '', '\n');
    const result: Shape.Piece[] = [];
    let offset = 0;
    for (const piece of pieces) {
      if (piece.end - piece.start !== piece.length)
        result.push({ kind: 'text', text: value.slice(offset, offset + piece.length) });
      else {
        let cursor = piece.start;
        for (const origin of this.origins) {
          const start = Math.max(piece.start, origin.start);
          const end = Math.min(piece.end, origin.end);
          if (end < start || end === start && piece.length > 0) continue;
          if (cursor < start)
            result.push({
              kind: 'text',
              text: value.slice(offset + cursor - piece.start, offset + start - piece.start)
            });
          result.push({
            kind: 'range', from: origin.origin + start - origin.start,
            to: origin.origin + end - origin.start
          });
          cursor = end;
        }
        if (cursor < piece.end)
          result.push({ kind: 'text', text: value.slice(offset + cursor - piece.start, offset + piece.length) });
      }
      offset += piece.length;
    }
    return result;
  }
}
