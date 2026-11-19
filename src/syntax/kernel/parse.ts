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
  Bindings,
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
import {createTokenizer} from './create-tokenizer.js'

const blank: FullNormalizedExtension = {
  attentionMarkers: { null: [] },
  contentInitial: {},
  disable: { null: [] },
  document: {},
  flow: {},
  flowInitial: {},
  insideSpan: { null: [] },
  string: {},
  text: {}
}

const emptyBindings: Bindings = Object.freeze({
  definitions: new Map<string, Bindings.Definition>(),
  footnotes: new Set<string>()
})

/**
 * @param options
 *   Configuration (optional).
 * @returns
 *   Parser.
 */
export function parse(options?: ParseOptions | null | undefined): ParseContext {
  const settings = options || {}
  const constructs = settings.constructs ?? (combineExtensions([
    blank,
    ...(settings.extensions || [])
  ]) as FullNormalizedExtension)

  const parser: ParseContext = {
    constructs,
    cjkFriendly: settings.cjkFriendly ?? false,
    target: settings.target ?? 'standard',
    bindings: settings.bindings ?? emptyBindings,
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
