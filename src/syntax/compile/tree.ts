/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-FileCopyrightText: Titus Wormer <tituswormer@gmail.com>
 * SPDX-License-Identifier: MPL-2.0 AND MIT
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Derived from mdast-util-from-markdown, https://github.com/syntax-tree/mdast-util-from-markdown. */

import { ReferenceQuestions } from './references.js';
import {
  ATXHeadingSyntax,
  BlockQuoteSyntax,
  BlockSyntax,
  BulletListSyntax,
  CalloutSyntax,
  CalloutTitleSyntax,
  ClauseSyntax,
  CodeBlockSyntax,
  ContainerBlockSyntax,
  DocumentSyntax,
  FencedCodeBlockSyntax,
  FootnoteDefinitionSyntax,
  FrontMatterSyntax,
  HeadingSyntax,
  HTMLBlockSyntax,
  HTMLTagBlockSyntax,
  IndentedCodeBlockSyntax,
  LinkDestinationSyntax,
  LinkLabelSyntax,
  LinkReferenceDefinitionSyntax,
  LinkTitleSyntax,
  ListItemSyntax,
  LiteralBlockSyntax,
  MathBlockSyntax,
  OrderedListSyntax,
  ParagraphSyntax,
  RawFrontMatterSyntax,
  SetextHeadingSyntax,
  TableDelimiterRowSyntax,
  TableRowSyntax,
  TableSyntax,
  ThematicBreakSyntax,
} from '../syntax/block.js';
import type { CalloutType } from '../constructs/text/inline-source-callout-declaration.js';
import { Syntax } from '../syntax/syntax.js';
import {
  ATXClosingSequenceSyntax,
  AutolinkSyntax,
  BackslashEscapeSyntax,
  CalloutDeclarationSyntax,
  CharacterReferenceSyntax,
  CodeSpanSyntax,
  CollapsedReferenceImageSyntax,
  CollapsedReferenceLinkSyntax,
  DelimitedSyntax,
  DelimiterTokenSyntax,
  FullReferenceImageSyntax,
  FullReferenceLinkSyntax,
  HardLineBreakSyntax,
  HTMLCommentSyntax,
  HTMLImageSyntax,
  HTMLLineBreakSyntax,
  ImageSyntax,
  InlineImageSyntax,
  InlineSyntax,
  InlineLinkSyntax,
  InlineMathSyntax,
  LinkSyntax,
  RawHTMLSyntax,
  ReferenceImageSyntax,
  ReferenceLinkSyntax,
  ReferenceSyntax,
  ResourceDestinationSyntax,
  ResourceTitleSyntax,
  ShortcutReferenceImageSyntax,
  ShortcutReferenceLinkSyntax,
  SoftLineBreakSyntax,
  type StringSegmentSyntax,
  TextTokenSyntax,
  TriviaTokenSyntax,
} from '../syntax/inline.js';
import { append, appendInline, children, replaceCurrent } from './children.js';

import { Fragment } from './types.js';

import type { Event, Point, Token } from '../types/index.js';

import type { Bindings } from '../syntax/reading.js';
import type {
  CompileContext,
  Compiler,
  CompileData,
  Config,
  Extension,
  Handle,
  OnEnterError,
  OnExitError,
  Options,
} from './types.js';
import { assert } from '../kernel/assert.js';
import { decodeNamedCharacterReference } from '../kernel/utils/decode-named-character-reference/index.js';
import { phrasingDocument } from '../constructs/bundle.js';
import { decodeNumericCharacterReference } from '../kernel/utils/decode-numeric-character-reference/index.js';
import { normalizeIdentifier } from '../kernel/utils/normalize-identifier/index.js';
import { stringifyPosition } from '../kernel/utils/stringify-position/index.js';
import { SpliceBuffer } from '../kernel/utils/subtokenize/lib/splice-buffer.js';
import { codes, constants, types } from '../kernel/utils/symbol/index.js';
// ZWSP edge mark: finish candidate ownership with each complete text field.
import { exitEdgeMark } from './edge-mark.js';
import { imageAttributes, readOpeningTag } from './html-tags.js';
import { toString } from './to-string.js';
import { measureWidth } from './width.js';
import { blockSpelling, columns, containerSpelling, written } from './spelling.js';
import { beginLiteral, literalValue, literalEnding, endLiteral } from './literal.js';

import { blockTypes, containerTypes, prepareLines } from './lines.js';
import { finishNode } from './envelope.js';

const own = {}.hasOwnProperty;

/**
 * Compile complete event streams, with source and grammar on the handler context.
 * Kagami: handlers keep the upstream tables and token stack, with no hidden input state.
 *
 * @param options
 * @param localDefinitions
 *   Definition semantics from this input when only a fragment is being compiled.
 * @param authoredParagraph
 *   This fragment is an ordinary live paragraph, whose outside whitespace is text.
 */
export function createCompiler(
  options: Options.Inline,
  localDefinitions?: ReadonlyMap<string, Bindings.Definition>,
  authoredParagraph?: boolean
): Compiler<Fragment>;
export function createCompiler(
  options?: Options.Document,
  localDefinitions?: ReadonlyMap<string, Bindings.Definition>,
  authoredParagraph?: boolean
): Compiler<DocumentSyntax>;
export function createCompiler(
  options: Options,
  localDefinitions?: ReadonlyMap<string, Bindings.Definition>,
  authoredParagraph?: boolean
): Compiler;
export function createCompiler(
  options?: Options | null,
  localDefinitions?: ReadonlyMap<string, Bindings.Definition>,
  authoredParagraph = false
) {
  const compiler = new TreeCompiler(options || {}, localDefinitions, authoredParagraph);
  return compiler.compile.bind(compiler);
}

/** The configuration and handler state retained by one compiler. */
class TreeCompiler {
  readonly config: Config;
  readonly data: CompileData = {};

  constructor(
    readonly settings: Options,
    readonly localDefinitions: ReadonlyMap<string, Bindings.Definition> | undefined,
    readonly authoredParagraph: boolean
  ) {
    const config: Config = {
      transforms: [(tree) => this.references(tree)],
      canContainEOLs: [
        'emphasis',
        'fragment',
        'atxHeading',
        'setextHeading',
        'paragraph',
        'strongEmphasis',
      ],
      enter: {
        autolink: opener(autolink),
        atxHeading: opener(heading),
        atxHeadingText: onenteratxheadingtext,
        blockQuote: opener(blockQuote, onenterblockquote),
        calloutDeclaration: opener(calloutDeclaration),
        calloutTitle: opener(calloutTitle),
        characterEscape: opener(characterEscape),
        characterReference: opener(characterReference),
        codeFenced: opener(codeFlow),
        codeFencedFenceInfo: onentercodefencedfenceinfo,
        codeFencedFenceMeta: onentercodefencedfenceinfo,
        codeIndented: opener(codeFlow),
        codeText: opener(codeText),
        codeTextData: onenterdata,
        data: onenterdata,
        definition: opener(definition),
        definitionDestination: onenterdefinitiondestination,
        definitionDestinationString: onenterstring,
        definitionLabelString: onenterstring,
        definitionTitle: onenterdefinitiontitle,
        definitionTitleString: onenterstring,
        emphasis: opener(emphasis),
        hardBreakEscape: opener(hardBreak),
        hardBreakTrailing: opener(hardBreak),
        htmlFlow: opener(html),
        htmlText: opener(htmlText),
        htmlTextData: onenterhtmltextdata,
        image: opener(image),
        label: buffer,
        link: opener(link),
        listItem: opener(listItem),
        listItemValue: onenterlistitemvalue,
        listOrdered: opener(list, onenterlistordered),
        listUnordered: opener(list),
        paragraph: opener(paragraph, onenterparagraph),
        reference: onenterreference,
        referenceString: onenterstring,
        resource: onenterresource,
        resourceDestination: onenterresourcedestination,
        resourceDestinationString: onenterstring,
        resourceTitleString: onenterstring,
        setextHeading: opener(heading),
        strong: opener(strong),
        thematicBreak: opener(thematicBreak),
      },
      exit: {
        atxHeading: closer(onexitatxheading),
        atxHeadingSequence: onexitatxheadingsequence,
        autolink: closer(),
        autolinkEmail: onexitautolinkemail,
        autolinkMarker: onexitautolinkmarker,
        autolinkProtocol: onexitautolinkprotocol,
        blockQuote: closer(),
        blockQuotePrefix: onexitblockquoteprefix,
        blockQuotePrefixWhitespace: onexitblockquoteprefixwhitespace,
        calloutDeclaration: onexitcalloutdeclaration,
        calloutDeclarationMarker: onexitcalloutdeclarationmarker,
        calloutDeclarationType: onexitcalloutdeclarationtype,
        calloutHead: onexitcallouthead,
        calloutTitle: onexitcallouttitle,
        characterEscape: closer(),
        characterEscapeValue: onexitcharacterescapevalue,
        characterReferenceMarker: onexitcharacterreferencedelimiter,
        characterReferenceMarkerHexadecimal: onexitcharacterreferencemarker,
        characterReferenceMarkerNumeric: onexitcharacterreferencemarker,
        characterReferenceValue: onexitcharacterreferencevalue,
        characterReference: closer(),
        codeFenced: closer(),
        codeFencedFence: onexitcodefencedfence,
        codeFencedFenceInfo: onexitcodefencedfenceinfo,
        codeFencedFenceMeta: onexitcodefencedfencemeta,
        codeFencedFenceSequence: onexitcodefencedfencesequence,
        codeFlowValue: onexitcodeflowvalue,
        codeIndented: closer(),
        codeText: closer(),
        codeTextData: onexitcodetextdata,
        codeTextPadding: onexitcodetextpadding,
        codeTextSequence: onexitcodetextsequence,
        codeTextTableEscape: onexittablepipeescape,
        data: onexitdata,
        definition: closer(),
        definitionDestination: onexitdefinitionfield,
        definitionDestinationLiteralMarker: onexitdefinitiondestinationmarker,
        definitionDestinationString: onexitdefinitiondestinationstring,
        definitionLabelString: onexitdefinitionlabelstring,
        definitionMarker: onexitdefinitionmarker,
        definitionTitle: onexitdefinitionfield,
        definitionTitleMarker: onexittitlemarker,
        definitionTitleString: onexitdefinitiontitlestring,
        emphasis: closer(),
        emphasisSequence: onexitsequence,
        escapeMarker: onexitescapemarker,
        hardBreakEscape: closer(onexithardbreak),
        hardBreakTrailing: closer(onexithardbreak),
        htmlFlow: closer(onexithtmlflow),
        htmlFlowData: onexithtmlflowdata,
        htmlText: closer(onexithtmltext),
        htmlTextData: onexithtmltextdata,
        image: closer(onexitlink),
        label: onexitlabel,
        labelImageMarker: onexitlabelimagemarker,
        labelMarker: onexitlabelmarker,
        labelText: onexitlabeltext,
        lineEnding: onexitlineending,
        lineEndingBlank: onexitlineendingblank,
        linePrefix: onexitlineprefix,
        lineSuffix: onexitlinetrivia,
        link: closer(onexitlink),
        listItem: closer(onexitlistitem),
        listItemIndent: onexitprefix,
        gfmFootnoteDefinitionIndent: onexitprefix,
        listItemMarker: onexitlistitemmarker,
        listItemPrefixWhitespace: onexitlistitemprefixwhitespace,
        listItemPrefix: onexitcontaineropening,
        listItemValue: onexitlistitemvalue,
        listOrdered: closer(onexitlistordered),
        listUnordered: closer(),
        paragraph: onexitparagraph,
        referenceMarker: onexitreferencemarker,
        referenceString: onexitreferencestring,
        resourceDestinationLiteralMarker: onexitresourcedestinationliteralmarker,
        resourceDestinationString: onexitresourcedestinationstring,
        resourceMarker: onexitresourcemarker,
        resourceTitleMarker: onexitresourcetitlemarker,
        resourceTitleString: onexitresourcetitlestring,
        setextHeading: closer(onexitsetextheading),
        setextHeadingLineSequence: onexitsetextheadinglinesequence,
        setextHeadingText: onexitsetextheadingtext,
        strong: closer(),
        strongSequence: onexitsequence,
        thematicBreak: closer(),
        whitespace: onexitwhitespace,
      },
    };

    configure(config, settings.mdastExtensions || []);
    this.config = config;
  }

  /**
   * Turn micromark events into a syntax tree.
   *
   * @param events
   *   Events.
   * @param value
   *   The text the events are of.
   * @returns
   *   Syntax tree.
   */
  compile(events: Array<Event>, value: string): DocumentSyntax | Fragment {
    const { settings, config, data, localDefinitions, authoredParagraph } = this;
    const document = new DocumentSyntax();
    document.spelling = { start: 0, end: 0 };
    let tree: DocumentSyntax = document;
    const context: CompileContext.Shared = {
      target: settings.target,
      source: value,
      grammar: settings.grammar,
      authoredParagraph,
      stack: [tree],
      tokenStack: [],
      config,
      enter,
      exit,
      buffer,
      resume,
      data,
    };
    const listStack: Array<number> = [];
    let index = -1;

    data.lineEnding = undefined;

    // Kagami: the text of a field has no block around it; its nodes are made
    // in a fragment, as a string’s are.
    if (settings.contentType === 'text' || settings.contentType === 'string') {
      context.stack.push(new Fragment());
      context.data.inString = settings.contentType === 'string' || undefined;
    }

    // Kagami: as in micromark-util-subtokenize, one buffer for the pass keeps
    // list-item insertions from moving the whole event-array suffix each time.
    const listEvents = new SpliceBuffer(events);

    while (++index < listEvents.length) {
      // We preprocess lists to add `listItem` tokens, and to infer whether
      // items the list itself are spread out.
      if (
        listEvents.get(index)[1].type === types.listOrdered ||
        listEvents.get(index)[1].type === types.listUnordered
      ) {
        if (listEvents.get(index)[0] === 'enter') {
          listStack.push(index);
        } else {
          const tail = listStack.pop();
          assert(typeof tail === 'number', 'expected list to be open');
          index = prepareList(listEvents, tail, index);
        }
      }
    }

    // Kagami: callers consume the tree, not the inserted events. Materialize
    // once for the remaining passes without replacing the caller's array.
    events = listEvents.slice(0);

    // Kagami: we preprocess lines to find the blank lines around blocks, and
    // how far lines are indented.
    tree.spelling = prepareLines(events);

    index = -1;

    while (++index < events.length) {
      const event = events[index];
      const handler = config[event[0]];

      if (
        event[0] === 'exit' &&
        (event[1].type === types.lineEnding || event[1].type === types.lineEndingBlank)
      ) {
        data.lineEnding = event[1];
      }

      if (own.call(handler, event[1].type)) {
        handler[event[1].type].call(
          Object.assign(
            { sliceSerialize: event[2].sliceSerialize, tabColumns: event[2].tabColumns },
            context
          ),
          event[1]
        );
      }
    }

    // Handle tokens still being open.
    if (context.tokenStack.length > 0) {
      const tail = context.tokenStack[context.tokenStack.length - 1]!;
      const handler = tail[1] || defaultOnError;
      handler.call(context, undefined, tail[0]);
    }

    if (settings.contentType === 'text' || settings.contentType === 'string') {
      const fragment = context.stack.pop();
      assert(fragment && fragment instanceof Fragment, 'expected fragment on stack');
      context.data.inString = undefined;
      resolveReferences(fragment, settings.bindings ?? undefined, localDefinitions);
      fragment.references.add(new ReferenceQuestions(events).labels(events[0]?.[1].start.offset, events.at(-1)?.[1].end.offset));
      return fragment;
    }

    // Figure out `root` position.
    tree.start = point(events.length > 0 ? events[0]![1].start : { line: 1, column: 1, offset: 0 });
    tree.end = point(
      events.length > 0 ? events[events.length - 2]![1].end : { line: 1, column: 1, offset: 0 }
    );

    // Call transforms.
    index = -1;
    while (++index < config.transforms.length) {
      tree = config.transforms[index]!(tree) || tree;
    }

    finishNode(tree);
    data.prefixStart = undefined;
    data.blankStart = undefined;
    data.lastBlankStart = undefined;
    data.containerDepth = undefined;
    data.containerPrefixes = undefined;

    new ReferenceQuestions(events).fields(tree);
    return tree;
  }

  /**
   * Give each reference its definition’s destination and title.
   *
   * @param tree
   *   Tree.
   */
  references(tree: DocumentSyntax): undefined {
    resolveReferences(tree, this.settings.bindings || undefined, this.localDefinitions);
  }

}

/** End the last body line, carrying a child's cut past indentation but not later explicit syntax. */
function finishBody(
  node: BlockSyntax | FrontMatterSyntax,
  token: Token,
  ending: Token | undefined
): number {
  if (node instanceof IndentedCodeBlockSyntax) return node.bodyEnd;
  if (node instanceof ContainerBlockSyntax) {
    const child = node.children[node.children.length - 1];
    if (
      child &&
      (token._lastPrefixEnd === undefined || token._lastPrefixEnd <= child.bodyEnd)
    ) {
      return child.bodyEnd;
    }
  }
  return ending && ending.end.offset === node.end ? ending.start.offset : node.end;
}

/** Extend the closed tail; a row's line ending never enters its cells. */
function extendBlock(node: BlockSyntax | FrontMatterSyntax | ClauseSyntax, end: number): undefined {
  const tail = node.lastChild;

  if (
    !(node instanceof TableRowSyntax) &&
    !(node instanceof TableDelimiterRowSyntax) &&
    tail &&
    (tail instanceof BlockSyntax ||
      tail instanceof FrontMatterSyntax ||
      tail instanceof ClauseSyntax) &&
    tail.end === node.end
  ) {
    extendBlock(tail, end);
    if (
      (node instanceof BlockSyntax || node instanceof FrontMatterSyntax) &&
      (tail instanceof BlockSyntax || tail instanceof FrontMatterSyntax)
    ) {
      node.bodyEnd = Math.max(node.bodyEnd, tail.bodyEnd);
    }
  } else {
    if (
      (node instanceof LiteralBlockSyntax && !(node instanceof IndentedCodeBlockSyntax)) ||
      node instanceof RawFrontMatterSyntax
    ) {
      // A container cutoff can precede the last content row's ending. Once
      // that ending arrives, the field's earlier ending is inside the body.
      // Indented code instead ends at its last nonblank value token.
      node.bodyEnd = Math.max(node.bodyEnd, node.end - node.trailing);
    }
    node.trailing += end - node.end;
  }
  node.end = end;
}

/**
 * Copy a point-like value.
 *
 * Kagami: a position is an offset.
 *
 * @param d
 *   Point-like value.
 * @returns
 *   Offset.
 */
export function point(d: Point.Source): number {
  return d.offset;
}

/**
 * The whitespace between two tokens, as written; a line ending in it is
 * written `\n`.
 */
function between(context: CompileContext, left: Token, right: Token): string {
  // Kagami: adjacent tokens have no gap, including at a numeric input chunk.
  // micromark's sliceSerialize expects a nonempty token at such a boundary.
  if (left.end.offset === right.start.offset) return '';
  return context.sliceSerialize({ start: left.end, end: right.start }).replace(/\r\n?/g, '\n');
}

/**
 * The quote a title is written between.
 */
function delimiter(context: CompileContext, marker: Token | undefined): '"' | "'" | '(' {
  assert(marker, 'expected a title marker');
  const value = context.sliceSerialize(marker);
  assert(value === '"' || value === "'" || value === '(', 'expected a quote');
  return value;
}

/** Copy the label slots shared by every link and image form. */
function copyLabel(previous: LinkSyntax | ImageSyntax, node: LinkSyntax | ImageSyntax): void {
  node.openingBracket = previous.openingBracket;
  node.closingBracket = previous.closingBracket;
  node.children = previous.children;
  if (previous instanceof ImageSyntax && node instanceof ImageSyntax) {
    node.exclamationMark = previous.exclamationMark;
    node.size = previous.size;
    node.alt = previous.alt;
    node.width = previous.width;
    node.height = previous.height;
  }
}

/** An empty reference bracket pair has its own class and no reference clause. */
function collapseReference(context: CompileContext): void {
  const previous = context.stack[context.stack.length - 1];
  if (
    context.data.referenceType === 'collapsed' &&
    (previous instanceof FullReferenceLinkSyntax || previous instanceof FullReferenceImageSyntax)
  ) {
    const node =
      previous instanceof ImageSyntax
        ? new CollapsedReferenceImageSyntax()
        : new CollapsedReferenceLinkSyntax();
    copyLabel(previous, node);
    node.identifier = previous.identifier;
    node.referenceOpeningBracket = previous.reference.openingBracket;
    node.referenceClosingBracket = previous.reference.closingBracket;
    replaceCurrent(context, node);
  }
  context.data.referenceType = undefined;
}

/**
 * Give each reference the destination and title of its definition: the first
 * definition of its label in the tree, or one bound elsewhere.
 *
 * @param tree
 *   Tree.
 * @param bindings
 *   What is defined elsewhere.
 * @returns
 *   Nothing.
 */
function resolveReferences(
  tree: DocumentSyntax | Fragment,
  bindings: Bindings | undefined,
  localDefinitions?: ReadonlyMap<string, Bindings.Definition>
): undefined {
  const definitions = new Map<string, LinkReferenceDefinitionSyntax>();
  const references: Array<ReferenceLinkSyntax | ReferenceImageSyntax> = [];
  const collect = (node: Syntax): void => {
    if (node instanceof LinkReferenceDefinitionSyntax && !definitions.has(node.identifier)) {
      definitions.set(node.identifier, node);
    } else if (node instanceof ReferenceLinkSyntax || node instanceof ReferenceImageSyntax)
      references.push(node);
  };
  if (tree instanceof DocumentSyntax) tree.iterate({ enter: collect });
  else for (const child of tree.children) child.iterate({ enter: collect });
  for (const node of references) {
    const definition =
      definitions.get(node.identifier) ??
      localDefinitions?.get(node.identifier) ??
      bindings?.definition(node.identifier);
    assert(definition, 'expected reference definition');
    node.destination = definition.destination;
    node.title = definition.title;
  }
}

/**
 * @param combined
 * @param extensions
 */
function configure(combined: Config, extensions: Array<Array<Extension> | Extension>): undefined {
  let index = -1;

  while (++index < extensions.length) {
    const value = extensions[index]!;

    if (Array.isArray(value)) {
      configure(combined, value);
    } else {
      extension(combined, value);
    }
  }
}

/**
 * @param combined
 * @param extension
 */
function extension(combined: Config, extension: Extension): undefined {
  let key: keyof Extension;

  for (key in extension) {
    if (own.call(extension, key)) {
      switch (key) {
        case 'canContainEOLs': {
          const right = extension[key];
          if (right) {
            combined[key].push(...right);
          }

          break;
        }

        case 'transforms': {
          const right = extension[key];
          if (right) {
            combined[key].push(...right);
          }

          break;
        }

        case 'enter':
        case 'exit': {
          const right = extension[key];
          if (right) {
            Object.assign(combined[key], right);
          }

          break;
        }
        // No default
      }
    }
  }
}

function defaultOnError(left: Token | undefined, right: Token): undefined {
  if (left) {
    throw new Error(
      'Cannot close `' +
        left.type +
        '` (' +
        stringifyPosition({ start: left.start, end: left.end }) +
        '): a different token (`' +
        right.type +
        '`, ' +
        stringifyPosition({ start: right.start, end: right.end }) +
        ') is open'
    );
  } else {
    throw new Error(
      'Cannot close document, a token (`' +
        right.type +
        '`, ' +
        stringifyPosition({ start: right.start, end: right.end }) +
        ') is still open'
    );
  }
}

/**
 * @param events
 * @param start
 * @param length
 */
// Kagami: indexed reads and splices follow subtokenize's SpliceBuffer use.
function prepareList(events: SpliceBuffer<Event>, start: number, length: number): number {
  let index = start - 1;
  let containerBalance = -1;
  let listSpread = false;
  let listItem: Token | undefined;
  let lineIndex: number | undefined;
  let firstBlankLineIndex: number | undefined;
  let atMarker: boolean | undefined;

  while (++index <= length) {
    const event = events.get(index);

    switch (event[1].type) {
      case types.listUnordered:
      case types.listOrdered:
      case types.blockQuote: {
        if (event[0] === 'enter') {
          containerBalance++;
        } else {
          containerBalance--;
        }

        atMarker = undefined;

        break;
      }

      case types.lineEndingBlank: {
        if (event[0] === 'enter') {
          if (
            listItem &&
            !atMarker &&
            !containerBalance &&
            !firstBlankLineIndex
          ) {
            firstBlankLineIndex = index;
          }

          atMarker = undefined;
        }

        break;
      }

      case types.linePrefix:
      case types.listItemValue:
      case types.listItemMarker:
      case types.listItemPrefix:
      case types.listItemPrefixWhitespace: {
        // Empty.

        break;
      }

      default: {
        atMarker = undefined;
      }
    }

    if (
      (!containerBalance &&
        event[0] === 'enter' &&
        event[1].type === types.listItemPrefix) ||
      (containerBalance === -1 &&
        event[0] === 'exit' &&
        (event[1].type === types.listUnordered ||
          event[1].type === types.listOrdered))
    ) {
      if (listItem) {
        let tailIndex = index;
        lineIndex = undefined;

        while (tailIndex--) {
          const tailEvent = events.get(tailIndex);

          if (
            tailEvent[1].type === types.lineEnding ||
            tailEvent[1].type === types.lineEndingBlank
          ) {
            if (tailEvent[0] === 'exit') continue;

            if (lineIndex) {
              events.get(lineIndex)[1].type = types.lineEndingBlank;
              listSpread = true;
            }

            tailEvent[1].type = types.lineEnding;
            lineIndex = tailIndex;
          } else if (
            tailEvent[1].type === types.linePrefix ||
            tailEvent[1].type === types.blockQuotePrefix ||
            tailEvent[1].type === types.blockQuotePrefixWhitespace ||
            tailEvent[1].type === types.blockQuoteMarker ||
            tailEvent[1].type === types.listItemIndent ||
            tailEvent[1].type === 'gfmFootnoteDefinitionIndent'
          ) {
            // Empty
          } else {
            break;
          }
        }

        if (
          firstBlankLineIndex &&
          (!lineIndex || firstBlankLineIndex < lineIndex)
        ) {
          listItem._spread = true;
        }

        // Fix position.
        let end = event[1].end;
        if (lineIndex) end = events.get(lineIndex)[1].start;
        else if (event[1].type === types.listItemPrefix) end = event[1].start;
        listItem.end = Object.assign({}, end);

        events.splice(lineIndex || index, 0, [['exit', listItem, event[2]]]);
        index++;
        length++;
      }

      // Create a new list item.
      if (event[1].type === types.listItemPrefix) {
        const item: Token = {
          type: 'listItem',
          _spread: false,
          start: Object.assign({}, event[1].start),
          end: Object.assign({}, event[1].end),
        };
        listItem = item;
        events.splice(index, 0, [['enter', item, event[2]]]);
        index++;
        length++;
        firstBlankLineIndex = undefined;
        atMarker = true;
      }
    }
  }

  events.get(start)[1]._spread = listSpread;
  return length;
}

/**
 * Create an opener handle.
 *
 * @param create
 *   Create a node.
 * @param and
 *   Optional function to also run.
 * @returns
 *   Handle.
 */
function opener(create: (token: Token) => Syntax, and?: Handle | undefined): Handle {
  return open;

  function open(this: CompileContext, token: Token): undefined {
    enter.call(this, create(token), token);
    if (and) and.call(this, token);
  }
}
function buffer(this: CompileContext): undefined {
  this.stack.push(new Fragment());
}
function enter(
  this: CompileContext,
  node: Syntax,
  token: Token,
  errorHandler?: OnEnterError | null | undefined
): undefined {
  const parent = this.stack[this.stack.length - 1];
  assert(parent, 'expected `parent`');

  node.start = point(token.start);

  if (blockTypes.includes(token.type)) {
    assert(node instanceof BlockSyntax || node instanceof FrontMatterSyntax, 'expected block');
    const prefix = this.data.prefixStart;
    const blank = this.data.blankStart;
    const lastBlank = this.data.lastBlankStart;
    let tail: Syntax | null | undefined;
    if (parent instanceof DocumentSyntax)
      tail = parent.children[parent.children.length - 1] ?? parent.frontMatter;
    else if (parent instanceof ContainerBlockSyntax) {
      tail = parent.children[parent.children.length - 1];
      if (!tail && parent instanceof CalloutSyntax) tail = parent.title;
      if (!tail && parent instanceof FootnoteDefinitionSyntax) tail = parent.label;
    }

    if (prefix !== undefined) {
      node.start = prefix;
    }

    node.bodyStart = node.start;

    if (
      blank !== undefined &&
      lastBlank !== undefined &&
      tail &&
      (tail instanceof BlockSyntax ||
        tail instanceof FrontMatterSyntax ||
        tail instanceof ClauseSyntax)
    ) {
      const end = blank === lastBlank ? node.start : lastBlank;
      tail.trailing += end - tail.end;
      tail.end = end;

      if (blank !== lastBlank) {
        node.start = lastBlank;
      }
    }

    node.leading = point(token.start) - node.start;
    this.data.blankStart = undefined;
    this.data.lastBlankStart = undefined;
  }

  if (this.data.intermediateStart !== undefined && node instanceof ClauseSyntax) {
    node.start = this.data.intermediateStart;
    this.data.intermediateStart = undefined;
  }

  if (!(node instanceof BulletListSyntax) && !(node instanceof OrderedListSyntax)) {
    this.data.prefixStart = undefined;
  }
  append(this, parent, node);
  this.stack.push(node);
  this.tokenStack.push([token, errorHandler || undefined]);

  if (token.type === types.codeIndented || token.type === types.htmlFlow) {
    beginLiteral(this, token, false);
  }

  // A list has no prefix of its own: its item occupies the same level.
  if (containerTypes.includes(token.type) && token.type !== 'listItem') {
    this.data.containerDepth = (this.data.containerDepth || 0) + 1;
  }
}
/**
 * Create a closer handle.
 *
 * @param and
 *   Optional function to also run.
 * @returns
 *   Handle.
 */
function closer(and?: Handle | undefined): Handle {
  return close;

  function close(this: CompileContext, token: Token): undefined {
    if (and) and.call(this, token);
    exit.call(this, token);
  }
}
function exit(
  this: CompileContext,
  token: Token,
  onExitError?: OnExitError | null | undefined
): undefined {
  const node = this.stack.pop();
  assert(node, 'expected `node`');
  const open = this.tokenStack.pop();

  if (!open) {
    throw new Error(
      'Cannot close `' +
        token.type +
        '` (' +
        stringifyPosition({ start: token.start, end: token.end }) +
        '): it’s not open'
    );
  } else if (open[0].type !== token.type) {
    if (onExitError) {
      onExitError.call(this, token, open[0]);
    } else {
      const handler = open[1] || defaultOnError;
      handler.call(this, token, open[0]);
    }
  }

  assert(!(node instanceof Fragment), 'unexpected fragment `exit`ed');
  // A container that continued on this prefix-only line keeps it. One
  // that did not continue ends before the next container's prefix.
  node.end =
    blockTypes.includes(token.type) &&
    this.data.prefixStart !== undefined &&
    (this.data.containerDepth || 0) > (this.data.containerPrefixes || 0)
      ? this.data.prefixStart
      : point(token.end);

  if (containerTypes.includes(token.type) && token.type !== 'listItem') {
    this.data.containerDepth = (this.data.containerDepth || 0) - 1;
  }

  if (node instanceof LiteralBlockSyntax || node instanceof RawFrontMatterSyntax) {
    endLiteral(this, node, token);
  }

  if (node instanceof BlockSyntax || node instanceof FrontMatterSyntax) {
    node.bodyEnd = finishBody(node, token, this.data.lineEnding);
  }

  if (
    node instanceof BlockSyntax ||
    node instanceof FrontMatterSyntax ||
    node instanceof ClauseSyntax
  ) {
    finishNode(node);
    this.data.blankStart = undefined;
    this.data.lastBlankStart = undefined;
  }
}
function resume(this: CompileContext): string {
  const fragment = this.stack.pop();
  assert(fragment instanceof Fragment, 'expected buffered fragment');
  return toString(fragment, this.source);
}
//
// Handlers.
//

function onenterlistordered(this: CompileContext): undefined {
  this.data.expectingFirstListItemValue = true;
}
function onenterlistitemvalue(this: CompileContext, token: Token): undefined {
  if (this.data.expectingFirstListItemValue) {
    const ancestor = this.stack[this.stack.length - 2];
    assert(ancestor, 'expected nodes on stack');
    assert(ancestor instanceof OrderedListSyntax, 'expected list on stack');
    ancestor.startNumber = Number.parseInt(
      this.sliceSerialize(token),
      constants.numericBaseDecimal
    );
    this.data.expectingFirstListItemValue = undefined;
  }
}
function onexitlistitemvalue(this: CompileContext, token: Token): undefined {
  const node = this.stack[this.stack.length - 1];
  assert(node, 'expected node on stack');
  assert(node instanceof ListItemSyntax, 'expected list item on stack');

  node.spelling.marker = this.sliceSerialize(token);
}
function onexitlistitemmarker(this: CompileContext, token: Token): undefined {
  const node = this.stack[this.stack.length - 1];
  assert(node, 'expected node on stack');
  assert(node instanceof ListItemSyntax, 'expected list item on stack');
  const ancestor = this.stack[this.stack.length - 2];
  assert(ancestor, 'expected nodes on stack');
  assert(
    ancestor instanceof BulletListSyntax || ancestor instanceof OrderedListSyntax,
    'expected list on stack'
  );

  node.spelling.marker += this.sliceSerialize(token);

  if (ancestor instanceof BulletListSyntax) {
    switch (token._listMarker) {
      case codes.asterisk:
        ancestor.spelling.pattern = 'asterisk';
        break;
      case codes.plusSign:
        ancestor.spelling.pattern = 'plusSign';
        break;
      default:
        ancestor.spelling.pattern = 'dash';
    }
  } else {
    ancestor.spelling.pattern =
      token._listMarker === codes.rightParenthesis ? 'decimalRightParenthesis' : 'decimalDot';
  }
}
function onexitlistitemprefixwhitespace(this: CompileContext, token: Token): undefined {
  const node = this.stack[this.stack.length - 1];
  assert(node, 'expected node on stack');
  assert(node instanceof ListItemSyntax, 'expected list item on stack');

  node.spelling.whitespaceAfterMarker = written(this, token);
}
function onexitlistitem(this: CompileContext, token: Token): undefined {
  const node = this.stack[this.stack.length - 1];
  assert(node && node instanceof ListItemSyntax, 'expected list item');
  const ancestor = this.stack[this.stack.length - 2];
  assert(ancestor, 'expected nodes on stack');
  assert(
    ancestor instanceof BulletListSyntax || ancestor instanceof OrderedListSyntax,
    'expected list on stack'
  );

  // A blank line between two blocks of an item makes the list loose, as one
  // between two items does.
  if (token._spread) {
    ancestor.spelling.tight = false;
  }
}
function onexitlistordered(this: CompileContext): undefined {
  const node = this.stack[this.stack.length - 1];
  assert(node, 'expected node on stack');
  assert(node instanceof OrderedListSyntax, 'expected list on stack');
  const numbers = node.children.map(function (d) {
    return Number.parseInt(d.spelling.marker, constants.numericBaseDecimal);
  });

  if (numbers.length > 1 && numbers.every((number) => number === numbers[0])) {
    node.spelling.numbering = 'constant';
  } else if (
    numbers.every((number, index) => index === 0 || number === numbers[index - 1]! + 1)
  ) {
    node.spelling.numbering = 'sequential';
  } else {
    node.spelling.numbering = null;
  }
}
function onenterblockquote(this: CompileContext): undefined {
  this.data.expectingFirstBlockQuotePrefix = true;
}
function onexitblockquoteprefixwhitespace(this: CompileContext, token: Token): undefined {
  if (this.data.expectingFirstBlockQuotePrefix) {
    const node = this.stack[this.stack.length - 1];
    assert(node, 'expected node on stack');
    assert(node instanceof BlockQuoteSyntax, 'expected block quote on stack');
    node.spelling.whitespaceAfterMarker = written(this, token);
  }
}
function onexitblockquoteprefix(this: CompileContext, token: Token): undefined {
  onexitcontaineropening.call(this, token);
  if (this.data.expectingFirstBlockQuotePrefix) {
    this.data.containerPrefixes = (this.data.containerPrefixes || 0) + 1;
  } else {
    onexitprefix.call(this, token);
  }
  this.data.expectingFirstBlockQuotePrefix = undefined;
}
function onexitcalloutdeclarationmarker(this: CompileContext, token: Token): undefined {
  const node = this.stack[this.stack.length - 1];
  assert(node && node instanceof CalloutDeclarationSyntax, 'expected declaration');
  if (node.opening) {
    node.closing = new DelimiterTokenSyntax(
      'calloutClosingMarker',
      point(token.start),
      point(token.end)
    );
  } else {
    node.opening = new DelimiterTokenSyntax(
      'calloutOpeningMarker',
      point(token.start),
      point(token.end)
    );
  }
}
function onexitcalloutdeclarationtype(this: CompileContext, token: Token): undefined {
  const node = this.stack[this.stack.length - 1];
  assert(node && node instanceof CalloutDeclarationSyntax, 'expected declaration');
  node.typeName = new DelimiterTokenSyntax(
    'calloutTypeName',
    point(token.start),
    point(token.end)
  );
  node.calloutType = this.sliceSerialize(
    token
  ).toLowerCase() as CalloutType;
}
function onexitcalloutdeclaration(this: CompileContext, token: Token): undefined {
  const declaration = this.stack[this.stack.length - 1];
  assert(declaration instanceof CalloutDeclarationSyntax, 'expected declaration');
  this.exit(token);
  const quote = this.stack[this.stack.length - 1];
  assert(quote instanceof BlockQuoteSyntax, 'expected block quote');
  const node = new CalloutSyntax();
  node.leading = quote.leading;
  node.trailing = quote.trailing;
  node.children = quote.children;
  node.calloutType = declaration.calloutType;
  node.title = new CalloutTitleSyntax();
  node.title.start = point(token.end);
  node.title.end = point(token.end);
  node.spelling = {
    ...quote.spelling,
    declaration: this.sliceSerialize(token),
    whitespaceAfterDeclaration: '',
  };
  replaceCurrent(this, node);
  this.data.calloutDeclaration = token;
}
function onexitcallouthead(this: CompileContext): undefined {
  const node = this.stack[this.stack.length - 1];
  assert(node && node instanceof CalloutSyntax, 'expected callout');
  const declaration = this.data.calloutDeclaration;
  const whitespace = this.data.whitespace;
  assert(declaration, 'expected a declaration');
  if (whitespace && point(whitespace.start) === point(declaration.end)) {
    Object.assign(node.spelling, { whitespaceAfterDeclaration: written(this, whitespace) });
  }
  this.data.calloutDeclaration = undefined;
}
function onexitcallouttitle(this: CompileContext, token: Token): undefined {
  const node = this.stack[this.stack.length - 1];
  assert(node && node instanceof CalloutTitleSyntax, 'expected title');
  this.exit(token);
  const parent = this.stack[this.stack.length - 1];
  assert(parent && parent instanceof CalloutSyntax, 'expected callout');
  parent.title = node;
}
function onentercodefencedfenceinfo(this: CompileContext, token: Token): undefined {
  onenterfencevalue.call(this, token);
  this.buffer();
}
/**
 * What follows the opening fence before its info or meta.
 */
function onenterfencevalue(this: CompileContext, token: Token): undefined {
  const node = this.stack[this.stack.length - 1];
  assert(node, 'expected node on stack');
  assert(
    node instanceof FencedCodeBlockSyntax || node instanceof MathBlockSyntax,
    'expected code on stack'
  );
  const fence = node instanceof FencedCodeBlockSyntax ? node.spelling.fence : node.spelling;
  const whitespace = this.data.whitespace;
  assert(fence, 'expected a fence');

  if (
    whitespace &&
    whitespace.end.offset === token.start.offset &&
    (node instanceof MathBlockSyntax || node.language === null)
  ) {
    fence.whitespaceAfterFence = written(this, whitespace);
  }
}
function onexitcodefencedfenceinfo(this: CompileContext): undefined {
  const data = this.resume();
  const node = this.stack[this.stack.length - 1];
  assert(node, 'expected node on stack');
  assert(node instanceof FencedCodeBlockSyntax, 'expected code on stack');
  node.language = data;
}
function onexitcodefencedfencemeta(this: CompileContext, token: Token): undefined {
  this.resume();
  const node = this.stack[this.stack.length - 1];
  assert(node, 'expected node on stack');
  assert(node instanceof FencedCodeBlockSyntax, 'expected code on stack');
  // Kagami: the meta is kept as written.
  node.meta = this.sliceSerialize(token);
}
function onexitcodefencedfence(this: CompileContext, token: Token): undefined {
  const node = this.stack[this.stack.length - 1];
  assert(
    node && (node instanceof FencedCodeBlockSyntax || node instanceof MathBlockSyntax),
    'expected code'
  );
  if (!this.data.literal) {
    beginLiteral(this, token, true);
  }
}
function onexitcodefencedfencesequence(this: CompileContext, token: Token): undefined {
  const node = this.stack[this.stack.length - 1];
  assert(node, 'expected node on stack');
  assert(
    node instanceof FencedCodeBlockSyntax || node instanceof MathBlockSyntax,
    'expected code on stack'
  );
  const fence = node instanceof FencedCodeBlockSyntax ? node.spelling.fence : node.spelling;
  const linePrefix = this.data.linePrefix;
  assert(fence, 'expected a fence');

  if (this.data.literal) {
    fence.closingFence = written(this, token);
    fence.spacesBeforeClosingFence =
      linePrefix && linePrefix.end.offset === token.start.offset ? columns(this, linePrefix) : 0;
  } else {
    fence.fence = written(this, token);
  }
}
function onexitcodeflowvalue(this: CompileContext, token: Token): undefined {
  const node = this.stack[this.stack.length - 1];
  assert(node, 'expected node on stack');
  assert(
    node instanceof CodeBlockSyntax || node instanceof MathBlockSyntax,
    'expected code on stack'
  );
  literalValue(this, node, token);
  // A code-value token ends on the last nonblank code line. The enclosing
  // indented-code token can also include later indentation-only lines.
  if (node instanceof IndentedCodeBlockSyntax) node.bodyEnd = token.end.offset;
}
function onexitdefinitionmarker(this: CompileContext, token: Token): undefined {
  const node = this.stack[this.stack.length - 1];
  assert(
    node &&
      (node instanceof LinkReferenceDefinitionSyntax || node instanceof FootnoteDefinitionSyntax),
    'expected definition'
  );
  const label = node instanceof FootnoteDefinitionSyntax ? node.label : node.labelField;
  label.trailing += point(token.end) - label.end;
  label.end = point(token.end);
  this.data.definitionMarker = token;
}
function onenterdefinitiondestination(this: CompileContext, token: Token): undefined {
  const node = this.stack[this.stack.length - 1];
  assert(node && node instanceof LinkReferenceDefinitionSyntax, 'expected definition');
  const marker = this.data.definitionMarker;
  assert(marker, 'expected a colon');
  node.spelling.whitespaceAfterLabel = between(this, marker, token);
  this.data.definitionDestination = token;
  const start = node.labelField.end;
  const linkDestination = new LinkDestinationSyntax();
  linkDestination.start = start;
  linkDestination.end = point(token.end);
  linkDestination.leading = point(token.start) - start;
  linkDestination.spelling = { inAngleBrackets: false };
  node.destinationField = linkDestination;
}
function onenterdefinitiontitle(this: CompileContext, token: Token): undefined {
  const node = this.stack[this.stack.length - 1];
  assert(node && node instanceof LinkReferenceDefinitionSyntax, 'expected definition');
  const destination = this.data.definitionDestination;
  assert(destination, 'expected a destination');
  node.spelling.whitespaceBeforeTitle = between(this, destination, token);
  const start = node.destinationField.end;
  node.title = '';
  const linkTitle = new LinkTitleSyntax();
  linkTitle.start = start;
  linkTitle.end = point(token.end);
  linkTitle.leading = point(token.start) - start;
  node.titleField = linkTitle;
}
function onenterstring(this: CompileContext): undefined {
  this.buffer();
  this.data.inString = true;
}
function onexitdefinitionlabelstring(this: CompileContext, token: Token): undefined {
  const fragment = this.stack[this.stack.length - 1];
  assert(fragment && fragment instanceof Fragment, 'expected fragment');
  this.resume();
  const node = this.stack[this.stack.length - 1];
  assert(node && node instanceof LinkReferenceDefinitionSyntax, 'expected definition');
  node.labelField.children = fragment.children as Array<StringSegmentSyntax>;
  node.labelField.end = point(token.end);
  node.identifier = normalizeIdentifier(
    this.sliceSerialize(token)
  ).toLowerCase();
  this.data.inString = undefined;
}
function onexitdefinitiontitlestring(this: CompileContext): undefined {
  const fragment = this.stack[this.stack.length - 1];
  assert(fragment && fragment instanceof Fragment, 'expected fragment');
  const value = this.resume();
  const node = this.stack[this.stack.length - 1];
  assert(
    node && node instanceof LinkReferenceDefinitionSyntax && node.titleField,
    'expected title'
  );
  node.title = value;
  node.titleField.children = fragment.children as Array<StringSegmentSyntax>;
  this.data.inString = undefined;
}
function onexitdefinitiondestinationstring(this: CompileContext): undefined {
  const fragment = this.stack[this.stack.length - 1];
  assert(fragment && fragment instanceof Fragment, 'expected fragment');
  const value = this.resume();
  const node = this.stack[this.stack.length - 1];
  assert(node && node instanceof LinkReferenceDefinitionSyntax, 'expected definition');
  node.destination = value;
  node.destinationField.children = fragment.children as Array<StringSegmentSyntax>;
  this.data.inString = undefined;
}
function onexitdefinitiondestinationmarker(this: CompileContext, token: Token): undefined {
  const node = this.stack[this.stack.length - 1];
  assert(node && node instanceof LinkReferenceDefinitionSyntax, 'expected definition');
  const field = node.destinationField;
  if (!field.spelling.inAngleBrackets) {
    field.leading = point(token.end) - field.start;
    field.spelling.inAngleBrackets = true;
  } else {
    field.trailing = point(token.end) - point(token.start);
  }
}
function onexittitlemarker(this: CompileContext, token: Token): undefined {
  const node = this.stack[this.stack.length - 1];
  assert(
    node && node instanceof LinkReferenceDefinitionSyntax && node.titleField,
    'expected title'
  );
  const field = node.titleField;
  if (!field.spelling) {
    field.spelling = { delimiter: delimiter(this, token) };
    field.leading = point(token.end) - field.start;
  } else {
    field.trailing = point(token.end) - point(token.start);
  }
}
function onexitdefinitionfield(this: CompileContext, token: Token): undefined {
  const node = this.stack[this.stack.length - 1];
  assert(node && node instanceof LinkReferenceDefinitionSyntax, 'expected definition');
  const field = token.type === 'definitionTitle' ? node.titleField : node.destinationField;
  assert(field, 'expected field');
  field.end = point(token.end);
  finishNode(field);
}
function onexitatxheadingsequence(this: CompileContext, token: Token): undefined {
  const node = this.stack[this.stack.length - 1];
  assert(node, 'expected node on stack');
  assert(node instanceof ATXHeadingSyntax, 'expected heading on stack');

  const opening = this.tokenStack[this.tokenStack.length - 1][0];
  if (token.start.offset === opening.start.offset) {
    const depth = this.sliceSerialize(token).length;

    assert(
      depth === 1 ||
        depth === 2 ||
        depth === 3 ||
        depth === 4 ||
        depth === 5 ||
        depth === 6,
      'expected `depth` between `1` and `6`'
    );

    node.level = depth;
  } else {
    // Kagami: the closing sequence, and what stands before it.
    const whitespace = this.data.whitespace;
    const before =
      whitespace && whitespace.end.offset === token.start.offset ? whitespace : undefined;

    // Read for the editor, the sequence is the last of the heading’s
    // content, and the whitespace before it is text; in a heading with no
    // text, it is what follows the opening sequence
    // (private-docs/design/syntax/for-the-editor.md).
    if (this.target === 'editor') {
      // ZWSP edge mark: whitespace after a candidate belongs to the field;
      // only whitespace without a candidate can follow the opening marker.
      if (before && node.children.length > 0) {
        node.children.push(new TextTokenSyntax('text', point(before.start), point(before.end)));
      } else if (before && !this.data.edgeMark) {
        node.spelling.whitespaceAfterMarker = written(this, before);
      }

      const atxClosingSequence = new ATXClosingSequenceSyntax();
      atxClosingSequence.start = point(token.start);
      atxClosingSequence.end = point(token.end);
      atxClosingSequence.sequence = new DelimiterTokenSyntax(
        'atxClosingSequenceMarker',
        point(token.start),
        point(token.end)
      );
      node.children.push(atxClosingSequence);
    } else {
      node.spelling.closingSequence = {
        whitespaceBefore: before ? written(this, before) : '',
        sequence: written(this, token),
      };
    }
    this.data.atxHeadingClosing = before || token;
  }
}
function onenteratxheadingtext(this: CompileContext, token: Token): undefined {
  const node = this.stack[this.stack.length - 1];
  assert(node, 'expected node on stack');
  assert(node instanceof ATXHeadingSyntax, 'expected heading on stack');
  const whitespace = this.data.whitespace;

  if (whitespace && whitespace.end.offset === token.start.offset) {
    node.spelling.whitespaceAfterMarker = written(this, whitespace);
  }
}
function onexitatxheading(this: CompileContext, token: Token): undefined {
  const node = this.stack[this.stack.length - 1];
  assert(node, 'expected node on stack');
  assert(node instanceof ATXHeadingSyntax, 'expected heading on stack');
  const closing = this.data.atxHeadingClosing;
  const candidate = this.data.edgeMark;
  const whitespace = this.data.whitespace;
  const tail = node.children[node.children.length - 1];

  // Kagami: like a paragraph's lineSuffix, the whitespace after the last
  // text token is trivia. It has no field line ending beside it, so the
  // frontier keeps it as editable source (fewer-edge-marks.md).
  if (!closing && whitespace && whitespace.end.offset === token.end.offset &&
      tail && tail.end === point(whitespace.start)) {
    appendInline(node, new TriviaTokenSyntax('trailingWhitespace', point(whitespace.start), point(whitespace.end)));
  }

  if (this.target === 'editor') {
    // ZWSP edge mark: the whitespace between the mark and the sequence is
    // all text.
    if (
      candidate &&
      closing &&
      closing.type === types.whitespace &&
      point(closing.start) === point(candidate.end)
    ) {
      node.children.unshift(
        new TextTokenSyntax('text', point(closing.start), point(closing.end))
      );
    }

    // ZWSP edge mark: the heading’s text runs to its closing sequence, or to
    // its end.
    exitEdgeMark.call(
      this,
      node,
      { start: token.start, end: closing ? closing.start : token.end },
      'atxHeading'
    );
    this.data.atxHeadingClosing = undefined;
    return;
  }

  // ZWSP edge mark: spaces between the mark and a closing sequence are the
  // text, but for the one the sequence needs before it.
  if (
    candidate &&
    closing &&
    closing.type === types.whitespace &&
    point(closing.start) === point(candidate.end)
  ) {
    const mark = exitEdgeMark.call(
      this,
      node,
      { start: token.start, end: closing.end },
      'atxHeading'
    );
    const tail = node.children[0];

    if (mark && tail) {
      assert(tail.type === 'text', 'expected text');
      tail.end--;
      assert(node.spelling.closingSequence, 'expected a closing sequence');
      node.spelling.closingSequence.whitespaceBefore = this.source.slice(tail.end, point(closing.end));

      if (tail.start === tail.end) {
        node.children.pop();
      }
    }
  } else {
    // ZWSP edge mark: the heading’s text runs to its closing sequence, or to
    // its end.
    exitEdgeMark.call(
      this,
      node,
      { start: token.start, end: closing ? closing.start : token.end },
      'atxHeading'
    );
  }

  this.data.atxHeadingClosing = undefined;
}
function onexitsetextheadingtext(this: CompileContext, token: Token): undefined {
  const node = this.stack[this.stack.length - 1];
  assert(node instanceof SetextHeadingSyntax, 'expected heading on stack');
  node.startsLinkTitle = token._startsLinkTitle === true;

  this.data.setextHeadingSlurpLineEnding = true;
  // Kagami: text points belong to the content tokenizer, not the underline's
  // flow tokenizer. Measure the text while its own context is active.
  const lines = this.sliceSerialize(token).split(/\r\n|\r|\n/);
  let widest = { width: 0, uncertain: 0 };
  let index = -1;

  // The spaces a paragraph strips from its lines are no text.
  while (++index < lines.length) {
    const width = measureWidth(lines[index]!.replace(/^[\t ]+|[\t ]+$/g, ''));

    if (width.width > widest.width) {
      widest = width;
    }
  }
  this.data.setextHeadingWidth = widest;
  // ZWSP edge mark: the text of a Setext heading is a paragraph’s text.
  exitEdgeMark.call(this, node, token, 'paragraph');
}
function onexitsetextheadinglinesequence(this: CompileContext, token: Token): undefined {
  const node = this.stack[this.stack.length - 1];
  assert(node, 'expected node on stack');
  assert(node instanceof SetextHeadingSyntax, 'expected heading on stack');
  const widest = this.data.setextHeadingWidth;
  assert(widest, 'expected text width');
  assert(token._setextLevel, 'expected `_setextLevel` on the underline');
  const length = this.sliceSerialize(token).length;

  node.level = token._setextLevel;
  // Kagami: whether the underline is as wide as the longest line of the
  // text, within what its uncertain characters could be off by
  // (private-docs/design/syntax/alignment.md).
  node.spelling.underline = {
    matchesText: Math.abs(widest.width - length) <= widest.uncertain,
    length,
  };
}
function onexitsetextheading(this: CompileContext): undefined {
  this.data.setextHeadingSlurpLineEnding = undefined;
  this.data.setextHeadingWidth = undefined;
}
function onenterparagraph(this: CompileContext, token: Token): undefined {
  const paragraph = this.stack[this.stack.length - 1];
  assert(paragraph instanceof ParagraphSyntax, 'expected paragraph on stack');
  paragraph.startsLinkTitle = token._startsLinkTitle === true;
  // ZWSP edge mark: a field has no file indentation. Once its tokenizer has
  // recognized a paragraph, the opening prefix is the user's text.
  const prefix = this.data.linePrefix;
  if (this.grammar !== phrasingDocument || !prefix || prefix.end.offset !== token.start.offset)
    return;
  paragraph.start = point(prefix.start);
  paragraph.spelling.spacesBeforeBlock = 0;
  paragraph.children.push(new TextTokenSyntax('text', point(prefix.start), point(prefix.end)));
}
function onexitparagraph(this: CompileContext, token: Token): undefined {
  const node = this.stack[this.stack.length - 1];
  assert(node, 'expected node on stack');

  assert(node instanceof ParagraphSyntax, 'expected paragraph on stack');
  const ancestor = this.stack[this.stack.length - 2];
  assert(ancestor, 'expected nodes on stack');
  const first = ancestor instanceof ContainerBlockSyntax && ancestor.children[0] === node;
  // ZWSP edge mark: a paragraph does not hold a text in which a task check or
  // a callout’s declaration would be read where it stands.
  const mark = exitEdgeMark.call(this, node, token, 'paragraph', {
    taskMarker: first && ancestor instanceof ListItemSyntax && ancestor.checked === null,
    calloutDeclaration: first && ancestor instanceof BlockQuoteSyntax,
  });

  // A task list check or a callout’s declaration before the text is the
  // item’s or the callout’s: the paragraph begins with its edge mark, or
  // with its first piece.
  if (mark) {
    // The paragraph owns its indentation. Only an ancestor's task check moves
    // its complete syntax start forward to the mark after that check.
    if (ancestor instanceof ListItemSyntax && ancestor.checked !== null) {
      node.start = point(mark.start);
      node.bodyStart = node.start;
    }
    node.leading = point(mark.end) - node.start;
  } else if (
    node.children.length > 0 &&
    ancestor instanceof ListItemSyntax &&
    ancestor.checked !== null
  ) {
    node.start = node.children[0]!.start;
    node.bodyStart = node.start;
  }

  this.exit(token);
}
function onenterdata(this: CompileContext, token: Token): undefined {
  const node = this.stack[this.stack.length - 1];
  assert(node, 'expected node on stack');
  const siblings = children(node);

  let tail = siblings[siblings.length - 1];

  // Kagami: text never spans a gap, such as the prefix of a container, or a
  // table’s backslash in code.
  if (!tail || tail.type !== 'text' || tail.end !== point(token.start)) {
    // Add a new text node.
    tail = text();
    tail.start = point(token.start);
    appendInline(node, tail as TextTokenSyntax<'text'>);
  }

  this.stack.push(tail);
}
function onexitdata(this: CompileContext, token: Token): undefined {
  const tail = this.stack.pop();
  assert(tail, 'expected a `node` to be on the stack');
  assert(tail.type === 'text', 'expected a `text` to be on the stack');
  tail.end = point(token.end);
}
function onexitlineending(this: CompileContext, token: Token): undefined {
  const context = this.stack[this.stack.length - 1];
  assert(context, 'expected `node`');

  // A literal owns its blank rows too. Container-prefix bookkeeping must
  // not divert their endings into the blank space between blocks.
  if (context instanceof LiteralBlockSyntax || context instanceof RawFrontMatterSyntax) {
    literalEnding(this, context, token);
    this.data.prefixStart = undefined;
    this.data.containerPrefixes = undefined;
    return;
  }

  if (
    this.data.prefixStart !== undefined &&
    (this.data.containerDepth || 0) >= (this.data.containerPrefixes || 0)
  ) {
    onexitlineendingblank.call(this, token);
    return;
  }

  const start = this.data.prefixStart ?? point(token.start);
  this.data.prefixStart = undefined;
  this.data.containerPrefixes = undefined;

  if (context.type === 'linkReferenceDefinition') return;

  let tail: Syntax | undefined;
  if (context instanceof DocumentSyntax)
    tail = context.children[context.children.length - 1] ?? context.frontMatter ?? undefined;
  else if (context instanceof ContainerBlockSyntax) {
    tail = context.children[context.children.length - 1];
    if (!tail && context instanceof CalloutSyntax) tail = context.title;
    if (!tail && context instanceof FootnoteDefinitionSyntax) tail = context.label;
  } else if (context instanceof TableSyntax) {
    tail =
      context.children[context.children.length - 1] ?? context.delimiterRow ?? context.headerRow;
  } else if (context instanceof TableRowSyntax)
    tail = context.children[context.children.length - 1];

  if (
    tail &&
    (tail instanceof BlockSyntax ||
      tail instanceof FrontMatterSyntax ||
      tail instanceof ClauseSyntax) &&
    (tail.end === start || tail.end === point(token.start))
  ) {
    extendBlock(tail, point(token.end));
    return;
  }

  // If we’re at a hard break, include the line ending in there.
  if (this.data.atHardBreak) {
    const siblings = children(context);
    const tail = siblings[siblings.length - 1];
    assert(tail, 'expected tail to have a starting position');
    assert(tail instanceof HardLineBreakSyntax, 'expected hard break');
    tail.lineEnding = new TextTokenSyntax('lineEnding', point(token.start), point(token.end));
    tail.end = point(token.end);
    this.data.atHardBreak = undefined;
    return;
  }

  // Kagami: in code, in HTML and in a string, a line ending is a node of its
  // own; in code, it is a space.
  if (
    context instanceof CodeSpanSyntax ||
    context instanceof InlineMathSyntax ||
    context instanceof RawHTMLSyntax ||
    context instanceof HTMLCommentSyntax ||
    context instanceof HTMLImageSyntax ||
    context instanceof HTMLLineBreakSyntax ||
    (context instanceof Fragment && this.data.inString)
  ) {
    context.children.push(
      new TextTokenSyntax('lineEnding', point(token.start), point(token.end))
    );

    if (context instanceof CodeSpanSyntax) {
      context.code += ' ';
    } else if (context instanceof InlineMathSyntax) {
      context.math += ' ';
    }

    return;
  }

  // Kagami: resource whitespace has line endings of its own, outside the
  // buffered destination and title strings.
  if (context instanceof InlineLinkSyntax || context instanceof InlineImageSyntax) {
    onexitresourceseparator.call(this, token);
    return;
  }

  if (!this.data.setextHeadingSlurpLineEnding && this.config.canContainEOLs.includes(context.type)) {
    // The whitespace after a task check belongs to the check, including a
    // line ending before the paragraph's first text. It is not a leading
    // soft break in the paragraph (compile/gfm-task-list-item.ts).
    const parent = this.stack[this.stack.length - 2];
    if (
      context instanceof ParagraphSyntax &&
      context.children.length === 0 &&
      parent instanceof ListItemSyntax &&
      parent.checked !== null
    )
      return;
    const softLineBreak = new SoftLineBreakSyntax();
    softLineBreak.start = point(token.start);
    softLineBreak.end = point(token.end);
    appendInline(context, softLineBreak);
  }
}
function onexitlineprefix(this: CompileContext, token: Token): undefined {
  onexitcontaineropening.call(this, token);
  onexitprefix.call(this, token);
  this.data.linePrefix = token;
  onexitlinetrivia.call(this, token);
}
/** An empty quote or item starts content after its complete first-line prefix. */
function onexitcontaineropening(this: CompileContext, token: Token): undefined {
  const node = this.stack[this.stack.length - 1];
  const open = this.tokenStack[this.tokenStack.length - 1];
  if (
    (node instanceof BlockQuoteSyntax || node instanceof ListItemSyntax) &&
    token.start.line === open[0].start.line
  ) {
    node.leading = point(token.end) - node.start;
  }
}
function onexitlinetrivia(this: CompileContext, token: Token): undefined {
  const node = this.stack[this.stack.length - 1];
  assert(node, 'expected node on stack');
  if (node instanceof InlineLinkSyntax || node instanceof InlineImageSyntax) {
    onexitresourceseparator.call(this, token);
  } else if (
    this.authoredParagraph &&
    node instanceof Fragment &&
    !this.data.inString &&
    (token.start.offset === 0 || token.end.offset === this.source.length)
  ) {
    // Authored outer whitespace is text; continuation indentation keeps its trivia.
    node.children.push(new TextTokenSyntax('text', point(token.start), point(token.end)));
  } else if (
    node instanceof Fragment ||
    node instanceof CodeSpanSyntax ||
    node instanceof InlineMathSyntax ||
    node instanceof RawHTMLSyntax ||
    node instanceof HTMLCommentSyntax ||
    node instanceof HTMLImageSyntax ||
    node instanceof HTMLLineBreakSyntax ||
    node instanceof DelimitedSyntax ||
    node instanceof ParagraphSyntax ||
    (node instanceof HeadingSyntax && !this.data.setextHeadingSlurpLineEnding)
  ) {
    const type = token.type === types.linePrefix ? 'paragraphIndentation' : 'trailingWhitespace';
    appendInline(node, new TriviaTokenSyntax(type, point(token.start), point(token.end)));
  }
}
/** Each separator follows the fixed part that has already been read. */
function onexitresourceseparator(this: CompileContext, token: Token): undefined {
  const node = this.stack[this.stack.length - 1];
  assert(
    node && (node instanceof InlineLinkSyntax || node instanceof InlineImageSyntax),
    'expected resource'
  );
  let siblings = node.openingSeparators;
  if (node.resourceTitle) siblings = node.titleSeparators;
  else if (node.resourceDestination) siblings = node.destinationSeparators;
  const type = token.type === types.lineEnding ? 'lineEnding' : 'resourceWhitespace';
  siblings.push(new TriviaTokenSyntax(type, point(token.start), point(token.end)));
}
function onexittablepipeescape(this: CompileContext, token: Token): undefined {
  const node = this.stack[this.stack.length - 1];
  assert(node && node instanceof CodeSpanSyntax, 'expected code span');
  node.children.push(
    new TriviaTokenSyntax('tablePipeEscape', point(token.start), point(token.end))
  );
}
/** Hold a prefix that starts a line until its content or line ending gives it an owner. */
function onexitprefix(this: CompileContext, token: Token): undefined {
  const node = this.stack[this.stack.length - 1];
  assert(node, 'expected node on stack');

  if (
    token.type !== types.linePrefix &&
    node instanceof TableSyntax &&
    this.data.intermediateStart === undefined
  ) {
    this.data.intermediateStart = point(token.start);
  }

  if (token.type !== types.linePrefix) {
    this.data.containerPrefixes = (this.data.containerPrefixes || 0) + 1;
  }

  if (
    this.data.prefixStart === undefined &&
    token.start.column === 1 &&
    (node instanceof DocumentSyntax ||
      node instanceof BlockQuoteSyntax ||
      node instanceof CalloutSyntax ||
      node instanceof BulletListSyntax ||
      node instanceof OrderedListSyntax ||
      node instanceof ListItemSyntax ||
      node instanceof FootnoteDefinitionSyntax)
  ) {
    this.data.prefixStart = point(token.start);
  }
}
/** Keep the first and last starts of a run of blank lines. */
function onexitlineendingblank(this: CompileContext, token: Token): undefined {
  const node = this.stack[this.stack.length - 1];
  if (node instanceof LiteralBlockSyntax || node instanceof RawFrontMatterSyntax) {
    onexitlineending.call(this, token);
    return;
  }
  // The label's line is not blank, even when its ending has this token type.
  if (
    node &&
    node instanceof FootnoteDefinitionSyntax &&
    node.children.length === 0 &&
    token.start.line === this.tokenStack[this.tokenStack.length - 1][0].start.line &&
    node.label.end === point(token.start)
  ) {
    extendBlock(node.label, point(token.end));
    this.data.prefixStart = undefined;
    this.data.containerPrefixes = undefined;
    return;
  }
  const start = this.data.prefixStart === undefined ? point(token.start) : this.data.prefixStart;

  if (this.data.blankStart === undefined) {
    this.data.blankStart = start;
  }

  this.data.lastBlankStart = start;
  this.data.prefixStart = undefined;
  this.data.containerPrefixes = undefined;
}
function onexitwhitespace(this: CompileContext, token: Token): undefined {
  this.data.whitespace = token;
  const node = this.stack[this.stack.length - 1];

  if (node && node instanceof CalloutSyntax) {
    const title = node.title;
    if (title.children.length === 0) title.start = point(token.end);
    else title.trailing += point(token.end) - title.end;
    title.end = point(token.end);
  }

  if (node && node instanceof HeadingSyntax) {
    const tail = node.children[node.children.length - 1];

    if (tail instanceof ATXClosingSequenceSyntax && tail.end === point(token.start)) {
      tail.separators.push(
        new TriviaTokenSyntax('trailingWhitespace', point(token.start), point(token.end))
      );
      tail.end = point(token.end);
    }
  }
}
function onexithardbreak(this: CompileContext, token: Token): undefined {
  const node = this.stack[this.stack.length - 1];
  assert(node, 'expected node on stack');
  assert(node instanceof HardLineBreakSyntax, 'expected break on stack');

  node.marker = new DelimiterTokenSyntax(
    'hardLineBreakMarker',
    point(token.start),
    point(token.end)
  );
  this.data.atHardBreak = true;
}
/**
 * Append the recognized text of a literal HTML block.
 *
 * @param token
 *   HTML content token.
 * @returns
 *   Nothing.
 */
function onexithtmlflowdata(this: CompileContext, token: Token): undefined {
  const node = this.stack[this.stack.length - 1];
  assert(node && node instanceof HTMLBlockSyntax, 'expected HTML block');
  literalValue(this, node, token);
}
function onexithtmlflow(this: CompileContext, token: Token): undefined {
  const node = this.stack[this.stack.length - 1];
  assert(node, 'expected node on stack');
  assert(node instanceof HTMLBlockSyntax, 'expected html on stack');
  node.closed = token._htmlClosed === true;

  // Kagami: a block of one line that opens with a tag on Kagami’s list is
  // that tag and nothing else: the seventh kind allows only whitespace after
  // its tag on the line (private-docs/rules/html-tokens.md).
  if (token._htmlFlowTag && !node.content.includes('\n')) {
    const opening = readOpeningTag(node.content);
    const start = point(token.start);
    const children: Array<TextTokenSyntax<'text'>> = [
      new TextTokenSyntax('text', start, start + opening.end),
    ];
    let tag: HTMLImageSyntax | HTMLLineBreakSyntax;
    if (token._htmlFlowTag === 'image') {
      tag = new HTMLImageSyntax();
      Object.assign(tag, imageAttributes(opening));
    } else {
      tag = new HTMLLineBreakSyntax();
    }
    tag.start = start;
    tag.end = start + opening.end;
    tag.children = children;
    const block = new HTMLTagBlockSyntax();
    block.leading = node.leading;
    block.trailing = node.trailing;
    block.spelling = node.spelling;
    block.tag = tag;
    replaceCurrent(this, block);
    this.data.literal = undefined;
    return;
  }
}
function onexithtmltext(this: CompileContext): undefined {
  const node = this.stack[this.stack.length - 1];
  assert(node, 'expected node on stack');

  // Kagami: what an `<img>` says, as a Markdown image says it, read from
  // its text: the indentation of a later line, which the paragraph strips,
  // and the prefixes of containers are no characters of it.
  if (node instanceof HTMLImageSyntax) {
    Object.assign(node, imageAttributes(readOpeningTag(toString(node.children, this.source))));
  }
}
function onenterhtmltextdata(this: CompileContext, token: Token): undefined {
  const node = this.stack[this.stack.length - 1];
  assert(node, 'expected node on stack');

  // Kagami: every kind of inline HTML keeps its text in pieces.
  if (
    node instanceof RawHTMLSyntax ||
    node instanceof HTMLCommentSyntax ||
    node instanceof HTMLImageSyntax ||
    node instanceof HTMLLineBreakSyntax
  ) {
    onenterdata.call(this, token);
  }
}
function onexithtmltextdata(this: CompileContext, token: Token): undefined {
  const node = this.stack[this.stack.length - 1];
  assert(node, 'expected node on stack');

  if (node.type === 'text') {
    onexitdata.call(this, token);
  }
}
function onexitcodetextdata(this: CompileContext, token: Token): undefined {
  onexitdata.call(this, token);
  const node = this.stack[this.stack.length - 1];
  assert(node, 'expected node on stack');
  assert(node instanceof CodeSpanSyntax, 'expected inline code on stack');

  node.code += this.sliceSerialize(token);
}
function onexitcodetextsequence(this: CompileContext, token: Token): undefined {
  const node = this.stack[this.stack.length - 1];
  assert(node, 'expected node on stack');
  assert(node instanceof CodeSpanSyntax, 'expected inline code on stack');

  if (point(token.start) === node.start) {
    node.openingBackticks = new DelimiterTokenSyntax(
      'backtickString',
      point(token.start),
      point(token.end)
    );
  } else {
    node.closingBackticks = new DelimiterTokenSyntax(
      'backtickString',
      point(token.start),
      point(token.end)
    );
  }
}
function onexitcodetextpadding(this: CompileContext, token: Token): undefined {
  const node = this.stack[this.stack.length - 1];
  assert(node, 'expected node on stack');
  assert(node instanceof CodeSpanSyntax, 'expected inline code on stack');
  const range = { start: point(token.start), end: point(token.end) };

  // Padding is trivia in the sequence; a padded line ending is trivia too.
  node.children.push(
    token.start.line !== token.end.line
      ? new TriviaTokenSyntax('lineEnding', range.start, range.end)
      : new TriviaTokenSyntax('codeSpanPadding', range.start, range.end)
  );
}
function onexitsequence(this: CompileContext, token: Token): undefined {
  const node = this.stack[this.stack.length - 1];
  assert(node, 'expected node on stack');
  assert(node instanceof DelimitedSyntax, 'expected delimited node on stack');

  if (point(token.start) === node.start) {
    node.openingDelimiter = new DelimiterTokenSyntax(
      'delimiterRun',
      point(token.start),
      point(token.end)
    );
  } else {
    node.closingDelimiter = new DelimiterTokenSyntax(
      'delimiterRun',
      point(token.start),
      point(token.end)
    );
  }
}
function onexitlink(this: CompileContext): undefined {
  collapseReference(this);
}
function onexitlabeltext(this: CompileContext, token: Token): undefined {
  const node = this.stack[this.stack.length - 2];
  assert(
    node instanceof ShortcutReferenceLinkSyntax || node instanceof ShortcutReferenceImageSyntax,
    'expected link or image label'
  );
  node.identifier = normalizeIdentifier(
    this.sliceSerialize(token)
  ).toLowerCase();
}
function onexitlabelmarker(this: CompileContext, token: Token): undefined {
  const ancestor = this.stack[this.stack.length - 2];
  assert(ancestor, 'expected ancestor on stack');
  assert(
    ancestor instanceof ImageSyntax || ancestor instanceof LinkSyntax,
    'expected image or link on stack'
  );

  if (ancestor.openingBracket === undefined) {
    ancestor.openingBracket = new DelimiterTokenSyntax(
      'openingBracket',
      point(token.start),
      point(token.end)
    );
  } else {
    ancestor.closingBracket = new DelimiterTokenSyntax(
      'closingBracket',
      point(token.start),
      point(token.end)
    );
  }
}
function onexitlabelimagemarker(this: CompileContext, token: Token): undefined {
  const ancestor = this.stack[this.stack.length - 2];
  assert(ancestor, 'expected ancestor on stack');
  assert(ancestor instanceof ImageSyntax, 'expected image on stack');

  ancestor.exclamationMark = new DelimiterTokenSyntax(
    'exclamationMark',
    point(token.start),
    point(token.end)
  );
}
function onexitlabel(this: CompileContext): undefined {
  const fragment = this.stack[this.stack.length - 1];
  assert(fragment, 'expected node on stack');
  assert(fragment instanceof Fragment, 'expected fragment on stack');
  const value = this.resume();
  const node = this.stack[this.stack.length - 1];
  assert(node, 'expected node on stack');
  assert(
    node instanceof ImageSyntax || node instanceof LinkSyntax,
    'expected image or link on stack'
  );

  node.children = fragment.children as Array<InlineSyntax>;

  if (node instanceof ImageSyntax) {
    node.alt = value;
  }
}
function onenterresource(this: CompileContext): undefined {
  const previous = this.stack[this.stack.length - 1];
  assert(
    previous instanceof ShortcutReferenceLinkSyntax ||
      previous instanceof ShortcutReferenceImageSyntax,
    'expected link or image label'
  );
  const node = previous instanceof ImageSyntax ? new InlineImageSyntax() : new InlineLinkSyntax();
  copyLabel(previous, node);
  replaceCurrent(this, node);
}
function onexitresourcemarker(this: CompileContext, token: Token): undefined {
  const node = this.stack[this.stack.length - 1];
  assert(node, 'expected node on stack');
  assert(
    node instanceof InlineImageSyntax || node instanceof InlineLinkSyntax,
    'expected image or link on stack'
  );

  if (node.openingParenthesis === undefined) {
    node.openingParenthesis = new DelimiterTokenSyntax(
      'openingParenthesis',
      point(token.start),
      point(token.end)
    );
  } else {
    node.closingParenthesis = new DelimiterTokenSyntax(
      'closingParenthesis',
      point(token.start),
      point(token.end)
    );
  }
}
function onenterresourcedestination(this: CompileContext, token: Token): undefined {
  const node = this.stack[this.stack.length - 1];
  assert(
    node instanceof InlineImageSyntax || node instanceof InlineLinkSyntax,
    'expected resource'
  );
  node.resourceDestination = new ResourceDestinationSyntax();
  node.resourceDestination.start = point(token.start);
  node.resourceDestination.end = point(token.end);
}
function onexitresourcedestinationliteralmarker(this: CompileContext, token: Token): undefined {
  const node = this.stack[this.stack.length - 1];
  assert(node, 'expected node on stack');
  assert(
    node instanceof InlineImageSyntax || node instanceof InlineLinkSyntax,
    'expected image or link on stack'
  );
  const destination = node.resourceDestination;
  assert(destination, 'expected a destination');

  if (destination.openingAngleBracket === null) {
    destination.openingAngleBracket = new DelimiterTokenSyntax(
      'openingAngleBracket',
      point(token.start),
      point(token.end)
    );
  } else {
    destination.closingAngleBracket = new DelimiterTokenSyntax(
      'closingAngleBracket',
      point(token.start),
      point(token.end)
    );
  }
}
function onexitresourcedestinationstring(this: CompileContext): undefined {
  const fragment = this.stack[this.stack.length - 1];
  assert(fragment, 'expected node on stack');
  assert(fragment instanceof Fragment, 'expected fragment on stack');
  const data = this.resume();
  const node = this.stack[this.stack.length - 1];
  assert(node, 'expected node on stack');
  assert(
    node instanceof InlineImageSyntax || node instanceof InlineLinkSyntax,
    'expected image or link on stack'
  );
  assert(node.resourceDestination, 'expected a destination');
  node.destination = data;
  node.resourceDestination.children = fragment.children as Array<StringSegmentSyntax>;
  this.data.inString = undefined;
}
function onexitresourcetitlemarker(this: CompileContext, token: Token): undefined {
  const node = this.stack[this.stack.length - 1];
  assert(node, 'expected node on stack');
  assert(
    node instanceof InlineImageSyntax || node instanceof InlineLinkSyntax,
    'expected image or link on stack'
  );

  if (node.resourceTitle === null) {
    // `""`: an empty title, unless a string follows.
    node.title = '';
    node.resourceTitle = new ResourceTitleSyntax();
    node.resourceTitle.openingDelimiter = new DelimiterTokenSyntax(
      'titleDelimiter',
      point(token.start),
      point(token.end)
    );
    node.resourceTitle.start = point(token.start);
  } else {
    node.resourceTitle.closingDelimiter = new DelimiterTokenSyntax(
      'titleDelimiter',
      point(token.start),
      point(token.end)
    );
    node.resourceTitle.end = point(token.end);
  }
}
function onexitresourcetitlestring(this: CompileContext): undefined {
  const fragment = this.stack[this.stack.length - 1];
  assert(fragment, 'expected node on stack');
  assert(fragment instanceof Fragment, 'expected fragment on stack');
  const data = this.resume();
  const node = this.stack[this.stack.length - 1];
  assert(node, 'expected node on stack');
  assert(
    node instanceof InlineImageSyntax || node instanceof InlineLinkSyntax,
    'expected image or link on stack'
  );
  assert(node.resourceTitle, 'expected a title');
  node.title = data;
  node.resourceTitle.children = fragment.children as Array<StringSegmentSyntax>;
  this.data.inString = undefined;
}
function onenterreference(this: CompileContext, token: Token): undefined {
  const previous = this.stack[this.stack.length - 1];
  assert(
    previous instanceof ShortcutReferenceLinkSyntax ||
      previous instanceof ShortcutReferenceImageSyntax,
    'expected link or image label'
  );
  const node =
    previous instanceof ImageSyntax
      ? new FullReferenceImageSyntax()
      : new FullReferenceLinkSyntax();
  copyLabel(previous, node);
  node.identifier = previous.identifier;
  node.reference = new ReferenceSyntax();
  node.reference.start = point(token.start);
  node.reference.end = point(token.end);
  replaceCurrent(this, node);
  this.data.referenceType = 'collapsed';
}
function onexitreferencemarker(this: CompileContext, token: Token): undefined {
  const node = this.stack[this.stack.length - 1];
  assert(
    node instanceof FullReferenceLinkSyntax || node instanceof FullReferenceImageSyntax,
    'expected reference'
  );
  const reference = node.reference;
  if (point(token.start) === reference.start) {
    reference.openingBracket = new DelimiterTokenSyntax(
      'openingBracket',
      point(token.start),
      point(token.end)
    );
  } else {
    reference.closingBracket = new DelimiterTokenSyntax(
      'closingBracket',
      point(token.start),
      point(token.end)
    );
  }
}
function onexitreferencestring(this: CompileContext, token: Token): undefined {
  const fragment = this.stack[this.stack.length - 1];
  assert(fragment instanceof Fragment, 'expected buffered label');
  this.resume();
  const node = this.stack[this.stack.length - 1];
  assert(
    node instanceof FullReferenceLinkSyntax || node instanceof FullReferenceImageSyntax,
    'expected reference'
  );
  node.reference.children = fragment.children as Array<StringSegmentSyntax>;
  node.identifier = normalizeIdentifier(
    this.sliceSerialize(token)
  ).toLowerCase();
  this.data.referenceType = 'full';
  this.data.inString = undefined;
}
function onexitescapemarker(this: CompileContext, token: Token): undefined {
  const node = this.stack[this.stack.length - 1];
  assert(node, 'expected node on stack');
  assert(node instanceof BackslashEscapeSyntax, 'expected escape on stack');

  node.backslash = new DelimiterTokenSyntax('backslash', point(token.start), point(token.end));
}
function onexitcharacterescapevalue(this: CompileContext, token: Token): undefined {
  const node = this.stack[this.stack.length - 1];
  assert(node, 'expected node on stack');
  assert(node instanceof BackslashEscapeSyntax, 'expected escape on stack');

  node.character = new TextTokenSyntax('escapedCharacter', point(token.start), point(token.end));
}
function onexitcharacterreferencedelimiter(this: CompileContext, token: Token): undefined {
  const node = this.stack[this.stack.length - 1];
  assert(node, 'expected node on stack');
  assert(node instanceof CharacterReferenceSyntax, 'expected reference on stack');

  if (node.ampersand === undefined) {
    node.ampersand = new DelimiterTokenSyntax('ampersand', point(token.start), point(token.end));
  } else {
    node.semicolon = new DelimiterTokenSyntax('semicolon', point(token.start), point(token.end));
  }
}
function onexitcharacterreferencemarker(this: CompileContext, token: Token): undefined {
  assert(
    token.type === 'characterReferenceMarkerNumeric' ||
      token.type === 'characterReferenceMarkerHexadecimal'
  );
  this.data.characterReferenceType = token.type;
}
function onexitcharacterreferencevalue(this: CompileContext, token: Token): undefined {
  const data = this.sliceSerialize(token);
  const type = this.data.characterReferenceType;
  let value: string;

  if (type) {
    value = decodeNumericCharacterReference(
      data,
      type === types.characterReferenceMarkerNumeric
        ? constants.numericBaseDecimal
        : constants.numericBaseHexadecimal
    );
    this.data.characterReferenceType = undefined;
  } else {
    const result = decodeNamedCharacterReference(data);
    assert(result !== false, 'expected reference to decode');
    value = result;
  }

  const tail = this.stack[this.stack.length - 1];
  assert(tail, 'expected `node`');
  assert(tail instanceof CharacterReferenceSyntax, 'expected reference on stack');
  // What stands between `&` and `;`: a name, or `#` and digits.
  tail.reference = new DelimiterTokenSyntax(
    'characterReferenceValue',
    tail.ampersand.end,
    point(token.end)
  );
  tail.character = value;
}
function onexitautolinkmarker(this: CompileContext, token: Token): undefined {
  const node = this.stack[this.stack.length - 1];
  assert(node, 'expected node on stack');
  assert(node instanceof AutolinkSyntax, 'expected link on stack');

  if (point(token.start) === node.start) {
    node.openingAngleBracket = new DelimiterTokenSyntax(
      'openingAngleBracket',
      point(token.start),
      point(token.end)
    );
  } else {
    node.closingAngleBracket = new DelimiterTokenSyntax(
      'closingAngleBracket',
      point(token.start),
      point(token.end)
    );
  }
}
function onexitautolinkprotocol(this: CompileContext, token: Token): undefined {
  const node = this.stack[this.stack.length - 1];
  assert(node, 'expected node on stack');
  assert(node instanceof AutolinkSyntax, 'expected link on stack');

  node.address = new TextTokenSyntax('autolinkAddress', point(token.start), point(token.end));
  node.destination = this.sliceSerialize(token);
}
function onexitautolinkemail(this: CompileContext, token: Token): undefined {
  const node = this.stack[this.stack.length - 1];
  assert(node, 'expected node on stack');
  assert(node instanceof AutolinkSyntax, 'expected link on stack');

  node.address = new TextTokenSyntax('autolinkAddress', point(token.start), point(token.end));
  node.destination = 'mailto:' + this.sliceSerialize(token);
}
//
// Creaters.
//

function autolink(): AutolinkSyntax {
  return new AutolinkSyntax();
}
function blockQuote(token: Token): BlockQuoteSyntax {
  const blockQuote = new BlockQuoteSyntax();
  blockQuote.spelling = { ...containerSpelling(token), whitespaceAfterMarker: '' };
  return blockQuote;
}
function calloutDeclaration(): CalloutDeclarationSyntax {
  return new CalloutDeclarationSyntax();
}
function calloutTitle(): CalloutTitleSyntax {
  return new CalloutTitleSyntax();
}
function characterEscape(): BackslashEscapeSyntax {
  return new BackslashEscapeSyntax();
}
function characterReference(): CharacterReferenceSyntax {
  return new CharacterReferenceSyntax();
}
function codeFlow(token: Token): CodeBlockSyntax {
  if (token.type === types.codeFenced) {
    const node = new FencedCodeBlockSyntax();
    node.spelling = {
      ...blockSpelling(token),
      fence: {
        fence: '',
        whitespaceAfterFence: '',
        closingFence: null,
        spacesBeforeClosingFence: 0,
      },
    };
    return node;
  }
  const node = new IndentedCodeBlockSyntax();
  node.spelling = blockSpelling(token);
  return node;
}
function codeText(): CodeSpanSyntax {
  return new CodeSpanSyntax();
}
function definition(token: Token): LinkReferenceDefinitionSyntax {
  const linkLabel = new LinkLabelSyntax();
  linkLabel.start = point(token.start);
  linkLabel.end = point(token.start);
  linkLabel.leading = 1;
  const linkReferenceDefinition = new LinkReferenceDefinitionSyntax();
  linkReferenceDefinition.labelField = linkLabel;
  linkReferenceDefinition.spelling = {
    ...blockSpelling(token),
    whitespaceAfterLabel: '',
    whitespaceBeforeTitle: '',
  };
  return linkReferenceDefinition;
}
function emphasis(): DelimitedSyntax {
  return new DelimitedSyntax('emphasis');
}
function heading(token: Token): HeadingSyntax {
  if (token.type === types.atxHeading) {
    const node = new ATXHeadingSyntax();
    node.spelling = { ...blockSpelling(token), whitespaceAfterMarker: '', closingSequence: null };
    return node;
  }
  const node = new SetextHeadingSyntax();
  node.spelling = { ...blockSpelling(token), underline: { matchesText: false, length: 0 } };
  return node;
}
function hardBreak(): HardLineBreakSyntax {
  return new HardLineBreakSyntax();
}
function html(token: Token): HTMLBlockSyntax {
  assert(token._htmlKind, 'expected `_htmlKind` on HTML');
  const htmlBlock = new HTMLBlockSyntax();
  htmlBlock.startCondition = token._htmlKind;
  htmlBlock.spelling = blockSpelling(token);
  return htmlBlock;
}
function htmlText(
  token: Token
): HTMLCommentSyntax | HTMLImageSyntax | HTMLLineBreakSyntax | RawHTMLSyntax {
  switch (token._htmlTextKind) {
    case 'comment': {
      return new HTMLCommentSyntax();
    }

    case 'image': {
      return new HTMLImageSyntax();
    }

    case 'lineBreak': {
      return new HTMLLineBreakSyntax();
    }

    default: {
      return new RawHTMLSyntax();
    }
  }
}
function image(): ShortcutReferenceImageSyntax {
  return new ShortcutReferenceImageSyntax();
}
function link(): ShortcutReferenceLinkSyntax {
  return new ShortcutReferenceLinkSyntax();
}
function list(token: Token): BulletListSyntax | OrderedListSyntax {
  const spelling = { ...containerSpelling(token), tight: !token._spread };
  if (token.type === types.listOrdered) {
    const node = new OrderedListSyntax();
    node.spelling = { ...spelling, pattern: 'decimalDot', numbering: null };
    return node;
  }
  const node = new BulletListSyntax();
  node.spelling = { ...spelling, pattern: 'dash' };
  return node;
}
function listItem(token: Token): ListItemSyntax {
  const listItem = new ListItemSyntax();
  listItem.spelling = {
    ...containerSpelling(token),
    marker: '',
    whitespaceAfterMarker: '',
    startsOnMarkerLine: token._startsOnFirstLine !== false,
    continuationIndent:
      token._continuationIndent === undefined ? null : token._continuationIndent,
  };
  return listItem;
}
function paragraph(token: Token): ParagraphSyntax {
  const paragraph = new ParagraphSyntax();
  paragraph.spelling = blockSpelling(token);
  return paragraph;
}
function strong(): DelimitedSyntax {
  return new DelimitedSyntax('strongEmphasis');
}
function text(): TextTokenSyntax<'text'> {
  return new TextTokenSyntax('text', 0, 0);
}
function thematicBreak(token: Token): ThematicBreakSyntax {
  const thematicBreak = new ThematicBreakSyntax();
  thematicBreak.spelling = blockSpelling(token);
  thematicBreak.canSetext = token._thematicBreakCanSetext === true;
  return thematicBreak;
}
