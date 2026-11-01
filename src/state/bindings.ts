/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ReferenceLabels, type Bindings } from '../syntax/index.js';
import type { Node } from 'prosemirror-model';
import { Plugin, PluginKey, Transaction, type EditorState, type EditorStateConfig } from 'prosemirror-state';
import type { Transform } from 'prosemirror-transform';
import { Decoration, DecorationSet } from 'prosemirror-view';
import { BindingSet, type BindingLabels } from '../parse/bindings.js';
import { readField } from '../parse/field.js';
import { changedRanges } from './changes.js';

const bindingsKey = new PluginKey<bindings.State>('bindings');

/** Keep definitions and the fields that consulted them in native mapped sets. */
export function bindings(): Plugin<bindings.State> {
  return new Plugin({
    key: bindingsKey,
    state: {
      init: (config, state) => bindings.State.create(state.doc, (config as bindings.Config).readings),
      apply: (tr, value) => value.apply(tr),
    },
  });
}

export namespace bindings {
  export interface Config extends EditorStateConfig {
    readonly readings?: ReadonlyMap<Node, ReferenceLabels>;
  }

  /** A reading's position is in the transaction after its recorded step. */
  interface FieldReading {
    position: number;
    end: number;
    step: number;
    references: ReferenceLabels;
    blockReading: boolean;
  }

  /** Record parser output even when its frontier did not need a document step. */
  export function record(tr: Transform, position: number, references: ReferenceLabels, blockReading = false): void {
    if (!(tr instanceof Transaction)) return;
    const readings: FieldReading[] = tr.getMeta(bindingsKey) ?? [];
    tr.setMeta(bindingsKey, [...readings, {
      position, end: position + tr.doc.nodeAt(position)!.nodeSize,
      step: tr.steps.length, references, blockReading,
    }]);
  }

  export function get(state: EditorState): State {
    const value = bindingsKey.getState(state);
    if (!value) throw new RangeError('The state has no bindings');
    return value;
  }

  /** Read changes to definitions from their changed ranges, before correction is dispatched. */
  export function after(before: State, tr: Transaction): State {
    return before.apply(tr);
  }

  /** Each label directly names the mapped fields that asked about it. */
  export class State extends BindingSet {
    constructor(
      readonly occurrences: DecorationSet,
      readonly definitionsByLabel: ReadonlyMap<string, DecorationSet>,
      readonly fields: DecorationSet,
      readonly dependents: ReadonlyMap<string, DecorationSet>,
      definitions: ReadonlyMap<string, Bindings.Definition>,
      footnotes: ReadonlySet<string>,
    ) { super(definitions, footnotes); }

    /** Initialization owns the whole document; subsequent updates own only changed ranges. */
    static create(doc: Node, readings?: ReadonlyMap<Node, ReferenceLabels>): State {
      const occurrences: Decoration[] = [];
      doc.descendants((node, position) => {
        const definition = definitionRange(node, position);
        if (definition) occurrences.push(definition);
        return !node.isTextblock;
      });
      const values = meaning(occurrences);
      const definitionsByLabel = new Map<string, DecorationSet>();
      for (const occurrence of occurrences) {
        const key = occurrence.spec.kind + ':' + occurrence.spec.identifier;
        definitionsByLabel.set(key, (definitionsByLabel.get(key) ?? DecorationSet.empty).add(doc, [occurrence]));
      }
      let state = new State(DecorationSet.create(doc, occurrences), definitionsByLabel, DecorationSet.empty, new Map(),
        values.definitions, values.footnotes);
      doc.descendants((node, position) => {
        if (!node.type.isInGroup('field')) return !node.isTextblock;
        // A native document without a file has no parser readings yet.
        const reading = readings ? null : readField(doc.resolve(position + 1), state);
        const references = reading?.references ?? readings?.get(node) ?? new ReferenceLabels();
        state = state.read(doc, position, position + node.nodeSize, references, reading?.kind === 'blocks');
        return false;
      });
      return state;
    }

    references(position: number): ReferenceLabels {
      return this.fields.find(position, position).find(field => field.from === position)?.spec.references ??
        new ReferenceLabels();
    }

    /** A native paragraph can arrive with source already read as blocks, without pending marks. */
    blockReading(position: number): boolean {
      return this.fields.find(position, position).some(field => field.from === position && field.spec.blockReading);
    }

    affected(labels: BindingLabels): Set<number> {
      const positions = new Set<number>();
      for (const kind of ['definitions', 'footnotes'] as const) {
        for (const label of labels[kind]) {
          for (const field of this.dependents.get(kind + ':' + label)?.find() ?? []) positions.add(field.from);
        }
      }
      return positions;
    }

    apply(tr: Transaction): State {
      if (!tr.docChanged && !tr.getMeta(bindingsKey)) return this;
      const changedDefinitions = new Map<string, { kind: string; identifier: string }>();
      const changedDefinition = (spec: { kind: string; identifier: string }) => {
        changedDefinitions.set(spec.kind + ':' + spec.identifier, spec);
      };
      let occurrences = this.occurrences.map(tr.mapping, tr.doc, { onRemove: changedDefinition });
      const definitionsByLabel = new Map<string, DecorationSet>();
      for (const [label, ranges] of this.definitionsByLabel) {
        const mapped = ranges.map(tr.mapping, tr.doc);
        if (mapped !== DecorationSet.empty) definitionsByLabel.set(label, mapped);
      }
      const retained = new Map<Node, { references: ReferenceLabels; blockReading: boolean }>();
      const carried: FieldReading[] = [];
      const changes = changedRanges(tr.steps, tr.mapping);
      for (const change of changes) {
        for (const field of this.fields.find(change.from, change.to))
          retained.set(field.spec.node, field.spec);
      }
      for (const change of changes) {
        const removed = occurrences.find(change.start, change.end).filter(value =>
          value.from < change.end && value.to > change.start);
        // Definition meanings and retained field readings come only from the changed ranges.
        const added: Decoration[] = [];
        tr.doc.nodesBetween(change.start, change.end, (node, position) => {
          const definition = definitionRange(node, position);
          if (definition) added.push(definition);
          const reading = retained.get(node);
          if (reading || node.isTextblock && !node.type.isInGroup('field')) carried.push({
            position, end: position + node.nodeSize, step: tr.steps.length,
            references: reading?.references ?? new ReferenceLabels(), blockReading: reading?.blockReading ?? false,
          });
          return !node.isTextblock;
        });
        for (const value of added) {
          removed.push(...occurrences.find(value.from, value.from).filter(old => old.from === value.from));
        }
        for (const value of removed) {
          changedDefinition(value.spec);
          const key = value.spec.kind + ':' + value.spec.identifier;
          const set = definitionsByLabel.get(key);
          if (!set) continue;
          const next = set.remove([value]);
          if (next === DecorationSet.empty) definitionsByLabel.delete(key);
          else definitionsByLabel.set(key, next);
        }
        for (const value of added) {
          changedDefinition(value.spec);
          const key = value.spec.kind + ':' + value.spec.identifier;
          definitionsByLabel.set(key, (definitionsByLabel.get(key) ?? DecorationSet.empty).add(tr.doc, [value]));
        }
        occurrences = occurrences.remove(removed).add(tr.doc, added);
      }
      let definitions = this.definitions;
      let footnotes = this.footnotes;
      for (const [key, { kind, identifier }] of changedDefinitions) {
        if (!identifier) continue;
        const first = definitionsByLabel.get(key)?.find().reduce<Decoration | undefined>((first, value) =>
          !first || value.from < first.from ? value : first, undefined);
        if (kind === 'footnote') {
          if (Boolean(first) === footnotes.has(identifier)) continue;
          const next = new Set(footnotes);
          if (first) next.add(identifier);
          else next.delete(identifier);
          footnotes = next;
        } else {
          const previous = definitions.get(identifier);
          if (first ? previous?.destination === first.spec.destination && previous?.title === first.spec.title
            : !previous)
            continue;
          const next = new Map(definitions);
          if (first) next.set(identifier, { destination: first.spec.destination, title: first.spec.title });
          else next.delete(identifier);
          definitions = next;
        }
      }
      const dependents = new Map<string, DecorationSet>();
      for (const [label, fields] of this.dependents) {
        const mapped = fields.map(tr.mapping, tr.doc);
        if (mapped !== DecorationSet.empty) dependents.set(label, mapped);
      }
      let state = new State(occurrences, definitionsByLabel, this.fields.map(tr.mapping, tr.doc), dependents,
        definitions, footnotes);
      const readings: readonly FieldReading[] = carried.concat(tr.getMeta(bindingsKey) ?? []);
      for (const reading of readings) {
        const mapping = tr.mapping.slice(reading.step);
        const start = mapping.mapResult(reading.position, 1);
        const end = mapping.mapResult(reading.end, -1);
        if (start.deletedAcross || end.deletedAcross || start.pos >= end.pos) continue;
        const node = tr.doc.nodeAt(start.pos);
        if (node?.isTextblock && start.pos + node.nodeSize === end.pos)
          state = state.read(tr.doc, start.pos, end.pos, reading.references, reading.blockReading);
      }
      return state;
    }

    private read(doc: Node, from: number, to: number, references: ReferenceLabels, blockReading = false): State {
      const previous = this.fields.find(from, to).filter(field => field.from === from);
      let fields = this.fields.remove(previous.slice());
      const dependents = new Map(this.dependents);
      for (const field of previous) {
        const labels: ReferenceLabels = field.spec.references;
        for (const kind of ['definitions', 'footnotes'] as const) for (const label of labels[kind]) {
          const key = kind + ':' + label;
          const set = dependents.get(key)!;
          const next = set.remove(set.find(from, to).filter(value => value.from === from));
          if (next === DecorationSet.empty) dependents.delete(key);
          else dependents.set(key, next);
        }
      }
      if (blockReading || references.definitions.size || references.footnotes.size) {
        const field = Decoration.node(from, to, {}, { references, blockReading, node: doc.nodeAt(from) });
        fields = fields.add(doc, [field]);
        for (const kind of ['definitions', 'footnotes'] as const) for (const label of references[kind]) {
          const key = kind + ':' + label;
          dependents.set(key, (dependents.get(key) ?? DecorationSet.empty).add(doc, [field]));
        }
      }
      return new State(this.occurrences, this.definitionsByLabel, fields, dependents, this.definitions, this.footnotes);
    }
  }
}

/** A definition's parsed meaning travels with its mapped node range. */
function definitionRange(node: Node, position: number): Decoration | null {
  const types = node.type.schema.nodes;
  if (node.type !== types.linkReferenceDefinition && node.type !== types.footnoteDefinition) return null;
  const { identifier, destination, title } = node.attrs;
  return Decoration.node(position, position + node.nodeSize, {}, {
    kind: node.type === types.linkReferenceDefinition ? 'definition' : 'footnote',
    identifier, destination, title,
  });
}

/** Compare only recorded definitions, never rediscover them in the document. */
function meaning(occurrences: Decoration[]): BindingSet {
  const definitions = new Map<string, Bindings.Definition>();
  const footnotes = new Set<string>();
  for (const { spec } of occurrences.sort((a, b) => a.from - b.from)) {
    if (!spec.identifier) continue;
    if (spec.kind === 'footnote') footnotes.add(spec.identifier);
    else if (!definitions.has(spec.identifier))
      definitions.set(spec.identifier, { destination: spec.destination, title: spec.title });
  }
  return new BindingSet(definitions, footnotes);
}
