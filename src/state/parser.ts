/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Plugin, PluginKey, type EditorState } from 'prosemirror-state';
import { Parser } from '../syntax/index.js';

const parserKey = new PluginKey('parser');
export const defaultParser = new Parser({ target: 'editor' });

/** Attach the document's compiled Markdown parser to the state configuration. */
export function parserPlugin(instance: Parser = defaultParser): Plugin {
  return new Plugin({
    key: parserKey,
    parser: instance,
  });
}

export function getParser(state: EditorState): Parser {
  const plugin = parserKey.get(state);
  if (!plugin) throw new RangeError('The state has no parser');
  return plugin.spec.parser;
}
