/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Event, InitialConstruct } from '../types/index.js';
import { wholeDocument } from '../constructs/bundle.js';
import { createTokenizer } from '../kernel/create-tokenizer.js';
import { parse } from '../kernel/parse.js';
import { preprocess } from '../kernel/preprocess.js';

/** Run a reader query on its own text, with each line starting at a physical column. */
export function queryEvents(text: string, initial: InitialConstruct, column = 0): Array<Event> {
  const parser = parse();
  parser.constructs = wholeDocument;
  parser.cjkFriendly = true;
  parser.target = 'editor';
  const tokenizer = createTokenizer(parser, initial);
  return tokenizer.write(preprocess({ atDocumentStart: false, column })(text, undefined, true));
}
