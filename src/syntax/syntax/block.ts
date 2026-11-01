/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ReferenceLabels } from './reading.js';
import type { HTMLFlowCondition } from '../types/index.js';
import { linearize } from '../compile/frontier.js';
import type { Frontier } from './frontier.js';
import { Syntax, EMPTY_CHILDREN, type SyntaxClass, type SyntaxVisitor } from './syntax.js';
import type { CalloutType } from '../constructs/text/inline-source-callout-declaration.js';
import type {
  DelimiterTokenSyntax,
  HTMLImageSyntax,
  HTMLLineBreakSyntax,
  InlineSyntax,
  LinkTitleStartSyntax,
  StringSegmentSyntax,
} from './inline.js';

export interface DocumentSpelling {
  /** Blank lines before the first and after the last block. */
  start: number;
  end: number;
}

export interface YAMLSpelling {
  commentBefore: string | null;
  trailingComment: string | null;
  blankLineBefore: boolean;
  /** A tag written on the node, `!!str`; null when its tag is resolved and not written. */
  explicitTag: string | null;
}

export interface YAMLCollectionSpelling extends YAMLSpelling {
  flow: boolean;
}

export interface BlockSpelling {
  /** Blank lines before this block at a sibling boundary. */
  leadingBlankLines: number;
  /** Blank lines after this block at a sibling boundary. */
  trailingBlankLines: number;
  /**
   * The spaces before the block on its first line, 0 to 3: before a list item's marker, a
   * heading's `#`, a quote's `>`, a fence, a paragraph's text. The specification allows spaces
   * only there, so the number is all there is.
   */
  spacesBeforeBlock: number;
}

export interface ContainerBlockSpelling extends BlockSpelling {
  /** Blank lines before the first and after the last child. */
  start: number;
  end: number;
}

export type BulletListPattern = 'dash' | 'asterisk' | 'plusSign';

export type OrderedListPattern = 'decimalDot' | 'decimalRightParenthesis';

export interface SetextUnderlineSpelling {
  /** Whether it is as wide as the longest line of the text, within the tolerance. */
  matchesText: boolean;
  /** Its length as written, used when it does not match. */
  length: number;
}

export interface FenceSpelling {
  /** The opening fence as written, ```` ``` ````, `~~~~` or `$$`. */
  fence: string;
  /** What stands between the opening fence and the info string or meta. */
  whitespaceAfterFence: string;
  /**
   * The closing fence as written, without the spaces before it, or null when the block ran to
   * the end of its container.
   */
  closingFence: string | null;
  /** The spaces before the closing fence, 0 to 3. */
  spacesBeforeClosingFence: number;
}

export interface ATXHeadingSpelling extends BlockSpelling {
  whitespaceAfterMarker: string;
  closingSequence: ATXHeadingSpelling.ClosingSequence | null;
}

export namespace ATXHeadingSpelling {
  export interface ClosingSequence {
    whitespaceBefore: string;
    sequence: string;
  }
}

export interface SetextHeadingSpelling extends BlockSpelling {
  underline: SetextUnderlineSpelling;
}

export interface FencedCodeBlockSpelling extends BlockSpelling {
  fence: FenceSpelling;
}

export interface FrontMatterSpelling {
  leadingBlankLines: number;
  trailingBlankLines: number;
  /** The fence as written, `---`. */
  fence: string;
}

export interface YAMLFrontMatterSpelling
  extends FrontMatterSpelling, YAMLFrontMatterSpelling.Content {}

export namespace YAMLFrontMatterSpelling {
  /** The spelling supplied by YAML between the Markdown fences. */
  export interface Content {
    /** How many spaces a nested block is indented by; null when nothing is nested. */
    indent: number | null;
    /**
     * A comment before the first pair that `yaml` gives to the document, one a blank line
     * separates from the pair, without its `#`.
     */
    commentBefore: string | null;
    /** A comment after the last pair, without its `#`. */
    trailingComment: string | null;
  }
}

export interface YAMLPairSpelling {
  whitespaceAfterColon: string;
}

export interface YAMLScalarSpelling extends YAMLSpelling {
  /**
   * Its style, in the YAML specification's words. The unparser asks `yaml` for it, and `yaml`
   * keeps it where the value can be written so and chooses another where it cannot: a value
   * that comes to hold `: ` is no longer plain.
   */
  style: YAMLScalarSyntax.Style;
}

export interface BlockQuoteSpelling extends ContainerBlockSpelling {
  /** What follows `>` on its line before the content: a space, or nothing. */
  whitespaceAfterMarker: string;
}

export interface CalloutSpelling extends ContainerBlockSpelling {
  whitespaceAfterMarker: string;
  /** The declaration as written, `[!note]` or `[!NOTE]`. */
  declaration: string;
  /** What stands between the declaration and the title. */
  whitespaceAfterDeclaration: string;
}

export interface BulletListSpelling extends ContainerBlockSpelling {
  pattern: BulletListPattern;
  tight: boolean;
}

export interface OrderedListSpelling extends ContainerBlockSpelling {
  pattern: OrderedListPattern;
  tight: boolean;
  /**
   * `sequential` when each number is one more than the one before, a list of one item
   * included; `constant` when two or more items all have the same number; null otherwise.
   */
  numbering: 'sequential' | 'constant' | null;
}

export interface ListItemSpelling extends ContainerBlockSpelling {
  /** The marker as written, with its character: `-`, `1.`. */
  marker: string;
  /** What stands between the marker and the content on its line. It may hold a tab. */
  whitespaceAfterMarker: string;
  /**
   * Whether the first block starts on the marker's line. `-` over `  foo` starts on the next;
   * the marker's line is no blank line. True for an item with no block.
   */
  startsOnMarkerLine: boolean;
  /**
   * How far the author indents the lines that continue a paragraph of the item's own: the
   * most frequent indentation of those that are not lazy, brought within what the item can
   * hold. Null when no such line shows it. Spaces before a block on its first line are the
   * block's `spacesBeforeBlock`.
   */
  continuationIndent: number | null;
}

export interface FootnoteDefinitionSpelling extends ContainerBlockSpelling {
  /** What stands between `]:` and the first block on its line. */
  whitespaceAfterLabel: string;
  /**
   * Whether the first block starts on the label's line. The label's line is no blank line.
   * True for a definition with no block.
   */
  startsOnLabelLine: boolean;
  /**
   * How far the author indents the lines after the first. A footnote definition takes four
   * columns; the value is read as a list item's is. Null when no line shows it.
   */
  continuationIndent: number | null;
}

export interface MathBlockSpelling extends BlockSpelling, FenceSpelling {
  /** What follows the opening fence on its line. Only the unparser reads it. */
  meta: string | null;
}

export interface LinkReferenceDefinitionSpelling extends BlockSpelling {
  /**
   * What stands between `]:` and the destination. The editor's `separator`. It may hold one
   * line ending, written `\n` here and standing for the file's line ending.
   */
  whitespaceAfterLabel: string;
  /** What stands between the destination and the title, likewise. */
  whitespaceBeforeTitle: string;
}

export interface LinkDestinationSpelling {
  /** Whether the destination is written between `<` and `>`. The editor's `wrapper`. */
  inAngleBrackets: boolean;
}

export interface LinkTitleSpelling {
  delimiter: '"' | "'" | '(';
}

export interface TableSpelling extends BlockSpelling {
  /**
   * The author's intention for the spaces between pipes and content, for the whole table.
   * See private-docs/design/syntax/alignment.md.
   */
  cellPadding: 'aligned' | 'oneSpace' | 'none';
  /** Whether rows are written between pipes at their outer edges, `| a | b |`. */
  enclosedInPipes: boolean;
}

export abstract class FrontMatterSyntax extends Syntax {
  /** Source offsets of the complete syntax, excluding surrounding blank lines and its last line ending. */
  bodyStart!: number;
  bodyEnd!: number;
  /** Source lengths around the front matter block; its YAML is unchanged. */
  override leading = 0;
  override trailing = 0;
  spelling!: FrontMatterSpelling;
}

export abstract class YAMLSyntax extends Syntax {
  override get leading(): 0 {
    return 0;
  }

  override get trailing(): 0 {
    return 0;
  }
}

export abstract class YAMLNodeSyntax extends YAMLSyntax {
  spelling!: YAMLSpelling;
}

export abstract class BlockSyntax extends Syntax {
  /** Source offsets of the complete syntax, excluding surrounding blank lines and its last line ending. */
  bodyStart!: number;
  bodyEnd!: number;
  /** Source lengths before and after the block's content. */
  override leading = 0;
  override trailing = 0;
  spelling!: BlockSpelling;
}

export abstract class ContainerBlockSyntax<
  Child extends BlockSyntax = BlockSyntax,
> extends BlockSyntax {
  children: Array<Child> = [];
  declare spelling: ContainerBlockSpelling;
}

export abstract class LeafBlockSyntax extends BlockSyntax {}

export abstract class TextBlockSyntax extends LeafBlockSyntax {
  readonly references = new ReferenceLabels();
  /** Whether the first source line can begin a following title of a link definition. */
  startsLinkTitle = false;
  children: Array<InlineSyntax> = [];

  get frontier(): Frontier {
    return linearize(this.children);
  }

  protected override childNodes(): ReadonlyArray<InlineSyntax> {
    return this.children;
  }

  override get firstChild(): InlineSyntax | null {
    return this.children[0] ?? null;
  }

  override get lastChild(): InlineSyntax | null {
    return this.children[this.children.length - 1] ?? null;
  }

  override getChildren(): ReadonlyArray<InlineSyntax>;
  override getChildren<T extends Syntax>(type: SyntaxClass<T>): ReadonlyArray<T>;
  override getChildren<T extends Syntax>(type?: SyntaxClass<T>): ReadonlyArray<Syntax> {
    return type ? super.getChildren(type) : this.children;
  }
}

export abstract class LiteralBlockSyntax extends LeafBlockSyntax {
  content = '';

  protected override childNodes(): ReadonlyArray<never> {
    return EMPTY_CHILDREN;
  }
}

export abstract class HeadingSyntax extends TextBlockSyntax {
  abstract level: 1 | 2 | 3 | 4 | 5 | 6;
}

export abstract class CodeBlockSyntax extends LiteralBlockSyntax {}

export abstract class ClauseSyntax extends Syntax {
  override leading = 0;
  override trailing = 0;
}

export abstract class InlineFieldClauseSyntax extends ClauseSyntax {
  readonly references = new ReferenceLabels();
  children: Array<InlineSyntax> = [];

  get frontier(): Frontier {
    return linearize(this.children);
  }

  protected override childNodes(): ReadonlyArray<InlineSyntax> {
    return this.children;
  }

  override get firstChild(): InlineSyntax | null {
    return this.children[0] ?? null;
  }

  override get lastChild(): InlineSyntax | null {
    return this.children[this.children.length - 1] ?? null;
  }

  override getChildren(): ReadonlyArray<InlineSyntax>;
  override getChildren<T extends Syntax>(type: SyntaxClass<T>): ReadonlyArray<T>;
  override getChildren<T extends Syntax>(type?: SyntaxClass<T>): ReadonlyArray<Syntax> {
    return type ? super.getChildren(type) : this.children;
  }
}

export abstract class StringFieldClauseSyntax<
  Child extends InlineSyntax = StringSegmentSyntax,
> extends ClauseSyntax {
  readonly references = new ReferenceLabels();
  children: Array<Child> = [];

  get frontier(): Frontier {
    return linearize(this.children);
  }

  protected override childNodes(): ReadonlyArray<Child> {
    return this.children;
  }

  override get firstChild(): Child | null {
    return this.children[0] ?? null;
  }

  override get lastChild(): Child | null {
    return this.children[this.children.length - 1] ?? null;
  }

  override getChildren(): ReadonlyArray<Child>;
  override getChildren<T extends Syntax>(type: SyntaxClass<T>): ReadonlyArray<T>;
  override getChildren<T extends Syntax>(type?: SyntaxClass<T>): ReadonlyArray<Syntax> {
    return type ? super.getChildren(type) : this.children;
  }
}

export class DocumentSyntax extends Syntax {
  readonly type = 'document' as const;

  /** Source lengths before and after the document's content. */
  override leading = 0;
  override trailing = 0;
  frontMatter: FrontMatterSyntax | null = null;
  children: Array<BlockSyntax> = [];
  spelling!: DocumentSpelling;

  protected override childNodes(): ReadonlyArray<Syntax> {
    return this.frontMatter ? [this.frontMatter, ...this.children] : this.children;
  }

  override get firstChild(): Syntax | null {
    return this.frontMatter ?? this.children[0] ?? null;
  }

  override get lastChild(): Syntax | null {
    return this.children[this.children.length - 1] ?? this.frontMatter;
  }

  override accept<R>(visitor: SyntaxVisitor<R>): R {
    return visitor.visitDocument(this);
  }
}

export class YAMLFrontMatterSyntax extends FrontMatterSyntax {
  readonly type = 'yamlFrontMatter' as const;
  root!: YAMLMappingSyntax;
  declare spelling: YAMLFrontMatterSpelling;

  protected override childNodes(): ReadonlyArray<Syntax> {
    return [this.root];
  }

  override get firstChild(): Syntax | null {
    return this.root;
  }

  override get lastChild(): Syntax | null {
    return this.root;
  }

  override accept<R>(visitor: SyntaxVisitor<R>): R {
    return visitor.visitYAMLFrontMatter(this);
  }
}

export class RawFrontMatterSyntax extends FrontMatterSyntax {
  readonly type = 'rawFrontMatter' as const;

  /**
   * Its content, as the specification gives it, a string: each line ending is `\n`, and the
   * columns of a tab another node took part of are spaces, as in `>→→foo`
   * (private-docs/design/syntax/tabs.md).
   */
  content = '';

  protected override childNodes(): ReadonlyArray<never> {
    return EMPTY_CHILDREN;
  }

  override accept<R>(visitor: SyntaxVisitor<R>): R {
    return visitor.visitRawFrontMatter(this);
  }
}

export class YAMLMappingSyntax extends YAMLNodeSyntax {
  readonly type = 'yamlMapping' as const;
  children: Array<YAMLPairSyntax> = [];
  declare spelling: YAMLCollectionSpelling;

  protected override childNodes(): ReadonlyArray<YAMLPairSyntax> {
    return this.children;
  }

  override get firstChild(): YAMLPairSyntax | null {
    return this.children[0] ?? null;
  }

  override get lastChild(): YAMLPairSyntax | null {
    return this.children[this.children.length - 1] ?? null;
  }

  override getChildren(): ReadonlyArray<YAMLPairSyntax>;
  override getChildren<T extends Syntax>(type: SyntaxClass<T>): ReadonlyArray<T>;
  override getChildren<T extends Syntax>(type?: SyntaxClass<T>): ReadonlyArray<Syntax> {
    return type ? super.getChildren(type) : this.children;
  }

  override accept<R>(visitor: SyntaxVisitor<R>): R {
    return visitor.visitYAMLMapping(this);
  }
}

export class YAMLPairSyntax extends YAMLSyntax {
  readonly type = 'yamlPair' as const;
  key!: YAMLNodeSyntax;
  value!: YAMLNodeSyntax;

  /** Whitespace after the colon, from the YAML token stream. */
  spelling!: YAMLPairSpelling;

  protected override childNodes(): ReadonlyArray<Syntax> {
    return [this.key, this.value];
  }

  override get firstChild(): Syntax | null {
    return this.key;
  }

  override get lastChild(): Syntax | null {
    return this.value;
  }

  override accept<R>(visitor: SyntaxVisitor<R>): R {
    return visitor.visitYAMLPair(this);
  }
}

export class YAMLSequenceSyntax extends YAMLNodeSyntax {
  readonly type = 'yamlSequence' as const;
  children: Array<YAMLNodeSyntax> = [];
  declare spelling: YAMLCollectionSpelling;

  protected override childNodes(): ReadonlyArray<YAMLNodeSyntax> {
    return this.children;
  }

  override get firstChild(): YAMLNodeSyntax | null {
    return this.children[0] ?? null;
  }

  override get lastChild(): YAMLNodeSyntax | null {
    return this.children[this.children.length - 1] ?? null;
  }

  override getChildren(): ReadonlyArray<YAMLNodeSyntax>;
  override getChildren<T extends Syntax>(type: SyntaxClass<T>): ReadonlyArray<T>;
  override getChildren<T extends Syntax>(type?: SyntaxClass<T>): ReadonlyArray<Syntax> {
    return type ? super.getChildren(type) : this.children;
  }

  override accept<R>(visitor: SyntaxVisitor<R>): R {
    return visitor.visitYAMLSequence(this);
  }
}

export class YAMLScalarSyntax extends YAMLNodeSyntax {
  readonly type = 'yamlScalar' as const;

  /** What the core schema resolves it to. */
  tag!: YAMLScalarSyntax.Tag;

  /**
   * Its content, in the YAML specification's word: the text with its quotes, escapes, folding
   * and indentation gone, before the tag gives it a meaning. `0x1F` is `"0x1F"`, `~` is `"~"`.
   */
  content = '';
  declare spelling: YAMLScalarSpelling;

  protected override childNodes(): ReadonlyArray<never> {
    return EMPTY_CHILDREN;
  }

  override accept<R>(visitor: SyntaxVisitor<R>): R {
    return visitor.visitYAMLScalar(this);
  }
}

export namespace YAMLScalarSyntax {
  export type Tag = 'string' | 'integer' | 'float' | 'boolean' | 'null';
  export type Style = 'plain' | 'singleQuoted' | 'doubleQuoted' | 'literal' | 'folded';
}

export class BlockQuoteSyntax extends ContainerBlockSyntax {
  readonly type = 'blockQuote' as const;
  declare spelling: BlockQuoteSpelling;

  protected override childNodes(): ReadonlyArray<BlockSyntax> {
    return this.children;
  }

  override get firstChild(): BlockSyntax | null {
    return this.children[0] ?? null;
  }

  override get lastChild(): BlockSyntax | null {
    return this.children[this.children.length - 1] ?? null;
  }

  override getChildren(): ReadonlyArray<BlockSyntax>;
  override getChildren<T extends Syntax>(type: SyntaxClass<T>): ReadonlyArray<T>;
  override getChildren<T extends Syntax>(type?: SyntaxClass<T>): ReadonlyArray<Syntax> {
    return type ? super.getChildren(type) : this.children;
  }

  override accept<R>(visitor: SyntaxVisitor<R>): R {
    return visitor.visitBlockQuote(this);
  }
}

export class CalloutSyntax extends ContainerBlockSyntax {
  readonly type = 'callout' as const;
  calloutType!: CalloutType;
  title!: CalloutTitleSyntax;
  declare spelling: CalloutSpelling;

  protected override childNodes(): ReadonlyArray<Syntax> {
    return [this.title, ...this.children];
  }

  override get firstChild(): Syntax | null {
    return this.title;
  }

  override get lastChild(): Syntax | null {
    return this.children[this.children.length - 1] ?? this.title;
  }

  override accept<R>(visitor: SyntaxVisitor<R>): R {
    return visitor.visitCallout(this);
  }
}

export class CalloutTitleSyntax extends InlineFieldClauseSyntax {
  readonly type = 'calloutTitle' as const;

  override accept<R>(visitor: SyntaxVisitor<R>): R {
    return visitor.visitCalloutTitle(this);
  }
}

export class BulletListSyntax extends ContainerBlockSyntax<ListItemSyntax> {
  readonly type = 'bulletList' as const;
  declare spelling: BulletListSpelling;

  protected override childNodes(): ReadonlyArray<ListItemSyntax> {
    return this.children;
  }

  override get firstChild(): ListItemSyntax | null {
    return this.children[0] ?? null;
  }

  override get lastChild(): ListItemSyntax | null {
    return this.children[this.children.length - 1] ?? null;
  }

  override getChildren(): ReadonlyArray<ListItemSyntax>;
  override getChildren<T extends Syntax>(type: SyntaxClass<T>): ReadonlyArray<T>;
  override getChildren<T extends Syntax>(type?: SyntaxClass<T>): ReadonlyArray<Syntax> {
    return type ? super.getChildren(type) : this.children;
  }

  override accept<R>(visitor: SyntaxVisitor<R>): R {
    return visitor.visitBulletList(this);
  }
}

export class OrderedListSyntax extends ContainerBlockSyntax<ListItemSyntax> {
  readonly type = 'orderedList' as const;
  startNumber = 0;
  declare spelling: OrderedListSpelling;

  protected override childNodes(): ReadonlyArray<ListItemSyntax> {
    return this.children;
  }

  override get firstChild(): ListItemSyntax | null {
    return this.children[0] ?? null;
  }

  override get lastChild(): ListItemSyntax | null {
    return this.children[this.children.length - 1] ?? null;
  }

  override getChildren(): ReadonlyArray<ListItemSyntax>;
  override getChildren<T extends Syntax>(type: SyntaxClass<T>): ReadonlyArray<T>;
  override getChildren<T extends Syntax>(type?: SyntaxClass<T>): ReadonlyArray<Syntax> {
    return type ? super.getChildren(type) : this.children;
  }

  override accept<R>(visitor: SyntaxVisitor<R>): R {
    return visitor.visitOrderedList(this);
  }
}

export class ListItemSyntax extends ContainerBlockSyntax {
  readonly type = 'listItem' as const;
  checked: boolean | null = null;
  declare spelling: ListItemSpelling;

  protected override childNodes(): ReadonlyArray<BlockSyntax> {
    return this.children;
  }

  override get firstChild(): BlockSyntax | null {
    return this.children[0] ?? null;
  }

  override get lastChild(): BlockSyntax | null {
    return this.children[this.children.length - 1] ?? null;
  }

  override getChildren(): ReadonlyArray<BlockSyntax>;
  override getChildren<T extends Syntax>(type: SyntaxClass<T>): ReadonlyArray<T>;
  override getChildren<T extends Syntax>(type?: SyntaxClass<T>): ReadonlyArray<Syntax> {
    return type ? super.getChildren(type) : this.children;
  }

  override accept<R>(visitor: SyntaxVisitor<R>): R {
    return visitor.visitListItem(this);
  }
}

export class FootnoteDefinitionSyntax extends ContainerBlockSyntax {
  readonly type = 'footnoteDefinition' as const;

  /** Its label, normalized as labels are matched. */
  identifier = '';
  label!: FootnoteLabelSyntax;
  declare spelling: FootnoteDefinitionSpelling;

  protected override childNodes(): ReadonlyArray<Syntax> {
    return [this.label, ...this.children];
  }

  override get firstChild(): Syntax | null {
    return this.label;
  }

  override get lastChild(): Syntax | null {
    return this.children[this.children.length - 1] ?? this.label;
  }

  override accept<R>(visitor: SyntaxVisitor<R>): R {
    return visitor.visitFootnoteDefinition(this);
  }
}

export class FootnoteLabelSyntax extends StringFieldClauseSyntax {
  readonly type = 'footnoteLabel' as const;

  override accept<R>(visitor: SyntaxVisitor<R>): R {
    return visitor.visitFootnoteLabel(this);
  }
}

export class ParagraphSyntax extends TextBlockSyntax {
  readonly type = 'paragraph' as const;

  override accept<R>(visitor: SyntaxVisitor<R>): R {
    return visitor.visitParagraph(this);
  }
}

export class MathBlockSyntax extends LiteralBlockSyntax {
  readonly type = 'mathBlock' as const;
  declare spelling: MathBlockSpelling;

  override accept<R>(visitor: SyntaxVisitor<R>): R {
    return visitor.visitMathBlock(this);
  }
}

export class HTMLBlockSyntax extends LiteralBlockSyntax {
  /** Whether the reader met the explicit end condition of a kind 1-5 HTML block. */
  closed = false;
  readonly type = 'htmlBlock' as const;
  startCondition!: HTMLFlowCondition;

  override accept<R>(visitor: SyntaxVisitor<R>): R {
    return visitor.visitHTMLBlock(this);
  }
}

export class HTMLTagBlockSyntax extends LeafBlockSyntax {
  readonly type = 'htmlTagBlock' as const;
  tag!: HTMLLineBreakSyntax | HTMLImageSyntax;

  protected override childNodes(): ReadonlyArray<Syntax> {
    return [this.tag];
  }

  override get firstChild(): Syntax | null {
    return this.tag;
  }

  override get lastChild(): Syntax | null {
    return this.tag;
  }

  override accept<R>(visitor: SyntaxVisitor<R>): R {
    return visitor.visitHTMLTagBlock(this);
  }
}

export class ThematicBreakSyntax extends LeafBlockSyntax {
  /** Whether the recognized marker sequence also spells a setext underline. */
  canSetext = false;
  readonly type = 'thematicBreak' as const;

  protected override childNodes(): ReadonlyArray<never> {
    return EMPTY_CHILDREN;
  }

  override accept<R>(visitor: SyntaxVisitor<R>): R {
    return visitor.visitThematicBreak(this);
  }
}

export class LinkReferenceDefinitionSyntax extends LeafBlockSyntax {
  readonly type = 'linkReferenceDefinition' as const;

  /** Its label, normalized as the specification matches labels. */
  identifier = '';

  /** Its destination, unescaped and decoded. */
  destination = '';

  /** Its title, decoded; null when it has none. */
  title: string | null = null;
  labelField!: LinkLabelSyntax;
  destinationField!: LinkDestinationSyntax;
  titleField: LinkTitleSyntax | null = null;
  declare spelling: LinkReferenceDefinitionSpelling;

  protected override childNodes(): ReadonlyArray<Syntax> {
    return this.titleField
      ? [this.labelField, this.destinationField, this.titleField]
      : [this.labelField, this.destinationField];
  }

  override get firstChild(): Syntax | null {
    return this.labelField;
  }

  override get lastChild(): Syntax | null {
    return this.titleField ?? this.destinationField;
  }

  override accept<R>(visitor: SyntaxVisitor<R>): R {
    return visitor.visitLinkReferenceDefinition(this);
  }
}

export class LinkLabelSyntax extends StringFieldClauseSyntax {
  readonly type = 'linkLabel' as const;

  override accept<R>(visitor: SyntaxVisitor<R>): R {
    return visitor.visitLinkLabel(this);
  }
}

export class LinkDestinationSyntax extends StringFieldClauseSyntax<
  StringSegmentSyntax | LinkTitleStartSyntax
> {
  readonly type = 'linkDestination' as const;
  spelling!: LinkDestinationSpelling;

  override accept<R>(visitor: SyntaxVisitor<R>): R {
    return visitor.visitLinkDestination(this);
  }
}

export class LinkTitleSyntax extends StringFieldClauseSyntax {
  readonly type = 'linkTitle' as const;
  spelling!: LinkTitleSpelling;

  override accept<R>(visitor: SyntaxVisitor<R>): R {
    return visitor.visitLinkTitle(this);
  }
}

export class TableSyntax extends LeafBlockSyntax {
  readonly type = 'table' as const;

  /** The alignment of each column, from the delimiter row. */
  alignments: Array<'left' | 'right' | 'center' | null> = [];
  headerRow!: TableRowSyntax;
  delimiterRow!: TableDelimiterRowSyntax;
  children: Array<TableRowSyntax> = [];
  declare spelling: TableSpelling;

  protected override childNodes(): ReadonlyArray<Syntax> {
    return [this.headerRow, this.delimiterRow, ...this.children];
  }

  override get firstChild(): Syntax | null {
    return this.headerRow;
  }

  override get lastChild(): Syntax | null {
    return this.children[this.children.length - 1] ?? this.delimiterRow;
  }

  override accept<R>(visitor: SyntaxVisitor<R>): R {
    return visitor.visitTable(this);
  }
}

export class TableRowSyntax extends ClauseSyntax {
  readonly type = 'tableRow' as const;
  children: Array<TableCellSyntax> = [];

  protected override childNodes(): ReadonlyArray<TableCellSyntax> {
    return this.children;
  }

  override get firstChild(): TableCellSyntax | null {
    return this.children[0] ?? null;
  }

  override get lastChild(): TableCellSyntax | null {
    return this.children[this.children.length - 1] ?? null;
  }

  override getChildren(): ReadonlyArray<TableCellSyntax>;
  override getChildren<T extends Syntax>(type: SyntaxClass<T>): ReadonlyArray<T>;
  override getChildren<T extends Syntax>(type?: SyntaxClass<T>): ReadonlyArray<Syntax> {
    return type ? super.getChildren(type) : this.children;
  }

  override accept<R>(visitor: SyntaxVisitor<R>): R {
    return visitor.visitTableRow(this);
  }
}

export class TableCellSyntax extends InlineFieldClauseSyntax {
  readonly type = 'tableCell' as const;

  override accept<R>(visitor: SyntaxVisitor<R>): R {
    return visitor.visitTableCell(this);
  }
}

export class TableDelimiterRowSyntax extends ClauseSyntax {
  readonly type = 'tableDelimiterRow' as const;
  children: Array<DelimiterTokenSyntax<'tableDelimiter'>> = [];

  protected override childNodes(): ReadonlyArray<DelimiterTokenSyntax<'tableDelimiter'>> {
    return this.children;
  }

  override get firstChild(): DelimiterTokenSyntax<'tableDelimiter'> | null {
    return this.children[0] ?? null;
  }

  override get lastChild(): DelimiterTokenSyntax<'tableDelimiter'> | null {
    return this.children[this.children.length - 1] ?? null;
  }

  override getChildren(): ReadonlyArray<DelimiterTokenSyntax<'tableDelimiter'>>;
  override getChildren<T extends Syntax>(type: SyntaxClass<T>): ReadonlyArray<T>;
  override getChildren<T extends Syntax>(type?: SyntaxClass<T>): ReadonlyArray<Syntax> {
    return type ? super.getChildren(type) : this.children;
  }

  override accept<R>(visitor: SyntaxVisitor<R>): R {
    return visitor.visitTableDelimiterRow(this);
  }
}

export class ATXHeadingSyntax extends HeadingSyntax {
  readonly type = 'atxHeading' as const;
  declare spelling: ATXHeadingSpelling;

  override level: 1 | 2 | 3 | 4 | 5 | 6 = 1;

  override accept<R>(visitor: SyntaxVisitor<R>): R {
    return visitor.visitATXHeading(this);
  }
}

export class SetextHeadingSyntax extends HeadingSyntax {
  readonly type = 'setextHeading' as const;
  declare spelling: SetextHeadingSpelling;

  override level: 1 | 2 = 1;

  override accept<R>(visitor: SyntaxVisitor<R>): R {
    return visitor.visitSetextHeading(this);
  }
}

export class FencedCodeBlockSyntax extends CodeBlockSyntax {
  readonly type = 'fencedCodeBlock' as const;
  language: string | null = null;
  meta: string | null = null;
  declare spelling: FencedCodeBlockSpelling;

  override accept<R>(visitor: SyntaxVisitor<R>): R {
    return visitor.visitFencedCodeBlock(this);
  }
}

export class IndentedCodeBlockSyntax extends CodeBlockSyntax {
  readonly type = 'indentedCodeBlock' as const;

  override accept<R>(visitor: SyntaxVisitor<R>): R {
    return visitor.visitIndentedCodeBlock(this);
  }
}
