/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-FileCopyrightText: Titus Wormer <tituswormer@gmail.com>
 * SPDX-License-Identifier: MPL-2.0 AND MIT
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Derived from micromark-extension-frontmatter, https://github.com/micromark/micromark-extension-frontmatter. */

/**
 * Front matter, `---` or `+++` over lines and a closing fence of the same
 * marker, at the very start of a document. Written on the model of
 * `micromark-extension-frontmatter` 2.0.0, which makes one construct for each
 * kind of matter: Kagami has two markers, keeps a fence’s trailing whitespace
 * in its token, and calls its lines `frontmatterData`. What is between the
 * fences is not read here.
 *
 * Line endings stay events of their own, as they do in fenced code: one
 * opaque token over them would break the linked chunks of the document.
 */
import type {
  Code,
  Construct,
  ConstructRecord,
  Effects,
  Event,
  InitialConstruct,
  State,
  TokenizeContext,
} from '../../types/index.js';
import { assert } from '../../kernel/assert.js';
import { markdownLineEnding, markdownSpace } from '../../kernel/utils/character/index.js';
import { codes, types } from '../../kernel/utils/symbol/index.js';
import { createTokenizer } from '../../kernel/create-tokenizer.js';
import { parse } from '../../kernel/parse.js';
import { preprocess } from '../../kernel/preprocess.js';

/**
 * Where front matter is found in a text, and with which marker.
 */
export type FrontmatterMatch = Readonly<{ from: number; to: number; marker: '---' | '+++' }>;

/**
 * A fence of each marker.
 */
const fences: ConstructRecord = {
  [codes.dash]: createFence(codes.dash),
  [codes.plusSign]: createFence(codes.plusSign),
};

// Kagami: one recognizer serves the check, the confirmed flow and standalone use.
const constructs: ConstructRecord = {
  [codes.dash]: createConstruct(codes.dash),
  [codes.plusSign]: createConstruct(codes.plusSign),
};

// Kagami: a confirmed preamble follows the original flow path, preserving its
// events and chunk coordinates. Only the document's check may enable it.
export const flow = {
  [codes.dash]: { concrete: true, name: 'frontmatter', tokenize: tokenizeConfirmed },
  [codes.plusSign]: { concrete: true, name: 'frontmatter', tokenize: tokenizeConfirmed },
} satisfies ConstructRecord;

// Kagami: check for a closing fence before the document skips containers.
// `flow` identifies the construct confirmed here; this check opens no container.
export const document: ConstructRecord = {
  [codes.dash]: { name: 'frontmatter', tokenize: tokenizeCheck, flow: flow[codes.dash] },
  [codes.plusSign]: { name: 'frontmatter', tokenize: tokenizeCheck, flow: flow[codes.plusSign] },
};

/**
 * Kagami: look ahead with the same recognizer, taking every event back.
 *
 * ```markdown
 * > | ---
 *     ^
 *   | > a
 *   | ---
 * ```
 */
function tokenizeCheck(effects: Effects, ok: State, nok: State): State {
  return effects.check(constructs, ok, nok);
}

/**
 * Kagami: read front matter only after its document-level check succeeded.
 * The document is still at the opening fence: only the check crossed lines.
 *
 * ```markdown
 * > | ---
 *     ^
 *   | > a
 *   | ---
 * ```
 */
function tokenizeConfirmed(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
  // Kagami: confirmation belongs to this flow construct, not to its name.
  return this._checkedConstruct === this.currentConstruct ? effects.attempt(constructs, ok, nok) : nok;
}

/**
 * Recognize the front matter at the start of `source`, without reading what
 * is between its fences. Positions include a byte order mark.
 *
 * @param source
 *   Text.
 * @returns
 *   Match, or nothing when there is no front matter, a closing fence missing.
 */
export function parseFrontmatter(source: string): FrontmatterMatch | null {
  // Kagami: standalone recognition has no parent container decisions to protect.
  return readConstruct(source, constructs, 'frontmatter');
}

/**
 * Recognize an opening fence that is the whole of `source`.
 *
 * @param source
 *   Text.
 * @returns
 *   Match, or nothing.
 */
export function parseFrontmatterOpening(source: string): FrontmatterMatch | null {
  const match = readConstruct(source, fences, 'frontmatterFence');
  return match && match.to === source.length ? match : null;
}

/**
 * Create front matter of one marker.
 *
 * @param marker
 *   `-` or `+`.
 * @returns
 *   Construct.
 */
function createConstruct(marker: Code): Construct {
  const fence = createFence(marker);

  return { concrete: true, name: 'frontmatter', tokenize: tokenizeFrontmatter };

  function tokenizeFrontmatter(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
    const self = this;

    return start;

    /**
     * Start of front matter.
     *
     * ```markdown
     * > | ---
     *     ^
     *   | title: "Venus"
     *   | ---
     * ```
     */
    function start(code: Code): State | undefined {
      // Only at the very start of the document.
      if (self.now().offset !== 0) {
        return nok(code);
      }

      effects.enter('frontmatter');
      return effects.attempt(fence, openAfter, nok)(code);
    }

    /**
     * After the opening fence.
     *
     * ```markdown
     * > | ---
     *        ^
     *   | title: "Venus"
     *   | ---
     * ```
     */
    function openAfter(code: Code): State | undefined {
      // EOF is not okay.
      if (code === codes.eof) {
        return nok(code);
      }

      return contentEnd(code);
    }

    /**
     * Start of a line: a closing fence, or a content chunk.
     *
     * ```markdown
     *   | ---
     * > | title: "Venus"
     *     ^
     * > | ---
     *     ^
     * ```
     */
    function lineStart(code: Code): State | undefined {
      return effects.attempt(fence, after, contentStart)(code);
    }

    /**
     * Start of a content chunk.
     *
     * ```markdown
     *   | ---
     * > | title: "Venus"
     *     ^
     *   | ---
     * ```
     */
    function contentStart(code: Code): State | undefined {
      if (code === codes.eof || markdownLineEnding(code)) {
        return contentEnd(code);
      }

      effects.enter('frontmatterData');
      return contentInside(code);
    }

    /**
     * In a content chunk.
     *
     * ```markdown
     *   | ---
     * > | title: "Venus"
     *     ^
     *   | ---
     * ```
     */
    function contentInside(code: Code): State | undefined {
      if (code === codes.eof || markdownLineEnding(code)) {
        effects.exit('frontmatterData');
        return contentEnd(code);
      }

      effects.consume(code);
      return contentInside;
    }

    /**
     * End of a line.
     *
     * ```markdown
     *   | ---
     * > | title: "Venus"
     *                   ^
     *   | ---
     * ```
     */
    function contentEnd(code: Code): State | undefined {
      // Require a closing fence.
      if (code === codes.eof) {
        return nok(code);
      }

      // Can only be an eol.
      assert(markdownLineEnding(code), 'expected eol');
      effects.enter(types.lineEnding);
      effects.consume(code);
      effects.exit(types.lineEnding);
      return lineStart;
    }

    /**
     * After front matter.
     *
     * ```markdown
     *   | ---
     *   | title: "Venus"
     * > | ---
     *        ^
     * ```
     */
    function after(code: Code): State | undefined {
      // `code` must be eol/eof.
      effects.exit('frontmatter');
      return ok(code);
    }
  }
}

/**
 * Create a fence of one marker: three of it, and whitespace.
 *
 * @param marker
 *   `-` or `+`.
 * @returns
 *   Construct.
 */
function createFence(marker: Code): Construct {
  assert(marker !== null, 'expected a marker');
  const buffer = String.fromCharCode(marker).repeat(3);

  return { partial: true, tokenize: tokenizeFence };

  function tokenizeFence(effects: Effects, ok: State, nok: State): State {
    let bufferIndex = 0;

    return start;

    /**
     * Start of a fence.
     *
     * ```markdown
     * > | ---
     *     ^
     * ```
     */
    function start(code: Code): State | undefined {
      if (code === buffer.charCodeAt(bufferIndex)) {
        effects.enter('frontmatterFence');
        return sequence(code);
      }

      return nok(code);
    }

    /**
     * In the sequence.
     *
     * ```markdown
     * > | ---
     *     ^
     * ```
     */
    function sequence(code: Code): State | undefined {
      if (bufferIndex === buffer.length) {
        return whitespace(code);
      }

      if (code === buffer.charCodeAt(bufferIndex++)) {
        effects.consume(code);
        return sequence;
      }

      return nok(code);
    }

    /**
     * In whitespace after the sequence.
     *
     * ```markdown
     * > | ---␠
     *        ^
     * ```
     */
    function whitespace(code: Code): State | undefined {
      if (markdownSpace(code)) {
        effects.consume(code);
        return whitespace;
      }

      if (code === codes.eof || markdownLineEnding(code)) {
        effects.exit('frontmatterFence');
        return ok(code);
      }

      return nok(code);
    }
  }
}

/**
 * Read `source` with `constructs` at its start, and the rest as one opaque
 * token, with no Markdown in it.
 *
 * @param source
 *   Text.
 * @param constructs
 *   Constructs to attempt.
 * @param type
 *   Type of the token that is the match.
 * @returns
 *   Match, or nothing.
 */
function readConstruct(
  source: string,
  constructs: ConstructRecord,
  type: 'frontmatter' | 'frontmatterFence'
): FrontmatterMatch | null {
  const bom = source.charCodeAt(0) === 0xfe_ff ? 1 : 0;

  if (!constructs[source.charCodeAt(bom)]) {
    return null;
  }

  const initial: InitialConstruct = { tokenize: initialize };
  const events: Array<Event> = createTokenizer(parse(), initial, undefined).write(
    preprocess()(source, 'utf8', true)
  );
  let index = -1;

  while (++index < events.length) {
    const token = events[index]![1];

    if (events[index]![0] === 'enter' && token.type === type) {
      const from = token.start.offset + bom;
      return {
        from,
        to: token.end.offset + bom,
        marker: source.charCodeAt(from) === codes.dash ? '---' : '+++',
      };
    }
  }

  return null;

  function initialize(effects: Effects): State {
    return effects.attempt(constructs, rest, rest);

    /**
     * After the construct, or where it was not.
     *
     * ```markdown
     * > | ---
     *        ^
     * ```
     */
    function rest(code: Code): State | undefined {
      if (code === codes.eof) {
        effects.consume(code);
        return undefined;
      }

      effects.enter(types.data);
      return opaque(code);
    }

    /**
     * In the rest.
     *
     * ```markdown
     * > | ---
     *        ^
     * ```
     */
    function opaque(code: Code): State | undefined {
      if (code === codes.eof) {
        effects.exit(types.data);
        return rest(code);
      }

      effects.consume(code);
      return opaque;
    }
  }
}
