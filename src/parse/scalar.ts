/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { YAMLFrontMatterSyntax, YAMLScalarSyntax, parseFile } from '../syntax/index.js';

/** The YAML reader's interpretation of an unquoted scalar field. */
type ScalarTag = 'string' | 'integer' | 'float' | 'boolean' | 'null';

/** Scalar inference belongs to the same YAML reader as file import. */
export function inferYAMLScalar(source: string): ScalarTag {
  const document = parseFile(`---\nvalue: ${source}\n---`, { target: 'editor' }).document;
  if (!(document.frontMatter instanceof YAMLFrontMatterSyntax)) return 'string';
  const value = document.frontMatter.root.children[0]?.value;
  return value instanceof YAMLScalarSyntax ? value.tag : 'string';
}
