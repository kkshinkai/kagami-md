/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { NodeType } from 'prosemirror-model';
import { schema } from '../types/schema.js';

/** The three owners of a recorded spelling field. */
type Ownership = 'front' | 'back' | 'ordinary';
type Field = { readonly kind: Ownership } | { readonly kind: 'nested'; readonly fields: Fields };
interface Fields {
  readonly [name: string]: Field;
}
interface Spelling {
  [name: string]: unknown;
}
const front: Field = { kind: 'front' };
const back: Field = { kind: 'back' };
const ordinary: Field = { kind: 'ordinary' };
const block = { leadingBlankLines: front, trailingBlankLines: back, spacesBeforeBlock: front } as const;
const container = { ...block, start: front, end: back } as const;
const fence = {
  fence: front, whitespaceAfterFence: front, closingFence: back, spacesBeforeClosingFence: back
} as const;
const yaml = { commentBefore: front, trailingComment: back, blankLineBefore: front, explicitTag: front } as const;

const plain = { leadingBlankLines: 0, trailingBlankLines: 1, spacesBeforeBlock: 0 };
const empty = { ...plain, start: 0, end: 0 };
const comments = { commentBefore: null, trailingComment: null, blankLineBefore: false, explicitTag: null };
/** One node type's ownership of spelling fields and its unwritten defaults. */
interface SpellingRule {
  readonly fields: Fields;
  readonly defaults: Spelling;
}

/** Every recorded field, including both ends of a nested fence, has an owner. */
const spellings = new Map<NodeType, SpellingRule>([
  [schema.nodes.document, { fields: { start: front, end: back }, defaults: { start: 0, end: 0 } }],
  [schema.nodes.yamlFrontMatter, {
    fields: {
      leadingBlankLines: front, trailingBlankLines: back, fence: front, indent: ordinary,
      commentBefore: front, trailingComment: back
    },
    defaults: {
      leadingBlankLines: 0, trailingBlankLines: 0, fence: '---', indent: null, commentBefore: null,
      trailingComment: null
    },
  }],
  [schema.nodes.rawFrontMatter, {
    fields: { leadingBlankLines: front, trailingBlankLines: back, fence: front },
    defaults: { leadingBlankLines: 0, trailingBlankLines: 0, fence: '---' },
  }],
  [schema.nodes.yamlMapping, { fields: { ...yaml, flow: ordinary }, defaults: { ...comments, flow: false } }],
  [schema.nodes.yamlSequence, { fields: { ...yaml, flow: ordinary }, defaults: { ...comments, flow: false } }],
  [schema.nodes.yamlScalar, { fields: { ...yaml, style: ordinary }, defaults: { ...comments, style: 'plain' } }],
  [schema.nodes.yamlPair, { fields: { whitespaceAfterColon: ordinary }, defaults: { whitespaceAfterColon: ' ' } }],
  [schema.nodes.paragraph, { fields: block, defaults: plain }],
  [schema.nodes.heading, {
    fields: { ...block, whitespaceAfterMarker: front, closingSequence: back, underline: back },
    defaults: { ...plain, whitespaceAfterMarker: null, closingSequence: null, underline: null },
  }],
  [schema.nodes.codeBlock, {
    fields: { ...block, fence: { kind: 'nested', fields: fence } },
    defaults: {
      ...plain,
      fence: { fence: '```', whitespaceAfterFence: '', closingFence: '```', spacesBeforeClosingFence: 0 }
    },
  }],
  [schema.nodes.mathBlock, {
    fields: { ...block, ...fence, meta: front },
    defaults: {
      ...plain, fence: '$$', whitespaceAfterFence: '', closingFence: '$$', spacesBeforeClosingFence: 0,
      meta: null
    },
  }],
  [schema.nodes.htmlBlock, { fields: block, defaults: plain }],
  [schema.nodes.htmlTagBlock, { fields: block, defaults: plain }],
  [schema.nodes.thematicBreak, { fields: block, defaults: plain }],
  [schema.nodes.blockQuote,
    { fields: { ...container, whitespaceAfterMarker: front }, defaults: { ...empty, whitespaceAfterMarker: ' ' } }],
  [schema.nodes.callout, {
    fields: { ...container, whitespaceAfterMarker: ordinary, declaration: front, whitespaceAfterDeclaration: front },
    defaults: { ...empty, whitespaceAfterMarker: ' ', declaration: '[!NOTE]', whitespaceAfterDeclaration: '' },
  }],
  [schema.nodes.bulletList,
    {
      fields: { ...container, pattern: front, tight: ordinary },
      defaults: { ...empty, pattern: 'dash', tight: true }
    }],
  [schema.nodes.orderedList, {
    fields: { ...container, pattern: front, tight: ordinary, numbering: ordinary },
    defaults: { ...empty, pattern: 'decimalDot', tight: true, numbering: 'sequential' },
  }],
  [schema.nodes.listItem, {
    fields: {
      ...container, marker: front, whitespaceAfterMarker: front, startsOnMarkerLine: front,
      continuationIndent: ordinary
    },
    defaults: {
      ...empty, trailingBlankLines: 0, marker: '-', whitespaceAfterMarker: ' ', startsOnMarkerLine: true,
      continuationIndent: null
    },
  }],
  [schema.nodes.footnoteDefinition, {
    fields: { ...container, whitespaceAfterLabel: front, startsOnLabelLine: front, continuationIndent: ordinary },
    defaults: { ...empty, whitespaceAfterLabel: ' ', startsOnLabelLine: true, continuationIndent: null },
  }],
  [schema.nodes.linkReferenceDefinition, {
    fields: { ...block, whitespaceAfterLabel: front, whitespaceBeforeTitle: ordinary },
    defaults: { ...plain, whitespaceAfterLabel: ' ', whitespaceBeforeTitle: ' ' },
  }],
  [schema.nodes.linkDestination, { fields: { inAngleBrackets: front }, defaults: { inAngleBrackets: false } }],
  [schema.nodes.linkTitle, { fields: { delimiter: front }, defaults: { delimiter: '"' } }],
  [schema.nodes.table, {
    fields: { ...block, cellPadding: ordinary, enclosedInPipes: ordinary },
    defaults: { ...plain, cellPadding: 'oneSpace', enclosedInPipes: true },
  }],
]);

/** Select whole classes from either spelling. Null means the unparser's default. */
export function combine(type: NodeType, first: unknown, second: unknown, fromFirst: readonly Ownership[]): unknown {
  const rule = spellings.get(type);
  return !rule || first == null && second == null ? null
    : new SpellingContext(fromFirst).select(rule.fields, first, second, rule.defaults);
}

/** Joining keeps the first block's front and the last block's back. */
export function joined(type: NodeType, first: unknown, second: unknown): unknown {
  if (first == null) return second;
  if (second == null) return first;
  return combine(type, first, second, ['front', 'ordinary']);
}

/** B3e item 1: a reshape keeps the old spelling of framing both kinds have. */
export function reshaped(type: NodeType, before: NodeType, previous: unknown, reading: unknown): unknown {
  const group = framing(type);
  if (type === before || !group || group !== framing(before)) return reading;
  const saved = record(previous);
  const next = { ...record(reading) };
  const oldFields = spellings.get(before)!.fields;
  for (const key in spellings.get(type)!.fields) {
    if (key in oldFields && saved && key in saved) next[key] = saved[key];
  }
  return next;
}

function framing(type: NodeType): 'quote' | 'definition' | null {
  const { blockQuote, callout, footnoteDefinition, linkReferenceDefinition } = type.schema.nodes;
  switch (type) {
    case blockQuote:
    case callout: return 'quote';
    case footnoteDefinition:
    case linkReferenceDefinition: return 'definition';
    default: return null;
  }
}

function record(value: unknown): Spelling | null {
  return value && typeof value === 'object' ? value as Spelling : null;
}

/** One operation's choices, shared by the walk through nested spelling fields. */
class SpellingContext {
  constructor(readonly fromFirst: readonly Ownership[]) {}

  select(fields: Fields, first: unknown, second: unknown, fallback: unknown): Spelling {
    const left = record(first);
    const right = record(second);
    const defaults = record(fallback);
    const result: Spelling = {};
    for (const name in fields) {
      const owner = fields[name]!;
      // Unrecorded spacing uses the destination's default, including tight lists.
      const ordinary = name === 'leadingBlankLines' || name === 'trailingBlankLines' ? undefined : defaults?.[name];
      const a = left && name in left ? left[name] : ordinary;
      const b = right && name in right ? right[name] : ordinary;
      let value: unknown;
      switch (owner.kind) {
        case 'front':
        case 'back':
        case 'ordinary':
          value = this.fromFirst.includes(owner.kind) ? a : b;
          break;
        case 'nested': {
          const selected = this.fromFirst.includes('front') ? a : b;
          value = selected === null ? null : this.select(owner.fields, a, b, defaults?.[name]);
          break;
        }
        default: owner satisfies never;
      }
      if (value !== undefined) result[name] = value;
    }
    return result;
  }
}
