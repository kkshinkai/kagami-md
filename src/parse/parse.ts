/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  ATXClosingSequenceSyntax, ATXHeadingSyntax, AutolinkSyntax, BackslashEscapeSyntax, BlockQuoteSyntax, BlockSyntax,
  BulletListSyntax, CalloutDeclarationSyntax, CalloutSyntax, CharacterReferenceSyntax, ClauseSyntax,
  CodeSpanSyntax, CollapsedReferenceLinkSyntax, DelimitedSyntax, DelimiterTokenSyntax,
  EmojiShortcodeSyntax, FootnoteDefinitionSyntax, FootnoteReferenceSyntax, FrontMatterSyntax,
  HardLineBreakSyntax, HeadingSyntax, HTMLCommentSyntax, HTMLLineBreakSyntax, HTMLImageSyntax,
  HTMLTagBlockSyntax, ImageSyntax, IndentedCodeBlockSyntax, InlineClauseSyntax, InlineFieldClauseSyntax,
  InlineLinkSyntax, InlineMathSyntax, LinkDestinationSyntax, LinkReferenceDefinitionSyntax, LinkLabelSyntax,
  LinkSyntax, LinkTitleStartSyntax, LinkTitleSyntax, ListItemSyntax, LiteralAutolinkSyntax, LiteralBlockSyntax,
  OrderedListSyntax, PendingATXHeadingMarkerSyntax, PendingBlockQuoteMarkerSyntax,
  PendingCodeFenceSyntax, PendingFootnoteLabelSyntax, PendingHTMLBlockSyntax, PendingListMarkerSyntax,
  PendingMathFenceSyntax, PendingSetextUnderlineSyntax, PendingTableSyntax, PendingThematicBreakSyntax,
  RawFrontMatterSyntax, RawHTMLSyntax, SoftLineBreakSyntax, StringFieldClauseSyntax, TableRowSyntax, TableSyntax,
  TagSyntax, TaskMarkerSyntax, TextBlockSyntax, ThematicBreakSyntax, TokenSyntax, TriviaTokenSyntax,
  WikiEmbedSyntax, WikilinkSyntax, YAMLFrontMatterSyntax, YAMLMappingSyntax, YAMLNodeSyntax, YAMLScalarSyntax,
  YAMLSequenceSyntax, type Frontier, type ReferenceLabels, type Syntax,
} from '../syntax/index.js';
import { Fragment, type Mark, type Node, type Schema } from 'prosemirror-model';
import { editorSpelling, editorType } from './tree.js';

/** Read blocks into a fragment, preserving their source spelling. */
export function parseBlocks(syntax: readonly BlockSyntax[], text: string, schema: Schema): Fragment {
  return Fragment.fromArray(new ParseContext(text, schema).blocks(syntax));
}

/** Read one block, including its fields and the editor's required empty bodies. */
export function parseBlock(syntax: BlockSyntax, text: string, schema: Schema, readings?: Map<Node, ReferenceLabels>): Node {
  return new ParseContext(text, schema, readings).block(syntax);
}

/** Turn a field's frontier into source text carrying occurrence marks. */
export function parseContent(frontier: Frontier, text: string, schema: Schema): Fragment {
  return new ParseContext(text, schema).content(frontier);
}

/** Build a node whose children have already been converted. */
export function parseNode(syntax: Syntax, content: Fragment | readonly Node[], schema: Schema): Node {
  return new ParseContext('', schema).node(syntax, content);
}

/** Front matter holds decoded YAML or a literal field, never Markdown. */
export function parseFrontMatter(syntax: FrontMatterSyntax, schema: Schema): Node {
  return new ParseContext('', schema).frontMatter(syntax);
}

/** The source and schema shared by a syntax-to-document walk. */
class ParseContext {
  constructor(readonly text: string, readonly schema: Schema,
    readonly readings?: Map<Node, ReferenceLabels>) {}

  blocks(syntax: readonly BlockSyntax[]): Node[] {
    return syntax.map(block => this.block(block));
  }

  body(syntax: readonly BlockSyntax[]): Node[] {
    return syntax.length ? this.blocks(syntax) : [this.schema.nodes.paragraph.createChecked()];
  }

  node(syntax: Syntax, content: Fragment | readonly Node[]): Node {
    const type = editorType(syntax, this.schema);
    if (!type) throw new RangeError(`No editor node for ${syntax.type}`);
    const attrs = attributes(syntax, type.spec.attrs);
    const spelling = editorSpelling(syntax);
    if (spelling !== undefined) attrs.spelling = spelling;
    if (syntax instanceof HeadingSyntax) {
      attrs.form = syntax instanceof ATXHeadingSyntax ? 'atx' : 'setext';
    } else if (syntax instanceof IndentedCodeBlockSyntax) {
      attrs.language = null;
      attrs.meta = null;
    } else if (syntax instanceof HTMLTagBlockSyntax) {
      Object.assign(attrs, attributes(syntax.tag, type.spec.attrs), { tag: syntax.tag.type });
    }
    const node = type.createChecked(attrs, content);
    if (syntax instanceof TextBlockSyntax || syntax instanceof InlineFieldClauseSyntax ||
        syntax instanceof StringFieldClauseSyntax) this.readings?.set(node, syntax.references);
    return node;
  }

  block(syntax: BlockSyntax): Node {
    if (syntax instanceof TextBlockSyntax) return this.node(syntax, this.content(syntax.frontier));
    if (syntax instanceof LiteralBlockSyntax) return this.node(syntax, this.literal(syntax.content));
    if (syntax instanceof HTMLTagBlockSyntax) {
      const text = syntax.tag.frontier.map(piece =>
        piece.nodes.at(-1)?.type === 'lineEnding' ? '\n' : this.text.slice(piece.start, piece.end)
      ).join('');
      return this.node(syntax, this.literal(text));
    }
    if (syntax instanceof ThematicBreakSyntax) return this.node(syntax, []);
    if (syntax instanceof BlockQuoteSyntax || syntax instanceof ListItemSyntax) {
      return this.node(syntax, this.body(syntax.children));
    }
    if (syntax instanceof BulletListSyntax || syntax instanceof OrderedListSyntax) {
      return this.node(syntax, this.blocks(syntax.children));
    }
    if (syntax instanceof CalloutSyntax) {
      return this.node(syntax,
        [this.node(syntax.title, this.content(syntax.title.frontier)), ...this.blocks(syntax.children)]);
    }
    if (syntax instanceof FootnoteDefinitionSyntax) {
      return this.node(syntax,
        [this.node(syntax.label, this.content(syntax.label.frontier)), ...this.body(syntax.children)]);
    }
    if (syntax instanceof LinkReferenceDefinitionSyntax) {
      const fields: (LinkLabelSyntax | LinkDestinationSyntax
        | LinkTitleSyntax)[] = [syntax.labelField, syntax.destinationField];
      if (syntax.titleField) fields.push(syntax.titleField);
      return this.node(syntax, fields.map(field => this.node(field, this.content(field.frontier))));
    }
    if (syntax instanceof TableSyntax) {
      return this.node(syntax, [this.row(syntax.headerRow, true), ...syntax.children.map(row => this.row(row, false))]);
    }
    throw new RangeError(`No editor conversion for ${syntax.type}`);
  }

  row(syntax: TableRowSyntax, header: boolean): Node {
    const type = header ? this.schema.nodes.tableHeader : this.schema.nodes.tableCell;
    return this.node(syntax, syntax.children.map(cell => {
      const paragraph = this.schema.nodes.tableParagraph.createChecked(null, this.content(cell.frontier));
      this.readings?.set(paragraph, cell.references);
      return type.createChecked(null, paragraph);
    }));
  }

  literal(text: string): readonly Node[] {
    return text ? [this.schema.text(text)] : [];
  }

  frontMatter(syntax: FrontMatterSyntax): Node {
    if (syntax instanceof RawFrontMatterSyntax) return this.node(syntax, this.literal(syntax.content));
    if (syntax instanceof YAMLFrontMatterSyntax) return this.node(syntax, [this.yaml(syntax.root)]);
    throw new RangeError(`No front matter conversion for ${syntax.type}`);
  }

  yaml(syntax: YAMLNodeSyntax): Node {
    if (syntax instanceof YAMLScalarSyntax) return this.node(syntax, this.literal(syntax.content));
    if (syntax instanceof YAMLSequenceSyntax)
      return this.node(syntax, syntax.children.map(child => this.yaml(child)));
    if (syntax instanceof YAMLMappingSyntax) {
      return this.node(syntax,
        syntax.children.map(pair => this.node(pair, [this.yaml(pair.key), this.yaml(pair.value)])));
    }
    throw new RangeError(`No YAML conversion for ${syntax.type}`);
  }

  content(frontier: Frontier): Fragment {
    const occurrences = new Map<Syntax, Mark>();
    const content: Node[] = [];
    let offset = 0;
    for (const piece of frontier) {
      const marks: Mark[] = [];
      for (const syntax of piece.nodes) {
        if (syntax instanceof TokenSyntax || syntax instanceof ClauseSyntax ||
          syntax instanceof InlineClauseSyntax) continue;
        let mark = occurrences.get(syntax);
        if (!mark) {
          const type = this.schema.marks[syntax.type];
          if (!type) throw new RangeError(`The frontier requires a mark absent from the schema: ${syntax.type}`);
          mark = type.create({ ...attributes(syntax, type.spec.attrs), occurrence: offset });
          occurrences.set(syntax, mark);
        }
        marks.push(mark);
      }
      if (piece.nodes.some((node, index) => metaChild(node, piece.nodes[index + 1])))
        marks.push(this.schema.marks.meta.create());
      const tail = piece.nodes.at(-1);
      if (tail?.type === 'lineEnding' || tail instanceof SoftLineBreakSyntax) {
        content.push(this.schema.nodes.lineEnding.createChecked(null, null, marks));
        offset++;
      } else if (piece.end > piece.start) {
        const value = this.text.slice(piece.start, piece.end);
        content.push(this.schema.text(value, marks));
        offset += value.length;
      }
    }
    return Fragment.fromArray(content);
  }
}

/** Copy the meaning named by the destination spec, leaving defaults to the schema. */
function attributes(value: object, declared: object | undefined): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const source = value as Record<string, unknown>;
  for (const name of Object.keys(declared ?? {})) {
    if (source[name] !== undefined) result[name] = source[name];
  }
  return result;
}

/** Classify each edge on the ancestor path by its grammatical slot. */
function metaChild(node: Syntax, next: Syntax | undefined): boolean {
  if (node instanceof TriviaTokenSyntax) {
    return node.type === 'codeSpanPadding' || node.type === 'inlineMathPadding' ||
      node.type === 'resourceWhitespace' || node.type === 'tablePipeEscape';
  }
  if (node instanceof RawHTMLSyntax || node instanceof HTMLCommentSyntax ||
      node instanceof HTMLLineBreakSyntax || node instanceof HTMLImageSyntax) return false;
  if (node instanceof TokenSyntax || node instanceof SoftLineBreakSyntax ||
      node instanceof LiteralAutolinkSyntax || node instanceof PendingThematicBreakSyntax ||
      node instanceof PendingSetextUnderlineSyntax) return node.tag !== 'Text';
  if (node instanceof ClauseSyntax || node instanceof InlineClauseSyntax) return false;
  if (node instanceof BackslashEscapeSyntax) return next === node.backslash;
  if (node instanceof AutolinkSyntax) return next !== node.address;
  if (node instanceof TagSyntax) return next !== node.name;
  if (node instanceof DelimitedSyntax) return next === node.openingDelimiter || next === node.closingDelimiter;
  if (node instanceof CodeSpanSyntax) return next === node.openingBackticks || next === node.closingBackticks;
  if (node instanceof InlineMathSyntax) return next === node.openingDollars || next === node.closingDollars;
  if (node instanceof LinkSyntax) {
    if (next === node.openingBracket || next === node.closingBracket || next instanceof InlineClauseSyntax)
      return true;
    if (node instanceof InlineLinkSyntax)
      return next === node.openingParenthesis || next === node.closingParenthesis;
    if (node instanceof CollapsedReferenceLinkSyntax)
      return next === node.referenceOpeningBracket || next === node.referenceClosingBracket;
    return false;
  }
  if (node instanceof FootnoteReferenceSyntax)
    return next === node.openingBracket || next === node.caret || next === node.closingBracket;
  if (node instanceof HardLineBreakSyntax) return next === node.marker;
  if (node instanceof WikilinkSyntax || node instanceof WikiEmbedSyntax)
    return next !== (node.alias ?? node.target);
  if (node instanceof PendingCodeFenceSyntax || node instanceof PendingMathFenceSyntax) return true;
  if (node instanceof PendingListMarkerSyntax || node instanceof PendingATXHeadingMarkerSyntax)
    return next === node.marker;
  if (node instanceof PendingBlockQuoteMarkerSyntax)
    return next instanceof DelimiterTokenSyntax && next.type === 'blockQuoteMarker';
  if (node instanceof PendingFootnoteLabelSyntax) return next !== node.label;
  if (node instanceof PendingTableSyntax)
    return next === node.delimiterRow ||
      next instanceof DelimiterTokenSyntax && next.type === 'tableCellDivider';
  if (node instanceof PendingHTMLBlockSyntax) return false;
  if (node instanceof CharacterReferenceSyntax || node instanceof EmojiShortcodeSyntax ||
      node instanceof ImageSyntax || node instanceof TaskMarkerSyntax ||
      node instanceof CalloutDeclarationSyntax || node instanceof ATXClosingSequenceSyntax ||
    node instanceof LinkTitleStartSyntax) return true;
  throw new RangeError(`Unclassified frontier node: ${node.type}`);
}
