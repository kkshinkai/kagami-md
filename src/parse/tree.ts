/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  ATXHeadingSyntax, BlockQuoteSyntax, BlockSyntax, BulletListSyntax, CalloutSyntax, CalloutTitleSyntax, ClauseSyntax,
  CodeBlockSyntax, DocumentSyntax, FootnoteDefinitionSyntax, FootnoteLabelSyntax, FrontMatterSyntax, HeadingSyntax,
  HTMLBlockSyntax, HTMLTagBlockSyntax, IndentedCodeBlockSyntax, InlineFieldClauseSyntax, LinkDestinationSyntax,
  LinkLabelSyntax, LinkReferenceDefinitionSyntax, LinkTitleSyntax, ListItemSyntax, LiteralBlockSyntax, MathBlockSyntax,
  OrderedListSyntax, ParagraphSyntax, RawFrontMatterSyntax, SetextHeadingSyntax, SoftLineBreakSyntax,
  StringFieldClauseSyntax, TableCellSyntax, TableDelimiterRowSyntax, TableRowSyntax, TableSyntax, TextBlockSyntax,
  ThematicBreakSyntax, YAMLFrontMatterSyntax, YAMLMappingSyntax, YAMLNodeSyntax, YAMLPairSyntax, YAMLScalarSyntax,
  YAMLSequenceSyntax, YAMLSyntax, type Frontier, type SourceRange, type Syntax,
} from '../syntax/index.js';
import type { Node, NodeType, Schema } from 'prosemirror-model';
import type { CodeSpelling, HeadingSpelling, NodeSpelling } from '../types/schema.js';

/** The block and field nodes represented by editor nodes. */
export type Relabeled = BlockSyntax | DocumentSyntax | FrontMatterSyntax |
  ClauseSyntax | YAMLSyntax;

/** The syntax children which become editor children, in their document order. */
export function children(syntax: Relabeled): readonly Relabeled[] {
  if (syntax instanceof TableSyntax) return syntax.getChildren(TableRowSyntax);
  return syntax.getChildren().filter((child): child is Relabeled =>
    child instanceof BlockSyntax || child instanceof FrontMatterSyntax ||
    child instanceof YAMLSyntax ||
      child instanceof ClauseSyntax && !(child instanceof TableDelimiterRowSyntax)
  );
}

/** Convert a syntax kind to the schema type that represents it. */
export function editorType(syntax: Syntax, schema: Schema): NodeType {
  const nodes = schema.nodes;
  if (syntax instanceof DocumentSyntax) return nodes.document;
  if (syntax instanceof FrontMatterSyntax) {
    if (syntax instanceof YAMLFrontMatterSyntax) return nodes.yamlFrontMatter;
    if (syntax instanceof RawFrontMatterSyntax) return nodes.rawFrontMatter;
  }
  if (syntax instanceof YAMLSyntax) {
    if (syntax instanceof YAMLMappingSyntax) return nodes.yamlMapping;
    if (syntax instanceof YAMLPairSyntax) return nodes.yamlPair;
    if (syntax instanceof YAMLSequenceSyntax) return nodes.yamlSequence;
    if (syntax instanceof YAMLScalarSyntax) return nodes.yamlScalar;
  }
  if (syntax instanceof BlockSyntax) {
    if (syntax instanceof ParagraphSyntax) return nodes.paragraph;
    if (syntax instanceof HeadingSyntax) return nodes.heading;
    if (syntax instanceof CodeBlockSyntax) return nodes.codeBlock;
    if (syntax instanceof MathBlockSyntax) return nodes.mathBlock;
    if (syntax instanceof HTMLBlockSyntax) return nodes.htmlBlock;
    if (syntax instanceof HTMLTagBlockSyntax) return nodes.htmlTagBlock;
    if (syntax instanceof ThematicBreakSyntax) return nodes.thematicBreak;
    if (syntax instanceof BlockQuoteSyntax) return nodes.blockQuote;
    if (syntax instanceof CalloutSyntax) return nodes.callout;
    if (syntax instanceof BulletListSyntax) return nodes.bulletList;
    if (syntax instanceof OrderedListSyntax) return nodes.orderedList;
    if (syntax instanceof ListItemSyntax) return nodes.listItem;
    if (syntax instanceof FootnoteDefinitionSyntax) return nodes.footnoteDefinition;
    if (syntax instanceof LinkReferenceDefinitionSyntax) return nodes.linkReferenceDefinition;
    if (syntax instanceof TableSyntax) return nodes.table;
  }
  if (syntax instanceof CalloutTitleSyntax) return nodes.calloutTitle;
  if (syntax instanceof FootnoteLabelSyntax) return nodes.footnoteLabel;
  if (syntax instanceof LinkLabelSyntax) return nodes.linkLabel;
  if (syntax instanceof LinkDestinationSyntax) return nodes.linkDestination;
  if (syntax instanceof LinkTitleSyntax) return nodes.linkTitle;
  if (syntax instanceof TableRowSyntax) return nodes.tableRow;
  if (syntax instanceof TableCellSyntax) return nodes.tableCell;
  throw new RangeError(`No editor node for ${syntax.type}`);
}

/** Adapt the CST's exact spelling variants to the editor's shared schema. */
export function editorSpelling(syntax: Syntax): NodeSpelling | undefined {
  if (syntax instanceof ATXHeadingSyntax) return {
    ...syntax.spelling, underline: null,
  } satisfies HeadingSpelling;
  if (syntax instanceof SetextHeadingSyntax) return {
    ...syntax.spelling, whitespaceAfterMarker: null, closingSequence: null,
  } satisfies HeadingSpelling;
  if (syntax instanceof IndentedCodeBlockSyntax) return {
    ...syntax.spelling, fence: null,
  } satisfies CodeSpelling;
  if (syntax instanceof BlockSyntax || syntax instanceof FrontMatterSyntax ||
      syntax instanceof YAMLNodeSyntax || syntax instanceof YAMLPairSyntax ||
      syntax instanceof DocumentSyntax || syntax instanceof LinkDestinationSyntax ||
      syntax instanceof LinkTitleSyntax) return syntax.spelling;
  return undefined;
}

/** A piece of a field's source and how many characters of the field it stands for. */
export interface SourcePiece extends SourceRange {
  length: number;
}

/** An editor node's source reading, including the empty bodies supplied by conversion. */
export class Correspondence {
  constructor(readonly syntax: Relabeled, readonly emptyAt: number | null = null) {}

  get range(): SourceRange {
    return this.emptyAt === null ? this.syntax : { start: this.emptyAt, end: this.emptyAt };
  }

  get pieces(): readonly SourcePiece[] | undefined {
    if (this.emptyAt !== null) return [{ start: this.emptyAt, end: this.emptyAt, length: 0 }];
    return sourcePieces(this.syntax);
  }

  /** The reading of each editor child, in editor order. */
  children(node: Node): Correspondence[] {
    if (this.emptyAt !== null || node.isTextblock) return [];
    const syntax = this.syntax;
    if (syntax instanceof TableCellSyntax) {
      if (node.childCount !== 1 || node.child(0).type !== node.type.schema.nodes.tableParagraph)
        throw new RangeError('A table cell must wrap one table paragraph');
      return [this];
    }
    const result = children(syntax).map(child => new Correspondence(child));
    const body = this.suppliedBody();
    if (body) result.push(body);
    if (result.length !== node.childCount)
      throw new RangeError('The reading does not correspond to the editor children');
    return result;
  }

  /** The empty paragraph conversion supplies to a container whose syntax holds no block, or null. */
  suppliedBody(): Correspondence | null {
    const syntax = this.syntax;
    if (this.emptyAt !== null || !(syntax instanceof DocumentSyntax || syntax instanceof BlockQuoteSyntax ||
        syntax instanceof ListItemSyntax || syntax instanceof FootnoteDefinitionSyntax) ||
        syntax.children.length) return null;
    let at = syntax.contentStart;
    if (syntax instanceof FootnoteDefinitionSyntax) at = syntax.label.end;
    if (syntax instanceof DocumentSyntax && syntax.frontMatter) at = syntax.frontMatter.end;
    return new Correspondence(syntax, at);
  }
}

/** A field's source ranges; decoded YAML has none unless decoding kept its length. */
export function sourcePieces(field: Syntax): readonly SourcePiece[] | undefined {
  if (field instanceof TextBlockSyntax || field instanceof InlineFieldClauseSyntax ||
      field instanceof StringFieldClauseSyntax)
    return frontierPieces(field.frontier, field.contentStart);
  if (field instanceof HTMLTagBlockSyntax) return frontierPieces(field.tag.frontier, field.tag.start);
  if (field instanceof LiteralBlockSyntax || field instanceof RawFrontMatterSyntax)
    return [{ start: field.contentStart, end: field.contentEnd, length: field.content.length }];
  if (field instanceof YAMLScalarSyntax && field.end - field.start === field.content.length)
    return [{ start: field.start, end: field.end, length: field.content.length }];
  return undefined;
}

/** A frontier's line endings each stand for one character of editor content. */
export function frontierPieces(frontier: Frontier, at: number): SourcePiece[] {
  if (!frontier.length) return [{ start: at, end: at, length: 0 }];
  return frontier.map(piece => {
    const tail = piece.nodes.at(-1);
    const ending = tail?.type === 'lineEnding' || tail instanceof SoftLineBreakSyntax;
    return { start: piece.start, end: piece.end, length: ending ? 1 : piece.end - piece.start };
  });
}
