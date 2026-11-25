/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Node } from 'prosemirror-model';
import type { YAMLPairSpelling } from '../syntax/index.js';
import { Document, Pair, Scalar, YAMLMap, YAMLSeq, isScalar, parseDocument,
  type Node as YAMLNode, type ScalarTag } from 'yaml';
import { schema } from '../types/schema.js';
import { SpelledPair } from './yamlpair.js';

/** Write a YAML value or pair through the YAML library's own stringifiers. */
export function unparseYAML(node: Node): string {
  const context = new YAMLContext();
  if (node.type === schema.nodes.yamlPair) {
    const mapping = new YAMLMap<YAMLNode, YAMLNode>(context.document.schema);
    mapping.items.push(context.pair(node));
    context.document.contents = mapping;
  } else {
    context.document.contents = context.node(node);
  }
  return context.document.toString({ lineWidth: 0 }).replace(/\n$/, '');
}

/** Write front matter's mapping and document comments without its fences. */
export function unparseYAMLBody(node: Node): string {
  const root = node.firstChild;
  if (!root) throw new RangeError('YAML front matter requires its mapping');
  const spelling = node.attrs.spelling;
  if (root.childCount === 0 && !root.attrs.flow && !root.attrs.spelling?.explicitTag) {
    const comments = [
      spelling?.commentBefore,
      root.attrs.spelling?.commentBefore,
      root.attrs.spelling?.trailingComment,
      spelling?.trailingComment,
    ].filter((text): text is string => typeof text === 'string' && text.length > 0);
    return comments.map(formatComment).join('\n');
  }
  const context = new YAMLContext();
  context.document.contents = context.node(root);
  context.document.commentBefore = spelling?.commentBefore ?? null;
  context.document.comment = spelling?.trailingComment ?? null;
  const indent = spelling?.indent && spelling.indent > 0 ? spelling.indent : 2;
  const indentSeq = spelling?.indent !== 0;
  return context.document.toString({ indent, indentSeq, lineWidth: 0 }).replace(/\n$/, '');
}

function formatComment(comment: string): string {
  return comment.split('\n').map(line => {
    if (!line) return '#';
    const separator = line.startsWith(' ') ? '' : ' ';
    return `#${separator}${line}`;
  }).join('\n');
}

/** Write the mapping between its recorded front matter fences. */
export function unparseFrontMatter(node: Node): string {
  const fence: string = node.attrs.spelling?.fence ?? '---';
  const body = unparseYAMLBody(node);
  return body ? fence + '\n' + body + '\n' + fence : fence + '\n' + fence;
}

/** The YAML schema and document shared by the conversion of a value's children. */
class YAMLContext {
  readonly document = new Document<YAMLNode, true>(undefined, {
    schema: 'core',
    customTags: tags => tags.map(tag => {
      if (typeof tag === 'string' || tag.collection || tag.tag === 'tag:yaml.org,2002:str') return tag;
      return sourceTag(tag);
    }),
  });

  pair(node: Node, inFlow = false): Pair<YAMLNode, YAMLNode> {
    if (node.childCount !== 2) throw new RangeError('A YAML pair requires its key and value');
    const key = this.node(node.child(0), inFlow);
    const value = this.node(node.child(1), inFlow);
    const spelling: YAMLPairSpelling | null = node.attrs.spelling;
    return new SpelledPair(key, value, spelling?.whitespaceAfterColon);
  }

  node(node: Node, inFlow = false, inFlowSequence = false): YAMLNode {
    const value = this.value(node, inFlow, inFlowSequence);
    const spelling = node.attrs.spelling;
    value.commentBefore = spelling?.commentBefore ?? undefined;
    value.comment = spelling?.trailingComment ?? undefined;
    value.spaceBefore = spelling?.blankLineBefore ?? false;
    if (spelling?.explicitTag) {
      const probe = parseDocument(spelling.explicitTag + ' null', { schema: 'core' });
      value.tag = probe.contents?.tag;
    }
    return value;
  }

  private value(node: Node, inFlow: boolean, inFlowSequence: boolean): YAMLNode {
    switch (node.type) {
      case schema.nodes.yamlMapping: {
        const flow = inFlow || Boolean(node.attrs.flow);
        const mapping = new YAMLMap<YAMLNode, YAMLNode>(this.document.schema);
        for (const child of node.content.content) mapping.items.push(this.pair(child, flow));
        mapping.flow = flow;
        return mapping;
      }
      case schema.nodes.yamlSequence: {
        const flow = inFlow || Boolean(node.attrs.flow);
        const sequence = new YAMLSeq<YAMLNode>(this.document.schema);
        for (const child of node.content.content) sequence.items.push(this.node(child, flow, flow));
        sequence.flow = flow;
        return sequence;
      }
      case schema.nodes.yamlScalar:
        return yamlScalar(node, inFlow, inFlowSequence);
      default:
        throw new RangeError(`Not a YAML node: ${node.type.name}`);
    }
  }
}

/** Keep a non-string scalar's editable source when the library resolves its value. */
function sourceTag(tag: ScalarTag): ScalarTag {
  return {
    ...tag,
    stringify(item, context, onComment, onChomp) {
      // Numeric/boolean/null content is editable text in the owned schema. The
      // standard parser resolves it; its source, not a JS number's spelling, is written.
      if (isScalar(item) && item.source !== undefined) return item.source;
      if (tag.stringify) return tag.stringify(item, context, onComment, onChomp);
      return String(item.value);
    },
  };
}

/** Resolve a scalar's source, retaining its requested quote or block style. */
function yamlScalar(node: Node, inFlow: boolean, inFlowSequence = false): Scalar {
  const text = node.textContent;
  let scalar: Scalar;
  if (node.attrs.tag === 'string') {
    scalar = new Scalar(text);
  } else if (text === '') {
    if (node.attrs.tag === 'null') {
      scalar = new Scalar(null);
      scalar.source = inFlowSequence ? 'null' : '';
    } else {
      scalar = new Scalar(text);
    }
  } else if (text.includes('\n') || text.includes('\r')) {
    scalar = new Scalar(text);
  } else {
    const parsed = parseDocument(text, { schema: 'core', intAsBigInt: true });
    // A native field edit reaches retention before the tag-inference
    // append. The field is still a scalar's content, even when that edit
    // no longer reads as the old scalar kind. Let YAML quote that content;
    // the normal field transaction assigns its new tag.
    if (
      parsed.errors.length ||
      parsed.warnings.length ||
      parsed.commentBefore ||
      parsed.comment ||
      !isScalar(parsed.contents) ||
      parsed.contents.commentBefore ||
      parsed.contents.comment ||
      (parsed.contents.source ?? '') !== text
    ) {
      scalar = new Scalar(text);
    } else {
      scalar = parsed.contents;
      scalar.source = text;
    }
  }
  const style = node.attrs.spelling?.style;
  if (inFlow && (style === 'literal' || style === 'folded' || text.includes('\n'))) {
    scalar.type = Scalar.QUOTE_DOUBLE;
    return scalar;
  }
  if (!style && !inFlow && text.includes('\n')) {
    scalar.type = Scalar.BLOCK_LITERAL;
    return scalar;
  }
  switch (style ?? 'plain') {
    case 'plain':
      scalar.type = Scalar.PLAIN;
      break;
    case 'singleQuoted':
      scalar.type = Scalar.QUOTE_SINGLE;
      break;
    case 'doubleQuoted':
      scalar.type = Scalar.QUOTE_DOUBLE;
      break;
    case 'literal':
      scalar.type = Scalar.BLOCK_LITERAL;
      break;
    case 'folded':
      scalar.type = Scalar.BLOCK_FOLDED;
      break;
  }
  return scalar;
}
