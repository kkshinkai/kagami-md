/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { DelimitedSyntax } from '../syntax/inline.js';
import type { Token } from '../types/index.js';
import type { CompileContext, Extension } from './types.js';

/**
 * Create an extension to enable highlight, `==a==`, Kagami’s own.
 *
 * @returns
 *   Extension to enable highlight.
 */
export function highlightFromMarkdown(): Extension {
  return {
    canContainEOLs: ['highlight'],
    enter: { highlight: enterHighlight },
    exit: {
      highlight: exitHighlight,
      highlightSequence: exitHighlightSequence,
    },
  };
}

function enterHighlight(this: CompileContext, token: Token): undefined {
  this.enter(new DelimitedSyntax('highlight'), token);
}

function exitHighlightSequence(this: CompileContext, token: Token): undefined {
  this.config.exit.emphasisSequence!.call(this, token);
}

function exitHighlight(this: CompileContext, token: Token): undefined {
  this.exit(token);
}
