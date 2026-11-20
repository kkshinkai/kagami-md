/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  Parser, YAMLFrontMatterSyntax, YAMLMappingSyntax, YAMLNodeSyntax, YAMLScalarSyntax,
  YAMLSequenceSyntax,
} from '../syntax/index.js';
import { Fragment, Slice, type Node, type NodeType, type ResolvedPos } from 'prosemirror-model';
import { ReplaceAroundStep, type Transform } from 'prosemirror-transform';
import { fieldSource, frontMatterSource } from '../parse/field.js';
import { parseFrontMatter } from '../parse/parse.js';
import { canonicalTableLines, definitionFrames, footnoteLabelFrame } from '../unparse/frames.js';
import { defaultUnparseOptions, unparseSlice } from '../unparse/unparse.js';
import { unparseFrontMatter } from '../unparse/yaml.js';
import { combine } from './classes.js';
import { readingShapes } from './reading.js';
import { reshapeBlocks } from './reshape.js';
import { keptShape, type Shape } from './transform.js';

const frontMatterParser = new Parser({ target: 'editor' });

/** Whether removing or replacing `from..to` crosses front matter or a structured head/definition. */
export function needsStructuredRemove(doc: Node, from: number, to: number): boolean {
  if (from >= to) return false;
  const left = doc.resolve(from);
  const right = doc.resolve(to);
  if (!left.parent.isTextblock || !right.parent.isTextblock || left.sameParent(right)) return false;
  if (left.depth >= 1 && left.node(1).type.isInGroup('frontMatter')) return true;
  const nodes = doc.type.schema.nodes;
  const leftType = left.parent.type;
  if (leftType === nodes.footnoteLabel || leftType === nodes.linkLabel ||
      leftType === nodes.linkDestination || leftType === nodes.linkTitle ||
      leftType === nodes.tableParagraph || right.parent.type === nodes.tableParagraph) return true;
  const shared = left.sharedDepth(to);
  for (let level = shared + 1; level < right.depth; level++) {
    const type = right.node(level).type;
    if (type === nodes.linkReferenceDefinition || type === nodes.footnoteDefinition ||
        type === nodes.callout || type === nodes.table)
      return true;
  }
  const leftLiteral = Boolean(leftType.spec.code || leftType.spec.marks === '');
  const rightLiteral = Boolean(right.parent.type.spec.code || right.parent.type.spec.marks === '');
  if (!leftLiteral && rightLiteral && doc.textBetween(to, right.end()).includes('\n')) return true;
  return false;
}

/** Delete across fields and carry the final field's surviving suffix into the first. */
export function removeAcrossFields(tr: Transform, from: number, to: number): number | undefined {
  let left = tr.doc.resolve(from);
  let right = tr.doc.resolve(to);
  if (left.depth >= 1 && left.node(1).type.isInGroup('frontMatter')) {
    return removeFromFrontMatter(tr, from, to);
  }
  if (needsStructuredRemove(tr.doc, from, to)) {
    removeByReshape(tr, from, to);
    return undefined;
  }
  // Literal fields hold line endings as text. The conversion has equal width,
  // so the suffix's character positions remain the ones the selection named.
  if (left.parent.type.spec.code || left.parent.type.spec.marks === '') {
    const endings: number[] = [];
    tr.doc.nodesBetween(to, right.end(), (node, position) => {
      if (node.type === tr.doc.type.schema.nodes.lineEnding) endings.push(position);
    });
    for (let index = endings.length - 1; index >= 0; index--) {
      const position = endings[index]!;
      tr.replaceWith(position, position + 1, tr.doc.type.schema.text('\n'));
    }
    tr.removeMark(to, right.end());
    left = tr.doc.resolve(from);
    right = tr.doc.resolve(to);
  }
  const depth = left.sharedDepth(to);
  let end = right.after();
  let open = right.depth - 1;
  while (open > depth && right.indexAfter(open) === right.node(open).childCount) end = right.after(open--);
  const slice = new Slice(leadingFrames(left, right, depth).append(trailingFrames(right, open, depth)),
    left.depth - depth, open - depth);
  tr.step(new ReplaceAroundStep(from, end, to, right.end(), slice, 0));
  return undefined;
}

interface YAMLScalarEntry {
  readonly node: Node;
  readonly syntax: YAMLScalarSyntax;
  readonly pos: number;
}

function stripYAMLSpelling(node: Node): Node {
  if (node.isText) return node;
  const children: Node[] = [];
  node.forEach(child => children.push(stripYAMLSpelling(child)));
  return node.type.create({ ...node.attrs, spelling: null }, children, node.marks);
}

function collectYAMLScalars(node: Node, syntax: YAMLNodeSyntax, pos: number, out: YAMLScalarEntry[]): void {
  const nodes = node.type.schema.nodes;
  if (node.type === nodes.yamlScalar && syntax instanceof YAMLScalarSyntax) {
    out.push({ node, syntax, pos });
    return;
  }
  if (node.type === nodes.yamlMapping && syntax instanceof YAMLMappingSyntax) {
    let childPos = pos + 1;
    for (let index = 0; index < node.childCount; index++) {
      const pair = node.child(index);
      const pairSyntax = syntax.children[index]!;
      const keyNode = pair.child(0);
      const valueNode = pair.child(1);
      collectYAMLScalars(keyNode, pairSyntax.key, childPos + 1, out);
      collectYAMLScalars(valueNode, pairSyntax.value, childPos + 1 + keyNode.nodeSize, out);
      childPos += pair.nodeSize;
    }
    return;
  }
  if (node.type === nodes.yamlSequence && syntax instanceof YAMLSequenceSyntax) {
    let childPos = pos + 1;
    for (let index = 0; index < node.childCount; index++) {
      const item = node.child(index);
      collectYAMLScalars(item, syntax.children[index]!, childPos, out);
      childPos += item.nodeSize;
    }
  }
}

function quotedScalarOffsets(raw: string): number[] | null {
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    const offsets: number[] = [];
    let cursor = 1;
    while (cursor < raw.length - 1) {
      offsets.push(cursor);
      if (raw[cursor] === '\\' && cursor + 1 < raw.length - 1) {
        const next = raw[cursor + 1]!;
        if (next === 'x') cursor += 4;
        else if (next === 'u') cursor += 6;
        else if (next === 'U') {
          const hex = Number.parseInt(raw.slice(cursor + 2, cursor + 10), 16);
          if (hex > 0xffff) offsets.push(cursor);
          cursor += 10;
        } else {
          cursor += 2;
        }
      } else {
        cursor++;
      }
    }
    offsets.push(raw.length - 1);
    return offsets;
  }
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) {
    const offsets: number[] = [];
    let cursor = 1;
    while (cursor < raw.length - 1) {
      offsets.push(cursor);
      if (raw[cursor] === "'" && raw[cursor + 1] === "'") cursor += 2;
      else cursor++;
    }
    offsets.push(raw.length - 1);
    return offsets;
  }
  return null;
}

function scalarInnerToSource(node: Node, syntax: YAMLScalarSyntax, fmSource: string, offset: number): number {
  const raw = fmSource.slice(syntax.start, syntax.end);
  if (raw.length === node.content.size) return syntax.start + offset;
  const offsets = quotedScalarOffsets(raw);
  if (offsets && offset >= 0 && offset < offsets.length) return syntax.start + offsets[offset]!;
  if (offset <= 0) return syntax.start;
  if (offset >= node.content.size) return syntax.end;
  return syntax.start + Math.min(raw.length, offset);
}

function scalarSourceToInner(node: Node, syntax: YAMLScalarSyntax, fmSource: string, sourcePos: number): number {
  const raw = fmSource.slice(syntax.start, syntax.end);
  const rel = sourcePos - syntax.start;
  if (raw.length === node.content.size) return Math.max(0, Math.min(node.content.size, rel));
  const offsets = quotedScalarOffsets(raw);
  if (offsets) {
    for (let index = 0; index < offsets.length; index++) {
      if (offsets[index]! >= rel) return Math.min(node.content.size, index);
    }
    return node.content.size;
  }
  return Math.max(0, Math.min(node.content.size, rel));
}

function yamlEditorToSource(frontMatter: Node, syntax: YAMLFrontMatterSyntax, fmSource: string,
  editorPos: number): number {
  const entries: YAMLScalarEntry[] = [];
  collectYAMLScalars(frontMatter.firstChild!, syntax.root, 1, entries);
  for (const entry of entries) {
    const start = entry.pos + 1;
    const end = start + entry.node.content.size;
    if (editorPos >= start && editorPos <= end) {
      return scalarInnerToSource(entry.node, entry.syntax, fmSource, editorPos - start);
    }
  }
  for (const entry of entries) {
    if (entry.pos + 1 >= editorPos) return entry.syntax.start;
  }
  return syntax.root.end;
}

function yamlSourceToEditor(frontMatter: Node, syntax: YAMLFrontMatterSyntax, fmSource: string,
  sourcePos: number): number {
  const entries: YAMLScalarEntry[] = [];
  collectYAMLScalars(frontMatter.firstChild!, syntax.root, 1, entries);
  if (!entries.length) return frontMatter.nodeSize;
  for (const entry of entries) {
    if (sourcePos <= entry.syntax.start) return entry.pos + 1;
    if (sourcePos <= entry.syntax.end) {
      return entry.pos + 1 + scalarSourceToInner(entry.node, entry.syntax, fmSource, sourcePos);
    }
  }
  const last = entries.at(-1)!;
  return last.pos + 1 + last.node.content.size;
}

function preserveUntouchedYAMLPairs(original: Node, rebuilt: Node, from: number, to: number): Node {
  const nodes = original.type.schema.nodes;
  if (original.type !== nodes.yamlFrontMatter || rebuilt.type !== nodes.yamlFrontMatter) {
    const trailing = original.attrs.spelling?.trailingBlankLines;
    if (trailing === undefined) return rebuilt;
    return rebuilt.type.create(
      { ...rebuilt.attrs, spelling: { ...rebuilt.attrs.spelling, trailingBlankLines: trailing } },
      rebuilt.content,
    );
  }
  const left = original.resolve(Math.max(0, Math.min(original.content.size, from)));
  const right = original.resolve(Math.max(0, Math.min(original.content.size, to)));
  const oldRoot = original.firstChild!;
  const newRoot = rebuilt.firstChild!;
  if (left.depth < 2 || right.depth < 2 || left.node(1) !== oldRoot || right.node(1) !== oldRoot) {
    return rebuilt.type.create({ ...rebuilt.attrs, spelling: original.attrs.spelling }, rebuilt.content);
  }
  const keepBefore = left.index(1);
  const keepAfter = oldRoot.childCount - 1 - right.index(1);
  if (newRoot.childCount < keepBefore + Math.max(0, keepAfter)) {
    return rebuilt.type.create({ ...rebuilt.attrs, spelling: original.attrs.spelling }, rebuilt.content);
  }
  const children: Node[] = [];
  for (let index = 0; index < newRoot.childCount; index++) {
    if (index < keepBefore) {
      children.push(oldRoot.child(index));
    } else if (keepAfter > 0 && index >= newRoot.childCount - keepAfter) {
      const oldIndex = oldRoot.childCount - (newRoot.childCount - index);
      children.push(oldRoot.child(oldIndex));
    } else {
      children.push(newRoot.child(index));
    }
  }
  const mergedRoot = newRoot.type.create({ ...newRoot.attrs, spelling: oldRoot.attrs.spelling }, children);
  return rebuilt.type.create({ ...rebuilt.attrs, spelling: original.attrs.spelling }, [mergedRoot]);
}

function frontMatterSliceSource(frontMatter: Node): {
  readonly fmSource: string;
  readonly parsedFM: YAMLFrontMatterSyntax | null;
  readonly canonical: Node;
} {
  const nodes = frontMatter.type.schema.nodes;
  if (frontMatter.type === nodes.rawFrontMatter) {
    const canonical = stripYAMLSpelling(frontMatter);
    return { fmSource: frontMatterSource(canonical), parsedFM: null, canonical };
  }
  const canonical = stripYAMLSpelling(frontMatter);
  const fmSource = unparseFrontMatter(canonical);
  const parsed = frontMatterParser.parseFile('\ufeff' + fmSource).document.frontMatter;
  const parsedFM = parsed instanceof YAMLFrontMatterSyntax ? parsed : null;
  return { fmSource, parsedFM, canonical };
}

function frontMatterEndpoint(frontMatter: Node, canonical: Node, parsedFM: YAMLFrontMatterSyntax | null,
  fmSource: string, pos: number): number {
  if (pos >= frontMatter.nodeSize) return fmSource.length;
  if (frontMatter.type === frontMatter.type.schema.nodes.rawFrontMatter) {
    const prefixLen = 4;
    return prefixLen + Math.max(0, Math.min(frontMatter.textContent.length, pos - 1));
  }
  if (!parsedFM) return fmSource.length;
  return yamlEditorToSource(canonical, parsedFM, fmSource, pos);
}

function removeFromFrontMatter(tr: Transform, from: number, to: number): number {
  const schema = tr.doc.type.schema;
  const nodes = schema.nodes;
  const frontMatter = tr.doc.firstChild!;
  const fmSize = frontMatter.nodeSize;
  const { fmSource, parsedFM, canonical } = frontMatterSliceSource(frontMatter);
  const srcFrom = frontMatterEndpoint(frontMatter, canonical, parsedFM, fmSource, from);
  if (to <= fmSize) {
    const srcTo = frontMatterEndpoint(frontMatter, canonical, parsedFM, fmSource, to);
    const nextSource = fmSource.slice(0, srcFrom) + fmSource.slice(srcTo);
    const parsedDoc = frontMatterParser.parseFile('\ufeff' + nextSource).document;
    if (parsedDoc.frontMatter) {
      const rawBuilt = parseFrontMatter(parsedDoc.frontMatter, schema);
      const nextFM = preserveUntouchedYAMLPairs(frontMatter, rawBuilt, from, to);
      tr.replaceWith(0, fmSize, nextFM);
      if (parsedDoc.frontMatter instanceof YAMLFrontMatterSyntax) {
        return yamlSourceToEditor(nextFM, parsedDoc.frontMatter, nextSource, srcFrom);
      }
      const fenceLen = (parsedDoc.frontMatter.spelling.fence ?? '---').length + 1;
      const rawOffset = Math.max(0, Math.min(nextFM.textContent.length, srcFrom - fenceLen));
      return 1 + rawOffset;
    }
  }
  const leftSource = fmSource.slice(0, srcFrom);
  const right = tr.doc.resolve(to);
  const authored = new Map<Shape, Node>();
  const suffix = rightSuffix(tr.doc, right, 0, to, nodes.paragraph, authored);
  const rightEnd = suffix.blocks.length === 0 ? suffix.cutPos : right.after(1);
  let rightText = '';
  const origins: { start: number; end: number; origin: number }[] = [];
  for (const piece of suffix.inline) {
    if (piece.kind === 'text') {
      rightText += piece.text;
    } else {
      const sliceText = tr.doc.textBetween(piece.from, piece.to, '', '\n');
      const startOffset = leftSource.length + rightText.length;
      origins.push({ start: startOffset, end: startOffset + sliceText.length, origin: piece.from });
      rightText += sliceText;
    }
  }
  const combined = leftSource + rightText;
  const parsedDoc = frontMatterParser.parseFile('\ufeff' + combined).document;
  const reading = readingShapes(parsedDoc.children, combined, schema, origins, authored);
  const bodyShapes: Shape[] = [...reading.shapes, ...suffix.blocks];
  if (parsedDoc.frontMatter) {
    const nextFM = preserveUntouchedYAMLPairs(frontMatter, parseFrontMatter(parsedDoc.frontMatter, schema), from, fmSize);
    if (!bodyShapes.length && rightEnd === tr.doc.content.size) {
      bodyShapes.push({ kind: 'text', type: nodes.paragraph, meaning: {}, text: [] });
    }
    const changedBody = reshapeBlocks(tr, fmSize, rightEnd, bodyShapes, authored);
    tr.replaceWith(0, fmSize, nextFM);
    if (leftSource.length <= parsedDoc.frontMatter.end) {
      if (parsedDoc.frontMatter instanceof YAMLFrontMatterSyntax) {
        return yamlSourceToEditor(nextFM, parsedDoc.frontMatter, combined, leftSource.length);
      }
      const fenceLen = (parsedDoc.frontMatter.spelling.fence ?? '---').length + 1;
      return 1 + Math.max(0, Math.min(nextFM.textContent.length, leftSource.length - fenceLen));
    }
    return nextFM.nodeSize + changedBody.locate(reading.locate(leftSource.length));
  }
  if (!bodyShapes.length && rightEnd === tr.doc.content.size) {
    bodyShapes.push({ kind: 'text', type: nodes.paragraph, meaning: {}, text: [] });
  }
  const changed = reshapeBlocks(tr, 0, rightEnd, bodyShapes, authored);
  return changed.locate(reading.locate(leftSource.length));
}

interface RightSuffix {
  readonly inline: Shape.Piece[];
  readonly blocks: Shape[];
  readonly cutPos: number;
}

function removeByReshape(tr: Transform, from: number, to: number): void {
  const doc = tr.doc;
  const nodes = doc.type.schema.nodes;
  const left = doc.resolve(from);
  const right = doc.resolve(to);
  const shared = left.sharedDepth(to);
  const sharedNode = left.node(shared);
  let replaceDepth = shared;
  if (sharedNode.type === nodes.linkReferenceDefinition) replaceDepth = shared - 1;
  else if (sharedNode.type === nodes.footnoteDefinition && left.index(shared) === 0) replaceDepth = shared - 1;
  else if (sharedNode.type === nodes.table || sharedNode.type === nodes.tableRow) {
    replaceDepth = sharedNode.type === nodes.table ? shared : shared - 1;
  }

  if (replaceDepth >= 1 && left.node(replaceDepth).type === nodes.table) {
    mergeTableRowsInPlace(tr, left, from, right, to, replaceDepth);
    return;
  }

  const leftType = leftTargetType(left, replaceDepth);
  const authored = new Map<Shape, Node>();
  const suffix = rightSuffix(doc, right, replaceDepth, to, leftType, authored);

  let deepLeftDepth = replaceDepth;
  while (deepLeftDepth + 1 < left.depth && canKeepEarlierSiblings(left, deepLeftDepth + 1)) {
    deepLeftDepth++;
  }

  const replaceTo = right.after(replaceDepth + 1);
  if (deepLeftDepth === replaceDepth && (suffix.blocks.length > 0 || suffix.cutPos === replaceTo)) {
    const replaceFrom = left.before(replaceDepth + 1);
    const leftShapes = buildLeftShapes(doc, left, from, replaceDepth + 1, suffix.inline, authored);
    reshapeBlocks(tr, replaceFrom, replaceTo, [...leftShapes, ...suffix.blocks], authored, { from, to: from });
    return;
  }

  const innerFrom = left.before(deepLeftDepth + 1);
  const innerTo = deepLeftDepth > replaceDepth ? left.end(deepLeftDepth) : left.after(replaceDepth + 1);
  const leftCloses: { afterChild: number; endParent: number }[] = [];
  for (let level = deepLeftDepth - 1; level > replaceDepth; level--) {
    leftCloses.push({ afterChild: left.after(level + 1), endParent: left.end(level) });
  }
  const afterTopLeft = left.after(replaceDepth + 1);
  const rightEnd = suffix.blocks.length === 0 ? suffix.cutPos : replaceTo;

  const leftAuthored = new Map<Shape, Node>();
  const localInline = materializePieces(doc, suffix.inline, innerFrom, innerTo);
  const leftShapes = buildLeftShapes(doc, left, from, deepLeftDepth + 1, localInline, leftAuthored);
  const stepStart = tr.steps.length;
  reshapeBlocks(tr, innerFrom, innerTo, leftShapes, leftAuthored, { from, to: from });

  for (const close of leftCloses) {
    const map = tr.mapping.slice(stepStart);
    const startPos = map.map(close.afterChild, 1);
    const endPos = map.map(close.endParent, -1);
    if (endPos > startPos) tr.delete(startPos, endPos);
  }

  const finalMap = tr.mapping.slice(stepStart);
  const mappedAfterLeft = finalMap.map(afterTopLeft, 1);
  const mappedRightEnd = finalMap.map(rightEnd, 1);
  if (suffix.blocks.length === 0) {
    if (mappedRightEnd > mappedAfterLeft) tr.delete(mappedAfterLeft, mappedRightEnd);
  } else {
    const localBlocks = materializeBlockShapes(doc, suffix.blocks, mappedAfterLeft, mappedRightEnd, finalMap, authored);
    reshapeBlocks(tr, mappedAfterLeft, mappedRightEnd, localBlocks, authored);
  }
}

function mergeTableRowsInPlace(tr: Transform, left: ResolvedPos, from: number, right: ResolvedPos, to: number,
  tableDepth: number): void {
  const nodes = tr.doc.type.schema.nodes;
  const r1 = left.index(tableDepth);
  const r2 = right.index(tableDepth);
  const row1 = left.node(tableDepth + 1);
  const row1Pos = left.before(tableDepth + 1);
  const row2 = right.node(tableDepth + 1);
  const row2Pos = right.before(tableDepth + 1);
  const c1 = left.index(tableDepth + 1);
  const c2 = right.index(tableDepth + 1);
  const cols = row1.childCount;
  const authored = new Map<Shape, Node>();
  const cells = keptChildren(row1, row1Pos, 0, c1, authored);
  const cell1 = row1.child(c1);
  const { spelling: _s, ...cellMeaning } = cell1.attrs;
  cells.push({
    kind: 'children',
    type: cell1.type,
    meaning: cellMeaning,
    children: [{
      kind: 'text',
      type: nodes.tableParagraph,
      meaning: {},
      text: [{ kind: 'range', from: left.start(), to: from }, { kind: 'range', from: to, to: right.end() }],
    }],
  });
  let row2CellPos = row2Pos + 1;
  for (let col = 0; col < cols; col++) {
    const row2Cell = row2.child(col);
    if (col > c1) {
      const targetType = row1.child(col).type;
      const { spelling: _cs, ...meaning } = row1.child(col).attrs;
      if (col <= c2) {
        cells.push({
          kind: 'children',
          type: targetType,
          meaning,
          children: [{ kind: 'text', type: nodes.tableParagraph, meaning: {}, text: [] }],
        });
      } else if (r1 === 0 && r2 > 0) {
        cells.push({
          kind: 'children',
          type: targetType,
          meaning,
          children: [keptShape(row2Cell.firstChild!, row2CellPos + 1, authored)],
        });
      } else {
        cells.push(keptShape(row2Cell, row2CellPos, authored));
      }
    }
    row2CellPos += row2Cell.nodeSize;
  }
  const { spelling: _rs, ...rowMeaning } = row1.attrs;
  const mergedRow: Shape = { kind: 'children', type: nodes.tableRow, meaning: rowMeaning, children: cells };
  reshapeBlocks(tr, row1Pos, right.after(tableDepth + 1), [mergedRow], authored, { from, to: from });
}

function canKeepEarlierSiblings(left: ResolvedPos, level: number): boolean {
  const node = left.node(level);
  const nodes = node.type.schema.nodes;
  if (node.type === nodes.bulletList || node.type === nodes.orderedList ||
      node.type === nodes.listItem || node.type === nodes.blockQuote || node.type === nodes.callout)
    return true;
  return node.type === nodes.footnoteDefinition && left.index(level) >= 1;
}

function materializePieces(doc: Node, pieces: readonly Shape.Piece[],
  keepFrom: number, keepTo: number): Shape.Piece[] {
  return pieces.map(piece => {
    if (piece.kind === 'range' && (piece.from < keepFrom || piece.to > keepTo)) {
      return { kind: 'text', text: doc.textBetween(piece.from, piece.to, '', '\n') };
    }
    return piece;
  });
}

function materializeBlockShapes(doc: Node, shapes: readonly Shape[], keepFrom: number, keepTo: number,
  mapping: Transform['mapping'], authored: Map<Shape, Node>): Shape[] {
  return shapes.map(shape => {
    const existing = authored.get(shape);
    if (shape.kind === 'text') {
      const mappedText = shape.text.map(piece => piece.kind === 'range'
        ? { kind: 'range' as const, from: mapping.map(piece.from, 1), to: mapping.map(piece.to, -1) }
        : piece);
      const next: Shape = { ...shape, text: materializePieces(doc, mappedText, keepFrom, keepTo) };
      if (existing) authored.set(next, existing);
      return next;
    }
    const next: Shape = {
      ...shape,
      children: materializeBlockShapes(doc, shape.children, keepFrom, keepTo, mapping, authored),
    };
    if (existing) authored.set(next, existing);
    return next;
  });
}

function leftTargetType(left: ResolvedPos, replaceDepth: number): NodeType {
  const nodes = left.doc.type.schema.nodes;
  for (let level = replaceDepth + 1; level < left.depth; level++) {
    const node = left.node(level);
    if (node.type === nodes.linkReferenceDefinition) return nodes.paragraph;
    if (node.type === nodes.footnoteDefinition && left.index(level) === 0) return nodes.paragraph;
    if (node.type === nodes.table && left.index(level) === 0) return nodes.paragraph;
  }
  return left.parent.type;
}

function buildLeftShapes(doc: Node, left: ResolvedPos, from: number, level: number,
  rightInline: readonly Shape.Piece[], authored: Map<Shape, Node>): Shape[] {
  const nodes = doc.type.schema.nodes;
  const node = left.node(level);
  if (node.type === nodes.linkReferenceDefinition) {
    const pieces = linkDefinitionPrefix(node, left.before(level), left.index(level), left.start(), from);
    return [{ kind: 'text', type: nodes.paragraph, meaning: {}, text: [...pieces, ...rightInline] }];
  }
  if (node.type === nodes.footnoteDefinition && left.index(level) === 0) {
    const labelFrame = footnoteLabelFrame(node);
    return [{
      kind: 'text',
      type: nodes.paragraph,
      meaning: {},
      text: [{ kind: 'text', text: labelFrame.before }, { kind: 'range', from: left.start(), to: from }, ...rightInline],
    }];
  }
  if (node.type === nodes.table) {
    return buildTableLeftShapes(doc, left, from, level, rightInline, authored);
  }
  if (level === left.depth) {
    const { spelling: _spelling, ...meaning } = node.attrs;
    return [{
      kind: 'text',
      type: node.type,
      meaning,
      text: [{ kind: 'range', from: left.start(), to: from }, ...rightInline],
    }];
  }
  const nodePos = left.before(level);
  const index = left.index(level);
  const children = keptChildren(node, nodePos, 0, index, authored);
  children.push(...buildLeftShapes(doc, left, from, level + 1, rightInline, authored));
  const { spelling: _spelling, ...meaning } = node.attrs;
  return [{ kind: 'children', type: node.type, meaning, children }];
}

function buildTableLeftShapes(doc: Node, left: ResolvedPos, from: number, tableLevel: number,
  rightInline: readonly Shape.Piece[], authored: Map<Shape, Node>): Shape[] {
  const nodes = doc.type.schema.nodes;
  const table = left.node(tableLevel);
  const tablePos = left.before(tableLevel);
  const rowIndex = left.index(tableLevel);
  const row = table.child(rowIndex);
  const colIndex = left.index(tableLevel + 1);
  if (rowIndex === 0) {
    const pieces: Shape.Piece[] = [{ kind: 'text', text: '| ' }];
    let cellPos = left.before(tableLevel + 1) + 1;
    for (let col = 0; col < colIndex; col++) {
      const cell = row.child(col);
      pieces.push({ kind: 'range', from: cellPos + 2, to: cellPos + cell.nodeSize - 2 });
      pieces.push({ kind: 'text', text: ' | ' });
      cellPos += cell.nodeSize;
    }
    pieces.push({ kind: 'range', from: left.start(), to: from }, ...rightInline);
    return [{ kind: 'text', type: nodes.paragraph, meaning: {}, text: pieces }];
  }
  const { firstLine, restText } = splitFirstLinePieces(doc, rightInline);
  const rows = keptChildren(table, tablePos, 0, rowIndex, authored);
  const rowPos = left.before(tableLevel + 1);
  const cells = keptChildren(row, rowPos, 0, colIndex, authored);
  const activeCell = row.child(colIndex);
  const { spelling: _cs, ...cellMeaning } = activeCell.attrs;
  cells.push({
    kind: 'children',
    type: activeCell.type,
    meaning: cellMeaning,
    children: [{
      kind: 'text',
      type: nodes.tableParagraph,
      meaning: {},
      text: [{ kind: 'range', from: left.start(), to: from }, ...firstLine],
    }],
  });
  for (let col = colIndex + 1; col < row.childCount; col++) {
    const cell = row.child(col);
    const { spelling: _s, ...emptyMeaning } = cell.attrs;
    cells.push({
      kind: 'children',
      type: cell.type,
      meaning: emptyMeaning,
      children: [{ kind: 'text', type: nodes.tableParagraph, meaning: {}, text: [] }],
    });
  }
  const { spelling: _rs, ...rowMeaning } = row.attrs;
  rows.push({ kind: 'children', type: nodes.tableRow, meaning: rowMeaning, children: cells });
  const { spelling: _ts, ...tableMeaning } = table.attrs;
  const result: Shape[] = [{ kind: 'children', type: nodes.table, meaning: tableMeaning, children: rows }];
  if (restText !== null) {
    result.push({ kind: 'text', type: nodes.paragraph, meaning: {}, text: [{ kind: 'text', text: restText }] });
  }
  return result;
}

function splitFirstLinePieces(doc: Node, pieces: readonly Shape.Piece[]): {
  firstLine: Shape.Piece[];
  restText: string | null;
} {
  const full = pieces.map(piece => piece.kind === 'text'
    ? piece.text : doc.textBetween(piece.from, piece.to, '', '\n')).join('');
  const newline = full.indexOf('\n');
  if (newline < 0) return { firstLine: [...pieces], restText: null };
  return {
    firstLine: full.slice(0, newline) ? [{ kind: 'text', text: full.slice(0, newline) }] : [],
    restText: full.slice(newline + 1),
  };
}

function rightSuffix(doc: Node, right: ResolvedPos, replaceDepth: number, to: number,
  leftType: NodeType, authored: Map<Shape, Node>): RightSuffix {
  const nodes = doc.type.schema.nodes;
  const leftLiteral = Boolean(leftType.spec.code || leftType.spec.marks === '');
  for (let level = replaceDepth + 1; level < right.depth; level++) {
    const node = right.node(level);
    if (node.type === nodes.linkReferenceDefinition) {
      const inline = linkDefinitionSuffix(node, right.before(level), right.index(level), to, right.end());
      return finishRightSuffix(right, level, replaceDepth, inline, [], authored);
    }
    if (node.type === nodes.footnoteDefinition && right.index(level) === 0) {
      return footnoteLabelSuffix(node, right, level, replaceDepth, to, authored);
    }
    if (node.type === nodes.table) {
      return tableRightSuffix(node, right, level, replaceDepth, to, leftType, authored);
    }
  }
  const inline = rightTextPieces(doc, right, to, leftLiteral);
  return finishRightSuffix(right, right.depth, replaceDepth, inline, [], authored);
}

function finishRightSuffix(right: ResolvedPos, consumedLevel: number, replaceDepth: number,
  inline: Shape.Piece[], inner: Shape[], authored: Map<Shape, Node>): RightSuffix {
  if (!inner.length) {
    let cutPos = right.after(consumedLevel);
    let open = consumedLevel - 1;
    while (open > replaceDepth) {
      const parent = right.node(open);
      const afterIndex = right.indexAfter(open);
      if (afterIndex === parent.childCount) {
        cutPos = right.after(open);
        open--;
        continue;
      }
      const remaining = Fragment.fromArray(parent.content.content.slice(afterIndex));
      if (parent.type.validContent(remaining)) {
        return { inline, blocks: [], cutPos };
      }
      break;
    }
    if (open === replaceDepth) return { inline, blocks: [], cutPos };
  }
  const blocks = wrapRightAncestors(right, consumedLevel - 1, replaceDepth, inner, authored);
  return { inline, blocks, cutPos: right.after(replaceDepth + 1) };
}

function tableRightSuffix(table: Node, right: ResolvedPos, tableLevel: number, replaceDepth: number,
  to: number, leftType: NodeType, authored: Map<Shape, Node>): RightSuffix {
  const nodes = table.type.schema.nodes;
  const rowIndex = right.index(tableLevel);
  const row = table.child(rowIndex);
  const colIndex = right.index(tableLevel + 1);
  const inline: Shape.Piece[] = [{ kind: 'range', from: to, to: right.end() }];
  let rowTail = '';
  for (let col = colIndex + 1; col < row.childCount; col++) {
    rowTail += ' | ' + fieldSource(row.child(col).firstChild!);
  }
  rowTail += ' |';
  const lines = canonicalTableLines(table);
  const afterLines = rowIndex === 0 ? lines.slice(1) : lines.slice(rowIndex + 2);
  if (leftType === nodes.paragraph && afterLines.length > 0) {
    inline.push({ kind: 'text', text: rowTail + '\n' + afterLines.join('\n') });
    return finishRightSuffix(right, tableLevel, replaceDepth, inline, [], authored);
  }
  if (rowTail) inline.push({ kind: 'text', text: rowTail });
  const extra: Shape[] = afterLines.length > 0
    ? [{ kind: 'text', type: nodes.paragraph, meaning: {}, text: [{ kind: 'text', text: afterLines.join('\n') }] }]
    : [];
  return finishRightSuffix(right, tableLevel, replaceDepth, inline, extra, authored);
}

function footnoteLabelSuffix(fn: Node, right: ResolvedPos, fnLevel: number, replaceDepth: number,
  to: number, authored: Map<Shape, Node>): RightSuffix {
  const nodes = fn.type.schema.nodes;
  const fnPos = right.before(fnLevel);
  const labelFrame = footnoteLabelFrame(fn);
  const inline: Shape.Piece[] = [
    { kind: 'range', from: to, to: right.end() },
    { kind: 'text', text: labelFrame.after },
  ];
  const first = fn.child(1);
  const firstPos = fnPos + 1 + fn.child(0).nodeSize;
  let remainingFrom = 1;
  if (labelFrame.startsOnLabelLine) {
    if (first.type === nodes.paragraph) {
      if (first.content.size > 0) {
        inline.push({ kind: 'text', text: labelFrame.gap });
        inline.push({ kind: 'range', from: firstPos + 1, to: firstPos + first.nodeSize - 1 });
      }
      remainingFrom = 2;
    } else {
      const written = unparseSlice(new Slice(Fragment.from(first), 0, 0), right, defaultUnparseOptions);
      if (written.length > 0) inline.push({ kind: 'text', text: labelFrame.gap + written });
      remainingFrom = 2;
    }
  }
  const remaining = keptChildren(fn, fnPos, remainingFrom, fn.childCount, authored);
  return finishRightSuffix(right, fnLevel, replaceDepth, inline, remaining, authored);
}

function rightTextPieces(doc: Node, right: ResolvedPos, to: number, leftLiteral: boolean): Shape.Piece[] {
  const end = right.end();
  const rightLiteral = Boolean(right.parent.type.spec.code || right.parent.type.spec.marks === '');
  if (leftLiteral || !rightLiteral) return [{ kind: 'range', from: to, to: end }];
  const text = doc.textBetween(to, end);
  if (!text.includes('\n')) return [{ kind: 'range', from: to, to: end }];
  const lines = text.split('\n');
  const pieces: Shape.Piece[] = [];
  let cursor = to;
  for (let index = 0; index < lines.length; index++) {
    if (index > 0) {
      pieces.push({ kind: 'text', text: '\n' });
      cursor++;
    }
    const line = lines[index]!;
    if (line.length > 0) {
      pieces.push({ kind: 'range', from: cursor, to: cursor + line.length });
      cursor += line.length;
    }
  }
  return pieces;
}

function wrapRightAncestors(right: ResolvedPos, fromLevel: number, replaceDepth: number,
  inner: Shape[], authored: Map<Shape, Node>): Shape[] {
  const nodes = right.doc.type.schema.nodes;
  let current = inner;
  for (let level = fromLevel; level > replaceDepth; level--) {
    const parent = right.node(level);
    const parentPos = right.before(level);
    const after = keptChildren(parent, parentPos, right.index(level) + 1, parent.childCount, authored);
    const children = [...current, ...after];
    if (!children.length) {
      current = [];
    } else if (parent.type === nodes.footnoteDefinition) {
      current = children;
    } else if (parent.type === nodes.callout) {
      current = [{ kind: 'children', type: nodes.blockQuote, meaning: {}, children }];
    } else {
      const { spelling: _spelling, ...meaning } = parent.attrs;
      current = [{ kind: 'children', type: parent.type, meaning, children }];
    }
  }
  return current;
}

function linkDefinitionPrefix(node: Node, pos: number, fieldIndex: number,
  fieldStart: number, from: number): Shape.Piece[] {
  const frames = definitionFrames(node);
  const pieces: Shape.Piece[] = [];
  let childPos = pos + 1;
  for (let index = 0; index < fieldIndex; index++) {
    const child = node.child(index);
    const frame = frames[index]!;
    if (frame.before) pieces.push({ kind: 'text', text: frame.before });
    pieces.push({ kind: 'range', from: childPos + 1, to: childPos + 1 + child.content.size });
    if (frame.after) pieces.push({ kind: 'text', text: frame.after });
    childPos += child.nodeSize;
  }
  const activeFrame = frames[fieldIndex]!;
  if (activeFrame.before) pieces.push({ kind: 'text', text: activeFrame.before });
  pieces.push({ kind: 'range', from: fieldStart, to: from });
  return pieces;
}

function linkDefinitionSuffix(node: Node, pos: number, fieldIndex: number,
  to: number, fieldEnd: number): Shape.Piece[] {
  const frames = definitionFrames(node);
  const pieces: Shape.Piece[] = [{ kind: 'range', from: to, to: fieldEnd }];
  const activeFrame = frames[fieldIndex]!;
  if (activeFrame.after) pieces.push({ kind: 'text', text: activeFrame.after });
  let childPos = pos + 1;
  for (let index = 0; index <= fieldIndex; index++) childPos += node.child(index).nodeSize;
  for (let index = fieldIndex + 1; index < node.childCount; index++) {
    const child = node.child(index);
    const frame = frames[index]!;
    if (frame.before) pieces.push({ kind: 'text', text: frame.before });
    pieces.push({ kind: 'range', from: childPos + 1, to: childPos + 1 + child.content.size });
    if (frame.after) pieces.push({ kind: 'text', text: frame.after });
    childPos += child.nodeSize;
  }
  return pieces;
}

function keptChildren(parent: Node, parentPos: number, fromIndex: number, toIndex: number,
  authored: Map<Shape, Node>): Shape[] {
  const shapes: Shape[] = [];
  let childPos = parentPos + 1;
  for (let index = 0; index < toIndex; index++) {
    const child = parent.child(index);
    if (index >= fromIndex) shapes.push(keptShape(child, childPos, authored));
    childPos += child.nodeSize;
  }
  return shapes;
}

function leadingFrames(left: ResolvedPos, right: ResolvedPos, depth: number): Fragment {
  const node = left.parent;
  const attrs = node.type === right.parent.type
    ? {
      ...node.attrs,
      spelling: combine(node.type, node.attrs.spelling, right.parent.attrs.spelling, ['front', 'ordinary'])
    }
      : node.attrs;
  let content = Fragment.from(node.type.create(attrs));
  for (let level = left.depth - 1; level > depth; level--) content = Fragment.from(left.node(level).copy(content));
  return content;
}

function trailingFrames(right: ResolvedPos, open: number, depth: number): Fragment {
  let content = Fragment.empty;
  for (let level = open; level > depth; level--) {
    const parent = right.node(level);
    const remaining = Fragment.fromArray(parent.content.content.slice(right.indexAfter(level)));
    const required = parent.type.contentMatch.fillBefore(content.append(remaining));
    if (!required) throw new RangeError('The surviving container cannot hold its remaining blocks');
    content = Fragment.from(parent.copy(required.append(content)));
  }
  return content;
}
