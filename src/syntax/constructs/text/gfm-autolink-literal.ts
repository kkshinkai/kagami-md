/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-FileCopyrightText: Titus Wormer <tituswormer@gmail.com>
 * SPDX-License-Identifier: MPL-2.0 AND MIT
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Derived from micromark-extension-gfm-autolink-literal, https://github.com/micromark/micromark-extension-gfm-autolink-literal. */

import type { Code, ConstructRecord, Effects, Event, State, TokenizeContext } from '../../types/index.js';
import {
  asciiAlpha,
  asciiAlphanumeric,
  asciiControl,
  markdownLineEndingOrSpace,
} from '../../kernel/utils/character/index.js';
import { contains, attentionPunctuation, whitespace } from '../../kernel/utils/character/dialect.js';
import { codes } from '../../kernel/utils/symbol/index.js';

const wwwPrefix = { tokenize: tokenizeWWWPrefix, partial: true };
const domain = { tokenize: tokenizeDomain, partial: true };
const path = { tokenize: tokenizePath, partial: true };
const trail = { tokenize: tokenizeTrail, partial: true };
const emailDomainDotTrail = {
  tokenize: tokenizeEmailDomainDotTrail,
  partial: true,
};

const wwwAutolink = {
  name: 'wwwAutolink',
  tokenize: tokenizeWWWAutolink,
  previous: previousWWW,
};

const protocolAutolink = {
  name: 'protocolAutolink',
  tokenize: tokenizeProtocolAutolink,
  previous: previousProtocol,
};

const emailAutolink = {
  name: 'emailAutolink',
  tokenize: tokenizeEmailAutolink,
  previous: previousEmail,
};

export const text: ConstructRecord = {};

let code: Code = codes.digit0;

// Add alphanumerics.
while (code < codes.leftCurlyBrace) {
  text[code] = emailAutolink;
  code++;
  if (code === codes.colon) code = codes.uppercaseA;
  else if (code === codes.leftSquareBracket) code = codes.lowercaseA;
}

text[codes.plusSign] = emailAutolink;
text[codes.dash] = emailAutolink;
text[codes.dot] = emailAutolink;
text[codes.underscore] = emailAutolink;
text[codes.uppercaseH] = [emailAutolink, protocolAutolink];
text[codes.lowercaseH] = [emailAutolink, protocolAutolink];
text[codes.uppercaseW] = [emailAutolink, wwwAutolink];
text[codes.lowercaseW] = [emailAutolink, wwwAutolink];

// To do: perform email autolink literals on events, afterwards.
// That’s where `markdown-rs` and `cmark-gfm` perform it.
// It should look for `@`, then for atext backwards, and then for a label
// forwards.
// To do: `mailto:`, `xmpp:` protocol as prefix.

/**
 * Email autolink literal.
 *
 * ```markdown
 * > | a contact@example.org b
 *       ^^^^^^^^^^^^^^^^^^^
 * ```
 */
function tokenizeEmailAutolink(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
  const self = this;
  let dot: boolean | undefined;
  let data: boolean;

  return start;

  /**
   * Start of email autolink literal.
   *
   * ```markdown
   * > | a contact@example.org b
   *       ^
   * ```
   */
  function start(code: Code): State | undefined {
    if (
      !gfmAtext(code) ||
      !previousEmail.call(self, self.previous) ||
      previousUnbalanced(self.events)
    ) {
      return nok(code);
    }

    effects.enter('literalAutolink');
    effects.enter('literalAutolinkEmail');
    return atext(code);
  }

  /**
   * In email atext.
   *
   * ```markdown
   * > | a contact@example.org b
   *       ^
   * ```
   */
  function atext(code: Code): State | undefined {
    if (gfmAtext(code)) {
      effects.consume(code);
      return atext;
    }

    if (code === codes.atSign) {
      effects.consume(code);
      return emailDomain;
    }

    return nok(code);
  }

  /**
   * In email domain.
   *
   * The reference code is a bit overly complex as it handles the `@`, of which
   * there may be just one.
   * Source: <https://github.com/github/cmark-gfm/blob/ef1cfcb/extensions/autolink.c#L318>
   *
   * ```markdown
   * > | a contact@example.org b
   *               ^
   * ```
   */
  function emailDomain(code: Code): State | undefined {
    // Dot followed by alphanumerical (not `-` or `_`).
    if (code === codes.dot) {
      return effects.check(
        emailDomainDotTrail,
        emailDomainAfter,
        emailDomainDot
      )(code);
    }

    // Alphanumerical, `-`, and `_`.
    if (
      code === codes.dash ||
      code === codes.underscore ||
      asciiAlphanumeric(code)
    ) {
      data = true;
      effects.consume(code);
      return emailDomain;
    }

    // To do: `/` if xmpp.

    // Note: normally we’d truncate trailing punctuation from the link.
    // However, email autolink literals cannot contain any of those markers,
    // except for `.`, but that can only occur if it isn’t trailing.
    // So we can ignore truncating!
    return emailDomainAfter(code);
  }

  /**
   * In email domain, on dot that is not a trail.
   *
   * ```markdown
   * > | a contact@example.org b
   *                      ^
   * ```
   */
  function emailDomainDot(code: Code): State | undefined {
    effects.consume(code);
    dot = true;
    return emailDomain;
  }

  /**
   * After email domain.
   *
   * ```markdown
   * > | a contact@example.org b
   *                          ^
   * ```
   */
  function emailDomainAfter(code: Code): State | undefined {
    // Domain must not be empty, must include a dot, and must end in alphabetical.
    // Source: <https://github.com/github/cmark-gfm/blob/ef1cfcb/extensions/autolink.c#L332>.
    if (data && dot && asciiAlpha(self.previous)) {
      effects.exit('literalAutolinkEmail');
      effects.exit('literalAutolink');
      return ok(code);
    }

    return nok(code);
  }
}

/**
 * `www` autolink literal.
 *
 * ```markdown
 * > | a www.example.org b
 *       ^^^^^^^^^^^^^^^
 * ```
 */
function tokenizeWWWAutolink(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
  const self = this;

  return wwwStart;

  /**
   * Start of www autolink literal.
   *
   * ```markdown
   * > | www.example.com/a?b#c
   *     ^
   * ```
   */
  function wwwStart(code: Code): State | undefined {
    if (
      (code !== codes.uppercaseW && code !== codes.lowercaseW) ||
      !previousWWW.call(self, self.previous) ||
      previousUnbalanced(self.events)
    ) {
      return nok(code);
    }

    effects.enter('literalAutolink');
    effects.enter('literalAutolinkWWW');
    // Note: we *check*, so we can discard the `www.` we parsed.
    // If it worked, we consider it as a part of the domain.
    return effects.check(
      wwwPrefix,
      effects.attempt(domain, effects.attempt(path, wwwAfter), nok),
      nok
    )(code);
  }

  /**
   * After a www autolink literal.
   *
   * ```markdown
   * > | www.example.com/a?b#c
   *                          ^
   * ```
   */
  function wwwAfter(code: Code): State | undefined {
    effects.exit('literalAutolinkWWW');
    effects.exit('literalAutolink');
    return ok(code);
  }
}

/**
 * Protocol autolink literal.
 *
 * ```markdown
 * > | a https://example.org b
 *       ^^^^^^^^^^^^^^^^^^^
 * ```
 */
function tokenizeProtocolAutolink(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
  const self = this;
  let buffer = '';
  let seen = false;

  return protocolStart;

  /**
   * Start of protocol autolink literal.
   *
   * ```markdown
   * > | https://example.com/a?b#c
   *     ^
   * ```
   */
  function protocolStart(code: Code): State | undefined {
    if (
      (code === codes.uppercaseH || code === codes.lowercaseH) &&
      previousProtocol.call(self, self.previous) &&
      !previousUnbalanced(self.events)
    ) {
      effects.enter('literalAutolink');
      effects.enter('literalAutolinkHTTP');
      buffer += String.fromCodePoint(code);
      effects.consume(code);
      return protocolPrefixInside;
    }

    return nok(code);
  }

  /**
   * In protocol.
   *
   * ```markdown
   * > | https://example.com/a?b#c
   *     ^^^^^
   * ```
   */
  function protocolPrefixInside(code: Code): State | undefined {
    // `5` is size of `https`
    if (asciiAlpha(code) && buffer.length < 5) {
      // @ts-expect-error: definitely number.
      buffer += String.fromCodePoint(code);
      effects.consume(code);
      return protocolPrefixInside;
    }

    if (code === codes.colon) {
      const protocol = buffer.toLowerCase();

      if (protocol === 'http' || protocol === 'https') {
        effects.consume(code);
        return protocolSlashesInside;
      }
    }

    return nok(code);
  }

  /**
   * In slashes.
   *
   * ```markdown
   * > | https://example.com/a?b#c
   *           ^^
   * ```
   */
  function protocolSlashesInside(code: Code): State | undefined {
    if (code === codes.slash) {
      effects.consume(code);

      if (seen) {
        return afterProtocol;
      }

      seen = true;
      return protocolSlashesInside;
    }

    return nok(code);
  }

  /**
   * After protocol, before domain.
   *
   * ```markdown
   * > | https://example.com/a?b#c
   *             ^
   * ```
   */
  function afterProtocol(code: Code): State | undefined {
    // To do: this is different from `markdown-rs`:
    // https://github.com/wooorm/markdown-rs/blob/b3a921c761309ae00a51fe348d8a43adbc54b518/src/construct/gfm_autolink_literal.rs#L172-L182
    return code === codes.eof ||
      asciiControl(code) ||
      markdownLineEndingOrSpace(code) ||
      unicodeWhitespace(code) ||
      unicodePunctuation(code)
      ? nok(code)
      : effects.attempt(domain, effects.attempt(path, protocolAfter), nok)(code);
  }

  /**
   * After a protocol autolink literal.
   *
   * ```markdown
   * > | https://example.com/a?b#c
   *                              ^
   * ```
   */
  function protocolAfter(code: Code): State | undefined {
    effects.exit('literalAutolinkHTTP');
    effects.exit('literalAutolink');
    return ok(code);
  }
}

/**
 * `www` prefix.
 *
 * ```markdown
 * > | a www.example.org b
 *       ^^^^
 * ```
 */
function tokenizeWWWPrefix(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
  let size = 0;

  return wwwPrefixInside;

  /**
   * In www prefix.
   *
   * ```markdown
   * > | www.example.com
   *     ^^^^
   * ```
   */
  function wwwPrefixInside(code: Code): State | undefined {
    if ((code === codes.uppercaseW || code === codes.lowercaseW) && size < 3) {
      size++;
      effects.consume(code);
      return wwwPrefixInside;
    }

    if (code === codes.dot && size === 3) {
      effects.consume(code);
      return wwwPrefixAfter;
    }

    return nok(code);
  }

  /**
   * After www prefix.
   *
   * ```markdown
   * > | www.example.com
   *         ^
   * ```
   */
  function wwwPrefixAfter(code: Code): State | undefined {
    // If there is *anything*, we can link.
    return code === codes.eof ? nok(code) : ok(code);
  }
}

/**
 * Domain.
 *
 * ```markdown
 * > | a https://example.org b
 *               ^^^^^^^^^^^
 * ```
 */
function tokenizeDomain(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
  let underscoreInLastSegment: boolean | undefined;
  let underscoreInLastLastSegment: boolean | undefined;
  let seen: boolean | undefined;

  return domainInside;

  /**
   * In domain.
   *
   * ```markdown
   * > | https://example.com/a
   *             ^^^^^^^^^^^
   * ```
   */
  function domainInside(code: Code): State | undefined {
    // Check whether this marker, which is a trailing punctuation
    // marker, optionally followed by more trailing markers, and then
    // followed by an end.
    if (code === codes.dot || code === codes.underscore) {
      return effects.check(trail, domainAfter, domainAtPunctuation)(code);
    }

    // GH documents that only alphanumerics (other than `-`, `.`, and `_`) can
    // occur, which sounds like ASCII only, but non-ASCII domains are supported,
    // so that’s Unicode.
    // Instead of some new production for Unicode alphanumerics, markdown
    // already has that for Unicode punctuation and whitespace, so use those.
    // Source: <https://github.com/github/cmark-gfm/blob/ef1cfcb/extensions/autolink.c#L12>.
    if (
      code === codes.eof ||
      markdownLineEndingOrSpace(code) ||
      unicodeWhitespace(code) ||
      (code !== codes.dash && unicodePunctuation(code))
    ) {
      return domainAfter(code);
    }

    seen = true;
    effects.consume(code);
    return domainInside;
  }

  /**
   * In domain, at potential trailing punctuation, that was not trailing.
   *
   * ```markdown
   * > | https://example.com
   *                    ^
   * ```
   */
  function domainAtPunctuation(code: Code): State | undefined {
    // There is an underscore in the last segment of the domain
    if (code === codes.underscore) {
      underscoreInLastSegment = true;
    }
    // Otherwise, it’s a `.`: save the last segment underscore in the
    // penultimate segment slot.
    else {
      underscoreInLastLastSegment = underscoreInLastSegment;
      underscoreInLastSegment = undefined;
    }

    effects.consume(code);
    return domainInside;
  }

  /**
   * After domain.
   *
   * ```markdown
   * > | https://example.com/a
   *                        ^
   * ```
   */
  function domainAfter(code: Code): State | undefined {
    // Note: that’s GH says a dot is needed, but it’s not true:
    // <https://github.com/github/cmark-gfm/issues/279>
    if (underscoreInLastLastSegment || underscoreInLastSegment || !seen) {
      return nok(code);
    }

    return ok(code);
  }
}

/**
 * Path.
 *
 * ```markdown
 * > | a https://example.org/stuff b
 *                          ^^^^^^
 * ```
 */
function tokenizePath(this: TokenizeContext, effects: Effects, ok: State): State {
  let sizeOpen = 0;
  let sizeClose = 0;

  return pathInside;

  /**
   * In path.
   *
   * ```markdown
   * > | https://example.com/a
   *                        ^^
   * ```
   */
  function pathInside(code: Code): State | undefined {
    if (code === codes.leftParenthesis) {
      sizeOpen++;
      effects.consume(code);
      return pathInside;
    }

    // To do: `markdown-rs` also needs this.
    // If this is a paren, and there are less closings than openings,
    // we don’t check for a trail.
    if (code === codes.rightParenthesis && sizeClose < sizeOpen) {
      return pathAtPunctuation(code);
    }

    // Check whether this trailing punctuation marker is optionally
    // followed by more trailing markers, and then followed
    // by an end.
    if (
      code === codes.exclamationMark ||
      code === codes.quotationMark ||
      code === codes.ampersand ||
      code === codes.apostrophe ||
      code === codes.rightParenthesis ||
      code === codes.asterisk ||
      code === codes.comma ||
      code === codes.dot ||
      code === codes.colon ||
      code === codes.semicolon ||
      code === codes.lessThan ||
      code === codes.questionMark ||
      code === codes.rightSquareBracket ||
      code === codes.underscore ||
      code === codes.tilde
    ) {
      return effects.check(trail, ok, pathAtPunctuation)(code);
    }

    if (
      code === codes.eof ||
      markdownLineEndingOrSpace(code) ||
      unicodeWhitespace(code)
    ) {
      return ok(code);
    }

    effects.consume(code);
    return pathInside;
  }

  /**
   * In path, at potential trailing punctuation, that was not trailing.
   *
   * ```markdown
   * > | https://example.com/a"b
   *                          ^
   * ```
   */
  function pathAtPunctuation(code: Code): State | undefined {
    // Count closing parens.
    if (code === codes.rightParenthesis) {
      sizeClose++;
    }

    effects.consume(code);
    return pathInside;
  }
}

/**
 * Trail.
 *
 * This calls `ok` if this *is* the trail, followed by an end, which means
 * the entire trail is not part of the link.
 * It calls `nok` if this *is* part of the link.
 *
 * ```markdown
 * > | https://example.com").
 *                        ^^^
 * ```
 */
function tokenizeTrail(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
  return trail;

  /**
   * In trail of domain or path.
   *
   * ```markdown
   * > | https://example.com").
   *                        ^
   * ```
   */
  function trail(code: Code): State | undefined {
    // Regular trailing punctuation.
    if (
      code === codes.exclamationMark ||
      code === codes.quotationMark ||
      code === codes.apostrophe ||
      code === codes.rightParenthesis ||
      code === codes.asterisk ||
      code === codes.comma ||
      code === codes.dot ||
      code === codes.colon ||
      code === codes.semicolon ||
      code === codes.questionMark ||
      code === codes.underscore ||
      code === codes.tilde
    ) {
      effects.consume(code);
      return trail;
    }

    // `&` followed by one or more alphabeticals and then a `;`, is
    // as a whole considered as trailing punctuation.
    // In all other cases, it is considered as continuation of the URL.
    if (code === codes.ampersand) {
      effects.consume(code);
      return trailCharacterReferenceStart;
    }

    // Needed because we allow literals after `[`, as we fix:
    // <https://github.com/github/cmark-gfm/issues/278>.
    // Check that it is not followed by `(` or `[`.
    if (code === codes.rightSquareBracket) {
      effects.consume(code);
      return trailBracketAfter;
    }

    if (
      // `<` is an end.
      code === codes.lessThan ||
      // So is whitespace.
      code === codes.eof ||
      markdownLineEndingOrSpace(code) ||
      unicodeWhitespace(code)
    ) {
      return ok(code);
    }

    return nok(code);
  }

  /**
   * In trail, after `]`.
   *
   * > 👉 **Note**: this deviates from `cmark-gfm` to fix a bug.
   * > See end of <https://github.com/github/cmark-gfm/issues/278> for more.
   *
   * ```markdown
   * > | https://example.com](
   *                         ^
   * ```
   */
  function trailBracketAfter(code: Code): State | undefined {
    // Whitespace or something that could start a resource or reference is the end.
    // Switch back to trail otherwise.
    if (
      code === codes.eof ||
      code === codes.leftParenthesis ||
      code === codes.leftSquareBracket ||
      markdownLineEndingOrSpace(code) ||
      unicodeWhitespace(code)
    ) {
      return ok(code);
    }

    return trail(code);
  }

  /**
   * In character-reference like trail, after `&`.
   *
   * ```markdown
   * > | https://example.com&amp;).
   *                         ^
   * ```
   */
  function trailCharacterReferenceStart(code: Code): State | undefined {
    // When non-alpha, it’s not a trail.
    return asciiAlpha(code) ? trailCharacterReferenceInside(code) : nok(code);
  }

  /**
   * In character-reference like trail.
   *
   * ```markdown
   * > | https://example.com&amp;).
   *                         ^
   * ```
   */
  function trailCharacterReferenceInside(code: Code): State | undefined {
    // Switch back to trail if this is well-formed.
    if (code === codes.semicolon) {
      effects.consume(code);
      return trail;
    }

    if (asciiAlpha(code)) {
      effects.consume(code);
      return trailCharacterReferenceInside;
    }

    // It’s not a trail.
    return nok(code);
  }
}

/**
 * Dot in email domain trail.
 *
 * This calls `ok` if this *is* the trail, followed by an end, which means
 * the trail is not part of the link.
 * It calls `nok` if this *is* part of the link.
 *
 * ```markdown
 * > | contact@example.org.
 *                        ^
 * ```
 */
function tokenizeEmailDomainDotTrail(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
  return start;

  /**
   * Dot.
   *
   * ```markdown
   * > | contact@example.org.
   *                    ^   ^
   * ```
   */
  function start(code: Code): State | undefined {
    // Must be dot.
    effects.consume(code);
    return after;
  }

  /**
   * After dot.
   *
   * ```markdown
   * > | contact@example.org.
   *                     ^   ^
   * ```
   */
  function after(code: Code): State | undefined {
    // Not a trail if alphanumeric.
    return asciiAlphanumeric(code) ? nok(code) : ok(code);
  }
}

/**
 * See:
 * <https://github.com/github/cmark-gfm/blob/ef1cfcb/extensions/autolink.c#L156>.
 */
function previousWWW(this: TokenizeContext, code: Code): boolean {
  return (
    code === codes.eof ||
    code === codes.leftParenthesis ||
    code === codes.asterisk ||
    code === codes.underscore ||
    code === codes.leftSquareBracket ||
    code === codes.rightSquareBracket ||
    code === codes.tilde ||
    markdownLineEndingOrSpace(code)
  );
}

/**
 * See:
 * <https://github.com/github/cmark-gfm/blob/ef1cfcb/extensions/autolink.c#L214>.
 */
function previousProtocol(this: TokenizeContext, code: Code): boolean {
  return !asciiAlpha(code);
}

function previousEmail(this: TokenizeContext, code: Code): boolean {
  // Do not allow a slash “inside” atext.
  // The reference code is a bit weird, but that’s what it results in.
  // Source: <https://github.com/github/cmark-gfm/blob/ef1cfcb/extensions/autolink.c#L307>.
  // Other than slash, every preceding character is allowed.
  return !(code === codes.slash || gfmAtext(code));
}

/**
 * @param code
 */
function gfmAtext(code: Code): boolean {
  return (
    code === codes.plusSign ||
    code === codes.dash ||
    code === codes.dot ||
    code === codes.underscore ||
    asciiAlphanumeric(code)
  );
}

/**
 * @param events
 */
function previousUnbalanced(events: Array<Event>): boolean {
  let index = events.length;
  let result = false;

  while (index--) {
    const token = events[index][1];

    if (
      (token.type === 'labelLink' || token.type === 'labelImage') &&
      !token._balanced
    ) {
      result = true;
      break;
    }

    // If we’ve seen this token, and it was marked as not having any unbalanced
    // bracket before it, we can exit.
    if (token._gfmAutolinkLiteralWalkedInto) {
      result = false;
      break;
    }
  }

  if (events.length > 0 && !result) {
    // Mark the last token as “walked into” w/o finding
    // anything.
    events[events.length - 1][1]._gfmAutolinkLiteralWalkedInto = true;
  }

  return result;
}

/**
 * Kagami: Unicode punctuation, by the dialect’s table, in place of
 * `micromark-util-character`’s. Receives UTF-16 units, as upstream does.
 *
 * @param code
 *   Code.
 * @returns
 *   Whether it is.
 */
function unicodePunctuation(code: Code): boolean {
  return code !== null && code >= 0 && contains(attentionPunctuation, code);
}

/**
 * Kagami: Unicode whitespace, by the dialect’s table, in place of
 * `micromark-util-character`’s. Receives UTF-16 units, as upstream does.
 *
 * @param code
 *   Code.
 * @returns
 *   Whether it is.
 */
function unicodeWhitespace(code: Code): boolean {
  return code !== null && code >= 0 && contains(whitespace, code);
}
