/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { HTMLFlowCondition } from '../types/index.js';
import { linearize } from '../compile/frontier.js';
import type { Frontier } from './frontier.js';
import { Syntax, EMPTY_CHILDREN, type SyntaxClass, type SyntaxVisitor } from './syntax.js';
import type { FootnoteLabelSyntax, TableCellSyntax } from './block.js';
import type { CalloutType } from '../constructs/text/inline-source-callout-declaration.js';

export abstract class InlineSyntax extends Syntax {
  override get leading(): 0 {
    return 0;
  }

  override get trailing(): 0 {
    return 0;
  }
}

export type TextTokenKind =
  | 'text'
  | 'lineEnding'
  | 'autolinkAddress'
  | 'escapedCharacter'
  | 'tagName';

export type DelimiterTokenKind =
  | 'ampersand'
  | 'atxClosingSequenceMarker'
  | 'atxHeadingMarker'
  | 'backslash'
  | 'backtickString'
  | 'blockQuoteMarker'
  | 'calloutClosingMarker'
  | 'calloutOpeningMarker'
  | 'calloutTypeName'
  | 'caret'
  | 'characterReferenceValue'
  | 'closingAngleBracket'
  | 'closingBracket'
  | 'closingColon'
  | 'closingNumberSign'
  | 'closingParenthesis'
  | 'closingWikiBrackets'
  | 'codeFence'
  | 'delimiterRun'
  | 'dollarString'
  | 'emojiName'
  | 'equalsSign'
  | 'exclamationMark'
  | 'footnoteOpeningMarker'
  | 'hardLineBreakMarker'
  | 'imageSizeHeight'
  | 'imageSizeSeparator'
  | 'imageSizeWidth'
  | 'infoString'
  | 'listMarker'
  | 'mathFence'
  | 'mathMeta'
  | 'openingAngleBracket'
  | 'openingBracket'
  | 'openingColon'
  | 'openingNumberSign'
  | 'openingParenthesis'
  | 'openingWikiBrackets'
  | 'semicolon'
  | 'tableCellDivider'
  | 'tableDelimiterRowMarker'
  | 'taskCheck'
  | 'titleDelimiter'
  | 'codeFenceMeta'
  | 'wikiAliasDelimiter'
  | 'colon'
  | 'tableDelimiter';

export type TriviaTokenKind =
  | 'lineEnding'
  | 'codeSpanPadding'
  | 'imageSizeWhitespace'
  | 'inlineMathPadding'
  | 'paragraphIndentation'
  | 'resourceWhitespace'
  | 'tablePipeEscape'
  | 'titleStartWhitespace'
  | 'trailingWhitespace'
  | 'taskMarkerWhitespace'
  | 'calloutDeclarationWhitespace'
  | 'codeFenceWhitespace'
  | 'mathFenceWhitespace'
  | 'blockQuoteWhitespace'
  | 'tableCellWhitespace';

export abstract class TokenSyntax extends InlineSyntax {
  abstract readonly tag: 'Text' | 'Delimiter' | 'Trivia';
  abstract override readonly type: TextTokenKind | DelimiterTokenKind | TriviaTokenKind;

  protected override childNodes(): ReadonlyArray<never> {
    return EMPTY_CHILDREN;
  }
}

export class TextTokenSyntax<Kind extends TextTokenKind = TextTokenKind> extends TokenSyntax {
  readonly tag = 'Text' as const;

  constructor(
    readonly type: Kind,
    start = 0,
    end = 0
  ) {
    super();
    this.start = start;
    this.end = end;
  }

  override accept<R>(visitor: SyntaxVisitor<R>): R {
    return visitor.visitTextToken(this);
  }
}

export class DelimiterTokenSyntax<
  Kind extends DelimiterTokenKind = DelimiterTokenKind,
> extends TokenSyntax {
  readonly tag = 'Delimiter' as const;

  constructor(
    readonly type: Kind,
    start = 0,
    end = 0
  ) {
    super();
    this.start = start;
    this.end = end;
  }

  override accept<R>(visitor: SyntaxVisitor<R>): R {
    return visitor.visitDelimiterToken(this);
  }
}

export class TriviaTokenSyntax<Kind extends TriviaTokenKind = TriviaTokenKind> extends TokenSyntax {
  readonly tag = 'Trivia' as const;

  constructor(
    readonly type: Kind,
    start = 0,
    end = 0
  ) {
    super();
    this.start = start;
    this.end = end;
  }

  override accept<R>(visitor: SyntaxVisitor<R>): R {
    return visitor.visitTriviaToken(this);
  }
}

export type StringSegmentSyntax =
  | TextTokenSyntax<'text' | 'lineEnding'>
  | TriviaTokenSyntax
  | BackslashEscapeSyntax
  | CharacterReferenceSyntax;

export type RawStringSegmentSyntax = TextTokenSyntax<'text' | 'lineEnding'> | TriviaTokenSyntax;

export type LineEndingSyntax = TextTokenSyntax<'lineEnding'> | TriviaTokenSyntax<'lineEnding'>;

export type ResourceSeparatorSyntax = TriviaTokenSyntax<'resourceWhitespace'> | LineEndingSyntax;

export abstract class InlineClauseSyntax extends InlineSyntax {}

export abstract class PendingSyntax extends InlineSyntax {}

export abstract class LinkSyntax extends InlineSyntax {
  openingBracket!: DelimiterTokenSyntax<'openingBracket'>;

  /** The link text. */
  children: Array<InlineSyntax> = [];
  closingBracket!: DelimiterTokenSyntax<'closingBracket'>;

  /** Where it leads: unescaped and decoded, and taken from its definition for a reference. */
  destination = '';

  /** Its title, decoded; null when it has none. */
  title: string | null = null;
}

export abstract class ReferenceLinkSyntax extends LinkSyntax {
  /** The label its definition was matched by, normalized. */
  identifier = '';
}

export abstract class ImageSyntax extends InlineSyntax {
  exclamationMark!: DelimiterTokenSyntax<'exclamationMark'>;
  openingBracket!: DelimiterTokenSyntax<'openingBracket'>;

  /** The image description. */
  children: Array<InlineSyntax> = [];
  size: ImageSizeSyntax | null = null;
  closingBracket!: DelimiterTokenSyntax<'closingBracket'>;
  destination = '';
  title: string | null = null;

  /** The description's content without its markup, as the specification makes the alternative text. */
  alt = '';
  width: number | null = null;
  height: number | null = null;
}

export abstract class ReferenceImageSyntax extends ImageSyntax {
  identifier = '';
}

export type DelimitedKind = 'emphasis' | 'strongEmphasis' | 'strikethrough' | 'highlight';

export class DelimitedSyntax extends InlineSyntax {
  openingDelimiter!: DelimiterTokenSyntax<'delimiterRun'>;
  children: Array<InlineSyntax> = [];
  closingDelimiter!: DelimiterTokenSyntax<'delimiterRun'>;

  constructor(readonly type: DelimitedKind) {
    super();
  }

  protected override childNodes(): ReadonlyArray<Syntax> {
    return [this.openingDelimiter, ...this.children, this.closingDelimiter];
  }

  override get firstChild(): Syntax | null {
    return this.openingDelimiter;
  }

  override get lastChild(): Syntax | null {
    return this.closingDelimiter;
  }

  override accept<R>(visitor: SyntaxVisitor<R>): R {
    return visitor.visitDelimited(this);
  }
}

export class SoftLineBreakSyntax extends InlineSyntax {
  readonly type = 'softLineBreak' as const;
  readonly tag = 'Text' as const;

  protected override childNodes(): ReadonlyArray<never> {
    return EMPTY_CHILDREN;
  }

  override accept<R>(visitor: SyntaxVisitor<R>): R {
    return visitor.visitSoftLineBreak(this);
  }
}

export class HardLineBreakSyntax extends InlineSyntax {
  readonly type = 'hardLineBreak' as const;

  /** The backslash, or the spaces. */
  marker!: DelimiterTokenSyntax<'hardLineBreakMarker'>;
  lineEnding!: LineEndingSyntax;

  protected override childNodes(): ReadonlyArray<Syntax> {
    return [this.marker, this.lineEnding];
  }

  override get firstChild(): Syntax | null {
    return this.marker;
  }

  override get lastChild(): Syntax | null {
    return this.lineEnding;
  }

  override accept<R>(visitor: SyntaxVisitor<R>): R {
    return visitor.visitHardLineBreak(this);
  }
}

export class BackslashEscapeSyntax extends InlineSyntax {
  readonly type = 'backslashEscape' as const;
  backslash!: DelimiterTokenSyntax<'backslash'>;
  character!: TextTokenSyntax<'escapedCharacter'>;

  protected override childNodes(): ReadonlyArray<Syntax> {
    return [this.backslash, this.character];
  }

  override get firstChild(): Syntax | null {
    return this.backslash;
  }

  override get lastChild(): Syntax | null {
    return this.character;
  }

  override accept<R>(visitor: SyntaxVisitor<R>): R {
    return visitor.visitBackslashEscape(this);
  }
}

export class CharacterReferenceSyntax extends InlineSyntax {
  readonly type = 'characterReference' as const;
  ampersand!: DelimiterTokenSyntax<'ampersand'>;

  /** What stands between `&` and `;`: a name, or `#` and digits. */
  reference!: DelimiterTokenSyntax<'characterReferenceValue'>;
  semicolon!: DelimiterTokenSyntax<'semicolon'>;

  /** What it stands for. */
  character = '';

  protected override childNodes(): ReadonlyArray<Syntax> {
    return [this.ampersand, this.reference, this.semicolon];
  }

  override get firstChild(): Syntax | null {
    return this.ampersand;
  }

  override get lastChild(): Syntax | null {
    return this.semicolon;
  }

  override accept<R>(visitor: SyntaxVisitor<R>): R {
    return visitor.visitCharacterReference(this);
  }
}

export class CodeSpanSyntax extends InlineSyntax {
  readonly type = 'codeSpan' as const;
  openingBackticks!: DelimiterTokenSyntax<'backtickString'>;
  children: Array<RawStringSegmentSyntax> = [];
  closingBackticks!: DelimiterTokenSyntax<'backtickString'>;

  /** The code: its line endings made spaces, its stripped spaces gone. */
  code = '';

  protected override childNodes(): ReadonlyArray<Syntax> {
    return [this.openingBackticks, ...this.children, this.closingBackticks];
  }

  override get firstChild(): Syntax | null {
    return this.openingBackticks;
  }

  override get lastChild(): Syntax | null {
    return this.closingBackticks;
  }

  override accept<R>(visitor: SyntaxVisitor<R>): R {
    return visitor.visitCodeSpan(this);
  }
}

export class InlineMathSyntax extends InlineSyntax {
  readonly type = 'inlineMath' as const;
  openingDollars!: DelimiterTokenSyntax<'dollarString'>;
  children: Array<RawStringSegmentSyntax> = [];
  closingDollars!: DelimiterTokenSyntax<'dollarString'>;

  /** The math: its line endings made spaces, its stripped spaces gone. */
  math = '';

  protected override childNodes(): ReadonlyArray<Syntax> {
    return [this.openingDollars, ...this.children, this.closingDollars];
  }

  override get firstChild(): Syntax | null {
    return this.openingDollars;
  }

  override get lastChild(): Syntax | null {
    return this.closingDollars;
  }

  override accept<R>(visitor: SyntaxVisitor<R>): R {
    return visitor.visitInlineMath(this);
  }
}

export class InlineLinkSyntax extends LinkSyntax {
  readonly type = 'inlineLink' as const;
  openingParenthesis!: DelimiterTokenSyntax<'openingParenthesis'>;

  /** Null for `[text]()`. */
  resourceDestination: ResourceDestinationSyntax | null = null;
  resourceTitle: ResourceTitleSyntax | null = null;

  /** Separators after `(`, before a title, and before `)`, in source order. */
  openingSeparators: Array<ResourceSeparatorSyntax> = [];
  destinationSeparators: Array<ResourceSeparatorSyntax> = [];
  titleSeparators: Array<ResourceSeparatorSyntax> = [];
  closingParenthesis!: DelimiterTokenSyntax<'closingParenthesis'>;

  protected override childNodes(): ReadonlyArray<Syntax> {
    return [
      this.openingBracket,
      ...this.children,
      this.closingBracket,
      this.openingParenthesis,
      ...this.openingSeparators,
      ...(this.resourceDestination ? [this.resourceDestination] : []),
      ...this.destinationSeparators,
      ...(this.resourceTitle ? [this.resourceTitle] : []),
      ...this.titleSeparators,
      this.closingParenthesis,
    ];
  }

  override get firstChild(): Syntax | null {
    return this.openingBracket;
  }

  override get lastChild(): Syntax | null {
    return this.closingParenthesis;
  }

  override accept<R>(visitor: SyntaxVisitor<R>): R {
    return visitor.visitInlineLink(this);
  }
}

export class FullReferenceLinkSyntax extends ReferenceLinkSyntax {
  readonly type = 'fullReferenceLink' as const;
  reference!: ReferenceSyntax;

  protected override childNodes(): ReadonlyArray<Syntax> {
    return [this.openingBracket, ...this.children, this.closingBracket, this.reference];
  }

  override get firstChild(): Syntax | null {
    return this.openingBracket;
  }

  override get lastChild(): Syntax | null {
    return this.reference;
  }

  override accept<R>(visitor: SyntaxVisitor<R>): R {
    return visitor.visitFullReferenceLink(this);
  }
}

export class CollapsedReferenceLinkSyntax extends ReferenceLinkSyntax {
  readonly type = 'collapsedReferenceLink' as const;

  /** `[` of `[]`. */
  referenceOpeningBracket!: DelimiterTokenSyntax<'openingBracket'>;

  /** `]` of `[]`. */
  referenceClosingBracket!: DelimiterTokenSyntax<'closingBracket'>;

  protected override childNodes(): ReadonlyArray<Syntax> {
    return [
      this.openingBracket,
      ...this.children,
      this.closingBracket,
      this.referenceOpeningBracket,
      this.referenceClosingBracket,
    ];
  }

  override get firstChild(): Syntax | null {
    return this.openingBracket;
  }

  override get lastChild(): Syntax | null {
    return this.referenceClosingBracket;
  }

  override accept<R>(visitor: SyntaxVisitor<R>): R {
    return visitor.visitCollapsedReferenceLink(this);
  }
}

export class ShortcutReferenceLinkSyntax extends ReferenceLinkSyntax {
  readonly type = 'shortcutReferenceLink' as const;

  protected override childNodes(): ReadonlyArray<Syntax> {
    return [this.openingBracket, ...this.children, this.closingBracket];
  }

  override get firstChild(): Syntax | null {
    return this.openingBracket;
  }

  override get lastChild(): Syntax | null {
    return this.closingBracket;
  }

  override accept<R>(visitor: SyntaxVisitor<R>): R {
    return visitor.visitShortcutReferenceLink(this);
  }
}

export class ResourceDestinationSyntax extends InlineClauseSyntax {
  readonly type = 'resourceDestination' as const;

  /** `<`, where the destination is written between `<` and `>`. */
  openingAngleBracket: DelimiterTokenSyntax<'openingAngleBracket'> | null = null;
  children: Array<StringSegmentSyntax> = [];
  closingAngleBracket: DelimiterTokenSyntax<'closingAngleBracket'> | null = null;

  protected override childNodes(): ReadonlyArray<Syntax> {
    return [
      ...(this.openingAngleBracket ? [this.openingAngleBracket] : []),
      ...this.children,
      ...(this.closingAngleBracket ? [this.closingAngleBracket] : []),
    ];
  }

  override get firstChild(): Syntax | null {
    return this.openingAngleBracket ?? this.children[0] ?? this.closingAngleBracket;
  }

  override get lastChild(): Syntax | null {
    return (
      this.closingAngleBracket ??
      this.children[this.children.length - 1] ??
      this.openingAngleBracket
    );
  }

  override accept<R>(visitor: SyntaxVisitor<R>): R {
    return visitor.visitResourceDestination(this);
  }
}

export class ResourceTitleSyntax extends InlineClauseSyntax {
  readonly type = 'resourceTitle' as const;

  /** `"`, `'` or `(`. */
  openingDelimiter!: DelimiterTokenSyntax<'titleDelimiter'>;
  children: Array<StringSegmentSyntax> = [];
  closingDelimiter!: DelimiterTokenSyntax<'titleDelimiter'>;

  protected override childNodes(): ReadonlyArray<Syntax> {
    return [this.openingDelimiter, ...this.children, this.closingDelimiter];
  }

  override get firstChild(): Syntax | null {
    return this.openingDelimiter;
  }

  override get lastChild(): Syntax | null {
    return this.closingDelimiter;
  }

  override accept<R>(visitor: SyntaxVisitor<R>): R {
    return visitor.visitResourceTitle(this);
  }
}

export class ReferenceSyntax extends InlineClauseSyntax {
  readonly type = 'reference' as const;
  openingBracket!: DelimiterTokenSyntax<'openingBracket'>;
  children: Array<StringSegmentSyntax> = [];
  closingBracket!: DelimiterTokenSyntax<'closingBracket'>;

  protected override childNodes(): ReadonlyArray<Syntax> {
    return [this.openingBracket, ...this.children, this.closingBracket];
  }

  override get firstChild(): Syntax | null {
    return this.openingBracket;
  }

  override get lastChild(): Syntax | null {
    return this.closingBracket;
  }

  override accept<R>(visitor: SyntaxVisitor<R>): R {
    return visitor.visitReference(this);
  }
}

export class InlineImageSyntax extends ImageSyntax {
  readonly type = 'inlineImage' as const;
  openingParenthesis!: DelimiterTokenSyntax<'openingParenthesis'>;
  resourceDestination: ResourceDestinationSyntax | null = null;
  resourceTitle: ResourceTitleSyntax | null = null;

  /** Separators after `(`, before a title, and before `)`, in source order. */
  openingSeparators: Array<ResourceSeparatorSyntax> = [];
  destinationSeparators: Array<ResourceSeparatorSyntax> = [];
  titleSeparators: Array<ResourceSeparatorSyntax> = [];
  closingParenthesis!: DelimiterTokenSyntax<'closingParenthesis'>;

  protected override childNodes(): ReadonlyArray<Syntax> {
    return [
      this.exclamationMark,
      this.openingBracket,
      ...this.children,
      ...(this.size ? [this.size] : []),
      this.closingBracket,
      this.openingParenthesis,
      ...this.openingSeparators,
      ...(this.resourceDestination ? [this.resourceDestination] : []),
      ...this.destinationSeparators,
      ...(this.resourceTitle ? [this.resourceTitle] : []),
      ...this.titleSeparators,
      this.closingParenthesis,
    ];
  }

  override get firstChild(): Syntax | null {
    return this.exclamationMark;
  }

  override get lastChild(): Syntax | null {
    return this.closingParenthesis;
  }

  override accept<R>(visitor: SyntaxVisitor<R>): R {
    return visitor.visitInlineImage(this);
  }
}

export class FullReferenceImageSyntax extends ReferenceImageSyntax {
  readonly type = 'fullReferenceImage' as const;
  reference!: ReferenceSyntax;

  protected override childNodes(): ReadonlyArray<Syntax> {
    return [
      this.exclamationMark,
      this.openingBracket,
      ...this.children,
      ...(this.size ? [this.size] : []),
      this.closingBracket,
      this.reference,
    ];
  }

  override get firstChild(): Syntax | null {
    return this.exclamationMark;
  }

  override get lastChild(): Syntax | null {
    return this.reference;
  }

  override accept<R>(visitor: SyntaxVisitor<R>): R {
    return visitor.visitFullReferenceImage(this);
  }
}

export class CollapsedReferenceImageSyntax extends ReferenceImageSyntax {
  readonly type = 'collapsedReferenceImage' as const;
  referenceOpeningBracket!: DelimiterTokenSyntax<'openingBracket'>;
  referenceClosingBracket!: DelimiterTokenSyntax<'closingBracket'>;

  protected override childNodes(): ReadonlyArray<Syntax> {
    return [
      this.exclamationMark,
      this.openingBracket,
      ...this.children,
      ...(this.size ? [this.size] : []),
      this.closingBracket,
      this.referenceOpeningBracket,
      this.referenceClosingBracket,
    ];
  }

  override get firstChild(): Syntax | null {
    return this.exclamationMark;
  }

  override get lastChild(): Syntax | null {
    return this.referenceClosingBracket;
  }

  override accept<R>(visitor: SyntaxVisitor<R>): R {
    return visitor.visitCollapsedReferenceImage(this);
  }
}

export class ShortcutReferenceImageSyntax extends ReferenceImageSyntax {
  readonly type = 'shortcutReferenceImage' as const;

  protected override childNodes(): ReadonlyArray<Syntax> {
    return [
      this.exclamationMark,
      this.openingBracket,
      ...this.children,
      ...(this.size ? [this.size] : []),
      this.closingBracket,
    ];
  }

  override get firstChild(): Syntax | null {
    return this.exclamationMark;
  }

  override get lastChild(): Syntax | null {
    return this.closingBracket;
  }

  override accept<R>(visitor: SyntaxVisitor<R>): R {
    return visitor.visitShortcutReferenceImage(this);
  }
}

export class ImageSizeSyntax extends InlineClauseSyntax {
  readonly type = 'imageSize' as const;
  separatorsBefore: Array<TriviaTokenSyntax<'imageSizeWhitespace'>> = [];
  separatorsAfter: Array<TriviaTokenSyntax<'imageSizeWhitespace'>> = [];
  equalsSign!: DelimiterTokenSyntax<'equalsSign'>;
  width: DelimiterTokenSyntax<'imageSizeWidth'> | null = null;

  /** `x`. */
  separator: DelimiterTokenSyntax<'imageSizeSeparator'> | null = null;
  height: DelimiterTokenSyntax<'imageSizeHeight'> | null = null;

  protected override childNodes(): ReadonlyArray<Syntax> {
    return [
      ...this.separatorsBefore,
      this.equalsSign,
      ...(this.width ? [this.width] : []),
      ...(this.separator ? [this.separator] : []),
      ...(this.height ? [this.height] : []),
      ...this.separatorsAfter,
    ];
  }

  override get firstChild(): Syntax | null {
    return this.separatorsBefore[0] ?? this.equalsSign;
  }

  override get lastChild(): Syntax | null {
    return (
      this.separatorsAfter[this.separatorsAfter.length - 1] ??
      this.height ??
      this.separator ??
      this.width ??
      this.equalsSign
    );
  }

  override accept<R>(visitor: SyntaxVisitor<R>): R {
    return visitor.visitImageSize(this);
  }
}

export class AutolinkSyntax extends InlineSyntax {
  readonly type = 'autolink' as const;
  openingAngleBracket!: DelimiterTokenSyntax<'openingAngleBracket'>;

  /** The URI or the address. */
  address!: TextTokenSyntax<'autolinkAddress'>;
  closingAngleBracket!: DelimiterTokenSyntax<'closingAngleBracket'>;

  /** Where it leads: `mailto:` before an email address. */
  destination = '';

  protected override childNodes(): ReadonlyArray<Syntax> {
    return [this.openingAngleBracket, this.address, this.closingAngleBracket];
  }

  override get firstChild(): Syntax | null {
    return this.openingAngleBracket;
  }

  override get lastChild(): Syntax | null {
    return this.closingAngleBracket;
  }

  override accept<R>(visitor: SyntaxVisitor<R>): R {
    return visitor.visitAutolink(this);
  }
}

export class LiteralAutolinkSyntax extends InlineSyntax {
  readonly type = 'literalAutolink' as const;
  readonly tag = 'Text' as const;

  /** Where it leads: `http://` before `www.`, `mailto:` before an email address. */
  destination = '';

  protected override childNodes(): ReadonlyArray<never> {
    return EMPTY_CHILDREN;
  }

  override accept<R>(visitor: SyntaxVisitor<R>): R {
    return visitor.visitLiteralAutolink(this);
  }
}

export class RawHTMLSyntax extends InlineSyntax {
  readonly type = 'rawHTML' as const;
  children: Array<RawStringSegmentSyntax> = [];

  protected override childNodes(): ReadonlyArray<RawStringSegmentSyntax> {
    return this.children;
  }

  override get firstChild(): RawStringSegmentSyntax | null {
    return this.children[0] ?? null;
  }

  override get lastChild(): RawStringSegmentSyntax | null {
    return this.children[this.children.length - 1] ?? null;
  }

  override getChildren(): ReadonlyArray<RawStringSegmentSyntax>;
  override getChildren<T extends Syntax>(type: SyntaxClass<T>): ReadonlyArray<T>;
  override getChildren<T extends Syntax>(type?: SyntaxClass<T>): ReadonlyArray<Syntax> {
    return type ? super.getChildren(type) : this.children;
  }

  override accept<R>(visitor: SyntaxVisitor<R>): R {
    return visitor.visitRawHTML(this);
  }
}

export class HTMLCommentSyntax extends InlineSyntax {
  readonly type = 'htmlComment' as const;
  children: Array<RawStringSegmentSyntax> = [];

  protected override childNodes(): ReadonlyArray<RawStringSegmentSyntax> {
    return this.children;
  }

  override get firstChild(): RawStringSegmentSyntax | null {
    return this.children[0] ?? null;
  }

  override get lastChild(): RawStringSegmentSyntax | null {
    return this.children[this.children.length - 1] ?? null;
  }

  override getChildren(): ReadonlyArray<RawStringSegmentSyntax>;
  override getChildren<T extends Syntax>(type: SyntaxClass<T>): ReadonlyArray<T>;
  override getChildren<T extends Syntax>(type?: SyntaxClass<T>): ReadonlyArray<Syntax> {
    return type ? super.getChildren(type) : this.children;
  }

  override accept<R>(visitor: SyntaxVisitor<R>): R {
    return visitor.visitHTMLComment(this);
  }
}

export class HTMLLineBreakSyntax extends InlineSyntax {
  readonly type = 'htmlLineBreak' as const;

  /** Its text in pieces, as raw HTML's is. */
  children: Array<RawStringSegmentSyntax> = [];

  get frontier(): Frontier {
    return linearize(this.children);
  }

  protected override childNodes(): ReadonlyArray<RawStringSegmentSyntax> {
    return this.children;
  }

  override get firstChild(): RawStringSegmentSyntax | null {
    return this.children[0] ?? null;
  }

  override get lastChild(): RawStringSegmentSyntax | null {
    return this.children[this.children.length - 1] ?? null;
  }

  override getChildren(): ReadonlyArray<RawStringSegmentSyntax>;
  override getChildren<T extends Syntax>(type: SyntaxClass<T>): ReadonlyArray<T>;
  override getChildren<T extends Syntax>(type?: SyntaxClass<T>): ReadonlyArray<Syntax> {
    return type ? super.getChildren(type) : this.children;
  }

  override accept<R>(visitor: SyntaxVisitor<R>): R {
    return visitor.visitHTMLLineBreak(this);
  }
}

export class HTMLImageSyntax extends InlineSyntax implements HTMLImageSyntax.Attributes {
  readonly type = 'htmlImage' as const;

  /** Kagami: attribute ranges in the tag's text, with line endings normalized and container prefixes removed. */
  attributeRanges: Array<HTMLImageSyntax.AttributeRange> = [];

  /** Kagami: the offset of the closing `>` or `/>` in that same text. */
  closingStart = 0;

  /** Its text in pieces, as raw HTML's is. */
  children: Array<RawStringSegmentSyntax> = [];

  get frontier(): Frontier {
    return linearize(this.children);
  }

  /** `src`, its character references read; `""` when it has none. */
  destination = '';

  /** `alt`, read so; `""` when it has none. */
  alt = '';

  /** `title`, read so; null when it has none. */
  title: string | null = null;

  /** `width` and `height` when each is a whole number of pixels, with or without `px`. */
  width: number | null = null;
  height: number | null = null;

  protected override childNodes(): ReadonlyArray<RawStringSegmentSyntax> {
    return this.children;
  }

  override get firstChild(): RawStringSegmentSyntax | null {
    return this.children[0] ?? null;
  }

  override get lastChild(): RawStringSegmentSyntax | null {
    return this.children[this.children.length - 1] ?? null;
  }

  override getChildren(): ReadonlyArray<RawStringSegmentSyntax>;
  override getChildren<T extends Syntax>(type: SyntaxClass<T>): ReadonlyArray<T>;
  override getChildren<T extends Syntax>(type?: SyntaxClass<T>): ReadonlyArray<Syntax> {
    return type ? super.getChildren(type) : this.children;
  }

  override accept<R>(visitor: SyntaxVisitor<R>): R {
    return visitor.visitHTMLImage(this);
  }
}

export namespace HTMLImageSyntax {
  /** Kagami: every authored attribute, including duplicates, in tag-local UTF-16 offsets. */
  export interface AttributeRange {
    name: string;
    nameStart: number;
    nameEnd: number;
    value: AttributeValue | null;
  }

  /** Kagami: the authored value without its quotes, before character-reference decoding. */
  export interface AttributeValue {
    start: number;
    end: number;
    quote: '"' | "'" | null;
  }

  /** The values and source ranges supplied by an HTML image's attributes. */
  export interface Attributes {
    attributeRanges: Array<AttributeRange>;
    closingStart: number;
    destination: string;
    alt: string;
    title: string | null;
    width: number | null;
    height: number | null;
  }
}

export class FootnoteReferenceSyntax extends InlineSyntax {
  readonly type = 'footnoteReference' as const;
  openingBracket!: DelimiterTokenSyntax<'openingBracket'>;
  caret!: DelimiterTokenSyntax<'caret'>;
  children: Array<StringSegmentSyntax> = [];
  closingBracket!: DelimiterTokenSyntax<'closingBracket'>;

  /** The label its definition was matched by, normalized. */
  identifier = '';

  protected override childNodes(): ReadonlyArray<Syntax> {
    return [this.openingBracket, this.caret, ...this.children, this.closingBracket];
  }

  override get firstChild(): Syntax | null {
    return this.openingBracket;
  }

  override get lastChild(): Syntax | null {
    return this.closingBracket;
  }

  override accept<R>(visitor: SyntaxVisitor<R>): R {
    return visitor.visitFootnoteReference(this);
  }
}

export class WikilinkSyntax extends InlineSyntax {
  readonly type = 'wikilink' as const;
  openingBrackets!: DelimiterTokenSyntax<'openingWikiBrackets'>;
  target!: WikilinkPartSyntax;

  /** `|`; null when there is no alias. */
  aliasDelimiter: DelimiterTokenSyntax<'wikiAliasDelimiter'> | null = null;
  alias: WikilinkPartSyntax | null = null;
  closingBrackets!: DelimiterTokenSyntax<'closingWikiBrackets'>;

  /** The target, trimmed. */
  destination = '';

  /** The alias, trimmed; null when there is none. */
  displayText: string | null = null;

  protected override childNodes(): ReadonlyArray<Syntax> {
    return [
      this.openingBrackets,
      this.target,
      ...(this.aliasDelimiter ? [this.aliasDelimiter] : []),
      ...(this.alias ? [this.alias] : []),
      this.closingBrackets,
    ];
  }

  override get firstChild(): Syntax | null {
    return this.openingBrackets;
  }

  override get lastChild(): Syntax | null {
    return this.closingBrackets;
  }

  override accept<R>(visitor: SyntaxVisitor<R>): R {
    return visitor.visitWikilink(this);
  }
}

export class WikiEmbedSyntax extends InlineSyntax {
  readonly type = 'wikiEmbed' as const;
  exclamationMark!: DelimiterTokenSyntax<'exclamationMark'>;
  openingBrackets!: DelimiterTokenSyntax<'openingWikiBrackets'>;
  target!: WikilinkPartSyntax;
  aliasDelimiter: DelimiterTokenSyntax<'wikiAliasDelimiter'> | null = null;
  alias: WikilinkPartSyntax | null = null;

  /** The size at the end of the alias. */
  size: ImageSizeSyntax | null = null;
  closingBrackets!: DelimiterTokenSyntax<'closingWikiBrackets'>;
  destination = '';
  displayText: string | null = null;
  width: number | null = null;
  height: number | null = null;

  protected override childNodes(): ReadonlyArray<Syntax> {
    return [
      this.exclamationMark,
      this.openingBrackets,
      this.target,
      ...(this.aliasDelimiter ? [this.aliasDelimiter] : []),
      ...(this.alias ? [this.alias] : []),
      ...(this.size ? [this.size] : []),
      this.closingBrackets,
    ];
  }

  override get firstChild(): Syntax | null {
    return this.exclamationMark;
  }

  override get lastChild(): Syntax | null {
    return this.closingBrackets;
  }

  override accept<R>(visitor: SyntaxVisitor<R>): R {
    return visitor.visitWikiEmbed(this);
  }
}

export class WikilinkPartSyntax extends InlineClauseSyntax {
  readonly type = 'wikilinkPart' as const;
  children: Array<StringSegmentSyntax> = [];

  protected override childNodes(): ReadonlyArray<StringSegmentSyntax> {
    return this.children;
  }

  override get firstChild(): StringSegmentSyntax | null {
    return this.children[0] ?? null;
  }

  override get lastChild(): StringSegmentSyntax | null {
    return this.children[this.children.length - 1] ?? null;
  }

  override getChildren(): ReadonlyArray<StringSegmentSyntax>;
  override getChildren<T extends Syntax>(type: SyntaxClass<T>): ReadonlyArray<T>;
  override getChildren<T extends Syntax>(type?: SyntaxClass<T>): ReadonlyArray<Syntax> {
    return type ? super.getChildren(type) : this.children;
  }

  override accept<R>(visitor: SyntaxVisitor<R>): R {
    return visitor.visitWikilinkPart(this);
  }
}

export class TagSyntax extends InlineSyntax {
  readonly type = 'tag' as const;
  openingNumberSign!: DelimiterTokenSyntax<'openingNumberSign'>;
  name!: TextTokenSyntax<'tagName'>;

  /** The `#` that closes a paired tag; null for a tag that is not closed. */
  closingNumberSign: DelimiterTokenSyntax<'closingNumberSign'> | null = null;

  protected override childNodes(): ReadonlyArray<Syntax> {
    return [
      this.openingNumberSign,
      this.name,
      ...(this.closingNumberSign ? [this.closingNumberSign] : []),
    ];
  }

  override get firstChild(): Syntax | null {
    return this.openingNumberSign;
  }

  override get lastChild(): Syntax | null {
    return this.closingNumberSign ?? this.name;
  }

  override accept<R>(visitor: SyntaxVisitor<R>): R {
    return visitor.visitTag(this);
  }
}

export class EmojiShortcodeSyntax extends InlineSyntax {
  readonly type = 'emojiShortcode' as const;
  openingColon!: DelimiterTokenSyntax<'openingColon'>;
  name!: DelimiterTokenSyntax<'emojiName'>;
  closingColon!: DelimiterTokenSyntax<'closingColon'>;

  /** The emoji it stands for. */
  emoji = '';

  protected override childNodes(): ReadonlyArray<Syntax> {
    return [this.openingColon, this.name, this.closingColon];
  }

  override get firstChild(): Syntax | null {
    return this.openingColon;
  }

  override get lastChild(): Syntax | null {
    return this.closingColon;
  }

  override accept<R>(visitor: SyntaxVisitor<R>): R {
    return visitor.visitEmojiShortcode(this);
  }
}

export class TaskMarkerSyntax extends InlineSyntax {
  readonly type = 'taskMarker' as const;
  openingBracket!: DelimiterTokenSyntax<'openingBracket'>;

  /** The space, `x` or `X` between the brackets. */
  mark!: DelimiterTokenSyntax<'taskCheck'>;
  closingBracket!: DelimiterTokenSyntax<'closingBracket'>;
  separators: Array<TriviaTokenSyntax<'taskMarkerWhitespace'>> = [];
  checked!: boolean;

  protected override childNodes(): ReadonlyArray<Syntax> {
    return [this.openingBracket, this.mark, this.closingBracket, ...this.separators];
  }

  override get firstChild(): Syntax | null {
    return this.openingBracket;
  }

  override get lastChild(): Syntax | null {
    return this.separators[this.separators.length - 1] ?? this.closingBracket;
  }

  override accept<R>(visitor: SyntaxVisitor<R>): R {
    return visitor.visitTaskMarker(this);
  }
}

export class CalloutDeclarationSyntax extends InlineSyntax {
  readonly type = 'calloutDeclaration' as const;

  /** `[!`. */
  opening!: DelimiterTokenSyntax<'calloutOpeningMarker'>;

  /** The word, `NOTE`. Not `type`, which is a node's kind everywhere else. */
  typeName!: DelimiterTokenSyntax<'calloutTypeName'>;

  /** `]`. */
  closing!: DelimiterTokenSyntax<'calloutClosingMarker'>;
  separators: Array<TriviaTokenSyntax<'calloutDeclarationWhitespace'>> = [];
  calloutType!: CalloutType;

  protected override childNodes(): ReadonlyArray<Syntax> {
    return [this.opening, this.typeName, this.closing, ...this.separators];
  }

  override get firstChild(): Syntax | null {
    return this.opening;
  }

  override get lastChild(): Syntax | null {
    return this.separators[this.separators.length - 1] ?? this.closing;
  }

  override accept<R>(visitor: SyntaxVisitor<R>): R {
    return visitor.visitCalloutDeclaration(this);
  }
}

export class ATXClosingSequenceSyntax extends InlineSyntax {
  readonly type = 'atxClosingSequence' as const;
  separators: Array<TriviaTokenSyntax<'trailingWhitespace'>> = [];
  sequence!: DelimiterTokenSyntax<'atxClosingSequenceMarker'>;

  protected override childNodes(): ReadonlyArray<Syntax> {
    return [this.sequence, ...this.separators];
  }

  override get firstChild(): Syntax | null {
    return this.sequence;
  }

  override get lastChild(): Syntax | null {
    return this.separators[this.separators.length - 1] ?? this.sequence;
  }

  override accept<R>(visitor: SyntaxVisitor<R>): R {
    return visitor.visitATXClosingSequence(this);
  }
}

export class PendingCodeFenceSyntax extends PendingSyntax {
  readonly type = 'pendingCodeFence' as const;

  /** ```` ``` ````, `~~~~`. */
  fence!: DelimiterTokenSyntax<'codeFence'>;
  separators: Array<TriviaTokenSyntax<'codeFenceWhitespace'>> = [];

  /** The language part of the info string; null when there is none. */
  info: DelimiterTokenSyntax<'infoString'> | null = null;
  infoSeparators: Array<TriviaTokenSyntax<'codeFenceWhitespace'>> = [];

  /** The rest of the info string after its language. */
  meta: DelimiterTokenSyntax<'codeFenceMeta'> | null = null;

  protected override childNodes(): ReadonlyArray<Syntax> {
    return [
      this.fence,
      ...this.separators,
      ...(this.info ? [this.info] : []),
      ...this.infoSeparators,
      ...(this.meta ? [this.meta] : []),
    ];
  }

  override get firstChild(): Syntax | null {
    return this.fence;
  }

  override get lastChild(): Syntax | null {
    return (
      this.meta ??
      this.infoSeparators[this.infoSeparators.length - 1] ??
      this.info ??
      this.separators[this.separators.length - 1] ??
      this.fence
    );
  }

  override accept<R>(visitor: SyntaxVisitor<R>): R {
    return visitor.visitPendingCodeFence(this);
  }
}

export class PendingMathFenceSyntax extends PendingSyntax {
  readonly type = 'pendingMathFence' as const;
  fence!: DelimiterTokenSyntax<'mathFence'>;
  separators: Array<TriviaTokenSyntax<'mathFenceWhitespace'>> = [];

  /** What follows the fence on its line; null when nothing does. */
  meta: DelimiterTokenSyntax<'mathMeta'> | null = null;

  protected override childNodes(): ReadonlyArray<Syntax> {
    return [this.fence, ...this.separators, ...(this.meta ? [this.meta] : [])];
  }

  override get firstChild(): Syntax | null {
    return this.fence;
  }

  override get lastChild(): Syntax | null {
    return this.meta ?? this.separators[this.separators.length - 1] ?? this.fence;
  }

  override accept<R>(visitor: SyntaxVisitor<R>): R {
    return visitor.visitPendingMathFence(this);
  }
}

export class PendingListMarkerSyntax extends PendingSyntax {
  readonly type = 'pendingListMarker' as const;

  /** The marker, `-`, `1.`. */
  marker!: DelimiterTokenSyntax<'listMarker'>;

  protected override childNodes(): ReadonlyArray<Syntax> {
    return [this.marker];
  }

  override get firstChild(): Syntax | null {
    return this.marker;
  }

  override get lastChild(): Syntax | null {
    return this.marker;
  }

  override accept<R>(visitor: SyntaxVisitor<R>): R {
    return visitor.visitPendingListMarker(this);
  }
}

export class PendingATXHeadingMarkerSyntax extends PendingSyntax {
  readonly type = 'pendingATXHeadingMarker' as const;
  marker!: DelimiterTokenSyntax<'atxHeadingMarker'>;

  protected override childNodes(): ReadonlyArray<Syntax> {
    return [this.marker];
  }

  override get firstChild(): Syntax | null {
    return this.marker;
  }

  override get lastChild(): Syntax | null {
    return this.marker;
  }

  override accept<R>(visitor: SyntaxVisitor<R>): R {
    return visitor.visitPendingATXHeadingMarker(this);
  }
}

export class PendingThematicBreakSyntax extends PendingSyntax {
  readonly type = 'pendingThematicBreak' as const;
  readonly tag = 'Delimiter' as const;

  protected override childNodes(): ReadonlyArray<never> {
    return EMPTY_CHILDREN;
  }

  override accept<R>(visitor: SyntaxVisitor<R>): R {
    return visitor.visitPendingThematicBreak(this);
  }
}

export class PendingBlockQuoteMarkerSyntax extends PendingSyntax {
  readonly type = 'pendingBlockQuoteMarker' as const;

  /** Each `>`, in order. */
  markers: Array<DelimiterTokenSyntax<'blockQuoteMarker'>> = [];
  separators: Array<TriviaTokenSyntax<'blockQuoteWhitespace'>> = [];

  /** The line endings between the markers of `>` over `>`, in order. */
  lineEndings: Array<LineEndingSyntax> = [];

  protected override childNodes(): ReadonlyArray<Syntax> {
    return [...this.markers, ...this.separators, ...this.lineEndings].sort(compareSourceOrder);
  }

  override get firstChild(): Syntax | null {
    return earlier(earlier(this.markers[0], this.separators[0]), this.lineEndings[0]) ?? null;
  }

  override get lastChild(): Syntax | null {
    return (
      later(
        later(this.markers[this.markers.length - 1], this.separators[this.separators.length - 1]),
        this.lineEndings[this.lineEndings.length - 1]
      ) ?? null
    );
  }

  override accept<R>(visitor: SyntaxVisitor<R>): R {
    return visitor.visitPendingBlockQuoteMarker(this);
  }
}

export class PendingFootnoteLabelSyntax extends PendingSyntax {
  readonly type = 'pendingFootnoteLabel' as const;

  /** `[^`. */
  opening!: DelimiterTokenSyntax<'footnoteOpeningMarker'>;
  label!: FootnoteLabelSyntax;

  /** `]`. */
  closingBracket!: DelimiterTokenSyntax<'closingBracket'>;

  /** `:`. */
  colon!: DelimiterTokenSyntax<'colon'>;

  protected override childNodes(): ReadonlyArray<Syntax> {
    return [this.opening, this.label, this.closingBracket, this.colon];
  }

  override get firstChild(): Syntax | null {
    return this.opening;
  }

  override get lastChild(): Syntax | null {
    return this.colon;
  }

  override accept<R>(visitor: SyntaxVisitor<R>): R {
    return visitor.visitPendingFootnoteLabel(this);
  }
}

export class PendingSetextUnderlineSyntax extends PendingSyntax {
  readonly type = 'pendingSetextUnderline' as const;
  readonly tag = 'Delimiter' as const;

  protected override childNodes(): ReadonlyArray<never> {
    return EMPTY_CHILDREN;
  }

  override accept<R>(visitor: SyntaxVisitor<R>): R {
    return visitor.visitPendingSetextUnderline(this);
  }
}

export class PendingTableSyntax extends PendingSyntax {
  readonly type = 'pendingTable' as const;

  /** The cells of the header row, each holding its inline content. */
  cells: Array<TableCellSyntax> = [];

  /** Each `|` of the header row, in order. */
  cellDividers: Array<DelimiterTokenSyntax<'tableCellDivider'>> = [];
  separators: Array<TriviaTokenSyntax<'tableCellWhitespace'>> = [];
  lineEnding!: LineEndingSyntax;
  delimiterRow!: DelimiterTokenSyntax<'tableDelimiterRowMarker'>;

  protected override childNodes(): ReadonlyArray<Syntax> {
    return [
      ...[...this.cells, ...this.cellDividers, ...this.separators].sort(compareSourceOrder),
      this.lineEnding,
      this.delimiterRow,
    ];
  }

  override get firstChild(): Syntax | null {
    return (
      earlier(earlier(this.cells[0], this.cellDividers[0]), this.separators[0]) ?? this.lineEnding
    );
  }

  override get lastChild(): Syntax | null {
    return this.delimiterRow;
  }

  override accept<R>(visitor: SyntaxVisitor<R>): R {
    return visitor.visitPendingTable(this);
  }
}

export class PendingHTMLBlockSyntax extends PendingSyntax {
  readonly type = 'pendingHTMLBlock' as const;

  /** The specification's start condition, 1 to 7. */
  startCondition!: HTMLFlowCondition;
  children: Array<InlineSyntax> = [];

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

  override accept<R>(visitor: SyntaxVisitor<R>): R {
    return visitor.visitPendingHTMLBlock(this);
  }
}

export class LinkTitleStartSyntax extends InlineSyntax {
  readonly type = 'linkTitleStart' as const;
  whitespace!: TriviaTokenSyntax<'titleStartWhitespace'>;

  /** `"`, `'` or `(`; null when only whitespace is typed. */
  delimiter: DelimiterTokenSyntax<'titleDelimiter'> | null = null;

  protected override childNodes(): ReadonlyArray<Syntax> {
    return this.delimiter ? [this.whitespace, this.delimiter] : [this.whitespace];
  }

  override get firstChild(): Syntax | null {
    return this.whitespace;
  }

  override get lastChild(): Syntax | null {
    return this.delimiter ?? this.whitespace;
  }

  override accept<R>(visitor: SyntaxVisitor<R>): R {
    return visitor.visitLinkTitleStart(this);
  }
}

export type InlineLeafSyntax =
  | TokenSyntax
  | SoftLineBreakSyntax
  | LiteralAutolinkSyntax
  | PendingThematicBreakSyntax
  | PendingSetextUnderlineSyntax;

function compareSourceOrder(left: Syntax, right: Syntax): number {
  return left.start - right.start || left.end - right.end;
}

function earlier(left: Syntax | undefined, right: Syntax | undefined): Syntax | undefined {
  if (!left) return right;
  if (!right) return left;
  return compareSourceOrder(left, right) <= 0 ? left : right;
}

function later(left: Syntax | undefined, right: Syntax | undefined): Syntax | undefined {
  if (!left) return right;
  if (!right) return left;
  return compareSourceOrder(left, right) >= 0 ? left : right;
}
