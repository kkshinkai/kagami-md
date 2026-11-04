/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import * as Syntax from '../syntax/index.js';
import type { Node, NodeType, Schema } from 'prosemirror-model';
import type { CodeSpelling, HeadingSpelling, NodeSpelling } from '../types/schema.js';

/** The block and field nodes represented by editor nodes. */
export type Relabeled = Syntax.BlockSyntax | Syntax.DocumentSyntax | Syntax.FrontMatterSyntax |
  Syntax.ClauseSyntax | Syntax.YAMLSyntax;

/** The syntax children which become editor children, in their document order. */
export function children(syntax: Relabeled): readonly Relabeled[] {
  if (syntax instanceof Syntax.TableSyntax) return syntax.getChildren(Syntax.TableRowSyntax);
  return syntax.getChildren().filter((child): child is Relabeled =>
    child instanceof Syntax.BlockSyntax || child instanceof Syntax.FrontMatterSyntax ||
    child instanceof Syntax.YAMLSyntax ||
      child instanceof Syntax.ClauseSyntax && !(child instanceof Syntax.TableDelimiterRowSyntax)
  );
}

/** Convert a syntax kind to the schema type that represents it. */
export function editorType(syntax: Syntax.Syntax, schema: Schema): NodeType {
  const nodes = schema.nodes;
  if (syntax instanceof Syntax.DocumentSyntax) return nodes.document;
  if (syntax instanceof Syntax.FrontMatterSyntax) {
    if (syntax instanceof Syntax.YAMLFrontMatterSyntax) return nodes.yamlFrontMatter;
    if (syntax instanceof Syntax.RawFrontMatterSyntax) return nodes.rawFrontMatter;
  }
  if (syntax instanceof Syntax.YAMLSyntax) {
    if (syntax instanceof Syntax.YAMLMappingSyntax) return nodes.yamlMapping;
    if (syntax instanceof Syntax.YAMLPairSyntax) return nodes.yamlPair;
    if (syntax instanceof Syntax.YAMLSequenceSyntax) return nodes.yamlSequence;
    if (syntax instanceof Syntax.YAMLScalarSyntax) return nodes.yamlScalar;
  }
  if (syntax instanceof Syntax.BlockSyntax) {
    if (syntax instanceof Syntax.ParagraphSyntax) return nodes.paragraph;
    if (syntax instanceof Syntax.HeadingSyntax) return nodes.heading;
    if (syntax instanceof Syntax.CodeBlockSyntax) return nodes.codeBlock;
    if (syntax instanceof Syntax.MathBlockSyntax) return nodes.mathBlock;
    if (syntax instanceof Syntax.HTMLBlockSyntax) return nodes.htmlBlock;
    if (syntax instanceof Syntax.HTMLTagBlockSyntax) return nodes.htmlTagBlock;
    if (syntax instanceof Syntax.ThematicBreakSyntax) return nodes.thematicBreak;
    if (syntax instanceof Syntax.BlockQuoteSyntax) return nodes.blockQuote;
    if (syntax instanceof Syntax.CalloutSyntax) return nodes.callout;
    if (syntax instanceof Syntax.BulletListSyntax) return nodes.bulletList;
    if (syntax instanceof Syntax.OrderedListSyntax) return nodes.orderedList;
    if (syntax instanceof Syntax.ListItemSyntax) return nodes.listItem;
    if (syntax instanceof Syntax.FootnoteDefinitionSyntax) return nodes.footnoteDefinition;
    if (syntax instanceof Syntax.LinkReferenceDefinitionSyntax) return nodes.linkReferenceDefinition;
    if (syntax instanceof Syntax.TableSyntax) return nodes.table;
  }
  if (syntax instanceof Syntax.CalloutTitleSyntax) return nodes.calloutTitle;
  if (syntax instanceof Syntax.FootnoteLabelSyntax) return nodes.footnoteLabel;
  if (syntax instanceof Syntax.LinkLabelSyntax) return nodes.linkLabel;
  if (syntax instanceof Syntax.LinkDestinationSyntax) return nodes.linkDestination;
  if (syntax instanceof Syntax.LinkTitleSyntax) return nodes.linkTitle;
  if (syntax instanceof Syntax.TableRowSyntax) return nodes.tableRow;
  if (syntax instanceof Syntax.TableCellSyntax) return nodes.tableCell;
  throw new RangeError(`No editor node for ${syntax.type}`);
}

/** Adapt the CST's exact spelling variants to the editor's shared schema. */
export function editorSpelling(syntax: Syntax.Syntax): NodeSpelling | undefined {
  if (syntax instanceof Syntax.ATXHeadingSyntax) return {
    ...syntax.spelling, underline: null,
  } satisfies HeadingSpelling;
  if (syntax instanceof Syntax.SetextHeadingSyntax) return {
    ...syntax.spelling, whitespaceAfterMarker: null, closingSequence: null,
  } satisfies HeadingSpelling;
  if (syntax instanceof Syntax.IndentedCodeBlockSyntax) return {
    ...syntax.spelling, fence: null,
  } satisfies CodeSpelling;
  if (syntax instanceof Syntax.BlockSyntax || syntax instanceof Syntax.FrontMatterSyntax ||
      syntax instanceof Syntax.YAMLNodeSyntax || syntax instanceof Syntax.YAMLPairSyntax ||
      syntax instanceof Syntax.DocumentSyntax || syntax instanceof Syntax.LinkDestinationSyntax ||
      syntax instanceof Syntax.LinkTitleSyntax) return syntax.spelling;
  return undefined;
}

/** A piece of a field's source and how many characters of the field it stands for. */
export interface SourcePiece extends Syntax.SourceRange {
  length: number;
}

/** An editor node's source reading, including the empty bodies supplied by conversion. */
export class Correspondence {
  constructor(readonly syntax: Relabeled, readonly emptyAt: number | null = null) {}

  get range(): Syntax.SourceRange {
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
    if (syntax instanceof Syntax.TableCellSyntax) {
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
    if (this.emptyAt !== null || !(syntax instanceof Syntax.DocumentSyntax || syntax instanceof Syntax.BlockQuoteSyntax ||
        syntax instanceof Syntax.ListItemSyntax || syntax instanceof Syntax.FootnoteDefinitionSyntax) ||
        syntax.children.length) return null;
    let at = syntax.contentStart;
    if (syntax instanceof Syntax.FootnoteDefinitionSyntax) at = syntax.label.end;
    if (syntax instanceof Syntax.DocumentSyntax && syntax.frontMatter) at = syntax.frontMatter.end;
    return new Correspondence(syntax, at);
  }
}

/** A field's source ranges; decoded YAML has none unless decoding kept its length. */
export function sourcePieces(field: Syntax.Syntax): readonly SourcePiece[] | undefined {
  if (field instanceof Syntax.TextBlockSyntax || field instanceof Syntax.InlineFieldClauseSyntax ||
      field instanceof Syntax.StringFieldClauseSyntax)
    return frontierPieces(field.frontier, field.contentStart);
  if (field instanceof Syntax.HTMLTagBlockSyntax) return frontierPieces(field.tag.frontier, field.tag.start);
  if (field instanceof Syntax.LiteralBlockSyntax || field instanceof Syntax.RawFrontMatterSyntax)
    return [{ start: field.contentStart, end: field.contentEnd, length: field.content.length }];
  if (field instanceof Syntax.YAMLScalarSyntax && field.end - field.start === field.content.length)
    return [{ start: field.start, end: field.end, length: field.content.length }];
  return undefined;
}

/** A frontier's line endings each stand for one character of editor content. */
export function frontierPieces(frontier: Syntax.Frontier, at: number): SourcePiece[] {
  if (!frontier.length) return [{ start: at, end: at, length: 0 }];
  return frontier.map(piece => {
    const tail = piece.nodes.at(-1);
    const ending = tail?.type === 'lineEnding' || tail instanceof Syntax.SoftLineBreakSyntax;
    return { start: piece.start, end: piece.end, length: ending ? 1 : piece.end - piece.start };
  });
}
