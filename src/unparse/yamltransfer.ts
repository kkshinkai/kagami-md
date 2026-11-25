/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Fragment, Slice, type Node, type NodeType, type Schema } from 'prosemirror-model';
import { parseYAML } from '../parse/parse.js';
import {
  YAMLFrontMatterSyntax, YAMLMappingSyntax, YAMLSequenceSyntax, parseFrontmatter, readYAML, type Parser,
} from '../syntax/index.js';
import { schema } from '../types/schema.js';
import { unparseAlone } from './unparse.js';
import { unparseYAML, unparseYAMLBody } from './yaml.js';

/** The enclosing container kind of a classified YAML slice. */
export type YAMLContainerKind = 'mapping' | 'sequence' | 'scalar';

/** Structural classification of a slice relative to the YAML subtree. */
export type YAMLSlice =
  | YAMLSlice.None
  | YAMLSlice.Inline
  | YAMLSlice.Entries
  | YAMLSlice.Document;

export namespace YAMLSlice {
  /** Slice contains no structured YAML nodes. */
  export interface None {
    readonly kind: 'none';
  }

  /** Selection remains inside the text of a single non-boolean `yamlScalar`. */
  export interface Inline {
    readonly kind: 'inline';
    readonly scalar: Node;
  }

  /** Selection covers complete entries (pairs, sequence items, or an atomic boolean) at one YAML depth. */
  export interface Entries {
    readonly kind: 'entries';
    readonly entries: Fragment;
    readonly container: YAMLContainerKind;
  }

  /** Selection spans `yamlFrontMatter` at the document root, optionally extending into body blocks. */
  export interface Document {
    readonly kind: 'document';
    readonly content: Fragment;
    readonly openStart: number;
    readonly openEnd: number;
  }
}

/** The slot inside structured front matter receiving pasted or dropped nodes. */
export type YAMLTarget = 'mapping' | 'sequence' | 'value';

/** Result of adapting incoming nodes to a YAML slot. */
export type YAMLAdaptation = YAMLAdaptation.Value | YAMLAdaptation.Entries;

export namespace YAMLAdaptation {
  /** Adapted single node replacing a pair's value slot. */
  export interface Value {
    readonly kind: 'value';
    readonly node: Node;
  }

  /** Adapted sibling entries spliced into a mapping (`yamlPair[]`), sequence (`yamlNode[]`), or promoted pair slot. */
  export interface Entries {
    readonly kind: 'entries';
    readonly nodes: readonly Node[];
  }
}

/** Optional parser and source serializer supplied when adapting Markdown blocks into YAML. */
export interface YAMLAdaptOptions {
  readonly parser?: Parser;
  readonly blockText?: (node: Node) => string;
}

/** Whether `node` belongs to structured YAML front matter or its transferred entries. */
export function isYAMLTransferNode(node: Node): boolean {
  return node.type === schema.nodes.yamlFrontMatter ||
    node.type === schema.nodes.yamlPair ||
    node.type.isInGroup('yamlNode');
}

/** Whether a fragment carries any structured YAML node. */
export function hasYAMLNodes(fragment: Fragment): boolean {
  return fragment.content.some(isYAMLTransferNode);
}

/** Whether `node` is a code block tagged with a YAML language (`yaml` or `yml`). */
export function isYAMLCodeBlock(node: Node): boolean {
  if (node.type !== schema.nodes.codeBlock) return false;
  const language: unknown = node.attrs.language;
  return typeof language === 'string' && /^ya?ml$/i.test(language.trim());
}

/** Classify any slice purely from its open depths and top-level YAML nodes. */
export function classifyYAMLSlice(slice: Slice): YAMLSlice {
  if (!slice.content.childCount || !hasYAMLNodes(slice.content)) {
    return { kind: 'none' };
  }
  const first = slice.content.firstChild!;
  if (first.type === schema.nodes.yamlFrontMatter &&
      (slice.openStart === 0 || slice.openEnd === 0 || slice.content.childCount > 1)) {
    return { kind: 'document', content: slice.content, openStart: slice.openStart, openEnd: slice.openEnd };
  }
  if (!slice.content.content.every(isYAMLTransferNode)) {
    return { kind: 'none' };
  }
  let content = slice.content;
  let containerType: NodeType | null = null;
  // Peel only symmetrically open wrappers: reaching `0` on either side stops at the first complete level.
  let open = Math.min(slice.openStart, slice.openEnd);
  while (open > 0 && content.childCount === 1) {
    const only = content.firstChild!;
    if (only.type === schema.nodes.yamlScalar) {
      // An atomic boolean scalar carries `NodeSelection`, so it transfers as a whole entry rather than inline text.
      if (only.attrs.tag === 'boolean') {
        return { kind: 'entries', entries: Fragment.from(only), container: 'scalar' };
      }
      return { kind: 'inline', scalar: only };
    }
    if (only.isInline) {
      return { kind: 'none' };
    }
    containerType = only.type;
    content = only.content;
    open--;
  }
  if (!content.childCount || content.firstChild!.isInline) {
    return { kind: 'none' };
  }
  let container: YAMLContainerKind = 'mapping';
  if (containerType === schema.nodes.yamlSequence) {
    container = 'sequence';
  } else if (containerType === null && content.childCount === 1 &&
      content.firstChild!.type === schema.nodes.yamlScalar) {
    container = 'scalar';
  }
  return { kind: 'entries', entries: content, container };
}

/** Peel only symmetrically open non-textblock container wrappers so outer block quotes/lists drop off without losing open depth. */
export function peelOpenWrapperSlice(slice: Slice): Slice {
  let content = slice.content;
  let openStart = slice.openStart;
  let openEnd = slice.openEnd;
  while (
    openStart > 0 &&
    openEnd > 0 &&
    content.childCount === 1 &&
    !content.firstChild!.isTextblock &&
    !content.firstChild!.isInline
  ) {
    content = content.firstChild!.content;
    openStart--;
    openEnd--;
  }
  return openStart === slice.openStart ? slice : new Slice(content, openStart, openEnd);
}

/** Serialize YAML entries (pairs, sequence items, or standalone scalar) into a `yaml` code block. */
export function yamlEntriesToCodeBlock(
  entries: readonly Node[],
  targetSchema: Schema,
  container: YAMLContainerKind = 'mapping',
): Node | null {
  if (!entries.length) return null;
  const { yamlMapping, yamlPair, yamlSequence } = schema.nodes;
  let serializedTarget: Node;
  switch (container) {
    case 'sequence':
      serializedTarget = yamlSequence.create(null, entries);
      break;
    case 'scalar':
      serializedTarget = entries[0]!;
      break;
    case 'mapping':
      if (entries.every(entry => entry.type === yamlPair)) {
        serializedTarget = yamlMapping.create(null, entries);
      } else if (entries.length === 1) {
        serializedTarget = entries[0]!;
      } else {
        serializedTarget = yamlSequence.create(null, entries);
      }
      break;
  }
  const source = unparseYAML(serializedTarget);
  const content = source ? targetSchema.text(source) : null;
  return targetSchema.nodes.codeBlock.create({ language: 'yaml' }, content);
}

/** Convert YAML nodes in an HTML serialization fragment to visible `yaml` code blocks while keeping inline scalar DOM. */
export function renderYAMLFragmentForHTML(fragment: Fragment): Fragment {
  if (!fragment.childCount || !hasYAMLNodes(fragment)) {
    return fragment;
  }
  const { yamlFrontMatter, yamlMapping, yamlScalar, yamlSequence } = schema.nodes;
  if (fragment.childCount === 1) {
    const first = fragment.firstChild!;
    if (first.type === yamlScalar && first.attrs.tag !== 'boolean') {
      return fragment;
    }
    if (first.type === yamlFrontMatter) {
      const block = frontMatterNodeToCodeBlock(first, 0, schema);
      return block ? Fragment.from(block) : fragment;
    }
    if (first.type === yamlMapping) {
      const block = yamlEntriesToCodeBlock(first.content.content, schema, 'mapping');
      return block ? Fragment.from(block) : fragment;
    }
    if (first.type === yamlSequence) {
      const block = yamlEntriesToCodeBlock(first.content.content, schema, 'sequence');
      return block ? Fragment.from(block) : fragment;
    }
    if (first.type === yamlScalar) {
      const block = yamlEntriesToCodeBlock([first], schema, 'scalar');
      return block ? Fragment.from(block) : fragment;
    }
  }
  if (fragment.content.every(isYAMLTransferNode)) {
    const block = yamlEntriesToCodeBlock(fragment.content, schema, 'mapping');
    return block ? Fragment.from(block) : fragment;
  }
  const replaced: Node[] = [];
  for (const child of fragment.content) {
    if (child.type === yamlFrontMatter) {
      const block = frontMatterNodeToCodeBlock(child, 0, schema);
      if (block) replaced.push(block);
    } else {
      replaced.push(child);
    }
  }
  return Fragment.fromArray(replaced);
}

/** Convert structural YAML nodes inside a clipboard or drag slice into `yaml` code blocks for the Markdown body. */
export function yamlSliceToBody(
  slice: Slice,
  allowLeadingFrontMatter: boolean,
): { readonly slice: Slice; readonly converted: boolean } {
  const classified = classifyYAMLSlice(slice);
  switch (classified.kind) {
    case 'none':
    case 'inline':
      return { slice, converted: false };
    case 'entries': {
      const block = yamlEntriesToCodeBlock(classified.entries.content, schema, classified.container);
      const next = block ? new Slice(Fragment.from(block), 0, 0) : Slice.empty;
      return { slice: next, converted: true };
    }
    case 'document': {
      if (allowLeadingFrontMatter && classified.openStart === 0) {
        return { slice, converted: false };
      }
      const replaced: Node[] = [];
      for (let index = 0; index < classified.content.childCount; index++) {
        const child = classified.content.child(index);
        if (child.type === schema.nodes.yamlFrontMatter) {
          const openStart = index === 0 ? classified.openStart : 0;
          const block = frontMatterNodeToCodeBlock(child, openStart, schema);
          if (block) replaced.push(block);
        } else {
          replaced.push(child);
        }
      }
      return {
        slice: new Slice(Fragment.fromArray(replaced), 0, classified.openEnd),
        converted: true,
      };
    }
  }
}

/** Parse a `yaml` code block back into structured YAML (`yamlMapping`, `yamlSequence`, or `yamlScalar`). */
export function parseYAMLCodeBlock(node: Node, targetSchema: Schema, parser?: Parser): Node | null {
  if (!isYAMLCodeBlock(node)) return null;
  const source = node.textContent;
  // Code blocks omit their closing fence newline just like `unparseYAML` strips its trailing newline;
  // restoring `\n` keeps block scalar chomping (`|-`, `|`, `|+`) a bijection across transfers.
  const value = source ? readYAML(source + '\n') : undefined;
  if (value) {
    // Reject implicit empty block containers from blank/comment text, while keeping explicit `{}` and `[]`.
    const emptyNonFlow = (value instanceof YAMLMappingSyntax || value instanceof YAMLSequenceSyntax) &&
      value.children.length === 0 && !value.spelling.flow;
    if (!emptyNonFlow) {
      return parseYAML(value, targetSchema);
    }
  }
  if (!parser) return null;
  const fenced = parseFrontmatter(source);
  if (!fenced || fenced.from !== 0 || fenced.to !== source.length || fenced.marker !== '---') {
    return null;
  }
  const file = parser.parseFile(source);
  if (file.document.frontMatter instanceof YAMLFrontMatterSyntax &&
      file.document.children.length === 0 &&
      file.document.frontMatter.root.children.length > 0) {
    return parseYAML(file.document.frontMatter.root, targetSchema);
  }
  return null;
}

/** Adapt incoming nodes to a target YAML slot (`mapping`, `sequence`, or `value`). */
export function adaptToYAMLTarget(
  nodes: readonly Node[],
  target: 'mapping' | 'sequence',
  targetSchema: Schema,
  options?: YAMLAdaptOptions,
): YAMLAdaptation.Entries;
export function adaptToYAMLTarget(
  nodes: readonly Node[],
  target: YAMLTarget,
  targetSchema: Schema,
  options?: YAMLAdaptOptions,
): YAMLAdaptation;
export function adaptToYAMLTarget(
  nodes: readonly Node[],
  target: YAMLTarget,
  targetSchema: Schema,
  options?: YAMLAdaptOptions,
): YAMLAdaptation {
  return new YAMLTargetAdapter(targetSchema, options).adapt(nodes, target);
}

/** Context shared while adapting pasted or dropped nodes into a target YAML slot. */
class YAMLTargetAdapter {
  constructor(
    private readonly targetSchema: Schema,
    private readonly options?: YAMLAdaptOptions,
  ) {}

  /** Adapt `nodes` into values or spliced entries according to the destination `target` slot. */
  adapt(nodes: readonly Node[], target: YAMLTarget): YAMLAdaptation {
    switch (target) {
      case 'mapping':
        return {
          kind: 'entries',
          nodes: nodes.flatMap(node => this.mappingEntries(node)),
        };
      case 'sequence':
        return {
          kind: 'entries',
          nodes: nodes.flatMap(node => this.sequenceItems(node)),
        };
      case 'value':
        return this.valueSlot(nodes);
    }
  }

  /** Convert one node into `yamlPair` entries for a `yamlMapping` container. */
  private mappingEntries(node: Node): readonly Node[] {
    const { yamlFrontMatter, yamlMapping, yamlPair } = this.targetSchema.nodes;
    if (node.type === yamlFrontMatter) return node.firstChild ? node.firstChild.content.content : [];
    if (node.type === yamlPair) return [node];
    if (node.type.isInGroup('yamlNode')) return [this.unnamedPair(node)];
    if (isYAMLCodeBlock(node)) {
      const parsed = parseYAMLCodeBlock(node, this.targetSchema, this.options?.parser);
      if (parsed) {
        // Splice non-empty mapping pairs directly so `{ a: 1, b: 2 }` adds siblings rather than `"": { ... }`.
        if (parsed.type === yamlMapping && parsed.childCount > 0) return parsed.content.content;
        return [this.unnamedPair(parsed)];
      }
    }
    return [this.unnamedPair(this.stringScalar(this.sourceText(node), true))];
  }

  /** Convert one node into `yamlNode` items for a `yamlSequence` container. */
  private sequenceItems(node: Node): readonly Node[] {
    const { yamlFrontMatter, yamlPair, yamlSequence } = this.targetSchema.nodes;
    if (node.type === yamlFrontMatter) return node.firstChild ? [node.firstChild] : [];
    if (node.type === yamlPair) return [node.child(1)];
    if (node.type.isInGroup('yamlNode')) return [node];
    if (isYAMLCodeBlock(node)) {
      const parsed = parseYAMLCodeBlock(node, this.targetSchema, this.options?.parser);
      if (parsed) {
        // Splice non-empty sequence items directly so `[a, b]` appends flat elements instead of nesting `[ [a, b] ]`.
        if (parsed.type === yamlSequence && parsed.childCount > 0) return parsed.content.content;
        return [parsed];
      }
    }
    return [this.stringScalar(this.sourceText(node), true)];
  }

  /** Adapt nodes written onto a selected pair's single value slot, promoting to mapping entries when multi-valued. */
  private valueSlot(nodes: readonly Node[]): YAMLAdaptation {
    if (nodes.length !== 1) {
      return this.adapt(nodes, 'mapping');
    }
    const only = nodes[0]!;
    const { yamlFrontMatter, yamlMapping, yamlPair } = this.targetSchema.nodes;
    if (only.type === yamlFrontMatter && only.firstChild) {
      if (only.firstChild.childCount > 0) {
        return { kind: 'entries', nodes: only.firstChild.content.content };
      }
      return { kind: 'value', node: only.firstChild };
    }
    if (only.type.isInGroup('yamlNode')) {
      return { kind: 'value', node: only };
    }
    if (isYAMLCodeBlock(only)) {
      const parsed = parseYAMLCodeBlock(only, this.targetSchema, this.options?.parser);
      if (parsed) {
        if (parsed.type === yamlMapping && parsed.childCount > 0) {
          return { kind: 'entries', nodes: parsed.content.content };
        }
        return { kind: 'value', node: parsed };
      }
      // Invalid or empty `yaml` code blocks fall back to plain string text without keeping outer fences.
      return { kind: 'value', node: this.stringScalar(only.textContent, true) };
    }
    if (only.type !== yamlPair) {
      return { kind: 'value', node: this.stringScalar(this.sourceText(only), true) };
    }
    return { kind: 'entries', nodes: [only] };
  }

  /** Wrap a YAML value in a pair with an empty string key (`"": value`). */
  private unnamedPair(value: Node): Node {
    return this.targetSchema.nodes.yamlPair.create(null, [this.stringScalar(''), value]);
  }

  /** Build a `yamlScalar` string node containing `text`, quoting explicit empty string values across settlement. */
  private stringScalar(text: string, quoteEmpty = false): Node {
    const content = text ? this.targetSchema.text(text) : null;
    const attrs = !text && quoteEmpty
      ? {
          tag: 'string',
          spelling: {
            style: 'doubleQuoted' as const,
            commentBefore: null,
            trailingComment: null,
            blankLineBefore: false,
            explicitTag: null,
          },
        }
      : { tag: 'string' };
    return this.targetSchema.nodes.yamlScalar.create(attrs, content);
  }

  /** Extract inner YAML text from `yaml` code blocks or serialized Markdown source from other body blocks. */
  private sourceText(node: Node): string {
    if (isYAMLCodeBlock(node)) return node.textContent;
    if (this.options?.blockText) return this.options.blockText(node);
    const { listItem, rawFrontMatter } = this.targetSchema.nodes;
    return node.type.isInGroup('block') || node.type === listItem || node.type === rawFrontMatter
      ? unparseAlone(node).body
      : node.textContent;
  }
}

/** Serialize the complete YAML portion of a sliced `yamlFrontMatter` node into a `yaml` code block. */
function frontMatterNodeToCodeBlock(frontMatter: Node, openStart: number, targetSchema: Schema): Node | null {
  if (openStart > 0) {
    let remaining = openStart;
    let current = Fragment.from(frontMatter);
    let containerType: NodeType | null = null;
    while (remaining > 0 && current.childCount === 1) {
      const only = current.firstChild!;
      if (only.type === schema.nodes.yamlScalar) return null;
      containerType = only.type;
      current = only.content;
      remaining--;
    }
    const completeEntries = current.content.filter(isCompleteYAMLTree);
    if (!completeEntries.length) return null;
    const container: YAMLContainerKind = containerType === schema.nodes.yamlSequence ? 'sequence' : 'mapping';
    return yamlEntriesToCodeBlock(completeEntries, targetSchema, container);
  }
  if (isCompleteYAMLTree(frontMatter)) {
    const source = unparseYAMLBody(frontMatter);
    const content = source ? targetSchema.text(source) : null;
    return targetSchema.nodes.codeBlock.create({ language: 'yaml' }, content);
  }
  // A slice with `openStart === 0` and `openEnd > 0` ending mid-`yamlPair` leaves `yamlFrontMatter` closed on the left
  // yet incomplete on the right (`!isCompleteYAMLTree`); descend single-child wrappers to recover intact entries.
  let current: Node = frontMatter;
  while (current.childCount === 1) {
    const only = current.firstChild!;
    if (current.type === schema.nodes.yamlPair) {
      if (only.type === schema.nodes.yamlScalar) return null;
      if (only.type === schema.nodes.yamlSequence) {
        return yamlEntriesToCodeBlock(only.content.content, targetSchema, 'sequence');
      }
      if (only.type === schema.nodes.yamlMapping && isCompleteYAMLTree(only)) {
        return yamlEntriesToCodeBlock(only.content.content, targetSchema, 'mapping');
      }
    }
    current = only;
  }
  return null;
}

/** Whether `node` and its descendants satisfy their `NodeSpec` content constraints (no half-sliced `yamlPair`). */
function isCompleteYAMLTree(node: Node): boolean {
  if (!node.type.validContent(node.content)) return false;
  for (let index = 0; index < node.childCount; index++) {
    if (!isCompleteYAMLTree(node.child(index))) return false;
  }
  return true;
}
