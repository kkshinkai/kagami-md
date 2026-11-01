/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-FileCopyrightText: Titus Wormer <tituswormer@gmail.com>
 * SPDX-License-Identifier: MPL-2.0 AND MIT
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Derived from mdast-util-to-string, https://github.com/syntax-tree/mdast-util-to-string. */

import { Syntax } from '../syntax/syntax.js';
import {
  AutolinkSyntax,
  BackslashEscapeSyntax,
  CharacterReferenceSyntax,
  CodeSpanSyntax,
  DelimitedSyntax,
  EmojiShortcodeSyntax,
  FootnoteReferenceSyntax,
  HardLineBreakSyntax,
  HTMLCommentSyntax,
  HTMLImageSyntax,
  HTMLLineBreakSyntax,
  ImageSyntax,
  InlineMathSyntax,
  LinkSyntax,
  LiteralAutolinkSyntax,
  PendingHTMLBlockSyntax,
  RawHTMLSyntax,
  SoftLineBreakSyntax,
  TagSyntax,
  TextTokenSyntax,
  TriviaTokenSyntax,
  WikiEmbedSyntax,
  WikilinkSyntax,
} from '../syntax/inline.js';
import { Fragment } from './types.js';

/** Read the semantic text of completed inline children in a compiler buffer. */
export function toString(value: Syntax | Fragment | ReadonlyArray<Syntax>, source: string): string {
  if (!(value instanceof Syntax) && !(value instanceof Fragment)) {
    return value.map((child) => toString(child, source)).join('');
  }
  if (value instanceof Fragment) return toString(value.children, source);
  if (value instanceof TextTokenSyntax || value instanceof TriviaTokenSyntax) {
    if (value.type === 'lineEnding') return '\n';
    if (value.type === 'text' || value.type === 'autolinkAddress') {
      // Kagami: source-backed text has the replacement characters of micromark's
      // preprocessed chunks when read as a semantic string.
      return source.slice(value.start, value.end).replace(/\0/g, '\ufffd');
    }
    return '';
  }
  // Kagami: an autolink's content is its address, without the delimiters or an
  // email destination's `mailto:` prefix.
  if (value instanceof AutolinkSyntax) return toString(value.address, source);
  if (value instanceof LiteralAutolinkSyntax || value instanceof TagSyntax) {
    return source.slice(value.start, value.end);
  }
  if (value instanceof SoftLineBreakSyntax || value instanceof HardLineBreakSyntax) return '\n';
  if (value instanceof FootnoteReferenceSyntax) return '';
  if (value instanceof BackslashEscapeSyntax)
    return source.slice(value.character.start, value.character.end);
  if (value instanceof CharacterReferenceSyntax) return value.character;
  if (value instanceof CodeSpanSyntax) return value.code;
  if (value instanceof InlineMathSyntax) return value.math;
  if (value instanceof EmojiShortcodeSyntax) return value.emoji;
  if (value instanceof WikilinkSyntax || value instanceof WikiEmbedSyntax) {
    return value.displayText ?? value.destination;
  }
  if (value instanceof ImageSyntax && value.alt) return value.alt;
  if (
    value instanceof LinkSyntax ||
    value instanceof ImageSyntax ||
    value instanceof DelimitedSyntax ||
    value instanceof RawHTMLSyntax ||
    value instanceof HTMLCommentSyntax ||
    value instanceof HTMLImageSyntax ||
    value instanceof HTMLLineBreakSyntax ||
    value instanceof PendingHTMLBlockSyntax
  ) {
    return toString(value.children, source);
  }
  return '';
}
