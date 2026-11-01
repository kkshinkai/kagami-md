/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type {
  DocumentSyntax,
  YAMLFrontMatterSyntax,
  RawFrontMatterSyntax,
  YAMLMappingSyntax,
  YAMLPairSyntax,
  YAMLSequenceSyntax,
  YAMLScalarSyntax,
  BlockQuoteSyntax,
  CalloutSyntax,
  CalloutTitleSyntax,
  BulletListSyntax,
  OrderedListSyntax,
  ListItemSyntax,
  FootnoteDefinitionSyntax,
  FootnoteLabelSyntax,
  ParagraphSyntax,
  MathBlockSyntax,
  HTMLBlockSyntax,
  HTMLTagBlockSyntax,
  ThematicBreakSyntax,
  LinkReferenceDefinitionSyntax,
  LinkLabelSyntax,
  LinkDestinationSyntax,
  LinkTitleSyntax,
  TableSyntax,
  TableRowSyntax,
  TableCellSyntax,
  TableDelimiterRowSyntax,
  ATXHeadingSyntax,
  SetextHeadingSyntax,
  FencedCodeBlockSyntax,
  IndentedCodeBlockSyntax,
} from './block.js';
import type {
  TextTokenSyntax,
  DelimiterTokenSyntax,
  TriviaTokenSyntax,
  DelimitedSyntax,
  SoftLineBreakSyntax,
  HardLineBreakSyntax,
  BackslashEscapeSyntax,
  CharacterReferenceSyntax,
  CodeSpanSyntax,
  InlineMathSyntax,
  InlineLinkSyntax,
  FullReferenceLinkSyntax,
  CollapsedReferenceLinkSyntax,
  ShortcutReferenceLinkSyntax,
  ResourceDestinationSyntax,
  ResourceTitleSyntax,
  ReferenceSyntax,
  InlineImageSyntax,
  FullReferenceImageSyntax,
  CollapsedReferenceImageSyntax,
  ShortcutReferenceImageSyntax,
  ImageSizeSyntax,
  AutolinkSyntax,
  LiteralAutolinkSyntax,
  RawHTMLSyntax,
  HTMLCommentSyntax,
  HTMLLineBreakSyntax,
  HTMLImageSyntax,
  FootnoteReferenceSyntax,
  WikilinkSyntax,
  WikiEmbedSyntax,
  WikilinkPartSyntax,
  TagSyntax,
  EmojiShortcodeSyntax,
  TaskMarkerSyntax,
  CalloutDeclarationSyntax,
  ATXClosingSequenceSyntax,
  PendingCodeFenceSyntax,
  PendingMathFenceSyntax,
  PendingListMarkerSyntax,
  PendingATXHeadingMarkerSyntax,
  PendingThematicBreakSyntax,
  PendingBlockQuoteMarkerSyntax,
  PendingFootnoteLabelSyntax,
  PendingSetextUnderlineSyntax,
  PendingTableSyntax,
  PendingHTMLBlockSyntax,
  LinkTitleStartSyntax,
} from './inline.js';

/** A non-node range in UTF-16 source offsets. */
export interface SourceRange {
  start: number;
  end: number;
}

export type SyntaxClass<T extends Syntax = Syntax> = abstract new (...args: never[]) => T;

export interface SyntaxIterateSpec {
  enter(node: Syntax): boolean | void;
  leave?(node: Syntax): void;
  from?: number;
  to?: number;
}

export interface SyntaxVisitor<R> {
  visitDocument(node: DocumentSyntax): R;
  visitYAMLFrontMatter(node: YAMLFrontMatterSyntax): R;
  visitRawFrontMatter(node: RawFrontMatterSyntax): R;
  visitYAMLMapping(node: YAMLMappingSyntax): R;
  visitYAMLPair(node: YAMLPairSyntax): R;
  visitYAMLSequence(node: YAMLSequenceSyntax): R;
  visitYAMLScalar(node: YAMLScalarSyntax): R;
  visitBlockQuote(node: BlockQuoteSyntax): R;
  visitCallout(node: CalloutSyntax): R;
  visitCalloutTitle(node: CalloutTitleSyntax): R;
  visitBulletList(node: BulletListSyntax): R;
  visitOrderedList(node: OrderedListSyntax): R;
  visitListItem(node: ListItemSyntax): R;
  visitFootnoteDefinition(node: FootnoteDefinitionSyntax): R;
  visitFootnoteLabel(node: FootnoteLabelSyntax): R;
  visitParagraph(node: ParagraphSyntax): R;
  visitMathBlock(node: MathBlockSyntax): R;
  visitHTMLBlock(node: HTMLBlockSyntax): R;
  visitHTMLTagBlock(node: HTMLTagBlockSyntax): R;
  visitThematicBreak(node: ThematicBreakSyntax): R;
  visitLinkReferenceDefinition(node: LinkReferenceDefinitionSyntax): R;
  visitLinkLabel(node: LinkLabelSyntax): R;
  visitLinkDestination(node: LinkDestinationSyntax): R;
  visitLinkTitle(node: LinkTitleSyntax): R;
  visitTable(node: TableSyntax): R;
  visitTableRow(node: TableRowSyntax): R;
  visitTableCell(node: TableCellSyntax): R;
  visitTableDelimiterRow(node: TableDelimiterRowSyntax): R;
  visitATXHeading(node: ATXHeadingSyntax): R;
  visitSetextHeading(node: SetextHeadingSyntax): R;
  visitFencedCodeBlock(node: FencedCodeBlockSyntax): R;
  visitIndentedCodeBlock(node: IndentedCodeBlockSyntax): R;
  visitTextToken(node: TextTokenSyntax): R;
  visitDelimiterToken(node: DelimiterTokenSyntax): R;
  visitTriviaToken(node: TriviaTokenSyntax): R;
  visitDelimited(node: DelimitedSyntax): R;
  visitSoftLineBreak(node: SoftLineBreakSyntax): R;
  visitHardLineBreak(node: HardLineBreakSyntax): R;
  visitBackslashEscape(node: BackslashEscapeSyntax): R;
  visitCharacterReference(node: CharacterReferenceSyntax): R;
  visitCodeSpan(node: CodeSpanSyntax): R;
  visitInlineMath(node: InlineMathSyntax): R;
  visitInlineLink(node: InlineLinkSyntax): R;
  visitFullReferenceLink(node: FullReferenceLinkSyntax): R;
  visitCollapsedReferenceLink(node: CollapsedReferenceLinkSyntax): R;
  visitShortcutReferenceLink(node: ShortcutReferenceLinkSyntax): R;
  visitResourceDestination(node: ResourceDestinationSyntax): R;
  visitResourceTitle(node: ResourceTitleSyntax): R;
  visitReference(node: ReferenceSyntax): R;
  visitInlineImage(node: InlineImageSyntax): R;
  visitFullReferenceImage(node: FullReferenceImageSyntax): R;
  visitCollapsedReferenceImage(node: CollapsedReferenceImageSyntax): R;
  visitShortcutReferenceImage(node: ShortcutReferenceImageSyntax): R;
  visitImageSize(node: ImageSizeSyntax): R;
  visitAutolink(node: AutolinkSyntax): R;
  visitLiteralAutolink(node: LiteralAutolinkSyntax): R;
  visitRawHTML(node: RawHTMLSyntax): R;
  visitHTMLComment(node: HTMLCommentSyntax): R;
  visitHTMLLineBreak(node: HTMLLineBreakSyntax): R;
  visitHTMLImage(node: HTMLImageSyntax): R;
  visitFootnoteReference(node: FootnoteReferenceSyntax): R;
  visitWikilink(node: WikilinkSyntax): R;
  visitWikiEmbed(node: WikiEmbedSyntax): R;
  visitWikilinkPart(node: WikilinkPartSyntax): R;
  visitTag(node: TagSyntax): R;
  visitEmojiShortcode(node: EmojiShortcodeSyntax): R;
  visitTaskMarker(node: TaskMarkerSyntax): R;
  visitCalloutDeclaration(node: CalloutDeclarationSyntax): R;
  visitATXClosingSequence(node: ATXClosingSequenceSyntax): R;
  visitPendingCodeFence(node: PendingCodeFenceSyntax): R;
  visitPendingMathFence(node: PendingMathFenceSyntax): R;
  visitPendingListMarker(node: PendingListMarkerSyntax): R;
  visitPendingATXHeadingMarker(node: PendingATXHeadingMarkerSyntax): R;
  visitPendingThematicBreak(node: PendingThematicBreakSyntax): R;
  visitPendingBlockQuoteMarker(node: PendingBlockQuoteMarkerSyntax): R;
  visitPendingFootnoteLabel(node: PendingFootnoteLabelSyntax): R;
  visitPendingSetextUnderline(node: PendingSetextUnderlineSyntax): R;
  visitPendingTable(node: PendingTableSyntax): R;
  visitPendingHTMLBlock(node: PendingHTMLBlockSyntax): R;
  visitLinkTitleStart(node: LinkTitleStartSyntax): R;
}

export const EMPTY_CHILDREN: ReadonlyArray<never> = Object.freeze([]);

/**
 * Navigation is defined on completed nodes. During compilation, event handlers
 * access only the slots initialized by the events already processed.
 */
export abstract class Syntax implements SourceRange {
  abstract readonly type: string;
  abstract readonly leading: number;
  abstract readonly trailing: number;
  start = 0;
  end = 0;

  get contentStart(): number {
    return this.start + this.leading;
  }

  get contentEnd(): number {
    return this.end - this.trailing;
  }

  get firstChild(): Syntax | null {
    return this.childNodes()[0] ?? null;
  }

  get lastChild(): Syntax | null {
    const children = this.childNodes();
    return children[children.length - 1] ?? null;
  }

  getChild<T extends Syntax>(type: SyntaxClass<T>): T | null {
    for (const child of this.childNodes()) {
      if (child instanceof type) return child;
    }
    return null;
  }

  protected abstract childNodes(): ReadonlyArray<Syntax>;

  getChildren(): ReadonlyArray<Syntax>;
  getChildren<T extends Syntax>(type: SyntaxClass<T>): ReadonlyArray<T>;
  getChildren<T extends Syntax>(type?: SyntaxClass<T>): ReadonlyArray<Syntax> {
    const children = this.childNodes();
    if (!type) return children;
    return children.filter((child): child is T => child instanceof type);
  }

  childAfter(pos: number): Syntax | null {
    for (const child of this.childNodes()) {
      if (child.end > pos) return child;
    }
    return null;
  }

  childBefore(pos: number): Syntax | null {
    const children = this.childNodes();
    for (let index = children.length - 1; index >= 0; index--) {
      const child = children[index]!;
      if (child.start < pos) return child;
    }
    return null;
  }

  enter(pos: number, side: -1 | 0 | 1 = 0): Syntax | null {
    for (const child of this.childNodes()) {
      const starts = side === 1 ? child.start <= pos : child.start < pos;
      const ends = side === -1 ? child.end >= pos : child.end > pos;
      if (starts && ends) return child;
    }
    return null;
  }

  resolve(pos: number, side: -1 | 0 | 1 = 0): Syntax {
    let current: Syntax = this;
    for (;;) {
      const next = current.enter(pos, side);
      if (!next) return current;
      current = next;
    }
  }

  iterate(spec: SyntaxIterateSpec): void {
    const from = spec.from ?? -Infinity;
    const to = spec.to ?? Infinity;
    if (this.end < from || this.start > to) return;
    if (spec.enter(this) === false) return;
    for (const child of this.childNodes()) child.iterate(spec);
    spec.leave?.(this);
  }

  abstract accept<R>(visitor: SyntaxVisitor<R>): R;
}
