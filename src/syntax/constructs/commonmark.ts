/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-FileCopyrightText: Titus Wormer <tituswormer@gmail.com>
 * SPDX-License-Identifier: MPL-2.0 AND MIT
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Derived from micromark, https://github.com/micromark/micromark. */

import { combineExtensions } from '../kernel/utils/combine-extensions/index.js';

import { resolver } from '../kernel/initialize/text.js';

import * as disable from './shared/disable.js';
import * as list from './document/list.js';
import * as blockQuote from './document/block-quote.js';
import * as definition from './content-initial/definition.js';
import * as codeIndented from './flow-initial/code-indented.js';
import * as headingATX from './flow/heading-atx.js';
import * as thematicBreak from './flow/thematic-break.js';
import * as setextUnderline from './flow/setext-underline.js';
import * as htmlFlow from './flow/html-flow.js';
import * as codeFenced from './flow/code-fenced.js';
import * as characterReference from './shared/character-reference.js';
import * as characterEscape from './shared/character-escape.js';
import * as lineEnding from './text/line-ending.js';
import * as labelStartImage from './text/label-start-image.js';
import * as htmlText from './text/html-text.js';
import * as autolink from './text/autolink.js';
import * as labelStartLink from './text/label-start-link.js';
import * as labelEnd from './text/label-end.js';
import * as hardBreakEscape from './text/hard-break-escape.js';
import * as attention from './text/attention.js';
import * as codeText from './text/code-text.js';

export const commonmark = combineExtensions([
  disable,
  list,
  blockQuote,
  definition,
  codeIndented,
  headingATX,
  thematicBreak,
  setextUnderline,
  htmlFlow,
  codeFenced,
  characterReference,
  characterEscape,
  lineEnding,
  labelStartImage,
  htmlText,
  autolink,
  labelStartLink,
  labelEnd,
  hardBreakEscape,
  attention,
  codeText,
  { insideSpan: { null: [resolver] } },
]);
