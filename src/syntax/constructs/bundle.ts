/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The grammars Kagami reads Markdown with.
//
// A grammar is a set of constructs: for each content type, which constructs may start at which
// character, and in what order they are tried. Each grammar here is put together from nothing,
// out of the constructs it needs. Nothing is taken in whole and then cut back, and nobody outside
// this file assembles a grammar.
//
// There are two kinds. A document is read in two phases: its blocks first, with the text of a
// paragraph taken only as far as its lines, and then the text of each field on its own. So there
// are grammars for blocks and grammars for the text of one field, and one grammar that reads
// blocks and text together.

import type { ConstructRecord, Extension, FullNormalizedExtension } from '../types/index.js';
import { combineExtensions } from '../kernel/utils/combine-extensions/index.js';

import * as definition from './content-initial/definition.js';
import * as blockQuote from './document/block-quote.js';
import * as list from './document/list.js';
import * as codeIndented from './flow-initial/code-indented.js';
import * as codeFenced from './flow/code-fenced.js';
import * as frontmatter from './flow/frontmatter.js';
import * as calloutHead from './flow/callout-head.js';
import * as gfmTable from './flow/gfm-table.js';
import * as headingATX from './flow/heading-atx.js';
import * as htmlFlow from './flow/html-flow.js';
import * as mathFlow from './flow/math-flow.js';
import * as setextUnderline from './flow/setext-underline.js';
import * as thematicBreak from './flow/thematic-break.js';
import * as characterEscape from './shared/character-escape.js';
import * as characterReference from './shared/character-reference.js';
import * as gfmFootnote from './shared/gfm-footnote.js';
import * as attention from './text/attention.js';
import * as atxHeadingClosing from './text/atx-heading-closing.js';
import * as autolink from './text/autolink.js';
import * as codeText from './text/code-text.js';
import * as emoji from './text/emoji.js';
// ZWSP edge mark: File grammars add this text construct after blocks have been recognized.
import * as edgeMark from './text/edge-mark.js';
import * as gfmAutolinkLiteral from './text/gfm-autolink-literal.js';
import * as gfmStrikethrough from './text/gfm-strikethrough.js';
import * as gfmTaskListItem from './text/gfm-task-list-item.js';
import * as hardBreakEscape from './text/hard-break-escape.js';
import * as tag from './text/tag.js';
import * as highlight from './text/highlight.js';
import * as imageSize from './text/image-size.js';
import * as htmlText from './text/html-text.js';
import * as titleCandidate from './text/inline-source-link-definition-title-candidate.js';
import * as phrasingTaskMarker from './text/inline-source-task-marker.js';
import * as calloutDeclaration from './text/inline-source-callout-declaration.js';
import * as labelEnd from './text/label-end.js';
import * as labelLineEnding from './text/label-line-ending.js';
import * as labelStartImage from './text/label-start-image.js';
import * as labelStartLink from './text/label-start-link.js';
import * as lineEnding from './text/line-ending.js';
import * as mathText from './text/math-text.js';
import * as wikilink from './text/wikilink.js';

// Every table a tokenizer may look into, empty.
const blank: Extension = {
  document: {},
  contentInitial: {},
  flowInitial: {},
  flow: {},
  string: {},
  text: {},
  insideSpan: { null: [] },
  attentionMarkers: { null: [] },
  disable: { null: [] },
};

/**
 * Puts a grammar together from its parts. Where several constructs start at one character, the
 * one in the part listed first is tried first. A construct that says of itself that it is added
 * after the others (`add: 'after'`) keeps that.
 */
function grammar(...parts: Extension[]): FullNormalizedExtension {
  // `combineExtensions` puts each extension in front of the ones given before it.
  return combineExtensions([blank, ...[...parts].reverse()]) as FullNormalizedExtension;
}

// The constructs that may start in a string: a definition's destination and title, a fence's info
// string, a link's destination and title.
const strings: Extension[] = [
  { string: characterReference.string },
  { string: characterEscape.string },
];

// Blocks.

// The flow constructs in the order they are tried. A Setext underline comes before a thematic
// break: `---` under a paragraph is an underline.
const paragraphFlow: Extension[] = [
  { flow: headingATX.flow },
  { flow: setextUnderline.flow },
  { flow: thematicBreak.flow },
  { flow: htmlFlow.flow },
  { flow: codeFenced.flow },
  { flow: mathFlow.flow },
];

const flow: Extension[] = [...paragraphFlow, { flow: gfmTable.flow }];

// A table recognizes its head and delimiter together. The paragraph query asks the other
// flow constructs about the current line, and the table construct about the following line.
export const paragraphInterruptions: ConstructRecord = grammar(...paragraphFlow).flow;

// Everything above the text of a paragraph.
const blockLevel: Extension[] = [
  { document: list.document },
  { document: blockQuote.document },
  { document: gfmFootnote.document },
  { contentInitial: definition.contentInitial },
  ...flow,
  ...strings,
];

// ZWSP edge mark: Indented code belongs only to file readings; typed indentation is content.
const fileBlockLevel: Extension[] = [{ flowInitial: codeIndented.flowInitial }, ...blockLevel];

// Front matter can stand only at the start of a document, and is tried before anything else
// that starts with `-` or `+`.
// Kagami: a document lookahead confirms flow without opening a container.
const documentStart: Extension[] = [{ document: frontmatter.document, flow: frontmatter.flow }];

// What the block phase takes of the text of a paragraph: where its lines end, and a task-list
// check, which is written in the text and decides what the list item around it is.
const linesOnly: Extension[] = [
  { text: lineEnding.text },
  { text: gfmTaskListItem.text },
];

// Text.

// A wiki link is Kagami's own. It is listed before the brackets wherever it is read, because
// it is tried before a link label, for `[[` and `![[`.
const wikilinks: Extension[] = [{ text: wikilink.text }];

// Brackets. A footnote call is tried before a link label, for `[^`. The footnote's entry for
// `]` is added after the label end.
const brackets: Extension[] = [
  { text: gfmFootnote.text },
  { text: labelStartLink.text },
  { text: labelStartImage.text },
  { text: labelEnd.text },
  // Kagami: the size at the end of an image's text, which opens only there.
  { text: imageSize.text },
];

// Literal autolinks are tried before attention, for `_`.
const literalAutolinks: Extension[] = [{ text: gfmAutolinkLiteral.text }];

// The rest of CommonMark's and GFM's inline constructs. Strikethrough is resolved inside a span
// before attention. An autolink is tried before inline HTML, and a hard break before an escape.
//
// Upstream also resolves plain text inside a span (`insideSpan: [attention, resolveText]`). The
// grammars the editor used before this file left that out, and so do these.
const inline: Extension[] = [
  {
    text: gfmStrikethrough.text,
    insideSpan: gfmStrikethrough.insideSpan,
    attentionMarkers: gfmStrikethrough.attentionMarkers,
  },
  {
    text: attention.text,
    insideSpan: attention.insideSpan,
    attentionMarkers: attention.attentionMarkers,
  },
  { text: autolink.text },
  { text: htmlText.text },
  { text: hardBreakEscape.text },
  { text: characterEscape.text },
  { text: characterReference.text },
  { text: codeText.text },
  { text: lineEnding.text },
];

// Kagami's own inline syntax. Highlight is resolved inside a span before strikethrough.
const dialect: Extension[] = [
  {
    text: highlight.text,
    insideSpan: highlight.insideSpan,
    attentionMarkers: highlight.attentionMarkers,
  },
  { text: tag.text },
  { text: emoji.text },
];

const math: Extension[] = [{ text: mathText.text }];

// The grammars.

// The text of a file: its blocks and their text together.
const fileContent: Extension[] = [
  ...fileBlockLevel,
  // Kagami: the head of a callout, on the first line of a quote's content, read in one pass.
  { flow: calloutHead.flow },
  { text: gfmTaskListItem.text },
  // ZWSP edge mark: A whole file finds candidates, including after a task check.
  { text: edgeMark.text },
  ...dialect,
  ...math,
  ...wikilinks,
  ...brackets,
  ...literalAutolinks,
  ...inline,
];

/** A document read whole: its blocks and their text together. Front matter may open it. */
export const wholeDocument: FullNormalizedExtension = grammar(...documentStart, ...fileContent);

/** A part of a file read whole, as a document is read after its front matter. */
export const partOfFile: FullNormalizedExtension = grammar(...fileContent);

// ZWSP edge mark: A field read as blocks keeps its leading character, and has no edge mark and
// no indented code.
/** The text of a field read as blocks, whole. */
export const phrasingDocument: FullNormalizedExtension = grammar(
  ...blockLevel,
  { flow: calloutHead.flow },
  { text: gfmTaskListItem.text },
  ...dialect,
  ...math,
  ...wikilinks,
  ...brackets,
  ...literalAutolinks,
  ...inline,
);

/** The block phase of a document. Front matter may open it. */
// ZWSP edge mark: Both file block phases find candidates before projection reads their fields.
export const documentBlocks: FullNormalizedExtension = grammar(
  ...documentStart, ...fileBlockLevel, ...linesOnly, { text: edgeMark.text },
);

// ZWSP edge mark: A file fragment includes block syntax even without a document preamble.
export const fileBlocks: FullNormalizedExtension = grammar(
  ...fileBlockLevel, ...linesOnly, { text: edgeMark.text },
);

// ZWSP edge mark: A field keeps its leading character and has no indented code construct.
export const fieldBlocks: FullNormalizedExtension = grammar(...blockLevel, ...linesOnly);

// Phrasing grammars disable indented code. Inline constructs consume continuation indentation.
const noIndentedCode: Extension = { disable: { null: ['codeIndented'] } };
const phrasingText: Extension[] = [
  ...dialect, ...math, ...wikilinks, ...brackets, ...literalAutolinks, ...inline, ...strings, noIndentedCode,
];

/**
 * The text of a field of inline content, with each conditional construct its place offers.
 * Compiled once, including every conditional combination. No grammar is assembled per request.
 */
export const inlinePhrasings = {
  paragraph: grammar(...phrasingText),
  setextHeading: grammar(...phrasingText),
  calloutTitle: grammar(...phrasingText),
  paragraphTask: grammar({ text: phrasingTaskMarker.text }, ...phrasingText),
  paragraphCallout: grammar({ text: calloutDeclaration.text }, ...phrasingText),
  paragraphTaskCallout: grammar({ text: phrasingTaskMarker.text }, { text: calloutDeclaration.text }, ...phrasingText),
  atxHeading: grammar({ text: atxHeadingClosing.text }, ...phrasingText),
  tableCell: grammar(...phrasingText),
} as const;

// Footnote labels retain their separate line-ending reading. Link labels and the
// other string fields consume continuation indentation through text/line-ending.
const phrasingLabel: Extension[] = [...strings, { string: labelLineEnding.string }];
const phrasingString: Extension[] = [...strings, { string: lineEnding.text }];

/** The text of a field of string content. A destination offers the start of a title. */
export const stringPhrasings = {
  linkLabel: grammar(...phrasingString),
  linkDestination: grammar({ string: titleCandidate.text }, ...phrasingString),
  linkTitle: grammar(...phrasingString),
  footnoteLabel: grammar(...phrasingLabel),
} as const;
