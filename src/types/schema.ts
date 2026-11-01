/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type {
  ATXHeadingSpelling, BlockSpelling, DocumentSpelling, FenceSpelling, FrontMatterSpelling,
  LinkDestinationSpelling, LinkTitleSpelling, SetextUnderlineSpelling, YAMLPairSpelling, YAMLSpelling,
} from '../syntax/index.js';
import {
  Fragment, Schema, type AttributeSpec, type MarkSpec, type MarkType, type NodeSpec,
  type TagParseRule
} from 'prosemirror-model';
import { tableNodes } from 'prosemirror-tables';

/** The spelling shared by the editor's ATX and setext heading node. */
export interface HeadingSpelling extends BlockSpelling {
  whitespaceAfterMarker: string | null;
  closingSequence: ATXHeadingSpelling.ClosingSequence | null;
  underline: SetextUnderlineSpelling | null;
}

/** The spelling shared by the editor's fenced and indented code node. */
export interface CodeSpelling extends BlockSpelling {
  fence: FenceSpelling | null;
}

/** The spelling records carried by document nodes. */
export type NodeSpelling = BlockSpelling | HeadingSpelling | CodeSpelling | DocumentSpelling | YAMLSpelling
  | FrontMatterSpelling
  | LinkDestinationSpelling | LinkTitleSpelling | YAMLPairSpelling;

/** The column alignments supported by Markdown tables. */
export type Alignment = 'left' | 'center' | 'right' | null;

/** Read an HTML or transported table alignment. */
export function alignment(value: unknown): Alignment {
  return value === 'left' || value === 'center' || value === 'right' ? value : null;
}

const tables = tableNodes({ tableGroup: 'block', cellContent: 'tableParagraph', cellAttributes: {} });
/** Preserve unmerged GFM cells when importing DOM through the native cell rules. */
function unmerged(rules: readonly TagParseRule[]): TagParseRule[] {
  return rules.map(rule => ({
    ...rule,
    getAttrs(dom) {
      const attrs = rule.getAttrs?.(dom);
      if (attrs === false) return false;
      return { colspan: 1, rowspan: 1, colwidth: null };
    },
  }));
}

const spelling = { default: null };

/** The node specs of Kagami's schema. */
const nodes = {
  /** The document holds optional front matter followed by its blocks. */
  document: {
    content: 'frontMatter? block+', attrs: { spelling },
  } as NodeSpec,

  /** The default block, holding editable inline source. */
  paragraph: {
    group: 'block field', content: 'inline*', attrs: { spelling },
    parseDOM: [{ tag: 'p' }], toDOM() { return ['p', 0]; },
  } as NodeSpec,

  /** Source characters, carrying the marks of their syntax occurrences. */
  text: { group: 'inline' } as NodeSpec,

  /** One source line ending, whether or not it renders as a hard break. */
  lineEnding: {
    inline: true, group: 'inline', selectable: false,
    leafText() { return '\n'; }, parseDOM: [{ tag: 'br[data-line-ending]' }],
    toDOM() { return ['br', { class: 'md-line-break', 'data-line-ending': '' }]; },
  } as NodeSpec,

  /** Structured front matter contains one YAML mapping. */
  yamlFrontMatter: {
    group: 'frontMatter', content: 'yamlMapping', attrs: { spelling }, defining: true, isolating: true,
    parseDOM: [{ tag: 'section[data-frontmatter]' }],
    toDOM() { return ['section', { class: 'md-frontmatter', 'data-frontmatter': '' }, 0]; },
  } as NodeSpec,

  /** Front matter that cannot be structured keeps its literal source. */
  rawFrontMatter: {
    group: 'frontMatter', content: 'text*', attrs: { spelling }, marks: '', code: true,
    defining: true, isolating: true,
    toDOM() { return ['pre', { class: 'md-frontmatter-source' }, ['code', 0]]; },
  } as NodeSpec,

  /** An ordered collection of YAML properties. */
  yamlMapping: {
    group: 'yamlNode yamlCollection', content: 'yamlPair*', attrs: { spelling }, defining: true, isolating: true,
    parseDOM: [{ tag: '.md-yaml-map' }],
    toDOM() { return ['div', { class: 'md-yaml-map' }, 0]; },
  } as NodeSpec,

  /** A YAML property contains its key followed by its value. */
  yamlPair: {
    content: 'yamlNode yamlNode', attrs: { spelling }, defining: true, isolating: true,
    parseDOM: [{ tag: '.md-yaml-property' }],
    toDOM() { return ['div', { class: 'md-yaml-property' }, 0]; },
  } as NodeSpec,

  /** An ordered sequence of YAML values. */
  yamlSequence: {
    group: 'yamlNode yamlCollection', content: 'yamlNode*', attrs: { spelling }, defining: true, isolating: true,
    parseDOM: [{ tag: '.md-yaml-array' }],
    toDOM() { return ['div', { class: 'md-yaml-array' }, 0]; },
  } as NodeSpec,

  /** A decoded scalar; its tag identifies the YAML value represented by its text. */
  yamlScalar: {
    group: 'yamlNode', content: 'text*', marks: '', code: true, defining: true, isolating: true,
    attrs: { spelling, tag: { default: 'string', validate: 'string' } },
    parseDOM: [{ tag: '.md-yaml-scalar', preserveWhitespace: 'full',
      getAttrs(dom) { return { tag: dom.getAttribute('data-yaml-tag') ?? 'string' }; } }],
    toDOM(node) { return ['div', { class: 'md-yaml-scalar', 'data-yaml-tag': node.attrs.tag }, 0]; },
  } as NodeSpec,

  /** A quote holds blocks, with an empty paragraph when its source body is empty. */
  blockQuote: {
    group: 'block container', content: 'block+', attrs: { spelling }, defining: true,
    parseDOM: [{ tag: 'blockquote' }], toDOM() { return ['blockquote', 0]; },
  } as NodeSpec,

  /** A callout's kind and title precede its optional body blocks. */
  callout: {
    group: 'block container', content: 'calloutTitle block*', defining: true,
    attrs: { spelling, calloutType: { default: 'note', validate: 'string' } },
    parseDOM: [{ tag: 'aside[data-callout]',
      getAttrs(dom) { return { calloutType: dom.getAttribute('data-callout') ?? 'note' }; } }],
    toDOM(node) { return ['aside', {
      class: `md-callout md-callout-${node.attrs.calloutType}`, 'data-callout': node.attrs.calloutType,
    }, 0]; },
  } as NodeSpec,

  /** The inline source on a callout's declaration line. */
  calloutTitle: {
    group: 'field', content: 'inline*', defining: true,
    parseDOM: [{ tag: '[data-callout-title]' }],
    toDOM() { return ['div', { class: 'md-callout-title', 'data-callout-title': '' }, 0]; },
  } as NodeSpec,

  /** An unordered list; spelling records its markers and tightness. */
  bulletList: {
    group: 'block list', content: 'listItem+', attrs: { spelling },
    parseDOM: [{ tag: 'ul' }], toDOM() { return ['ul', 0]; },
  } as NodeSpec,

  /** A numbered list beginning with startNumber. */
  orderedList: {
    group: 'block list', content: 'listItem+',
    attrs: { spelling, startNumber: { default: 1, validate: 'number' } },
    parseDOM: [{ tag: 'ol', getAttrs(dom) { return { startNumber: Number(dom.getAttribute('start') ?? 1) }; } }],
    toDOM(node) { return ['ol', { start: node.attrs.startNumber }, 0]; },
  } as NodeSpec,

  /** A list item's optional checkbox is separate from its block content. */
  listItem: {
    group: 'container', content: 'block+', attrs: { spelling, checked: { default: null, validate: 'boolean|null' } },
    defining: true,
    parseDOM: [{ tag: 'li', getAttrs(dom) {
      const checkbox = dom.querySelector<HTMLInputElement>(
        ':scope > input[type="checkbox"], :scope > label > input[type="checkbox"]');
      return { checked: checkbox ? checkbox.checked : null };
    } }],
    toDOM(node) {
      if (node.attrs.checked === null) return ['li', ['div', { class: 'md-list-item-content' }, 0]];
      return ['li', { class: 'task-list-item', 'data-task': 'true' },
        ['input', { type: 'checkbox', class: 'task-list-checkbox', 'aria-label': 'Toggle task',
          checked: node.attrs.checked ? 'checked' : null, contenteditable: 'false', tabindex: '-1' }],
        ['div', { class: 'md-list-item-content task-list-content' }, 0]];
    },
  } as NodeSpec,

  /** A footnote's editable label followed by its body blocks. */
  footnoteDefinition: {
    group: 'block container', content: 'footnoteLabel block+', defining: true,
    attrs: { spelling, identifier: { default: '', validate: 'string' } },
    toDOM() { return ['div', { class: 'md-footnote-definition', 'data-footnote-definition': '' }, 0]; },
  } as NodeSpec,

  /** A footnote label permits line endings but no nested inline nodes. */
  footnoteLabel: {
    group: 'field', content: '(text | lineEnding)*', defining: true,
    toDOM() { return ['span', { class: 'md-footnote-definition-head' },
      ['span', { contenteditable: 'false' }, '[^'], ['span', 0], ['span', { contenteditable: 'false' }, ']:']]; },
  } as NodeSpec,

  /** An ATX or setext heading; level is its rank and form its Markdown form. */
  heading: {
    group: 'block field', content: 'inline*', defining: true,
    attrs: { spelling, level: { default: 1, validate: 'number' }, form: { default: 'atx', validate: 'string' } },
    parseDOM: [1, 2, 3, 4, 5, 6].map(level => ({ tag: `h${level}`, attrs: { level, form: 'atx' } })),
    toDOM(node) { return [`h${node.attrs.level}`, 0]; },
  } as NodeSpec,

  /** Literal code, with nullable language and metadata from its info string. */
  codeBlock: {
    group: 'block', content: 'text*', marks: '', code: true, defining: true,
    attrs: {
      spelling, language: { default: null, validate: 'string|null' },
      meta: { default: null, validate: 'string|null' }
    },
    parseDOM: [{ tag: 'pre', preserveWhitespace: 'full', getAttrs(dom) {
      const language = dom.querySelector('code')?.className.match(/(?:^|\s)language-(\S+)/)?.[1];
      return { language: language ?? dom.getAttribute('data-lang') };
    } }],
    toDOM(node) { return ['pre', { 'data-lang': node.attrs.language }, ['code', 0]]; },
  } as NodeSpec,

  /** Literal block math between the fences recorded in its spelling. */
  mathBlock: {
    group: 'block', content: 'text*', attrs: { spelling }, marks: '', code: true, defining: true,
    toDOM() { return ['div', { class: 'md-math-block', 'data-math-block': '' }, ['pre', ['code', 0]]]; },
  } as NodeSpec,

  /** Literal HTML, with the CommonMark start condition that opened the block. */
  htmlBlock: {
    group: 'block', content: 'text*', marks: '', code: true, defining: true,
    attrs: { spelling, startCondition: { default: 6, validate: 'number' } },
    toDOM() { return ['div', { class: 'md-html-block', 'data-html-block': '' }, 0]; },
  } as NodeSpec,

  /** A standalone image or line-break tag keeps both its source and interpreted attributes. */
  htmlTagBlock: {
    group: 'block', content: 'text*', marks: '', defining: true,
    attrs: {
      spelling, tag: { default: 'htmlLineBreak', validate: 'string' }, destination: { default: '', validate: 'string' },
      title: { default: null, validate: 'string|null' }, alt: { default: '', validate: 'string' },
      width: { default: null, validate: 'number|null' }, height: { default: null, validate: 'number|null' },
    },
    toDOM() { return ['div', { class: 'md-html-block', 'data-html-tag-block': '' }, 0]; },
  } as NodeSpec,

  /** A thematic break has no editable content. */
  thematicBreak: {
    group: 'block', attrs: { spelling }, atom: true,
    parseDOM: [{ tag: 'hr' }], toDOM() { return ['hr']; },
  } as NodeSpec,

  /** A link definition's semantic values accompany its three editable string fields. */
  linkReferenceDefinition: {
    group: 'block', content: 'linkLabel linkDestination linkTitle?', defining: true,
    attrs: { spelling, identifier: { default: '', validate: 'string' },
      destination: { default: '', validate: 'string' },
      title: { default: null, validate: 'string|null' } },
    toDOM() { return ['span', { class: 'md-link-definition', 'data-link-definition': '' }, 0]; },
  } as NodeSpec,

  /** A link definition label may extend over source lines. */
  linkLabel: {
    group: 'field', content: '(text | lineEnding)*', defining: true,
    toDOM() { return ['span', { class: 'md-link-definition-head' },
      ['span', { contenteditable: 'false' }, '['], ['span', 0], ['span', { contenteditable: 'false' }, ']:']]; },
  } as NodeSpec,

  /** A destination's editable spelling, without its optional angle brackets. */
  linkDestination: {
    group: 'field', content: 'text*', attrs: { spelling }, defining: true,
    toDOM() { return ['span', { class: 'md-link-definition-destination' }, 0]; },
  } as NodeSpec,

  /** A title's editable source; spelling retains its quote delimiter. */
  linkTitle: {
    group: 'field', content: '(text | lineEnding)*', attrs: { spelling }, defining: true,
    toDOM() { return ['span', { class: 'md-link-definition-title' }, 0]; },
  } as NodeSpec,

  /** A GFM table keeps column alignments beside the native table structure. */
  table: {
    ...tables.table, content: 'tableRow+', attrs: { spelling, alignments: { default: [] } },
    parseDOM: [{ tag: 'table', getAttrs(dom) {
      return { alignments: Array.from(dom.querySelector('tr')?.children ?? [], cell => {
        return alignment((cell as HTMLElement).style.textAlign || cell.getAttribute('align'));
      }) };
    } }],
  } as NodeSpec,

  /** Each row contains at least one cell, under Kagami's node names. */
  tableRow: { ...tables.table_row, content: '(tableHeader | tableCell)+' } as NodeSpec,

  /** A header cell uses the table package's attributes and DOM rules. */
  tableHeader: { ...tables.table_header, parseDOM: [
    { tag: 'td', priority: 60, getAttrs(dom) {
      return dom.parentElement === dom.closest('table')?.querySelector('tr')
        ? { colspan: 1, rowspan: 1, colwidth: null } : false;
    } },
    ...unmerged(tables.table_header.parseDOM as readonly TagParseRule[]),
  ] } as NodeSpec,

  /** A body cell uses the table package's attributes and DOM rules. */
  tableCell: {
    ...tables.table_cell, parseDOM: unmerged(tables.table_cell.parseDOM as readonly TagParseRule[])
  } as NodeSpec,

  /** The one textblock inside each cell, as the table package requires. */
  tableParagraph: {
    group: 'field', content: 'inline*',
    parseDOM: [{ tag: 'p', context: 'tableHeader/|tableCell/', priority: 60,
      getAttrs: dom => dom.closest('td, th') ? null : false }],
    toDOM() { return ['p', 0]; },
  } as NodeSpec,
};

/** An inline syntax occurrence. Nested and adjacent occurrences remain distinct. */
function inline(className: string, syntax: string, attrs: Record<string, AttributeSpec> = {}): MarkSpec {
  return {
    excludes: '', inclusive: false,
    attrs: { occurrence: { default: 0, validate: 'number' }, ...attrs },
    toDOM() { return ['span', { class: className, 'data-syntax': syntax }, 0]; },
  };
}

const destination = { default: '', validate: 'string' };
const title = { default: null, validate: 'string|null' };
const identifier = { default: '', validate: 'string' };
const image = {
  destination, title, alt: { default: '', validate: 'string' },
  width: { default: null, validate: 'number|null' }, height: { default: null, validate: 'number|null' },
};

/** The mark specs for inline syntax, pending blocks, and concealed source. */
const marks = {
  /** A line ending rendered as whitespace. */
  softLineBreak: inline('md-soft-line-break', 'softLineBreak'),
  /** A source line ending rendered as a hard break. */
  hardLineBreak: inline('md-hard-line-break', 'hardLineBreak'),
  /** An escaped punctuation character. */
  backslashEscape: inline('md-backslash-escape', 'backslashEscape'),
  /** A character reference carries its decoded characters. */
  characterReference: {
    ...inline('md-character-reference', 'characterReference', { character: { default: '', validate: 'string' } }),
    toDOM(value) { return ['span', { class: 'md-character-reference', 'data-decoded': value.attrs.character }, 0]; },
  } as MarkSpec,
  /** Code between backtick delimiters, with its normalized value. */
  codeSpan: {
    ...inline('md-code-span', 'codeSpan', { code: { default: '', validate: 'string' } }),
    parseDOM: [{ tag: 'code', preserveWhitespace: 'full', getAttrs: dom => ({ code: dom.textContent }) }],
  } as MarkSpec,
  /** Emphasized source. */
  emphasis: { ...inline('md-emphasis', 'emphasis'), parseDOM: [{ tag: 'em' }, { tag: 'i' }] } as MarkSpec,
  /** Strongly emphasized source. */
  strongEmphasis: {
    ...inline('md-strong-emphasis', 'strongEmphasis'), parseDOM: [{ tag: 'strong' }, { tag: 'b' }]
  } as MarkSpec,
  /** Deleted source. */
  strikethrough: {
    ...inline('md-strikethrough', 'strikethrough'),
    parseDOM: [{ tag: 'del' }, { tag: 's' }, { tag: 'strike' }]
  } as MarkSpec,
  /** Highlighted source. */
  highlight: { ...inline('md-highlight', 'highlight'), parseDOM: [{ tag: 'mark' }] } as MarkSpec,
  /** Inline math carries its literal formula. */
  inlineMath: inline('md-inline-math', 'inlineMath', { math: { default: '', validate: 'string' } }),
  /** A link with an authored destination and optional title. */
  inlineLink: {
    ...inline('md-inline-link', 'inlineLink', { destination, title }),
    parseDOM: [{
      tag: 'a[href]',
      getAttrs: dom => ({ destination: dom.getAttribute('href'), title: dom.getAttribute('title') })
    }],
  } as MarkSpec,
  /** A link with a separate reference label. */
  fullReferenceLink: inline('md-full-reference-link', 'fullReferenceLink', { destination, title, identifier }),
  /** A link whose empty reference label repeats its text. */
  collapsedReferenceLink: inline('md-collapsed-reference-link', 'collapsedReferenceLink',
    { destination, title, identifier }),
  /** A link whose text is also its reference label. */
  shortcutReferenceLink: inline('md-shortcut-reference-link', 'shortcutReferenceLink',
    { destination, title, identifier }),
  /** An image with an authored destination. */
  inlineImage: inline('md-inline-image', 'inlineImage', image),
  /** An image with a separate reference label. */
  fullReferenceImage: inline('md-full-reference-image', 'fullReferenceImage', { ...image, identifier }),
  /** An image with an empty repeated reference label. */
  collapsedReferenceImage: inline('md-collapsed-reference-image', 'collapsedReferenceImage', { ...image, identifier }),
  /** An image whose alt text supplies its reference label. */
  shortcutReferenceImage: inline('md-shortcut-reference-image', 'shortcutReferenceImage', { ...image, identifier }),
  /** An angle-bracket autolink. */
  autolink: inline('md-autolink', 'autolink', { destination }),
  /** A GFM autolink recognized in plain source. */
  literalAutolink: inline('md-literal-autolink', 'literalAutolink', { destination }),
  /** An uninterpreted HTML token. */
  rawHTML: inline('md-raw-html', 'rawHTML'),
  /** An HTML comment. */
  htmlComment: inline('md-html-comment', 'htmlComment'),
  /** An HTML line-break token. */
  htmlLineBreak: {
    ...inline('md-html-line-break', 'htmlLineBreak'),
    parseDOM: [{
      tag: 'br:not([data-line-ending])',
      getContent: (_dom, schema) => Fragment.from(schema.text('<br/>'))
    }],
  } as MarkSpec,
  /** An HTML image token, with the same image meaning as Markdown images. */
  htmlImage: {
    ...inline('md-html-image', 'htmlImage', image),
    parseDOM: [{ tag: 'img[src]', getAttrs: dom => ({
      destination: dom.getAttribute('src'), alt: dom.getAttribute('alt') ?? '', title: dom.getAttribute('title'),
      width: dom.hasAttribute('width') ? Number(dom.getAttribute('width')) : null,
      height: dom.hasAttribute('height') ? Number(dom.getAttribute('height')) : null,
    }), getContent: (dom, schema) => Fragment.from(schema.text((dom as HTMLElement).outerHTML)) }],
  } as MarkSpec,
  /** A reference to a footnote identifier. */
  footnoteReference: inline('md-footnote-reference', 'footnoteReference', { identifier }),
  /** A wiki link's destination and optional displayed label. */
  wikilink: inline('md-wikilink', 'wikilink', { destination, displayText: { default: null, validate: 'string|null' } }),
  /** A wiki embed may also carry image dimensions. */
  wikiEmbed: inline('md-wiki-embed', 'wikiEmbed', {
    destination, displayText: { default: null, validate: 'string|null' }, width: image.width, height: image.height,
  }),
  /** A hashtag occurrence. */
  tag: inline('md-tag', 'tag'),
  /** An emoji shortcode carries the glyph rendered before its source. */
  emojiShortcode: {
    ...inline('md-emoji-shortcode', 'emojiShortcode', { emoji: { default: '', validate: 'string' } }),
    toDOM(value) { return ['span', { class: 'md-emoji-shortcode' },
      ['span', { class: 'md-emoji-preview', contenteditable: 'false' }, value.attrs.emoji], ['span', 0]]; },
  } as MarkSpec,
  /** A task marker awaiting conversion into a list item's checkbox. */
  taskMarker: inline('md-task-marker', 'taskMarker', { checked: { default: false, validate: 'boolean' } }),
  /** A declaration awaiting conversion of its quote into a callout. */
  calloutDeclaration: inline('md-callout-declaration', 'calloutDeclaration',
    { calloutType: { default: 'note', validate: 'string' } }),
  /** An ATX heading's optional closing hashes. */
  atxClosingSequence: inline('md-atx-closing-sequence', 'atxClosingSequence'),
  /** A code fence awaiting settlement. */
  pendingCodeFence: { ...inline('md-pending-code-fence md-pending-syntax', 'pendingCodeFence'), group: 'pending' },
  /** A math fence awaiting settlement. */
  pendingMathFence: { ...inline('md-pending-math-fence md-pending-syntax', 'pendingMathFence'), group: 'pending' },
  /** A list marker awaiting settlement. */
  pendingListMarker: { ...inline('md-pending-list-marker md-pending-syntax', 'pendingListMarker'), group: 'pending' },
  /** A heading marker awaiting settlement. */
  pendingATXHeadingMarker: {
    ...inline('md-pending-atx-heading-marker md-pending-syntax', 'pendingATXHeadingMarker'),
    group: 'pending'
  },
  /** A thematic break awaiting settlement. */
  pendingThematicBreak: {
    ...inline('md-pending-thematic-break md-pending-syntax', 'pendingThematicBreak'), group: 'pending'
  },
  /** A quote marker awaiting settlement. */
  pendingBlockQuoteMarker: {
    ...inline('md-pending-block-quote-marker md-pending-syntax', 'pendingBlockQuoteMarker'),
    group: 'pending'
  },
  /** A footnote label awaiting settlement. */
  pendingFootnoteLabel: {
    ...inline('md-pending-footnote-label md-pending-syntax', 'pendingFootnoteLabel'), group: 'pending'
  },
  /** A setext underline awaiting settlement. */
  pendingSetextUnderline: {
    ...inline('md-pending-setext-underline md-pending-syntax', 'pendingSetextUnderline'),
    group: 'pending'
  },
  /** A table delimiter awaiting settlement. */
  pendingTable: { ...inline('md-pending-table md-pending-syntax', 'pendingTable'), group: 'pending' },
  /** An HTML opening awaiting settlement, with its CommonMark start condition. */
  pendingHTMLBlock: {
    ...inline('md-pending-html-block md-pending-syntax', 'pendingHTMLBlock',
      { startCondition: { default: 6, validate: 'number' } }), group: 'pending',
  },
  /** An authored title opening at the end of a definition destination. */
  linkTitleStart: inline('md-link-title-start', 'linkTitleStart'),
  /** Source delimiters concealed independently of the occurrence they belong to. */
  meta: {
    excludes: '', inclusive: false, meta: true,
    toDOM() { return ['span', { class: 'md-meta', 'data-syntax': 'meta' }, 0]; },
  } as MarkSpec,
};

/** Kagami's document schema. */
export const schema = new Schema({ topNode: 'document', nodes, marks });

/** The marks that describe a recognized block waiting for settlement. */
export const pendingMarks: ReadonlySet<MarkType> = new Set(
  Object.values(schema.marks).filter(type => type.spec.group === 'pending')
);
