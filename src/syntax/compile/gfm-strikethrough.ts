/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-FileCopyrightText: Titus Wormer <tituswormer@gmail.com>
 * SPDX-License-Identifier: MPL-2.0 AND MIT
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Derived from mdast-util-gfm-strikethrough, https://github.com/syntax-tree/mdast-util-gfm-strikethrough. */

import { DelimitedSyntax } from '../syntax/inline.js';
import type { Token } from '../types/index.js';
import type { CompileContext, Extension } from './types.js';

/**
 * Create an extension to enable GFM strikethrough.
 *
 * @returns
 *   Extension to enable GFM strikethrough.
 */
export function gfmStrikethroughFromMarkdown(): Extension {
  return {
    canContainEOLs: ['strikethrough'],
    enter: { strikethrough: enterStrikethrough },
    exit: {
      strikethrough: exitStrikethrough,
      strikethroughSequence: exitStrikethroughSequence,
    },
  };
}

function enterStrikethrough(this: CompileContext, token: Token): undefined {
  this.enter(new DelimitedSyntax('strikethrough'), token);
}

function exitStrikethroughSequence(this: CompileContext, token: Token): undefined {
  this.config.exit.emphasisSequence!.call(this, token);
}

function exitStrikethrough(this: CompileContext, token: Token): undefined {
  this.exit(token);
}
