/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-FileCopyrightText: Titus Wormer <tituswormer@gmail.com>
 * SPDX-License-Identifier: MPL-2.0 AND MIT
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Derived from mdast-util-from-markdown, https://github.com/syntax-tree/mdast-util-from-markdown. */

import { DocumentSyntax } from '../syntax/block.js';
import { Fragment, type Compiler, type Options } from './types.js';
import { parseEvents } from './events.js';
import { createCompiler } from './tree.js';

export { parseEvents } from './events.js';
export { point } from './tree.js';

/**
 * Turn markdown into a syntax tree.
 *
 * Kagami: a file is read whole, with the grammar of a whole document,
 * CJK-friendly; the text of a field is read with the grammar of its field, as
 * text or string content.
 *
 * @param value
 *   Markdown to parse.
 * @param options
 *   Configuration.
 * @returns
 *   Syntax tree.
 */
export function fromMarkdown(value: string, options: Options.Inline): Fragment;
export function fromMarkdown(value: string, options?: Options.Document): DocumentSyntax;
export function fromMarkdown(value: string, options: Options): DocumentSyntax | Fragment;
export function fromMarkdown(value: string, options?: Options | null): DocumentSyntax | Fragment {
  return compiler(options ?? {})(parseEvents(value, options), value);
}

/** Compile a complete event reading. Phrasing-local stages remain internal. */
export function compiler(options: Options.Inline): Compiler<Fragment>;
export function compiler(options?: Options.Document): Compiler<DocumentSyntax>;
export function compiler(options: Options): Compiler;
export function compiler(options?: Options | null): Compiler {
  return createCompiler(options ?? {});
}
