/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import * as Syntax from '../syntax/index.js';
import { Fragment, type Mark, type Node, type Schema } from 'prosemirror-model';
import { editorSpelling, editorType } from './tree.js';

/** Turn a document read for the editor into its ProseMirror document. */
export function parse(syntax: Syntax.DocumentSyntax, text: string, schema: Schema): Node {
  return new ParseContext(text, schema).document(syntax);
}

export namespace parse {
  /** Read blocks into a fragment, preserving their source spelling. */
  export function blocks(syntax: readonly Syntax.BlockSyntax[], text: string, schema: Schema): Fragment {
    return Fragment.fromArray(new ParseContext(text, schema).blocks(syntax));
  }

  /** Read one block, including its fields and the editor's required empty bodies. */
  export function block(syntax: Syntax.BlockSyntax, text: string, schema: Schema, readings?: Map<Node, Syntax.ReferenceLabels>): Node {
    return new ParseContext(text, schema, readings).block(syntax);
  }

  /** Turn a field's frontier into source text carrying occurrence marks. */
  export function content(frontier: Syntax.Frontier, text: string, schema: Schema): Fragment {
    return new ParseContext(text, schema).content(frontier);
  }

  /** Build a node whose children have already been converted. */
  export function node(syntax: Syntax.Syntax, content: Fragment | readonly Node[], schema: Schema): Node {
    return new ParseContext('', schema).node(syntax, content);
  }

  /** Front matter holds decoded YAML or a literal field, never Markdown. */
  export function frontMatter(syntax: Syntax.FrontMatterSyntax, schema: Schema): Node {
    return new ParseContext('', schema).frontMatter(syntax);
  }
}

/** The source and schema shared by a syntax-to-document walk. */
class ParseContext {
  constructor(readonly text: string, readonly schema: Schema,
    readonly readings?: Map<Node, Syntax.ReferenceLabels>) {}

  document(syntax: Syntax.DocumentSyntax): Node {
    const children = this.body(syntax.children);
    if (syntax.frontMatter) children.unshift(this.frontMatter(syntax.frontMatter));
    return this.node(syntax, children);
  }

  blocks(syntax: readonly Syntax.BlockSyntax[]): Node[] {
    return syntax.map(block => this.block(block));
  }

  body(syntax: readonly Syntax.BlockSyntax[]): Node[] {
    return syntax.length ? this.blocks(syntax) : [this.schema.nodes.paragraph.createChecked()];
  }

  node(syntax: Syntax.Syntax, content: Fragment | readonly Node[]): Node {
    const type = editorType(syntax, this.schema);
    if (!type) throw new RangeError(`No editor node for ${syntax.type}`);
    const attrs = attributes(syntax, type.spec.attrs);
    const spelling = editorSpelling(syntax);
    if (spelling !== undefined) attrs.spelling = spelling;
    if (syntax instanceof Syntax.HeadingSyntax) {
      attrs.form = syntax instanceof Syntax.ATXHeadingSyntax ? 'atx' : 'setext';
    } else if (syntax instanceof Syntax.IndentedCodeBlockSyntax) {
      attrs.language = null;
      attrs.meta = null;
    } else if (syntax instanceof Syntax.HTMLTagBlockSyntax) {
      Object.assign(attrs, attributes(syntax.tag, type.spec.attrs), { tag: syntax.tag.type });
    }
    const node = type.createChecked(attrs, content);
    if (syntax instanceof Syntax.TextBlockSyntax || syntax instanceof Syntax.InlineFieldClauseSyntax ||
        syntax instanceof Syntax.StringFieldClauseSyntax) this.readings?.set(node, syntax.references);
    return node;
  }

  block(syntax: Syntax.BlockSyntax): Node {
    if (syntax instanceof Syntax.TextBlockSyntax) return this.node(syntax, this.content(syntax.frontier));
    if (syntax instanceof Syntax.LiteralBlockSyntax) return this.node(syntax, this.literal(syntax.content));
    if (syntax instanceof Syntax.HTMLTagBlockSyntax) {
      const text = syntax.tag.frontier.map(piece =>
        piece.nodes.at(-1)?.type === 'lineEnding' ? '\n' : this.text.slice(piece.start, piece.end)
      ).join('');
      return this.node(syntax, this.literal(text));
    }
    if (syntax instanceof Syntax.ThematicBreakSyntax) return this.node(syntax, []);
    if (syntax instanceof Syntax.BlockQuoteSyntax || syntax instanceof Syntax.ListItemSyntax) {
      return this.node(syntax, this.body(syntax.children));
    }
    if (syntax instanceof Syntax.BulletListSyntax || syntax instanceof Syntax.OrderedListSyntax) {
      return this.node(syntax, this.blocks(syntax.children));
    }
    if (syntax instanceof Syntax.CalloutSyntax) {
      return this.node(syntax,
        [this.node(syntax.title, this.content(syntax.title.frontier)), ...this.blocks(syntax.children)]);
    }
    if (syntax instanceof Syntax.FootnoteDefinitionSyntax) {
      return this.node(syntax,
        [this.node(syntax.label, this.content(syntax.label.frontier)), ...this.body(syntax.children)]);
    }
    if (syntax instanceof Syntax.LinkReferenceDefinitionSyntax) {
      const fields: (Syntax.LinkLabelSyntax | Syntax.LinkDestinationSyntax
        | Syntax.LinkTitleSyntax)[] = [syntax.labelField, syntax.destinationField];
      if (syntax.titleField) fields.push(syntax.titleField);
      return this.node(syntax, fields.map(field => this.node(field, this.content(field.frontier))));
    }
    if (syntax instanceof Syntax.TableSyntax) {
      return this.node(syntax, [this.row(syntax.headerRow, true), ...syntax.children.map(row => this.row(row, false))]);
    }
    throw new RangeError(`No editor conversion for ${syntax.type}`);
  }

  row(syntax: Syntax.TableRowSyntax, header: boolean): Node {
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

  frontMatter(syntax: Syntax.FrontMatterSyntax): Node {
    if (syntax instanceof Syntax.RawFrontMatterSyntax) return this.node(syntax, this.literal(syntax.content));
    if (syntax instanceof Syntax.YAMLFrontMatterSyntax) return this.node(syntax, [this.yaml(syntax.root)]);
    throw new RangeError(`No front matter conversion for ${syntax.type}`);
  }

  yaml(syntax: Syntax.YAMLNodeSyntax): Node {
    if (syntax instanceof Syntax.YAMLScalarSyntax) return this.node(syntax, this.literal(syntax.content));
    if (syntax instanceof Syntax.YAMLSequenceSyntax)
      return this.node(syntax, syntax.children.map(child => this.yaml(child)));
    if (syntax instanceof Syntax.YAMLMappingSyntax) {
      return this.node(syntax,
        syntax.children.map(pair => this.node(pair, [this.yaml(pair.key), this.yaml(pair.value)])));
    }
    throw new RangeError(`No YAML conversion for ${syntax.type}`);
  }

  content(frontier: Syntax.Frontier): Fragment {
    const occurrences = new Map<Syntax.Syntax, Mark>();
    const content: Node[] = [];
    let offset = 0;
    for (const piece of frontier) {
      const marks: Mark[] = [];
      for (const syntax of piece.nodes) {
        if (syntax instanceof Syntax.TokenSyntax || syntax instanceof Syntax.ClauseSyntax ||
          syntax instanceof Syntax.InlineClauseSyntax) continue;
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
      if (tail?.type === 'lineEnding' || tail instanceof Syntax.SoftLineBreakSyntax) {
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
function metaChild(node: Syntax.Syntax, next: Syntax.Syntax | undefined): boolean {
  if (node instanceof Syntax.TriviaTokenSyntax) {
    return node.type === 'codeSpanPadding' || node.type === 'inlineMathPadding' ||
      node.type === 'resourceWhitespace' || node.type === 'tablePipeEscape';
  }
  if (node instanceof Syntax.RawHTMLSyntax || node instanceof Syntax.HTMLCommentSyntax ||
      node instanceof Syntax.HTMLLineBreakSyntax || node instanceof Syntax.HTMLImageSyntax) return false;
  if (node instanceof Syntax.TokenSyntax || node instanceof Syntax.SoftLineBreakSyntax ||
      node instanceof Syntax.LiteralAutolinkSyntax || node instanceof Syntax.PendingThematicBreakSyntax ||
      node instanceof Syntax.PendingSetextUnderlineSyntax) return node.tag !== 'Text';
  if (node instanceof Syntax.ClauseSyntax || node instanceof Syntax.InlineClauseSyntax) return false;
  if (node instanceof Syntax.BackslashEscapeSyntax) return next === node.backslash;
  if (node instanceof Syntax.AutolinkSyntax) return next !== node.address;
  if (node instanceof Syntax.TagSyntax) return next !== node.name;
  if (node instanceof Syntax.DelimitedSyntax) return next === node.openingDelimiter || next === node.closingDelimiter;
  if (node instanceof Syntax.CodeSpanSyntax) return next === node.openingBackticks || next === node.closingBackticks;
  if (node instanceof Syntax.InlineMathSyntax) return next === node.openingDollars || next === node.closingDollars;
  if (node instanceof Syntax.LinkSyntax) {
    if (next === node.openingBracket || next === node.closingBracket || next instanceof Syntax.InlineClauseSyntax)
      return true;
    if (node instanceof Syntax.InlineLinkSyntax)
      return next === node.openingParenthesis || next === node.closingParenthesis;
    if (node instanceof Syntax.CollapsedReferenceLinkSyntax)
      return next === node.referenceOpeningBracket || next === node.referenceClosingBracket;
    return false;
  }
  if (node instanceof Syntax.FootnoteReferenceSyntax)
    return next === node.openingBracket || next === node.caret || next === node.closingBracket;
  if (node instanceof Syntax.HardLineBreakSyntax) return next === node.marker;
  if (node instanceof Syntax.WikilinkSyntax || node instanceof Syntax.WikiEmbedSyntax)
    return next !== (node.alias ?? node.target);
  if (node instanceof Syntax.PendingCodeFenceSyntax || node instanceof Syntax.PendingMathFenceSyntax) return true;
  if (node instanceof Syntax.PendingListMarkerSyntax || node instanceof Syntax.PendingATXHeadingMarkerSyntax)
    return next === node.marker;
  if (node instanceof Syntax.PendingBlockQuoteMarkerSyntax)
    return next instanceof Syntax.DelimiterTokenSyntax && next.type === 'blockQuoteMarker';
  if (node instanceof Syntax.PendingFootnoteLabelSyntax) return next !== node.label;
  if (node instanceof Syntax.PendingTableSyntax)
    return next === node.delimiterRow ||
      next instanceof Syntax.DelimiterTokenSyntax && next.type === 'tableCellDivider';
  if (node instanceof Syntax.PendingHTMLBlockSyntax) return false;
  if (node instanceof Syntax.CharacterReferenceSyntax || node instanceof Syntax.EmojiShortcodeSyntax ||
      node instanceof Syntax.ImageSyntax || node instanceof Syntax.TaskMarkerSyntax ||
      node instanceof Syntax.CalloutDeclarationSyntax || node instanceof Syntax.ATXClosingSequenceSyntax ||
    node instanceof Syntax.LinkTitleStartSyntax) return true;
  throw new RangeError(`Unclassified frontier node: ${node.type}`);
}
