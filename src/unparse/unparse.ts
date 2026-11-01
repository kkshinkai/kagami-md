/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { RetainedBlock, RetainedList } from '../source/index.js';
import { fieldSource, frontMatterSource } from '../parse/field.js';
import { Fragment, type Node, type ResolvedPos, type Slice } from 'prosemirror-model';
import { fitsIndentedCode, fitsOnMarkerLine, htmlBlockEnds, longestClosingFence, needsEdgeMark,
  paragraphReactions, repairPhrasing, startsLinkTitle, measureWidth, type CalloutSpelling,
  type FootnoteDefinitionSpelling,
  type MathBlockSpelling, type TableSpelling } from '../syntax/index.js';
import { schema, pendingMarks, type CodeSpelling, type HeadingSpelling } from '../types/schema.js';
import {
  after, atFileStart, blanks, definitionFrames, expressesEmpty, indentation, inlineNode, itemMarker, itemPattern,
  listPattern, quoteMarker
} from './frames.js';
import { frontMatterFence, markerPattern, opensAfterMarker } from './markers.js';
import {
  blockBoundary, boundaryRange, constrainBoundary, requestedBoundary,
  type BoundaryParent
} from './separators.js';
import {
  Closing, type DisambiguationContext, type Opening, type Unparsed
} from './unparsed.js';
import { yaml } from './yaml.js';

/** Write a block's body and its exposure to neighboring blocks. */
export function unparse(node: Node, context: DisambiguationContext): Unparsed {
  return new UnparseContext(false).block(node, context);
}

export namespace unparse {
  /** Write a block as the only block of a file, as an export shows its source. */
  export function alone(node: Node): Unparsed {
    return unparse(node, {
      column: 0, laterColumn: 0, preceding: null, followed: false, terminated: false,
      parent: schema.nodes.document.create(null, node), index: 0, loose: true,
    });
  }

  /**
   * The blank lines between two adjacent units: what their nodes record, kept within the range
   * that preserves both readings.
   *
   * @param list The list both are items of, or null at the top level.
   */
  export function separator(left: RetainedBlock | RetainedList, right: RetainedBlock | RetainedList,
    list: Node | null): number {
    const loose = list?.attrs.spelling?.tight === false;
    const parent = list ? { sameList: true, loose }
      : 'items' in right ? { sameList: false, loose: true,
        marker: itemMarker(right.node, right.node.firstChild!, 0, listPattern(right.node, left.closing.openList)) }
      : null;
    const range = blockBoundary(right.node, left.closing, right.opening, parent);
    if (!range) throw new RangeError('The units have no boundary that preserves their reading');
    return constrainBoundary(requestedBoundary(left.node, right.node, list ? Number(loose) : 1), range);
  }

  /**
   * Write a slice for the clipboard: in its own spelling, from no kept source, and with no edge
   * mark. The clipboard is no file: where a paragraph standing alone would read as something
   * else, its text is written with the backslash the tree would take (`foo` over `\\===`).
   *
   * @param slice A slice of a document.
   * @param from Where it was taken from: a value of a YAML sequence is written as an item of one, `- one`.
   * @returns Its Markdown.
   */
  export function slice(slice: Slice, from: ResolvedPos): string {
    let content = slice.content;
    for (let open = Math.min(slice.openStart, slice.openEnd); open && content.childCount === 1; open--)
      content = content.firstChild!.content;
    if (content.firstChild?.isInline) return content.content.map(inlineNode).join('');
    if (from.parent.type === schema.nodes.yamlSequence &&
        content.content.every(node => node.type.isInGroup('yamlNode')))
      content = Fragment.from(from.parent.type.create(null, content));
    // The slice stands as a document of its own.
    return new UnparseContext(true).sequence({
      column: 0, laterColumn: 0, preceding: null, followed: false, terminated: false,
      parent: schema.nodes.document.create(null, content), index: 0, loose: true,
    }, 1, false).body;
  }
}

/** Settings shared by a walk over the supplied document nodes. */
class UnparseContext {
  constructor(readonly clipboard: boolean) {}

  block(node: Node, context: DisambiguationContext): Unparsed {
    const margin = blockMargin(node, context);
    const column = context.column + margin.length;
    switch (node.type) {
      case schema.nodes.paragraph: return this.paragraph(node, context, margin);
      case schema.nodes.heading: return this.heading(node, margin, column);
      case schema.nodes.codeBlock: return this.code(node, context, margin);
      case schema.nodes.mathBlock: return this.math(node, context, margin);
      case schema.nodes.htmlBlock:
      case schema.nodes.htmlTagBlock: {
        const condition = node.type === schema.nodes.htmlTagBlock ? 7 : node.attrs.startCondition;
        const end = htmlBlockEnds(node.textContent, condition);
        return written(margin + node.textContent, 'html', column, condition !== 7,
          { ...Closing.none, leaf: condition <= 5 && end !== null ? 'none' : 'html' });
      }
      case schema.nodes.thematicBreak:
        // Kept from front matter at the start of the file (private-docs/design/influences.md, I5).
        return fenceOpening(written(margin + (!this.clipboard && atFileStart(context.parent, context.index) ? '----' : '---'),
          'thematicBreak', column, false));
      case schema.nodes.blockQuote: return this.quote(node, context, margin);
      case schema.nodes.callout: return this.callout(node, context, margin);
      case schema.nodes.bulletList:
      case schema.nodes.orderedList: return this.list(node, context);
      case schema.nodes.listItem: return new ItemContext(this, node, context, margin).write();
      case schema.nodes.footnoteDefinition: return this.footnote(node, context, margin);
      case schema.nodes.linkReferenceDefinition: {
        const frames = definitionFrames(node);
        let body = margin;
        for (let index = 0; index < node.childCount; index++) {
          const frame = frames[index]!;
          body += frame.before + fieldSource(node.child(index)) + frame.after;
        }
        return written(body, 'definition', column, false,
          { ...Closing.none, leaf: node.childCount === 3 ? 'definitionComplete' : 'definition' });
      }
      case schema.nodes.table:
        return written(this.table(node, margin), 'table', column, true, { ...Closing.none, leaf: 'table' });
      case schema.nodes.tableParagraph:
      case schema.nodes.calloutTitle:
      case schema.nodes.linkLabel:
      case schema.nodes.linkDestination:
      case schema.nodes.linkTitle:
      case schema.nodes.footnoteLabel:
        return written(fieldSource(node), 'text', column, false);
      case schema.nodes.rawFrontMatter:
        return written(frontMatterSource(node), 'thematicBreak', column, true);
      case schema.nodes.yamlFrontMatter:
        return written(yaml.frontMatter(node), 'thematicBreak', column, true);
      case schema.nodes.yamlMapping:
      case schema.nodes.yamlSequence:
      case schema.nodes.yamlScalar:
      case schema.nodes.yamlPair:
        return written(yaml(node), 'text', column, false);
      default:
        throw new RangeError(`No Markdown unparser for ${node.type.name}`);
    }
  }

  /**
   * Write the children of `first.parent` from `first.index` on, the first at `first`.
   *
   * @param framed Whether the parent's leading blank lines are written before them.
   */
  sequence(first: DisambiguationContext, defaultGap: number, framed: boolean): Unparsed {
    const nodes = first.parent.content.content.slice(first.index);
    const parts: string[] = [];
    let opening: Opening | null = null;
    let closing = first.preceding;
    for (let index = 0; index < nodes.length; index++) {
      const node = nodes[index]!;
      const follows = index + 1 < nodes.length;
      const part = this.block(node, {
        ...first,
        column: index ? first.laterColumn : first.column,
        preceding: closing,
        followed: follows || first.followed,
        terminated: follows || first.terminated,
        index: first.index + index,
      });
      if (index) parts.push(separator(nodes[index - 1]!, node, closing, part.opening, defaultGap));
      else if (framed) {
        const empty = nodes.length === 1 && node.type === schema.nodes.paragraph && !node.content.size;
        parts.push('\n'.repeat(Math.max(0, blanks(first.parent, 'start') - Number(empty))));
      }
      parts.push(childBody(node, part.body));
      if (!opening) opening = part.opening;
      closing = part.closing;
    }
    return { body: parts.join(''), opening, closing: closing ?? Closing.none };
  }

  private paragraph(node: Node, context: DisambiguationContext, margin: string): Unparsed {
    let text = fieldSource(node);
    if (this.clipboard) {
      for (const repair of repairPhrasing(text, 'paragraph', { escapeBlocks: true }).reverse())
        text = text.slice(0, repair.start) + repair.insert + text.slice(repair.end);
    }
    const { parent, index } = context;
    const edge = !this.clipboard && (text || !expressesEmpty(parent, index)) && needsEdgeMark(text, 'paragraph', {
      taskMarker: index === 0 && parent.type === schema.nodes.listItem && parent.attrs.checked === null,
      calloutDeclaration: index === 0 && parent.type === schema.nodes.blockQuote,
    }) ? '\u200b' : '';
    const pending = pendingLines(node);
    const reactions = new Set(paragraphReactions(text, context.laterColumn).filter(line => !pending.has(line)));
    const lines = text.split('\n');
    for (let index = 0; index < lines.length; index++) if (reactions.has(index)) lines[index] = '    ' + lines[index];
    let body = margin + edge + lines.join('\n');
    // A transient terminal paragraph break becomes the last line's ending at a following boundary.
    if (context.followed && text.endsWith('\n')) body = body.slice(0, -1);
    if (!body) return { body, opening: null, closing: Closing.none };
    return fenceOpening(written(body, startsLinkTitle(text) && !edge ? 'linkTitle' : 'text',
      context.column + margin.length, false, { ...Closing.none, leaf: 'paragraph' }));
  }

  private heading(node: Node, margin: string, column: number): Unparsed {
    const spelling: HeadingSpelling | null = node.attrs.spelling;
    const text = fieldSource(node);
    const atx = node.attrs.form === 'atx';
    const kind = atx ? 'atxHeading' : 'paragraph';
    const edge = !this.clipboard && (text || !atx) && needsEdgeMark(text, kind) ? '\u200b' : '';
    if (atx) {
      const close = spelling?.closingSequence;
      const head = '#'.repeat(node.attrs.level) + (spelling?.whitespaceAfterMarker || (text ? ' ' : ''));
      return written(margin + head + edge + text + (close ? close.whitespaceBefore + close.sequence : ''),
        'atxHeading', column, true);
    }
    const underline = spelling?.underline;
    const width = underline && !underline.matchesText
      ? underline.length : Math.max(1, ...text.split('\n').map(line => measureWidth(line).width));
    return fenceOpening(written(margin + edge + text + '\n' + (node.attrs.level === 1 ? '=' : '-').repeat(width),
      startsLinkTitle(text) ? 'linkTitle' : 'text', column, false));
  }

  private fenced(node: Node, opening: string, closing: string | null, margin: string,
    context: DisambiguationContext): Unparsed {
    const text = node.textContent;
    const padding = continuationMargin(context, margin);
    let body = margin + opening;
    if (text || closing !== null) body += '\n';
    if (text) body += text.split('\n').map(line => padding + line).join('\n');
    if (closing !== null) body += (text ? '\n' : '') + closing;
    return written(body, 'fence', context.column + margin.length, true,
      { ...Closing.none, leaf: closing === null ? 'fence' : 'none' });
  }

  private code(node: Node, context: DisambiguationContext, margin: string): Unparsed {
    const spelling: CodeSpelling | null = node.attrs.spelling;
    const language: string | null = node.attrs.language;
    const meta: string | null = node.attrs.meta;
    const text = node.textContent;
    const opening: Opening = { kind: 'indentedCode', column: context.column + 4,
      interruptsParagraph: false, frontMatter: null };
    if (indentedCode(node) &&
      boundaryRange(context.preceding, opening, { sameList: false, loose: context.loose }) !== null) {
      const body = text.split('\n').map(line => line ? '    ' + line : '').join('\n');
      return written(body, 'indentedCode', opening.column, false, { ...Closing.none, leaf: 'indentedCode' });
    }
    const saved = spelling?.fence;
    const column = context.laterColumn + continuationMargin(context, margin).length;
    const useTilde = language?.includes('`') || meta?.includes('`') ||
      !saved && language && longestClosingFence(text, '`', column) >= 3;
    const fence = closingFence(useTilde ? '~~~' : saved?.fence ?? '```', text, 3, column);
    const info = (language ?? '').replace(/\\/g, '\\\\').replace(/&/g, '&amp;') + (meta ? ' ' + meta : '');
    const close = fenceClose(saved?.closingFence, fence, text, context);
    return this.fenced(node, fence + (saved?.whitespaceAfterFence ?? '') + info,
      close === null ? null : ' '.repeat(saved?.spacesBeforeClosingFence ?? 0) + close, margin, context);
  }

  private math(node: Node, context: DisambiguationContext, margin: string): Unparsed {
    const spelling: MathBlockSpelling | null = node.attrs.spelling;
    const column = context.laterColumn + continuationMargin(context, margin).length;
    const fence = closingFence(spelling?.fence ?? '$$', node.textContent, 2, column);
    const close = fenceClose(spelling?.closingFence, fence, node.textContent, context);
    return this.fenced(node, fence + (spelling?.whitespaceAfterFence ?? '') + (spelling?.meta ?? ''),
      close === null ? null : ' '.repeat(spelling?.spacesBeforeClosingFence ?? 0) + close, margin, context);
  }

  private quote(node: Node, context: DisambiguationContext, margin: string): Unparsed {
    const gap: string = node.attrs.spelling?.whitespaceAfterMarker ?? ' ';
    const prefixes: QuotePrefixes = {
      first: margin + quoteMarker(gap, context.column + margin.length),
      later: quoteMarker(gap, context.laterColumn),
    };
    const body = new QuoteContext(this, node, context, prefixes).write(0);
    return written(body.body, 'blockQuote', context.column + margin.length, opensAfterMarker(body.opening),
      { ...Closing.none, leaf: blanks(node, 'end') ? 'none' : Closing.paragraph(body.closing.leaf), openQuote: true });
  }

  private callout(node: Node, context: DisambiguationContext, margin: string): Unparsed {
    const spelling: CalloutSpelling | null = node.attrs.spelling;
    const calloutType: string = node.attrs.calloutType;
    const title = node.child(0);
    const gap: string = spelling?.whitespaceAfterMarker ?? ' ';
    const first = margin + quoteMarker(gap, context.column + margin.length);
    const later = quoteMarker(gap, context.laterColumn);
    const declaration = spelling?.declaration?.toLowerCase() === `[!${calloutType}]`
      ? spelling.declaration : `[!${calloutType.toUpperCase()}]`;
    let text = first + declaration + (spelling?.whitespaceAfterDeclaration || (title.content.size ? ' ' : ''))
      + fieldSource(title);
    const body = new QuoteContext(this, node, { ...context, column: context.laterColumn },
      { first: later, later }).write(1);
    if (node.childCount > 1) text += '\n' + body.body;
    else text += ('\n' + bareQuote(later)).repeat(blanks(node, 'end'));
    const leaf = blanks(node, 'end') || node.childCount === 1 ? 'none' : Closing.paragraph(body.closing.leaf);
    return written(text, 'blockQuote', context.column + margin.length, true,
      { ...Closing.none, leaf, openQuote: true });
  }

  private list(node: Node, context: DisambiguationContext): Unparsed {
    const loose = node.attrs.spelling?.tight === false;
    const parts: string[] = [];
    let opening: Opening | null = null;
    let closing = context.preceding;
    for (let index = 0; index < node.childCount; index++) {
      const child = node.child(index);
      const follows = index + 1 < node.childCount;
      const part = this.block(child, {
        column: index ? context.laterColumn : context.column,
        laterColumn: context.laterColumn,
        preceding: closing,
        followed: follows || context.followed,
        terminated: follows || blanks(node, 'end') > 0 || context.terminated,
        parent: node, index, loose,
      });
      if (index) parts.push(separator(node.child(index - 1), child, closing, part.opening,
        Number(loose), { sameList: true, loose }));
      parts.push(part.body);
      if (!opening) opening = part.opening;
      closing = part.closing;
    }
    return { body: parts.join(''), opening, closing: closing ?? Closing.none };
  }

  private footnote(node: Node, context: DisambiguationContext, margin: string): Unparsed {
    const spelling: FootnoteDefinitionSpelling | null = node.attrs.spelling;
    const head = '[^' + fieldSource(node.child(0)) + ']:';
    const gap: string = spelling?.whitespaceAfterLabel ?? ' ';
    const first = node.child(1);
    const marginAffectsBody = first.type === schema.nodes.codeBlock || first.type === schema.nodes.mathBlock ||
      first.type.isInGroup('list');
    const compact = spelling?.startsOnLabelLine !== false && !indentedCode(first) &&
      !(marginAffectsBody && openingIndent(first) > 0);
    const continuation = Math.max(4, spelling?.continuationIndent ?? 4);
    const childColumn = compact ? after(margin + head + gap, context.column) : context.laterColumn + 4;
    const body = this.sequence({
      column: childColumn, laterColumn: context.laterColumn + continuation,
      preceding: null, followed: false, terminated: context.terminated,
      parent: node, index: 1, loose: true,
    }, 1, true);
    // The label owns all opening whitespace; the child's Opening identifies only structural margin.
    const ownedMargin = compact && body.opening ? body.opening.column - childColumn : 0;
    const text = margin + head + (compact ? gap : '\n    ') +
      prefix(body.body.slice(ownedMargin), '', ' '.repeat(continuation), '', '');
    return written(text, 'footnoteDefinition', context.column + margin.length,
      !compact || opensAfterMarker(body.opening),
      { ...body.closing, continuation: context.laterColumn + 4, openList: null, openQuote: false });
  }

  private table(node: Node, margin: string): string {
    const rows = node.content.content;
    const spelling: TableSpelling | null = node.attrs.spelling;
    const count = Math.max(0, ...rows.map(row => row.childCount));
    const alignments: Array<string | null> = Array.from({ length: count },
      (_, index) => node.attrs.alignments[index] ?? null);
    const widths = alignments.map((alignment, index) => Math.max(delimiterWidth(alignment),
      ...rows.map(row => measureWidth(row.maybeChild(index) ? fieldSource(row.child(index).child(0)) : '').width)));
    const padding: string = spelling?.cellPadding ?? 'oneSpace';
    const enclosed = (spelling?.enclosedInPipes ?? true) || count === 1;
    const lines: string[] = [];
    for (let index = 0; index < rows.length; index++) {
      const cells = rows[index]!.content.content.map((cell, column) => {
        const text = fieldSource(cell.child(0));
        const edge = !this.clipboard && text && needsEdgeMark(text, 'tableCell') ? '\u200b' : '';
        let result = (padding === 'none' ? '' : ' ') + edge + text;
        if (padding === 'aligned') result += ' '.repeat(widths[column]! - measureWidth(text).width);
        return result + (padding === 'none' ? '' : ' ');
      });
      lines.push(tableRow(cells, enclosed));
      if (index) continue;
      const delimiter = alignments.map((alignment, column) => {
        const left = alignment === 'left' || alignment === 'center' ? ':' : '';
        const right = alignment === 'right' || alignment === 'center' ? ':' : '';
        const width = padding === 'aligned' ? widths[column]! - left.length - right.length : 3;
        const text = left + '-'.repeat(width) + right;
        return padding === 'none' ? text : ' ' + text + ' ';
      });
      lines.push(tableRow(delimiter, enclosed));
    }
    return margin + lines.join('\n');
  }
}

interface QuotePrefixes {
  readonly first: string;
  readonly later: string;
}

/** Quote indentation and sibling exposure while writing one quote's children. */
class QuoteContext {
  private closing: Closing | null = null;
  private closingColumn: number;

  constructor(readonly writer: UnparseContext, readonly owner: Node, readonly context: DisambiguationContext,
    readonly prefixes: QuotePrefixes) {
    this.closingColumn = context.laterColumn;
  }

  /** Write the owner's children from `from` on at the quote's columns, retaining the protective-prefix retry. */
  write(from: number): Unparsed {
    const nodes = this.owner.content.content.slice(from);
    const parts: string[] = [];
    const empty = nodes.length === 1 && nodes[0]!.type === schema.nodes.paragraph && !nodes[0]!.content.size;
    const leading = Math.max(0, blanks(this.owner, 'start') - Number(empty));
    const firstBlank = bareQuote(this.prefixes.first);
    const laterBlank = bareQuote(this.prefixes.later);
    if (leading) parts.push(firstBlank + '\n', (laterBlank + '\n').repeat(leading - 1));
    let opening: Opening | null = null;
    for (let index = 0; index < nodes.length; index++) {
      const node = nodes[index]!;
      const atStart = index === 0 && leading === 0;
      const column = atStart ? this.context.column : this.context.laterColumn;
      let first = atStart ? this.prefixes.first : this.prefixes.later;
      let later = alignLiteralPrefix(node, first, this.prefixes.later, column, this.context.laterColumn);
      const follows = index + 1 < nodes.length;
      let part = this.child(node, from + index, first, later, column, follows);
      const lines = childBody(node, part.body).split('\n');
      const protectFirst = first.endsWith('>') && /^[ \t]/.test(lines[0]!);
      const protectLater = later.endsWith('>') && lines.slice(1).some(line => /^[ \t]/.test(line));
      if (protectFirst || protectLater) {
        if (protectFirst) first += ' ';
        later = this.prefixes.later + (protectLater ? ' ' : '');
        later = alignLiteralPrefix(node, first, later, column, this.context.laterColumn);
        part = this.child(node, from + index, first, later, column, follows);
      }
      const preceding = shiftClosing(this.closing, after(first, column) - this.closingColumn);
      if (index) {
        const gap = separator(nodes[index - 1]!, node, preceding, part.opening, 1);
        parts.push('\n', (laterBlank + '\n').repeat(gap.length - 1));
      }
      parts.push(prefix(childBody(node, part.body), first, later, atStart ? firstBlank : laterBlank, laterBlank));
      if (!opening) opening = part.opening;
      this.closing = part.closing;
      this.closingColumn = after(later, this.context.laterColumn);
    }
    parts.push(('\n' + laterBlank).repeat(blanks(this.owner, 'end')));
    return { body: parts.join(''), opening, closing: this.closing ?? Closing.none };
  }

  private child(node: Node, index: number, first: string, later: string, column: number,
    followed: boolean): Unparsed {
    const childColumn = after(first, column);
    return this.writer.block(node, {
      column: childColumn,
      laterColumn: after(later, this.context.laterColumn),
      preceding: shiftClosing(this.closing, childColumn - this.closingColumn),
      followed,
      terminated: followed || blanks(this.owner, 'end') > 0 || this.context.terminated,
      parent: this.owner, index, loose: true,
    });
  }
}

interface ItemChild {
  readonly node: Node;
  readonly part: Unparsed;
  readonly continuation: number;
  readonly preceding: Closing | null;
}

/** Marker, indentation and tightness shared by an item's children. */
class ItemContext {
  /** The marker its list gives it; an item outside a list, as on the clipboard, keeps its own. */
  readonly marker: string;
  readonly loose: boolean;
  readonly gap: string;
  readonly check: string;
  readonly head: string;

  constructor(readonly writer: UnparseContext, readonly node: Node, readonly context: DisambiguationContext,
    readonly margin: string) {
    const list = context.parent.type.isInGroup('list') ? context.parent : null;
    this.marker = list ? itemMarker(list, node, context.index, itemPattern(list, context.index, context.preceding))
      : node.attrs.spelling?.marker ?? '-';
    this.loose = list ? context.loose : false;
    this.gap = node.attrs.spelling?.whitespaceAfterMarker || ' ';
    this.check = taskCheck(node.attrs.checked);
    this.head = this.marker + this.gap + this.check;
  }

  write(): Unparsed {
    const emptyChild = this.node.childCount === 1 && !this.node.child(0).content.size;
    // An empty marker may have one line ending before its first child. Further
    // recorded blank lines cannot be written without closing the item.
    const openingBreak = blanks(this.node, 'start') > Number(emptyChild);
    const markerLine = this.node.attrs.spelling?.startsOnMarkerLine !== false;
    let compact = markerLine && !openingBreak;
    let body = this.body(compact, this.loose);
    if (compact && !fitsOnMarkerLine(this.margin + this.head, body.body.split('\n', 1)[0]!, this.context.column)) {
      compact = false;
      body = this.body(false, this.loose);
    }
    const columns = this.columns(compact);
    const marker = this.marker;
    const markerGap = openingBreak && markerLine ? this.gap : '';
    const text = compact ? this.margin + this.head + body.body
      : this.margin + marker + markerGap + '\n' + ' '.repeat(columns) + this.check + body.body;
    const checked: boolean | null = this.node.attrs.checked;
    const empty = !body.opening && checked === null;
    const interrupts = compact && !empty && (marker.length === 1 || marker.slice(0, -1) === '1') &&
      opensAfterMarker(body.opening);
    return written(text, 'listItem', this.context.column + this.margin.length, interrupts, {
      leaf: checked !== null && this.node.childCount === 1 ? 'paragraph' : body.closing.leaf,
      continuation: this.context.laterColumn + columns,
      openList: markerPattern(marker), openQuote: false,
    });
  }

  private body(compact: boolean, loose: boolean): Unparsed {
    const columns = this.columns(compact);
    const children: ItemChild[] = [];
    const checked: boolean | null = this.node.attrs.checked;
    let closing: Closing | null = null;
    let opening: Opening | null = null;
    for (let index = 0; index < this.node.childCount; index++) {
      const child = this.node.child(index);
      const continuation = child.type === schema.nodes.paragraph
        ? Math.max(columns, this.node.attrs.spelling?.continuationIndent ?? columns) : columns;
      const firstColumn = index || !compact
        ? this.context.laterColumn + columns : after(this.margin + this.head, this.context.column);
      const follows = index + 1 < this.node.childCount;
      const part = this.writer.block(child, {
        column: firstColumn, laterColumn: this.context.laterColumn + continuation,
        preceding: closing, followed: follows, terminated: follows || this.context.terminated,
        parent: this.node, index, loose,
      });
      if (index && !loose && blockBoundary(child, closing, part.opening, { sameList: false, loose }) === null &&
        blockBoundary(child, closing, part.opening, { sameList: false, loose: true }) !== null)
        return this.body(compact, true);
      children.push({ node: child, part, continuation, preceding: closing });
      if (!opening) opening = part.opening;
      closing = index === 0 && checked !== null && !part.opening
        ? { ...Closing.none, leaf: 'paragraph' } : part.closing;
    }
    const parts: string[] = [];
    for (let index = 0; index < children.length; index++) {
      const child = children[index]!;
      if (index) parts.push(separator(children[index - 1]!.node, child.node, child.preceding, child.part.opening,
        Number(this.loose), { sameList: false, loose }), ' '.repeat(columns));
      parts.push(prefix(childBody(child.node, child.part.body), '', ' '.repeat(child.continuation), '', ''));
    }
    return { body: parts.join(''), opening, closing: closing ?? Closing.none };
  }

  /** Whitespace before the child's first token participates in its item's indentation. */
  private columns(compact: boolean): number {
    const padding = this.node.attrs.checked === null ? openingIndent(this.node.child(0)) : 0;
    const at = this.context.column + this.margin.length + this.marker.length;
    const width = after(this.gap + ' '.repeat(padding), at) - at;
    return continuationMargin(this.context,
      this.margin).length + this.marker.length + (compact && width <= 4 ? width : 1);
  }
}

/** A nonempty body with an opening and, by default, no continuation. */
function written(body: string, kind: Opening.Kind, column: number, interruptsParagraph: boolean,
  closing: Closing = Closing.none): Unparsed {
  return { body, opening: { kind, column, interruptsParagraph, frontMatter: null }, closing };
}

/**
 * A thematic break, paragraph or Setext heading, which can stand first in a file: its opening
 * records the front matter fence its first line is (private-docs/design/influences.md, I5).
 */
function fenceOpening(written: Unparsed): Unparsed {
  return written.opening ? { ...written, opening: { ...written.opening, frontMatter: frontMatterFence(written.body) } }
    : written;
}

/** The recorded sibling gap constrained by the grammar's boundary range. */
function separator(previous: Node, next: Node, closing: Closing | null, opening: Opening | null,
  defaultGap: number, parent: BoundaryParent | null = null): string {
  const requested = requestedBoundary(previous, next, defaultGap);
  let range = blockBoundary(next, closing, opening, parent);
  if (!range && parent && !parent.loose) range = blockBoundary(next, closing, opening, { ...parent, loose: true });
  if (!range) throw new RangeError('The written blocks have no boundary that preserves their reading');
  return '\n'.repeat(1 + constrainBoundary(requested, range));
}

/** First-line indentation that does not continue a preceding container. */
function blockMargin(node: Node, context: DisambiguationContext): string {
  const margin = indentation(node);
  // An item after an item of its list is not inside it.
  if (node.type === schema.nodes.listItem && context.parent.type.isInGroup('list') && context.index > 0)
    return margin;
  const continuation = context.preceding?.continuation;
  if (continuation != null && context.column + margin.length >= continuation)
    return ' '.repeat(Math.max(0, continuation - context.column - 1));
  return margin;
}

/** Whether a code field still fits its recorded indented form. */
function indentedCode(node: Node): boolean {
  return node.type === schema.nodes.codeBlock && node.attrs.spelling?.fence === null &&
    !node.attrs.language && !node.attrs.meta && fitsIndentedCode(node.textContent);
}

/** The shortest permitted fence at least as long as the recorded one. */
function closingFence(preferred: string, text: string, minimum: number, column: number): string {
  const marker = preferred[0];
  if (marker !== '`' && marker !== '~' && marker !== '$') throw new RangeError('Invalid fence character');
  const length = Math.max(minimum, preferred.length, longestClosingFence(text, marker, column) + 1);
  return marker.repeat(length);
}

/** Prefix every physical line, using each ancestor's empty-line form where needed. */
function prefix(text: string, first: string, later: string, emptyFirst: string, emptyLater: string): string {
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const nonempty = index ? later : first;
    const empty = index ? emptyLater : emptyFirst;
    lines[index] = (line ? nonempty : empty) + line;
  }
  return lines.join('\n');
}

/** Quote-owned whitespace moves the physical origin of its children's indentation. */
function shiftClosing(closing: Closing | null, columns: number): Closing | null {
  if (closing?.continuation == null || !columns) return closing;
  return { ...closing, continuation: closing.continuation + columns };
}

/** Physical paragraph lines whose block reading is intentionally pending. */
function pendingLines(node: Node): Set<number> {
  const result = new Set<number>();
  let line = 0;
  for (const child of node.content.content) {
    if (child.marks.some(mark => pendingMarks.has(mark.type))) result.add(line);
    if (child.type === schema.nodes.lineEnding) line++;
    else if (child.isText) line += child.text!.split('\n').length - 1;
  }
  return result;
}

/** The first token's structural indentation before an item's own prefix. */
function openingIndent(node: Node): number {
  if (node.type.isInGroup('list')) return openingIndent(node.child(0));
  return indentedCode(node) ? 4 : indentation(node).length;
}

/** A wider continuation prefix already owns that part of the first line's margin. */
function continuationMargin(context: DisambiguationContext, margin: string): string {
  const occupied = Math.max(0, context.laterColumn - context.column);
  return ' '.repeat(Math.max(0, margin.length - occupied));
}

/** Keep an open or recorded closer only while it preserves the field and its extent. */
function fenceClose(saved: string | null | undefined, fence: string, text: string,
  context: DisambiguationContext): string | null {
  // The last field newline needs a further physical ending when the fence stays open.
  if (saved === null && !context.followed && (context.terminated || !text.endsWith('\n'))) return null;
  return saved && saved[0] === fence[0] && saved.length >= fence.length ? saved : fence;
}

/** A list item's optional task marker. */
function taskCheck(checked: boolean | null): string {
  if (checked === null) return '';
  return checked ? '[x] ' : '[ ] ';
}

/** The minimal delimiter cell width including its alignment colons. */
function delimiterWidth(alignment: string | null): number {
  if (alignment === 'center') return 5;
  return alignment ? 4 : 3;
}

/** A table row's cell separators and optional edge pipes. */
function tableRow(cells: readonly string[], enclosed: boolean): string {
  const pipe = enclosed ? '|' : '';
  return pipe + cells.join('|') + pipe;
}

/** Literal tabs retain their phase when an ancestor's continuation prefix changes. */
function literalTabs(node: Node): boolean {
  switch (node.type) {
    case schema.nodes.codeBlock:
    case schema.nodes.mathBlock:
    case schema.nodes.htmlBlock:
    case schema.nodes.htmlTagBlock:
      return node.textContent.split('\n').some(line => /^[ \t]*\t/.test(line));
    default:
      return node.content.content.some(literalTabs);
  }
}

/** Align the continuation prefix to the first prefix when a literal contains tabs. */
function alignLiteralPrefix(node: Node, first: string, later: string, column: number, laterColumn: number): string {
  if (!literalTabs(node)) return later;
  const difference = (after(first, column) - after(later, laterColumn) + 4) % 4;
  return ' '.repeat(difference) + later;
}

/** A quote's marker without its content whitespace. */
function bareQuote(prefix: string): string {
  return prefix.slice(0, prefix.indexOf('>') + 1);
}

/** A list owns edge blank rows but writes no syntax of its own on them. */
function childBody(node: Node, body: string): string {
  if (!node.type.isInGroup('list')) return body;
  return '\n'.repeat(blanks(node, 'start')) + body + '\n'.repeat(blanks(node, 'end'));
}
