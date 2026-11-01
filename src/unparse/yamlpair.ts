/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Adapted from yaml 2.9.1 stringifyPair/stringify/stringifyComment. The pair
 * writer accepts the colon whitespace recorded by Kagami's parser. */
/*
Copyright Eemeli Aro <eemeli@gmail.com>

Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.
*/
import { Pair, Scalar, isAlias, isCollection, isScalar, isSeq, type Node as YAMLNode } from 'yaml';
import { stringifyString, type StringifyContext } from 'yaml/util';

/** A YAML pair that remembers the whitespace after its colon. */
export class SpelledPair extends Pair<YAMLNode, YAMLNode> {
  declare value: YAMLNode;

  constructor(key: YAMLNode, value: YAMLNode, readonly whitespace: string | undefined) {
    super(key, value);
  }

  override toString(context?: StringifyContext, onComment?: () => void, onChompKeep?: () => void): string {
    if (!context) return super.toString(context, onComment, onChompKeep);
    return new PairContext(this, context).write(onComment, onChompKeep);
  }
}

/** The indentation and comment state shared by one pair's two fields. */
class PairContext {
  readonly context: StringifyContext;
  private keyComment: string | null;
  private keyCommentDone = false;
  private valueCommentDone = false;
  private chompKeep = false;
  private explicit: boolean;

  constructor(readonly pair: SpelledPair, readonly outer: StringifyContext) {
    const key = pair.key;
    const simple = outer.options.simpleKeys;
    this.keyComment = key.comment || null;
    if (simple && this.keyComment) throw new Error('With simple keys, key nodes cannot have comments');
    if (simple && isCollection(key)) throw new Error('With simple keys, collection cannot be used as a key value');
    this.explicit = !simple && (isCollection(key) || !isScalar(key) ||
      key.type === Scalar.BLOCK_FOLDED || key.type === Scalar.BLOCK_LITERAL);
    this.context = {
      ...outer,
      allNullValues: false,
      implicitKey: !this.explicit && (simple || !outer.allNullValues),
      indent: outer.indent + outer.indentStep,
    };
  }

  write(onComment?: () => void, onChompKeep?: () => void): string {
    const context = this.context;
    const options = context.options;
    let text = stringifyNode(this.pair.key, context,
      () => { this.keyCommentDone = true; }, () => { this.chompKeep = true; });
    if (!this.explicit && !context.inFlow && text.length > 1024) {
      if (options.simpleKeys)
        throw new Error('With simple keys, single line scalar must not span more than 1024 characters');
      this.explicit = true;
    }
    if (context.inFlow && this.outer.allNullValues) {
      if (this.keyCommentDone) onComment?.();
      if (!text) return '?';
      return this.explicit ? '? ' + text : text;
    }
    if (!context.inFlow && this.outer.allNullValues && !options.simpleKeys) {
      text = '? ' + text;
      if (this.keyComment && !this.keyCommentDone) {
        text += lineComment(text, context.indent, options.commentString(this.keyComment));
      } else if (this.chompKeep) {
        onChompKeep?.();
      }
      return text;
    }
    if (this.keyCommentDone) this.keyComment = null;
    if (this.explicit) {
      if (this.keyComment) text += lineComment(text, context.indent, options.commentString(this.keyComment));
      text = '? ' + text + '\n' + this.outer.indent + ':';
    } else {
      text += ':';
      if (this.keyComment) text += lineComment(text, context.indent, options.commentString(this.keyComment));
    }
    const value = this.pair.value;
    context.implicitKey = false;
    if (!this.explicit && !this.keyComment && isScalar(value)) context.indentAtStart = text.length + 1;
    this.chompKeep = false;
    if (!options.indentSeq && context.indentStep.length >= 2 && !context.inFlow && !this.explicit &&
      isSeq(value) && !value.flow && !value.tag && !value.anchor) {
      // If indentSeq === false, consider '- ' as part of indentation where possible.
      context.indent = context.indent.substring(2);
    }
    const written = stringifyNode(value, context,
      () => { this.valueCommentDone = true; }, () => { this.chompKeep = true; });
    text += this.separator(written) + written;
    if (context.inFlow) {
      if (this.valueCommentDone) onComment?.();
    } else if (value.comment && !this.valueCommentDone) {
      text += lineComment(text, context.indent, options.commentString(value.comment));
    } else if (this.chompKeep) {
      onChompKeep?.();
    }
    return text;
  }

  private separator(text: string): string {
    const value = this.pair.value;
    const context = this.context;
    let separator = this.pair.whitespace || ' ';
    if (this.keyComment || value.spaceBefore || value.commentBefore) {
      separator = value.spaceBefore ? '\n' : '';
      if (value.commentBefore) {
        const comment = context.options.commentString(value.commentBefore);
        separator += '\n' + indentComment(comment, context.indent);
      }
      if (!text && !context.inFlow) {
        if (separator === '\n' && value.comment) separator = '\n\n';
      } else {
        separator += '\n' + context.indent;
      }
    } else if (!this.explicit && isCollection(value)) {
      const newline = text.indexOf('\n');
      const flow = context.inFlow ?? value.flow ?? value.items.length === 0;
      if ((newline !== -1 || !flow) && !hasPropertiesLine(text, newline)) separator = '\n' + context.indent;
    } else if (!text || text.startsWith('\n')) {
      separator = '';
    }
    return separator;
  }
}

/** Whether a collection's tag or anchor occupies its own opening line. */
function hasPropertiesLine(text: string, newline: number): boolean {
  if (newline < 0 || text[0] !== '&' && text[0] !== '!') return false;
  let space = text.indexOf(' ');
  if (text[0] === '&' && space !== -1 && space < newline && text[space + 1] === '!')
    space = text.indexOf(' ', space + 1);
  return space === -1 || newline < space;
}

/** The library exposes node and tag stringifiers, but not its dispatch helper.
 * These nodes are already built; no parse or rendered-text search is involved. */
function stringifyNode(node: YAMLNode, context: StringifyContext,
  onComment: () => void, onChompKeep: () => void): string {
  if (isAlias(node)) return node.toString(context);
  const tags = context.doc.schema.tags;
  let matches = node.tag ? tags.filter(tag => tag.tag === node.tag) : [];
  if (!matches.length) {
    matches = isScalar(node)
      ? tags.filter(tag => tag.identify?.(node.value))
      : tags.filter(tag => tag.nodeClass && node instanceof tag.nodeClass);
  }
  const tested = matches.filter(tag => tag.test);
  if (!node.tag && tested.length) matches = tested;
  const format = isScalar(node) ? node.format : undefined;
  const tag = matches.find(tag => tag.format === format) ?? matches.find(tag => !tag.format) ?? matches[0];
  if (!tag) throw new RangeError('The YAML node has no tag');
  const properties: string[] = [];
  if (context.doc.directives) {
    if (node.anchor) {
      context.anchors.add(node.anchor);
      properties.push('&' + node.anchor);
    }
    const name = node.tag ?? (tag.default ? null : tag.tag);
    if (name) properties.push(context.doc.directives.tagString(name));
  }
  const prefix = properties.join(' ');
  if (prefix) context.indentAtStart = (context.indentAtStart ?? 0) + prefix.length + 1;
  let text: string;
  if (!isScalar(node)) text = node.toString(context, onComment, onChompKeep);
  else if (tag.stringify) text = tag.stringify(node, context, onComment, onChompKeep);
  else text = stringifyString(node, context, onComment, onChompKeep);
  if (!prefix) return text;
  if (isScalar(node) || text[0] === '{' || text[0] === '[') return prefix + ' ' + text;
  return prefix + '\n' + context.indent + text;
}

/** Indent a comment while preserving blank comment lines. */
function indentComment(comment: string, indent: string): string {
  if (/^\n+$/.test(comment)) return comment.substring(1);
  if (!indent) return comment;
  return comment.replace(/^(?! *$)/gm, indent);
}

/** The whitespace and text of a comment following a written field. */
function lineComment(text: string, indent: string, comment: string): string {
  if (text.endsWith('\n')) return indentComment(comment, indent);
  if (comment.includes('\n')) return '\n' + indentComment(comment, indent);
  return (text.endsWith(' ') ? '' : ' ') + comment;
}
