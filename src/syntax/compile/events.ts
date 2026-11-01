/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-FileCopyrightText: Titus Wormer <tituswormer@gmail.com>
 * SPDX-License-Identifier: MPL-2.0 AND MIT
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Derived from mdast-util-from-markdown, https://github.com/syntax-tree/mdast-util-from-markdown. */

import type { Event, Point } from '../types/index.js';
import type { Options } from './types.js';
import { wholeDocument } from '../constructs/bundle.js';
import { parse } from '../kernel/parse.js';
import { postprocess } from '../kernel/postprocess.js';
import { preprocess } from '../kernel/preprocess.js';
import { subtokenize } from '../kernel/utils/subtokenize/index.js';

/** Read all events, including inline content, for a complete reading. */
export function parseEvents(
  value: string,
  options?: Options | null,
  from?: Point.Source
): Array<Event> {
  return postprocess(tokenize(value, options, from));
}

/** Read the block structure while leaving text chunks for the chosen phrasing branch. */
export function blockEvents(value: string, options: Options): Array<Event> {
  const events = tokenize(value, options);
  while (!subtokenize(events, true)) {
    // Resolve structure and string content; leave inline text to its consumer.
  }
  return events;
}

/** One tokenizer owns the source and all nested event contexts. */
function tokenize(
  value: string,
  options?: Options | null,
  from?: Point.Source
): Array<Event> {
  const settings = options || {};
  const parser = parse(options);
  parser.constructs = settings.grammar || wholeDocument;
  parser.cjkFriendly = true;
  parser.target = settings.target;

  // External bindings are consulted at the reference that needs them.
  parser.bindings = settings.bindings || undefined;
  const tokenizer = parser[settings.contentType || 'document'](from);
  if (settings.tableCell) tokenizer._gfmTableCell = true;
  return tokenizer.write(preprocess({ atDocumentStart: false })(value, undefined, true));
}
