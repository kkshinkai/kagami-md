/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

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

  /** The labels whose first definition or footnote membership changed. */
  changed(after: BindingSet): BindingLabels {
    const labels = new BindingLabels();
    if (this === after) return labels;
    if (this.definitions !== after.definitions) {
      for (const [label, value] of this.definitions) {
        const next = after.definitions.get(label);
        if (!next || next.destination !== value.destination || next.title !== value.title) labels.definitions.add(label);
      }
      for (const label of after.definitions.keys()) if (!this.definitions.has(label)) labels.definitions.add(label);
    }
    if (this.footnotes !== after.footnotes) {
      for (const label of this.footnotes) if (!after.footnotes.has(label)) labels.footnotes.add(label);
      for (const label of after.footnotes) if (!this.footnotes.has(label)) labels.footnotes.add(label);
    }
    return labels;
  }

  /** Block compilation resolves the first local definition before consulting these bindings. */
  withBlocks(nodes: readonly BlockSyntax[]): BindingSet {
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
    if (!definitions.size && !footnotes.size) return this;
    return new BindingSet(
      new Map([...this.definitions, ...definitions]),
      new Set([...this.footnotes, ...footnotes]),
    );
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
