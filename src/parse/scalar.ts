/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { YAMLFrontMatterSyntax, YAMLScalarSyntax, Parser } from '../syntax/index.js';

const yamlParser = new Parser({ target: 'editor' });

/** The YAML reader's interpretation of an unquoted scalar field. */
type ScalarTag = 'string' | 'integer' | 'float' | 'boolean' | 'null';

/** Scalar inference belongs to the same YAML reader as file import. */
export function inferYAMLScalar(source: string): ScalarTag {
  if (source.includes('\n') || source.includes('\r')) return 'string';
  const document = yamlParser.parseFile(`---\nvalue: ${source}\n---`).document;
  if (!(document.frontMatter instanceof YAMLFrontMatterSyntax) || document.children.length > 0) return 'string';
  const frontMatterSpelling = document.frontMatter.spelling;
  if (frontMatterSpelling.commentBefore || frontMatterSpelling.trailingComment) return 'string';
  if (document.frontMatter.root.children.length !== 1) return 'string';
  const pair = document.frontMatter.root.children[0]!;
  if (pair.key.spelling.commentBefore || pair.key.spelling.trailingComment) return 'string';
  const value = pair.value;
  if (!(value instanceof YAMLScalarSyntax) || value.spelling.commentBefore || value.spelling.trailingComment) {
    return 'string';
  }
  if (value.tag !== 'string' && value.content !== source) return 'string';
  return value.tag;
}
