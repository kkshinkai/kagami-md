/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  DelimiterTokenSyntax,
  ImageSizeSyntax,
  ImageSyntax,
  TriviaTokenSyntax,
  WikiEmbedSyntax,
} from '../syntax/inline.js';
import type { Token } from '../types/index.js';

import type { CompileContext, Extension } from './types.js';
import { assert } from '../kernel/assert.js';
import { constants } from '../kernel/utils/symbol/index.js';

/**
 * Create an extension to enable the size at the end of an image’s
 * description or an embed’s alias, `=20x10`, Kagami’s own.
 *
 * @returns
 *   Extension.
 */
export function imageSizeFromMarkdown(): Extension {
  return {
    enter: { imageSize: enterImageSize },
    exit: {
      imageSize: exitImageSize,
      imageSizeHeight: exitImageSizeHeight,
      imageSizeMarker: exitImageSizeMarker,
      imageSizeSeparator: exitImageSizeSeparator,
      imageSizeWidth: exitImageSizeWidth,
      imageSizeWhitespace: exitImageSizeWhitespace,
      imageSizeTrailingWhitespace: exitImageSizeWhitespace,
    },
  };
}

function exitImageSizeWhitespace(this: CompileContext, token: Token): undefined {
  const node = this.stack[this.stack.length - 2];
  assert(node instanceof ImageSyntax || node instanceof WikiEmbedSyntax, 'expected image or embed');
  const size = node.size;
  assert(size, 'expected size');
  const siblings =
    token.type === 'imageSizeWhitespace' ? size.separatorsBefore : size.separatorsAfter;
  siblings.push(new TriviaTokenSyntax('imageSizeWhitespace', token.start.offset, token.end.offset));
}

/**
 * The image or the embed whose size is being read: the nearest on the stack.
 */
function owner(context: CompileContext): ImageSyntax | WikiEmbedSyntax {
  let index = context.stack.length;

  while (index--) {
    const node = context.stack[index]!;

    if (node instanceof ImageSyntax || node instanceof WikiEmbedSyntax) return node;
  }

  assert(false, 'expected an image or an embed on stack');
}

function enterImageSize(this: CompileContext): undefined {
  const node = owner(this);
  node.size = new ImageSizeSyntax();
  node.width = null;
  node.height = null;
}

function exitImageSizeMarker(this: CompileContext, token: Token): undefined {
  const node = owner(this);
  assert(node.size, 'expected a size');
  node.size.equalsSign = new DelimiterTokenSyntax(
    'equalsSign',
    token.start.offset,
    token.end.offset
  );
}

function exitImageSizeSeparator(this: CompileContext, token: Token): undefined {
  const node = owner(this);
  assert(node.size, 'expected a size');
  node.size.separator = new DelimiterTokenSyntax(
    'imageSizeSeparator',
    token.start.offset,
    token.end.offset
  );
}

function exitImageSizeWidth(this: CompileContext, token: Token): undefined {
  const node = owner(this);
  assert(node.size, 'expected a size');
  node.size.width = new DelimiterTokenSyntax(
    'imageSizeWidth',
    token.start.offset,
    token.end.offset
  );
  node.width = Number.parseInt(this.sliceSerialize(token), constants.numericBaseDecimal);
}

function exitImageSizeHeight(this: CompileContext, token: Token): undefined {
  const node = owner(this);
  assert(node.size, 'expected a size');
  node.size.height = new DelimiterTokenSyntax(
    'imageSizeHeight',
    token.start.offset,
    token.end.offset
  );
  node.height = Number.parseInt(this.sliceSerialize(token), constants.numericBaseDecimal);
}

function exitImageSize(this: CompileContext): undefined {
  const node = owner(this);
  const size = node.size;
  assert(size, 'expected size');
  size.start = size.separatorsBefore[0]?.start ?? size.equalsSign.start;
  size.end =
    size.separatorsAfter[size.separatorsAfter.length - 1]?.end ??
    size.height?.end ??
    size.separator?.end ??
    size.width?.end ??
    size.equalsSign.end;
}
