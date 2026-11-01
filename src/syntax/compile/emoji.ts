/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { DelimiterTokenSyntax, EmojiShortcodeSyntax } from '../syntax/inline.js';
import type { Token } from '../types/index.js';
import type { CompileContext, Extension } from './types.js';
import { assert } from '../kernel/assert.js';
import { emojiForName } from '../constructs/text/emoji.js';

/**
 * Create an extension to enable emoji shortcodes, `:smile:`, Kagami’s own.
 *
 * @returns
 *   Extension.
 */
export function emojiFromMarkdown(): Extension {
  return {
    enter: { emojiShortcode: enterEmojiShortcode },
    exit: {
      emojiShortcode: exitEmojiShortcode,
      emojiShortcodeMarker: exitEmojiShortcodeMarker,
      emojiShortcodeName: exitEmojiShortcodeName,
    },
  };
}

function enterEmojiShortcode(this: CompileContext, token: Token): undefined {
  this.enter(new EmojiShortcodeSyntax(), token);
}

function exitEmojiShortcodeMarker(this: CompileContext, token: Token): undefined {
  const node = this.stack[this.stack.length - 1];
  assert(node && node instanceof EmojiShortcodeSyntax);

  if (token.start.offset === node.start) {
    node.openingColon = new DelimiterTokenSyntax(
      'openingColon',
      token.start.offset,
      token.end.offset
    );
  } else {
    node.closingColon = new DelimiterTokenSyntax(
      'closingColon',
      token.start.offset,
      token.end.offset
    );
  }
}

function exitEmojiShortcodeName(this: CompileContext, token: Token): undefined {
  const node = this.stack[this.stack.length - 1];
  assert(node && node instanceof EmojiShortcodeSyntax);
  const emoji = emojiForName(this.sliceSerialize(token));
  assert(emoji, 'expected a name the construct accepted');
  node.name = new DelimiterTokenSyntax('emojiName', token.start.offset, token.end.offset);
  node.emoji = emoji;
}

function exitEmojiShortcode(this: CompileContext, token: Token): undefined {
  this.exit(token);
}
