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
export function yaml(node: Node): string {
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

export namespace yaml {
  /** Write front matter's mapping and document comments without its fences. */
  export function body(node: Node): string {
    const root = node.firstChild;
    if (!root) throw new RangeError('YAML front matter requires its mapping');
    const context = new YAMLContext();
    const spelling = node.attrs.spelling;
    context.document.contents = context.node(root);
    context.document.commentBefore = spelling?.commentBefore ?? null;
    context.document.comment = spelling?.trailingComment ?? null;
    return context.document.toString({ indent: spelling?.indent ?? 2, lineWidth: 0 }).replace(/\n$/, '');
  }

  /** Write the mapping between its recorded front matter fences. */
  export function frontMatter(node: Node): string {
    const fence: string = node.attrs.spelling?.fence ?? '---';
    return fence + '\n' + body(node) + '\n' + fence;
  }
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

  pair(node: Node): Pair<YAMLNode, YAMLNode> {
    if (node.childCount !== 2) throw new RangeError('A YAML pair requires its key and value');
    const key = this.node(node.child(0));
    const value = this.node(node.child(1));
    const spelling: YAMLPairSpelling | null = node.attrs.spelling;
    return new SpelledPair(key, value, spelling?.whitespaceAfterColon);
  }

  node(node: Node): YAMLNode {
    const value = this.value(node);
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

  private value(node: Node): YAMLNode {
    switch (node.type) {
      case schema.nodes.yamlMapping: {
        const mapping = new YAMLMap<YAMLNode, YAMLNode>(this.document.schema);
        for (const child of node.content.content) mapping.items.push(this.pair(child));
        mapping.flow = node.attrs.spelling?.flow ?? false;
        return mapping;
      }
      case schema.nodes.yamlSequence: {
        const sequence = new YAMLSeq<YAMLNode>(this.document.schema);
        for (const child of node.content.content) sequence.items.push(this.node(child));
        sequence.flow = node.attrs.spelling?.flow ?? false;
        return sequence;
      }
      case schema.nodes.yamlScalar:
        return yamlScalar(node);
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
function yamlScalar(node: Node): Scalar {
  let scalar: Scalar;
  if (node.attrs.tag === 'string') {
    scalar = new Scalar(node.textContent);
  } else {
    const parsed = parseDocument(node.textContent, { schema: 'core', intAsBigInt: true });
    // A native field edit reaches retention before the tag-inference
    // append. The field is still a scalar's content, even when that edit
    // no longer reads as the old scalar kind. Let YAML quote that content;
    // the normal field transaction assigns its new tag.
    if (parsed.errors.length || parsed.warnings.length || parsed.contents && !isScalar(parsed.contents)) {
      scalar = new Scalar(node.textContent);
    } else {
      scalar = parsed.contents ?? new Scalar(null);
      scalar.source = node.textContent;
    }
  }
  switch (node.attrs.spelling?.style ?? 'plain') {
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
