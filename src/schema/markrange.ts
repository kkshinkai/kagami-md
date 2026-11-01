/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  ATXClosingSequenceSyntax, BackslashEscapeSyntax, CalloutDeclarationSyntax,
  CharacterReferenceSyntax, DelimitedSyntax, HardLineBreakSyntax, LinkSyntax,
  PendingSyntax, SoftLineBreakSyntax, TaskMarkerSyntax, Syntax, transduce,
  Bindings, type Phrasing,
} from '../syntax/index.js';
import { inlineBody, inlineFormat, type InlineBranch, type InlineFormat } from './inlineformat.js';

type UnitKind = 'text' | 'literal' | 'break' | 'syntax';
interface Unit {
  kind: UnitKind;
  from: number;
  to: number;
  value: string;
  identity: string;
  formats: readonly InlineFormat[];
  context: readonly string[];
  selected: boolean;
  active: boolean;
  frame: InlineBranch | null;
}
interface Branch { kind: 'branch'; syntax: InlineBranch; children: Tree[] }
type Tree = Unit | Branch;
interface Piece { text: string; origin: number | null }
interface Scope {
  from: number;
  to: number;
  formats: readonly InlineFormat[];
  context: readonly string[];
  frame: InlineBranch | null;
}

/** A parsed inline range, with its semantic coverage and Markdown encoding. */
export class MarkRange {
  readonly coverage: MarkRange.Coverage;
  private readonly tree: Tree[];

  constructor(
    readonly analysis: MarkRange.Analysis,
    readonly from: number,
    readonly to: number,
    readonly format: InlineFormat,
    readonly mode: Phrasing,
    readonly bindings?: Bindings
  ) {
    if (from < 0 || to < from || to > analysis.value.length) {
      throw new RangeError('Formatting range is outside its source');
    }
    this.tree = new BuildContext(analysis.value, from, to, format).read(analysis.children);
    const selected = flatten(this.tree).filter(unit => unit.selected && unit.value.trim().length);
    const active = selected.filter(unit => unit.active).length;
    if (!selected.length) this.coverage = 'none';
    else if (!active) this.coverage = 'off';
    else this.coverage = active === selected.length ? 'on' : 'mixed';
  }

  /**
   * Set coverage without changing other formatting or literal/link identity.
   * A candidate must read back to the complete expected inline meaning. Null
   * means that none of the available delimiter spellings represents it.
   */
  change(enabled: boolean): MarkRange.Change | null {
    const unchanged = () => new MarkRange.Change(this.analysis.value, [{ text: this.analysis.value, origin: 0 }]);
    if (this.coverage === 'none') return unchanged();
    const tree = copyTree(this.tree);
    const units = flatten(tree);
    let changed = false;
    for (const unit of units) {
      if (!unit.selected || unit.active === enabled) continue;
      unit.active = enabled;
      changed = true;
    }
    if (!changed) return unchanged();
    trimEdges(units);
    const expected = signature(units, this.format);
    const spellings: readonly Spelling[] = this.format === 'bold' || this.format === 'italic'
      ? ['preserve', 'star', 'underscore'] : ['preserve'];
    const bindings = this.bindings ?? Bindings.none;
    for (const escape of [false, true]) {
      for (const spelling of spellings) {
        const pieces = new WriteContext(this.analysis.value, this.format, spelling, escape).sequence(tree);
        const source = pieces.map(piece => piece.text).join('');
        const reading = transduce(source, {
          phrasing: this.mode, settle: true, firstInListItem: false, firstInBlockQuote: false,
        }, bindings);
        if (reading.kind !== 'inline') continue;
        const actual = new BuildContext(source, 0, 0, this.format).read(reading.children);
        if (signature(flatten(actual), this.format) === expected) {
          return new MarkRange.Change(this.analysis.value, pieces);
        }
      }
    }
    return null;
  }
}

export namespace MarkRange {
  export type Coverage = 'none' | 'off' | 'on' | 'mixed';
  export interface Analysis { value: string; children: readonly Syntax[] }
  export interface Edit { from: number; to: number; text: string }

  /** Source edits and the character correspondence left by an encoding. */
  export class Change {
    readonly source: string;
    readonly edits: readonly Edit[];
    private readonly retained: readonly Retained[];

    constructor(source: string, pieces: readonly Piece[]) {
      const context = new ChangeContext(source);
      for (const piece of pieces) if (piece.text.length) context.add(piece);
      context.finish();
      this.source = pieces.map(piece => piece.text).join('');
      this.edits = context.edits;
      this.retained = context.retained;
    }

    /** Associate an endpoint with the retained character on its requested side. */
    map(offset: number, association: -1 | 1): number {
      const inside = this.retained.find(piece => offset > piece.from && offset < piece.to);
      if (inside) return inside.output + offset - inside.from;
      const left = this.retained.findLast(piece => piece.to <= offset);
      const right = this.retained.find(piece => piece.from >= offset);
      const end = left ? left.output + left.to - left.from : 0;
      if (association > 0) return right?.output ?? end;
      return left ? end : (right?.output ?? 0);
    }
  }
}

/** Builds formatting operands from parser-owned constructs and source gaps. */
class BuildContext {
  constructor(
    readonly source: string,
    readonly from: number,
    readonly to: number,
    readonly format: InlineFormat
  ) {}

  read(nodes: readonly Syntax[], scope: Scope = {
    from: 0, to: this.source.length, formats: [], context: [], frame: null,
  }): Tree[] {
    const result: Tree[] = [];
    let pos = scope.from;
    for (const node of nodes) {
      if (pos < node.start) result.push(...this.text(pos, node.start, scope));
      const format = inlineFormat(node);
      if ((node instanceof DelimitedSyntax || node instanceof LinkSyntax) &&
          (format || node instanceof LinkSyntax)) {
        const body = inlineBody(node);
        const context = node instanceof LinkSyntax
          ? [...scope.context, this.source.slice(node.start, body.from) + '\0' + this.source.slice(body.to, node.end)]
          : scope.context;
        const children = this.read(node.children, {
          from: body.from, to: body.to,
          formats: format ? [...scope.formats, format] : scope.formats,
          context, frame: format === this.format ? node : scope.frame,
        });
        if (format === this.format) result.push(...children);
        else result.push({ kind: 'branch', syntax: node, children });
      } else {
        result.push(...this.node(node, scope));
      }
      pos = node.end;
    }
    if (pos < scope.to) result.push(...this.text(pos, scope.to, scope));
    return result;
  }

  node(node: Syntax, scope: Scope): Unit[] {
    if (node instanceof CharacterReferenceSyntax) {
      return [this.unit('text', node.start, node.end, node.character, 'text', scope)];
    }
    if (node instanceof BackslashEscapeSyntax) {
      return [this.unit('text', node.start, node.end,
        this.source.slice(node.character.start, node.character.end), 'text', scope)];
    }
    if (node.type === 'text') return this.text(node.start, node.end, scope);
    let kind: UnitKind = 'literal';
    if (node instanceof SoftLineBreakSyntax || node instanceof HardLineBreakSyntax || node.type === 'lineEnding') {
      kind = 'break';
    } else if (node instanceof PendingSyntax || node instanceof TaskMarkerSyntax ||
               node instanceof CalloutDeclarationSyntax || node instanceof ATXClosingSequenceSyntax) {
      kind = 'syntax';
    }
    return [this.unit(kind, node.start, node.end, this.source.slice(node.start, node.end),
      kind === 'literal' ? node.type : kind, scope)];
  }

  text(from: number, to: number, scope: Scope): Unit[] {
    const result: Unit[] = [];
    let pos = from;
    for (const value of this.source.slice(from, to)) {
      result.push(this.unit('text', pos, pos + value.length, value, 'text', scope));
      pos += value.length;
    }
    return result;
  }

  unit(kind: UnitKind, from: number, to: number, value: string, identity: string, scope: Scope): Unit {
    return {
      kind, from, to, value, identity,
      formats: scope.formats.filter(format => format !== this.format),
      context: scope.context,
      selected: (kind === 'text' || kind === 'literal') && from >= this.from && to <= this.to,
      active: scope.formats.includes(this.format) && kind !== 'break' && kind !== 'syntax',
      frame: scope.frame,
    };
  }
}

function flatten(tree: readonly Tree[]): Unit[] {
  return tree.flatMap(node => {
    switch (node.kind) {
      case 'branch': return flatten(node.children);
      case 'text':
      case 'literal':
      case 'break':
      case 'syntax': return [node];
      default: {
        const exhaustive: never = node;
        throw new Error(`Unknown formatting node: ${exhaustive}`);
      }
    }
  });
}

function copyTree(tree: readonly Tree[]): Tree[] {
  return tree.map(node => {
    switch (node.kind) {
      case 'branch': return { ...node, children: copyTree(node.children) };
      case 'text':
      case 'literal':
      case 'break':
      case 'syntax': return { ...node };
      default: {
        const exhaustive: never = node;
        throw new Error(`Unknown formatting node: ${exhaustive}`);
      }
    }
  });
}

/** Keep whitespace, but exclude the whitespace at each marked sequence's edges. */
function trimEdges(units: Unit[]): void {
  for (let start = 0; start < units.length;) {
    if (!units[start]!.active) {
      start++;
      continue;
    }
    let end = start + 1;
    while (end < units.length && units[end]!.active) end++;
    let left = start;
    let right = end;
    while (left < right && units[left]!.kind === 'text' && !units[left]!.value.trim()) {
      units[left++]!.active = false;
    }
    while (right > left && units[right - 1]!.kind === 'text' && !units[right - 1]!.value.trim()) {
      units[--right]!.active = false;
    }
    start = end;
  }
}

type Spelling = 'preserve' | 'star' | 'underscore';
interface Written { pieces: Piece[]; active: boolean; units: Unit[] }
const delimiters: Record<InlineFormat, string> = { bold: '**', italic: '*', strike: '~~', highlight: '==' };

/** Encodes uniformly marked siblings around complete subtrees, keeping other envelopes intact. */
class WriteContext {
  constructor(
    readonly source: string,
    readonly format: InlineFormat,
    readonly spelling: Spelling,
    readonly escape: boolean
  ) {}

  sequence(tree: readonly Tree[]): Piece[] {
    const written = tree.map(node => this.node(node));
    const result: Piece[] = [];
    for (let index = 0; index < written.length;) {
      const first = written[index]!;
      if (!first.active) {
        result.push(...first.pieces);
        index++;
        continue;
      }
      let end = index + 1;
      while (end < written.length && written[end]!.active) end++;
      const marked = written.slice(index, end);
      const frame = marked.flatMap(entry => entry.units).find(unit => unit.frame)?.frame;
      let delimiter = delimiters[this.format];
      if (this.spelling === 'preserve' && frame) {
        delimiter = this.source.slice(frame.start, inlineBody(frame).from);
      } else if (this.spelling === 'underscore') {
        delimiter = this.format === 'bold' ? '__' : '_';
      }
      result.push({ text: delimiter, origin: null });
      for (const entry of marked) result.push(...entry.pieces);
      result.push({ text: delimiter, origin: null });
      index = end;
    }
    return result;
  }

  node(node: Tree): Written {
    switch (node.kind) {
      case 'branch': {
        const units = flatten(node.children);
        const active = units.length > 0 && units.every(unit => unit.active);
        const body = active ? this.bare(node.children) : this.sequence(node.children);
        return { units, active, pieces: this.branch(node, body) };
      }
      case 'text':
      case 'literal':
      case 'break':
      case 'syntax': return { units: [node], active: node.active, pieces: this.unit(node) };
      default: {
        const exhaustive: never = node;
        throw new Error(`Unknown formatting node: ${exhaustive}`);
      }
    }
  }

  bare(tree: readonly Tree[]): Piece[] {
    return tree.flatMap(node => {
      switch (node.kind) {
        case 'branch': return this.branch(node, this.bare(node.children));
        case 'text':
        case 'literal':
        case 'break':
        case 'syntax': return this.unit(node);
        default: {
          const exhaustive: never = node;
          throw new Error(`Unknown formatting node: ${exhaustive}`);
        }
      }
    });
  }

  branch(node: Branch, body: readonly Piece[]): Piece[] {
    const range = inlineBody(node.syntax);
    return [this.retain(node.syntax.start, range.from), ...body, this.retain(range.to, node.syntax.end)];
  }

  unit(unit: Unit): Piece[] {
    const piece = this.retain(unit.from, unit.to);
    const code = piece.text.charCodeAt(0);
    const punctuation = (code >= 33 && code <= 47) || (code >= 58 && code <= 64) ||
      (code >= 91 && code <= 96) || (code >= 123 && code <= 126);
    // Encode raw punctuation; decoded and opaque constructs retain their spelling.
    if (this.escape && unit.kind === 'text' && (unit.selected || unit.active) &&
        piece.text.length === 1 && unit.value === piece.text && punctuation) {
      return [{ text: '\\', origin: null }, piece];
    }
    return [piece];
  }

  retain(from: number, to: number): Piece {
    return { text: this.source.slice(from, to), origin: from };
  }
}

/** Compare decoded content, format sets, and literal/link identity. */
function signature(units: readonly Unit[], format: InlineFormat): string {
  return JSON.stringify(units.flatMap(unit => {
    const formats = [...new Set([...unit.formats, ...(unit.active ? [format] : [])])].sort();
    const values = unit.kind === 'text' ? [...unit.value] : [unit.value];
    return values.map(value => [unit.identity, value, formats, unit.context]);
  }));
}

interface Retained { from: number; to: number; output: number }

/** Turns monotone retained pieces into edits and a character correspondence. */
class ChangeContext {
  readonly edits: MarkRange.Edit[] = [];
  readonly retained: Retained[] = [];
  cursor = 0;
  output = 0;
  pending = '';

  constructor(readonly source: string) {}

  add(piece: Piece): void {
    if (piece.origin === null) {
      this.pending += piece.text;
    } else {
      if (piece.origin < this.cursor) throw new RangeError('Formatting reordered retained source');
      this.gap(piece.origin);
      this.retained.push({ from: piece.origin, to: piece.origin + piece.text.length, output: this.output });
      this.cursor = piece.origin + piece.text.length;
      this.pending = '';
    }
    this.output += piece.text.length;
  }

  finish(): void {
    this.gap(this.source.length);
  }

  gap(to: number): void {
    const from = this.cursor;
    const text = this.pending;
    const at = this.output - text.length;
    const original = this.source.slice(from, to);
    let prefix = 0;
    let suffix = 0;
    while (prefix < original.length && prefix < text.length && original[prefix] === text[prefix]) prefix++;
    while (suffix < original.length - prefix && suffix < text.length - prefix &&
           original[original.length - suffix - 1] === text[text.length - suffix - 1]) suffix++;
    // Regenerated framing retains position identity wherever its edges are unchanged.
    if (prefix) this.retained.push({ from, to: from + prefix, output: at });
    if (prefix + suffix < original.length || prefix + suffix < text.length) {
      this.edits.push({ from: from + prefix, to: to - suffix, text: text.slice(prefix, text.length - suffix) });
    }
    if (suffix) this.retained.push({ from: to - suffix, to, output: at + text.length - suffix });
  }
}
