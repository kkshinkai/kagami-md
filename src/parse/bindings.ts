/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Node } from 'prosemirror-model';
import {
  BlockSyntax, ContainerBlockSyntax, FootnoteDefinitionSyntax, LinkReferenceDefinitionSyntax,
  type Bindings, type ReferenceLabels,
} from '../syntax/index.js';

/** A document's bindings, enumerable when comparing completed readings. */
export class BindingSet implements Bindings {
  constructor(
    readonly definitions: ReadonlyMap<string, Bindings.Definition> = new Map(),
    readonly footnotes: ReadonlySet<string> = new Set(),
  ) {}

  definition(label: string): Bindings.Definition | undefined {
    return this.definitions.get(label);
  }

  footnote(label: string): boolean {
    return this.footnotes.has(label);
  }
}

/** Definitions already hold their parsed meaning; collecting bindings never reads phrasing. */
export function readBindings(doc: Node): BindingSet {
  const definitions = new Map<string, Bindings.Definition>();
  const footnotes = new Set<string>();
  const types = doc.type.schema.nodes;
  doc.descendants(node => {
    if (node.type === types.linkReferenceDefinition) {
      const { identifier, destination, title } = node.attrs;
      if (identifier && !definitions.has(identifier)) definitions.set(identifier, { destination, title });
      return false;
    }
    if (node.type === types.footnoteDefinition && node.attrs.identifier) footnotes.add(node.attrs.identifier);
    return !node.isTextblock;
  });
  return new BindingSet(definitions, footnotes);
}

export namespace readBindings {
  /** Block compilation resolves the first local definition before consulting external bindings. */
  export function blocks(nodes: readonly BlockSyntax[], external: BindingSet): BindingSet {
    const definitions = new Map<string, Bindings.Definition>();
    const footnotes = new Set<string>();
    for (const block of nodes) {
      block.iterate({ enter(node) {
        if (node instanceof LinkReferenceDefinitionSyntax) {
          if (!definitions.has(node.identifier)) definitions.set(node.identifier, {
            destination: node.destination, title: node.title,
          });
          return false;
        }
        if (node instanceof FootnoteDefinitionSyntax) footnotes.add(node.identifier);
        return node instanceof ContainerBlockSyntax;
      } });
    }
    if (!definitions.size && !footnotes.size) return external;
    return new BindingSet(
      new Map([...external.definitions, ...definitions]),
      new Set([...external.footnotes, ...footnotes]),
    );
  }

  /** The labels whose first definition or footnote membership changed. */
  export function changed(before: BindingSet, after: BindingSet): BindingLabels {
    const labels = new BindingLabels();
    if (before === after) return labels;
    if (before.definitions !== after.definitions) {
      for (const [label, value] of before.definitions) {
        const next = after.definitions.get(label);
        if (!next || next.destination !== value.destination || next.title !== value.title) labels.definitions.add(label);
      }
      for (const label of after.definitions.keys()) if (!before.definitions.has(label)) labels.definitions.add(label);
    }
    if (before.footnotes !== after.footnotes) {
      for (const label of before.footnotes) if (!after.footnotes.has(label)) labels.footnotes.add(label);
      for (const label of after.footnotes) if (!before.footnotes.has(label)) labels.footnotes.add(label);
    }
    return labels;
  }
}

/** Definition and footnote labels occupy independent namespaces. */
export class BindingLabels {
  readonly definitions = new Set<string>();
  readonly footnotes = new Set<string>();

  get size(): number {
    return this.definitions.size + this.footnotes.size;
  }

  intersects(other: ReferenceLabels): boolean {
    for (const label of this.definitions) if (other.definitions.has(label)) return true;
    for (const label of this.footnotes) if (other.footnotes.has(label)) return true;
    return false;
  }
}
