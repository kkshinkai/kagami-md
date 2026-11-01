/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-FileCopyrightText: Titus Wormer <tituswormer@gmail.com>
 * SPDX-License-Identifier: MPL-2.0 AND MIT
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Derived from micromark, https://github.com/micromark/micromark. */

import type {
  Create,
  FullNormalizedExtension,
  InitialConstruct,
  ParseContext,
  ParseOptions,
  Point,
  TokenizeContext
} from '../types/index.js';

import {combineExtensions} from './utils/combine-extensions/index.js'
import {content} from './initialize/content.js'
import {document} from './initialize/document.js'
import {flow} from './initialize/flow.js'
import {string, text} from './initialize/text.js'
import {commonmark as defaultConstructs} from '../constructs/commonmark.js'
import {createTokenizer} from './create-tokenizer.js'

/**
 * @param options
 *   Configuration (optional).
 * @returns
 *   Parser.
 */
export function parse(options?: ParseOptions | null | undefined): ParseContext {
  const settings = options || {}
  const constructs = combineExtensions([
    defaultConstructs,
    ...(settings.extensions || [])
  ]) as FullNormalizedExtension

  const parser: ParseContext = {
    constructs,
    references: [],
    content: create(content),
    defined: [],
    document: create(document),
    flow: create(flow),
    lazy: {},
    string: create(string),
    text: create(text)
  }

  return parser

  /**
   * @param initial
   *   Construct to start with.
   * @returns
   *   Create a tokenizer.
   */
  function create(initial: InitialConstruct): Create {
    return creator

    function creator(from?: Point.Source | undefined): TokenizeContext {
      return createTokenizer(parser, initial, from)
    }
  }
}
