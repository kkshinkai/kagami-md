/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Node } from 'prosemirror-model';
import { TableCellSyntax, type Parser } from '../syntax/index.js';
import { children, Correspondence, type SourcePiece } from '../parse/tree.js';
import { writtenChildren, writtenFieldText, type unparse } from '../unparse/unparse.js';
import { fieldSource } from '../parse/field.js';
import type { EditorLoc, SourceLoc } from './location.js';
import { RetainedBlock, RetainedList, type RetainedDoc } from './retained.js';

/** A query-local address, obtained by summing widths down the sequence. */
interface Address {
  readonly block: RetainedBlock;
  readonly source: number;
  readonly editor: number;
  readonly item: boolean;
}
interface Located {
  readonly address: Address;
  readonly part: 'leading' | 'body' | 'trailing' | 'start' | 'end';
  readonly text: string;
  readonly inner: number;
}
/** A place the caret can stand, with its corresponding field text when it has any. */
interface Place { readonly start: number; readonly end: number; readonly editor: number; readonly length: number }

/** An outside query reads only the block holding its location. */
export class SourceMap {
  constructor(readonly tree: RetainedDoc, readonly options: unparse.Options,
    readonly parser: Parser) {}

  sourceToEditor(location: SourceLoc): EditorLoc {
    check(location, this.tree.length);
    const found = this.locate(location);
    const before = location ? this.locate(location - 1) : null;
    if (before && pair(before.text.charCodeAt(before.inner), found.text.charCodeAt(found.inner)))
      throw new RangeError('A location cannot split a surrogate pair');
    let previous: Unit | null = null;
    // The body's end can also end a field, before its final physical line ending or gap.
    if (before?.part === 'body' && before.inner === before.text.length - 1) {
      previous = this.read(before.address);
      const at = previous.inText(previous.toProbe(before.text.length));
      if (at !== null) return at as EditorLoc;
    }
    if (found.part === 'start' || found.part === 'leading')
      return caret(found.address.block.node, found.address.editor, false) as EditorLoc;
    if (found.part === 'end') return caret(found.address.block.node, found.address.editor, true) as EditorLoc;
    if (found.part === 'trailing') return this.after(found.address) as EditorLoc;
    const unit = previous && before!.address.block === found.address.block ? previous : this.read(found.address);
    const point = unit.toProbe(found.inner);
    return (unit.inText(point) ?? ownerPlace(unit, unit.reading, unit.node, unit.editor, point, unit.places) ??
      this.after(found.address)) as EditorLoc;
  }

  editorToSource(location: EditorLoc): SourceLoc {
    check(location, this.tree.size);
    const address = this.atEditor(location);
    const node = address.block.node;
    const unit = this.read(address);
    // Between units, or at a list's edge: where the unit after it begins; at the end, where the
    // unit before it ends.
    if (location <= address.editor) return unit.start as SourceLoc;
    if (location >= address.editor + node.nodeSize) return unit.end as SourceLoc;
    const resolved = node.resolve(location - address.editor - 1);
    if (resolved.parent.isTextblock) {
      const text = resolved.parent.textBetween(0, resolved.parent.content.size, '', '\n');
      const at = resolved.parentOffset;
      if (pair(text.charCodeAt(at - 1), text.charCodeAt(at)))
        throw new RangeError('A location cannot split a surrogate pair');
    }
    let reading = unit.reading;
    let current = node;
    for (let depth = 0; depth < resolved.depth; depth++) {
      const index = resolved.index(depth);
      reading = unit.children(reading, current)[index]!;
      current = current.child(index);
    }
    if (current.isTextblock) {
      const offset = Math.max(0, resolved.parentOffset - unit.trimmed(reading, current));
      const raw = unit.fromProbe(fromField(unit.fieldPieces(reading, current), offset, reading.range.start));
      return (unit.source + Math.min(unit.text.length, raw)) as SourceLoc;
    }
    const parts = unit.children(reading, current);
    const index = resolved.index(resolved.depth);
    let point = reading.range.start;
    if (index < parts.length) point = parts[index]!.range.start;
    else if (parts.length) point = parts.at(-1)!.range.end;
    return (unit.source + unit.fromProbe(point)) as SourceLoc;
  }

  private atEditor(position: number): Address {
    const found = this.tree.units.atEditor(position);
    const value = found.unit;
    const source = this.tree.leading.length + found.source;
    if (value instanceof RetainedBlock) return { block: value, source, editor: found.editor, item: false };
    const inner = Math.max(0, Math.min(value.items.size, position - found.editor - 1));
    const item = value.items.atEditor(inner);
    return { block: item.unit, source: source + value.leading.length + item.source,
      editor: found.editor + 1 + item.editor, item: true };
  }

  private locate(position: number): Located {
    const tree = this.tree;
    if (position < tree.leading.length)
      return { address: this.atEditor(0), part: 'start', text: tree.leading, inner: position };
    const end = tree.length - tree.trailing.length;
    if (position >= end)
      return { address: this.atEditor(tree.units.size), part: 'end', text: tree.trailing, inner: position - end };
    const found = tree.units.atSource(position - tree.leading.length);
    const value = found.unit;
    let address: Address;
    const start = tree.leading.length + found.source;
    if (value instanceof RetainedList) {
      const inner = position - start;
      if (inner < value.leading.length)
        return { address: this.atEditor(found.editor + 1), part: 'start', text: value.leading, inner };
      const end = value.length - value.trailing.length;
      if (inner >= end)
        return { address: this.atEditor(found.editor + value.size - 1), part: 'end',
          text: value.trailing, inner: inner - end };
      const item = value.items.atSource(inner - value.leading.length);
      address = { block: item.unit, source: start + value.leading.length + item.source,
        editor: found.editor + 1 + item.editor, item: true };
    } else address = { block: value, source: start, editor: found.editor, item: false };
    const block = address.block;
    const offset = position - address.source;
    if (offset < block.leading.length) return { address, part: 'leading', text: block.leading, inner: offset };
    const bodyEnd = block.leading.length + block.body.length;
    return offset < bodyEnd ? { address, part: 'body', text: block.body, inner: offset - block.leading.length } :
      { address, part: 'trailing', text: block.trailing, inner: offset - bodyEnd };
  }

  private read(address: Address): Unit {
    const block = address.block;
    const node = block.node;
    const types = node.type.schema.nodes;
    // The final physical ending is boundary text, but a literal body can end in a content
    // newline. Supply its actual terminator so reading does not consume that content newline.
    const text = block.body + (block.trailing.length ? '\n' : '');
    const emptyLabels = emptyLabelIndices(node, text, address.item, this.parser);
    let probe = text;
    for (let index = emptyLabels.length - 1; index >= 0; index--) {
      const at = emptyLabels[index]!;
      probe = probe.slice(0, at) + 'x' + probe.slice(at);
    }
    const source = address.source + block.leading.length;
    // The file's first unit reads with front matter. The mark keeps a first U+FEFF of the
    // body's text a character; parseFile excludes the supplied mark from its coordinates.
    const blocks = source === 0 ? []
      : this.parser.parseBlocks(probe);
    const file = blocks.length ? null
      : this.parser.parseFile('\ufeff' + probe).document;
    const roots = file?.frontMatter ? [file.frontMatter] : file?.children ?? blocks;
    const items = address.item && roots.length === 1 ? children(roots[0]!) : roots;
    if (file && !roots.length && !address.item && node.type === types.paragraph && !block.body.length)
      return new Unit(new Correspondence(file, file.start + file.leading), node, source, address.editor, this.options, text, []);
    if (roots.length !== 1 || items.length !== 1)
      throw new RangeError('A unit does not read alone as it does in the file');
    return new Unit(new Correspondence(items[0]!), node, source, address.editor, this.options, text, emptyLabels);
  }

  /** Boundary text points to the next caret in its owner, without reading a second unit. */
  private after(address: Address): number {
    const end = address.editor + address.block.size;
    const root = this.tree.units.atEditor(address.editor);
    if (address.item && end >= root.editor + root.unit.size - 1 || end >= this.tree.units.size)
      return caret(address.block.node, address.editor, true);
    const next = this.atEditor(end);
    return caret(next.block.node, next.editor, false);
  }
}

interface EmptyLabelTarget {
  readonly path: readonly number[];
  readonly kind: 'link' | 'footnote';
}

/** Locate active empty definition labels in a top-level or nested writing unit. */
function emptyLabelIndices(node: Node, text: string, item: boolean, parser: Parser): number[] {
  const targets: EmptyLabelTarget[] = [];
  collectEmptyLabelPaths(node, [], targets);
  if (!targets.length) return [];
  const parsed = targets.some(target => target.path.length > 0) ? parser.parseBlocks(text) : [];
  const results: number[] = [];
  let minOffset = 0;
  for (const target of targets) {
    let searchFrom = minOffset;
    if (target.path.length > 0 && parsed.length > 0) {
      let current = item && parsed.length === 1 ? children(parsed[0]!)[0] : parsed[0];
      for (const step of target.path) {
        if (!current) break;
        current = children(current)[step];
      }
      if (current && current.start > searchFrom) searchFrom = current.start;
    }
    if (target.kind === 'footnote') {
      const found = text.indexOf('[^]:', searchFrom);
      if (found >= 0) {
        results.push(found + 2);
        minOffset = found + 4;
      }
    } else {
      const found = text.indexOf('[]:', searchFrom);
      if (found >= 0) {
        results.push(found + 1);
        minOffset = found + 3;
      }
    }
  }
  return results;
}

function collectEmptyLabelPaths(node: Node, path: number[], targets: EmptyLabelTarget[]): void {
  const types = node.type.schema.nodes;
  if ((node.type === types.linkReferenceDefinition || node.type === types.footnoteDefinition) &&
      !fieldSource(node.firstChild!)) {
    const kind = node.type === types.footnoteDefinition ? 'footnote' : 'link';
    targets.push({ path: [...path], kind });
    return;
  }
  if (node.isTextblock) return;
  for (let index = 0; index < node.childCount; index++) {
    path.push(index);
    collectEmptyLabelPaths(node.child(index), path, targets);
    path.pop();
  }
}

/** The first or last editable place follows the editor node tree, not another unit's source. */
function caret(node: Node, at: number, last: boolean): number {
  while (!node.isTextblock && node.childCount) {
    if (last) {
      const child = node.lastChild!;
      at += node.nodeSize - 1 - child.nodeSize;
      node = child;
    } else {
      node = node.firstChild!;
      at++;
    }
  }
  return at + (node.isTextblock ? 1 + (last ? node.content.size : 0) : 0);
}

/** A unit read alone and the origin of its corresponding editor node. */
class Unit {
  private mapped: readonly Place[] | null = null;
  /** The readings of children the writing option left out: not in the file, they hold no source location. */
  private readonly omitted = new WeakSet<Correspondence>();

  constructor(readonly reading: Correspondence, readonly node: Node, readonly source: number,
    readonly editor: number, readonly options: unparse.Options, readonly text: string,
    readonly emptyLabels: readonly number[]) {}
  get start(): number { return this.source + this.fromProbe(this.reading.range.start); }
  get end(): number { return this.source + this.fromProbe(this.reading.range.end); }
  get places(): readonly Place[] {
    return this.mapped ??= places(this, this.reading, this.node, this.editor);
  }
  get first(): number { return this.places[0]!.editor; }
  get last(): number {
    const place = this.places.at(-1)!;
    return place.editor + place.length;
  }
  toProbe(inner: number): number {
    let shift = 0;
    for (const at of this.emptyLabels) {
      if (inner > at) shift++;
    }
    return inner + shift;
  }
  fromProbe(point: number): number {
    let shift = 0;
    for (let index = 0; index < this.emptyLabels.length; index++) {
      if (point > this.emptyLabels[index]! + index) shift++;
    }
    return point - shift;
  }
  fieldPieces(reading: Correspondence, node: Node): readonly SourcePiece[] {
    const types = node.type.schema.nodes;
    if (this.emptyLabels.length > 0 && (node.type === types.linkLabel || node.type === types.footnoteLabel) &&
        !fieldSource(node)) {
      const start = reading.pieces?.[0]?.start ?? this.emptyLabels[0]!;
      return [{ start, end: start, length: 0 }];
    }
    return reading.pieces ?? [];
  }
  /** Only a rewritten field loses its prefix; a retained field still starts with its spaces. */
  trimmed(reading: Correspondence, node: Node): number {
    const types = node.type.schema.nodes;
    if (this.options.keepStartingSpaceOrTab !== 'trim' ||
      node.type !== types.paragraph && node.type !== types.heading && node.type !== types.tableParagraph) return 0;
    const first = reading.pieces?.find(piece => piece.length);
    const character = first ? this.text.charCodeAt(first.start) : -1;
    if (character === 32 || character === 9) return 0;
    return fieldSource(node).length - writtenFieldText(node, this.options).length;
  }
  /**
   * Omitted children have no syntax node; their positions meet the next written child. The first
   * child with no syntax of its own, written or omitted, stands for the empty paragraph the
   * parent's syntax reads as when it holds no block.
   */
  children(reading: Correspondence, node: Node): Correspondence[] {
    const actual = children(reading.syntax);
    if (reading.emptyAt !== null || node.isTextblock || actual.length === node.childCount ||
      reading.syntax instanceof TableCellSyntax ||
      this.options.keepEmptyParagraph === 'keep-all-with-zwsp') return reading.children(node);
    const written = writtenChildren(node, 0, this.options);
    if (written.length === node.childCount) return reading.children(node);
    const result: Correspondence[] = [];
    let body = reading.suppliedBody();
    let kept = 0;
    let next = 0;
    for (let index = 0; index < node.childCount; index++) {
      const isWritten = written[kept] === index;
      if (isWritten) kept++;
      const syntax = isWritten ? actual[next] : undefined;
      if (syntax) {
        result.push(new Correspondence(syntax));
        next++;
      } else if (body) {
        result.push(body);
        body = null;
      } else if (isWritten) {
        throw new RangeError('The reading does not correspond to the editor children');
      } else {
        const empty = new Correspondence(reading.syntax, actual[next]?.start ?? reading.range.end);
        this.omitted.add(empty);
        result.push(empty);
      }
    }
    return result;
  }

  /** Whether the reading is of a child the writing option left out. */
  isOmitted(reading: Correspondence): boolean { return this.omitted.has(reading); }

  /** The editor position of a location in a field's text, or at a node with no text, or null. */
  inText(point: number): number | null {
    for (const place of this.places) {
      if (point < place.start || point > place.end) continue;
      if (point === place.end) return place.editor + place.length;
      if (place.end - place.start === place.length) return place.editor + point - place.start;
      return place.editor;
    }
    return null;
  }
}

function places(unit: Unit, reading: Correspondence, node: Node, at: number, result: Place[] = []): Place[] {
  if (node.isTextblock) {
    const pieces = unit.fieldPieces(reading, node);
    const before = result.length;
    let offset = unit.trimmed(reading, node);
    for (const piece of pieces) {
      if (piece.length)
        result.push({ start: piece.start, end: piece.end, editor: at + 1 + offset, length: piece.length });
      offset += piece.length;
    }
    const last = pieces.at(-1);
    const limit = unit.text.length + unit.emptyLabels.length;
    if (last && last.end - last.start === last.length && offset < node.content.size) {
      const extra = Math.min(node.content.size - offset, Math.max(0, limit - last.end));
      if (extra) {
        result.push({ start: last.end, end: last.end + extra, editor: at + 1 + offset, length: extra });
        offset += extra;
      }
    }
    const where = pieces[0]?.start ?? reading.range.start;
    if (result.length === before) result.push({ start: where, end: where, editor: at + 1 + offset, length: 0 });
  } else {
    const children = unit.children(reading, node);
    if (!node.childCount) result.push({ start: reading.range.start, end: reading.range.start, editor: at, length: 0 });
    node.forEach((child, offset, index) => {
      if (!unit.isOmitted(children[index]!)) places(unit, children[index]!, child, at + 1 + offset, result);
    });
  }
  return result;
}

/** A character that is no text, by its owner, the innermost node holding it; null outside. */
function ownerPlace(unit: Unit, reading: Correspondence, node: Node, at: number, point: number,
  available?: readonly Place[]): number | null {
  const range = reading.range;
  if (point < range.start || point >= range.end) return null;
  if (!node.isTextblock) {
    const children = unit.children(reading, node);
    let found: number | null = null;
    node.forEach((child, offset, index) => {
      if (!unit.isOmitted(children[index]!)) found ??= ownerPlace(unit, children[index]!, child, at + 1 + offset, point);
    });
    if (found !== null) return found;
  }
  const within = available ?? places(unit, reading, node, at);
  const next = within.find(place => place.start > point);
  const last = within.at(-1)!;
  return next ? next.editor : last.editor + last.length;
}

/** A field offset back to the source: at a boundary between pieces, the start of the next. */
function fromField(pieces: readonly SourcePiece[], offset: number, otherwise: number): number {
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i]!;
    if (offset < piece.length) return piece.end - piece.start === piece.length ? piece.start + offset : piece.start;
    if (i === pieces.length - 1) return piece.end - piece.start === piece.length ? piece.start + offset : piece.end;
    offset -= piece.length;
  }
  return otherwise;
}
function check(point: number, size: number): void {
  if (!Number.isSafeInteger(point) || point < 0 || point > size)
    throw new RangeError('Location is outside the document');
}
function pair(before: number, after: number): boolean {
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}
