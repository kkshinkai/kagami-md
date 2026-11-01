/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Attrs, Node } from 'prosemirror-model';

/** The semantic attributes passed to structural operations, without a node's spelling. */
export function meaning(node: Node): Attrs {
  const types = node.type.schema.nodes;
  const attrs = node.attrs;
  switch (node.type) {
    case types.heading:
      return { level: attrs.level, form: attrs.form };
    case types.codeBlock:
      return { language: attrs.language, meta: attrs.meta };
    case types.orderedList:
      return { startNumber: attrs.startNumber };
    case types.listItem:
      return { checked: attrs.checked };
    case types.callout:
      return { calloutType: attrs.calloutType };
    case types.footnoteDefinition:
      return { identifier: attrs.identifier };
    case types.linkReferenceDefinition:
      return { identifier: attrs.identifier, destination: attrs.destination, title: attrs.title };
    case types.htmlBlock:
      return { startCondition: attrs.startCondition };
    case types.htmlTagBlock:
      return { tag: attrs.tag, destination: attrs.destination, title: attrs.title,
        alt: attrs.alt, width: attrs.width, height: attrs.height };
    case types.table:
      return { alignments: attrs.alignments };
    case types.yamlScalar:
      return { tag: attrs.tag, anchor: attrs.anchor };
    case types.yamlMapping:
    case types.yamlSequence:
      return { anchor: attrs.anchor };
    case types.yamlAlias:
      return { name: attrs.name };
    default:
      return {};
  }
}
