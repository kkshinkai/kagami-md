/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-FileCopyrightText: Titus Wormer <tituswormer@gmail.com>
 * SPDX-License-Identifier: MPL-2.0 AND MIT
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Derived from mdast-util-frontmatter, https://github.com/syntax-tree/mdast-util-frontmatter. */

import {
  DocumentSyntax,
  RawFrontMatterSyntax,
  YAMLFrontMatterSyntax,
  YAMLMappingSyntax,
  YAMLNodeSyntax,
  YAMLPairSyntax,
  YAMLScalarSyntax,
  YAMLSequenceSyntax,
  type YAMLSpelling,
  type YAMLFrontMatterSpelling,
} from '../syntax/block.js';
import type { Token } from '../types/index.js';

import type { CompileContext, Extension } from './types.js';
import type { Document, Node as YAMLNode, Pair, Scalar } from 'yaml';
import type { SourceRange } from '../syntax/syntax.js';
import { assert } from '../kernel/assert.js';
import { isAlias, isMap, isScalar, isSeq, parseDocument } from 'yaml';
import { written } from './spelling.js';
import { beginLiteral, literalValue } from './literal.js';

declare module './types.js' {
  interface CompileData {
    /**
     * The fences of the front matter being made.
     */
    frontmatterFences?: Array<Token> | undefined;
  }
}

/**
 * A scalar’s style, in the words of the YAML specification, by `yaml`’s
 * names for it.
 */
const styles: Record<Scalar.Type, YAMLScalarSyntax.Style> = {
  PLAIN: 'plain',
  QUOTE_SINGLE: 'singleQuoted',
  QUOTE_DOUBLE: 'doubleQuoted',
  BLOCK_LITERAL: 'literal',
  BLOCK_FOLDED: 'folded',
};

/**
 * A YAML node the tree has no type for: the front matter is kept as source.
 */
class Unreadable extends Error {}

/**
 * Create an extension to read front matter: its fences, and the YAML between
 * them, which the package `yaml` reads
 * (private-docs/design/syntax/front-matter.md).
 *
 * @returns
 *   Extension.
 */
export function frontmatterFromMarkdown(): Extension {
  return {
    enter: { frontmatter: open },
    exit: {
      frontmatter: close,
      frontmatterData: value,
      frontmatterFence: fence,
    },
  };
}

function open(this: CompileContext, token: Token): undefined {
  const rawFrontMatter = new RawFrontMatterSyntax();
  rawFrontMatter.spelling = {
    fence: '',
    leadingBlankLines: token._leadingBlankLines || 0,
    trailingBlankLines: token._trailingBlankLines || 0,
  };
  this.enter(rawFrontMatter, token);
  this.data.frontmatterFences = [];
}

function close(this: CompileContext, token: Token): undefined {
  const node = this.stack[this.stack.length - 1];
  assert(node, 'expected node on stack');
  assert(node instanceof RawFrontMatterSyntax, 'expected front matter on stack');
  const fences = this.data.frontmatterFences;
  assert(fences && fences.length === 2, 'expected two fences');
  this.exit(token);
  const root = this.stack[this.stack.length - 1];
  assert(root, 'expected node on stack');
  assert(root instanceof DocumentSyntax, 'expected document on stack');
  // Front matter is no child of the document.

  // The YAML between the fences, after the line ending of the first.
  const between = this.sliceSerialize({ start: fences[0]!.end, end: fences[1]!.start });
  const eol = /^(\r\n|\r|\n)/.exec(between);
  const size = eol ? eol[0].length : 0;
  const yaml = new YAMLReader(between.slice(size), fences[0]!.end.offset + size).read();
  let frontMatter: RawFrontMatterSyntax | YAMLFrontMatterSyntax = node;

  if (yaml) {
    const yamlFrontMatter = new YAMLFrontMatterSyntax();
    yamlFrontMatter.leading = node.leading;
    yamlFrontMatter.trailing = node.trailing;
    yamlFrontMatter.start = node.start;
    yamlFrontMatter.end = node.end;
    yamlFrontMatter.bodyStart = node.bodyStart;
    yamlFrontMatter.bodyEnd = node.bodyEnd;
    yamlFrontMatter.root = yaml.root;
    yamlFrontMatter.spelling = { ...node.spelling, ...yaml.spelling };
    frontMatter = yamlFrontMatter;
  }

  root.frontMatter = frontMatter;
  this.data.frontmatterFences = undefined;
}

function value(this: CompileContext, token: Token): undefined {
  const node = this.stack[this.stack.length - 1];
  assert(node, 'expected node on stack');
  assert(node instanceof RawFrontMatterSyntax, 'expected front matter on stack');
  literalValue(this, node, token);
}

function fence(this: CompileContext, token: Token): undefined {
  const node = this.stack[this.stack.length - 1];
  assert(node, 'expected node on stack');
  assert(node instanceof RawFrontMatterSyntax, 'expected front matter on stack');
  const fences = this.data.frontmatterFences;
  assert(fences, 'expected fences');

  if (fences.length === 0) {
    node.spelling.fence = written(this, token);
    beginLiteral(this, token, true);
  }

  fences.push(token);
}

/** The YAML tree and document spelling between front matter fences. */
interface YAMLReading {
  root: YAMLMappingSyntax;
  spelling: YAMLFrontMatterSpelling.Content;
}

/** Read a YAML tree with one source, document and indentation tally. */
class YAMLReader {
  readonly document: Document.Parsed;
  /** How far each nested block collection is indented below its key. */
  readonly steps: Array<number> = [];

  constructor(readonly source: string, readonly start: number) {
    this.document = parseDocument(source, {
      keepSourceTokens: true,
      intAsBigInt: true,
      prettyErrors: false,
      schema: 'core',
      uniqueKeys: false,
      version: '1.2',
    });
  }

  /** Read a mapping, preserving unsupported YAML as raw front matter. */
  read(): YAMLReading | undefined {
    let root: YAMLNodeSyntax;

    if (this.document.errors.length > 0 || this.document.warnings.length > 0) {
      return undefined;
    }

    try {
      if (this.document.contents === null) {
        const mapping = new YAMLMappingSyntax();
        mapping.start = this.start;
        mapping.end = this.start;
        mapping.spelling = { ...yamlSpelling(undefined, this.document), flow: false };
        root = mapping;
      } else {
        root = this.one(this.document.contents);
      }
    } catch (error) {
      if (error instanceof Unreadable) {
        return undefined;
      }

      throw error;
    }

    if (!(root instanceof YAMLMappingSyntax)) {
      return undefined;
    }

    return {
      root,
      spelling: {
        indent: mostFrequent(this.steps),
        commentBefore: this.document.commentBefore ?? null,
        trailingComment: this.document.comment ?? null,
      },
    };
  }

  /**
   * One node.
   *
   * @param node
   *   Node of `yaml`.
   * @returns
   *   Node of the tree.
   */
  one(node: unknown): YAMLNodeSyntax {
    // By design: anchors and aliases need a source editor, not independent value controls.
    // The YAML parser identifies them, including nodes nested in keys or collections.
    if (isAlias(node) || ((isMap(node) || isSeq(node) || isScalar(node)) && node.anchor)) {
      throw new Unreadable();
    }

    if (isMap(node)) {
      const flow = node.flow === true;
      const children: Array<YAMLPairSyntax> = [];
      let index = -1;

      while (++index < node.items.length) {
        children.push(this.pair(node.items[index] as Pair, flow));
      }

      const yamlMapping = new YAMLMappingSyntax();
      Object.assign(yamlMapping, this.range(node));
      yamlMapping.children = children;
      yamlMapping.spelling = { ...yamlSpelling(node, this.document), flow };
      return yamlMapping;
    }

    if (isSeq(node)) {
      const children: Array<YAMLNodeSyntax> = [];
      let index = -1;

      while (++index < node.items.length) {
        children.push(this.one(node.items[index]));
      }

      const yamlSequence = new YAMLSequenceSyntax();
      Object.assign(yamlSequence, this.range(node));
      yamlSequence.children = children;
      yamlSequence.spelling = { ...yamlSpelling(node, this.document), flow: node.flow === true };
      return yamlSequence;
    }

    if (!isScalar(node)) {
      throw new Unreadable();
    }

    // The content is the decoded string, or the text of a scalar that its tag
    // makes something else.
    const content = typeof node.value === 'string' ? node.value : node.source || '';

    if (typeof node.value === 'string') {
      return this.scalar(node, 'string', content);
    }

    if (node.value === null) {
      return this.scalar(node, 'null', content);
    }

    if (typeof node.value === 'boolean') {
      return this.scalar(node, 'boolean', content);
    }

    if (typeof node.value === 'bigint') {
      return this.scalar(node, 'integer', content);
    }

    if (typeof node.value === 'number') {
      return this.scalar(node, 'float', content);
    }

    throw new Unreadable();
  }

  /**
   * A scalar.
   *
   * @param node
   *   Scalar of `yaml`.
   * @param tag
   *   What the core schema resolves it to.
   * @param content
   *   Its content.
   * @returns
   *   Scalar of the tree.
   */
  scalar(node: Scalar, tag: YAMLScalarSyntax.Tag, content: string): YAMLScalarSyntax {
    const type = node.type;

    const yamlScalar = new YAMLScalarSyntax();
    Object.assign(yamlScalar, this.range(node));
    yamlScalar.tag = tag;
    yamlScalar.content = content;
    yamlScalar.spelling = {
      ...yamlSpelling(node, this.document),
      style: (type && styles[type]) || 'plain',
    };
    return yamlScalar;
  }

  /**
   * A pair.
   *
   * A key or a value written as nothing, `{a}` or `? a`, is a null scalar with
   * an empty range.
   *
   * @param item
   *   Pair of `yaml`.
   * @param flow
   *   Whether its mapping is in flow style.
   * @returns
   *   Pair of the tree.
   */
  pair(item: Pair, flow: boolean): YAMLPairSyntax {
    const given = item.value === null ? undefined : this.one(item.value);
    const at = given ? given.start : this.start;
    const key = item.key === null ? this.nothing(at) : this.one(item.key);
    const target = given || this.nothing(key.end);

    if (!flow && item.key && (isMap(item.value) || isSeq(item.value)) && !item.value.flow) {
      this.steps.push(
        this.column(item.value.range![0]) - this.column((item.key as YAMLNode).range![0])
      );
    }

    let whitespace = '';
    let colon = false;
    const tokens = item.srcToken && item.srcToken.sep;
    let index = -1;

    while (tokens && ++index < tokens.length) {
      const token = tokens[index];
      if (token.type === 'map-value-ind') {
        colon = true;
      } else if (colon && token.type === 'space') {
        whitespace += token.source;
      } else if (colon) {
        break;
      }
    }

    const yamlPair = new YAMLPairSyntax();
    yamlPair.start = key.start;
    yamlPair.end = target.end;
    yamlPair.key = key;
    yamlPair.value = target;
    yamlPair.spelling = { whitespaceAfterColon: whitespace };
    return yamlPair;
  }

  /**
   * A key or a value written as nothing: null, empty, at `at`.
   *
   * @param at
   *   Offset.
   * @returns
   *   Scalar.
   */
  nothing(at: number): YAMLScalarSyntax {
    const yamlScalar = new YAMLScalarSyntax();
    yamlScalar.tag = 'null';
    yamlScalar.start = at;
    yamlScalar.end = at;
    yamlScalar.spelling = { ...yamlSpelling(undefined, this.document), style: 'plain' };
    return yamlScalar;
  }

  /**
   * The range of a node, as offsets in the document.
   *
   * @param node
   *   Node of `yaml`.
   * @returns
   *   Range.
   */
  range(node: YAMLNode): SourceRange {
    const range = node.range;
    assert(range, 'expected a range');
    return { start: this.start + range[0], end: this.start + range[1] };
  }

  /**
   * The column of an offset in `source`.
   *
   * @param offset
   *   Offset.
   * @returns
   *   Column, from 0.
   */
  column(offset: number): number {
    return offset - (this.source.lastIndexOf('\n', offset - 1) + 1);
  }
}

/**
 * What every YAML node records: its comments, a blank line before it, and a
 * tag written on it.
 *
 * @param node
 *   Node of `yaml`, or nothing for a node written as nothing.
 * @param document
 *   Document of `yaml`.
 * @returns
 *   Spelling.
 */
function yamlSpelling(node: YAMLNode | undefined, document: Document.Parsed): YAMLSpelling {
  return {
    commentBefore: node?.commentBefore ?? null,
    trailingComment: node?.comment ?? null,
    blankLineBefore: node?.spaceBefore === true,
    // `yaml` gives a written tag in full, `tag:yaml.org,2002:str`, and writes
    // it back short.
    explicitTag: node?.tag ? document.directives.tagString(node.tag) : null,
  };
}

/**
 * The value found most often, the earliest of them on a tie.
 *
 * @param values
 *   Values.
 * @returns
 *   Value, or nothing when there is none.
 */
function mostFrequent(values: Array<number>): number | null {
  const counts = new Map<number, number>();
  let best: number | null = null;
  let index = -1;

  while (++index < values.length) {
    counts.set(values[index]!, (counts.get(values[index]!) || 0) + 1);
  }

  // A map keeps the order in which its keys were first set.
  for (const [value, count] of counts) {
    if (best === null || count > counts.get(best)!) {
      best = value;
    }
  }

  return best;
}
