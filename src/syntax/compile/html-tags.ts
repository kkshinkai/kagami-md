/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What a tag on Kagami's list says (private-docs/rules/html-tokens.md). The construct has told
 * which tag it is; what is inside it, its attributes, is read here, by the opening the parser
 * package leaves for the inside of HTML (src/syntax/AGENTS.md). The text is a
 * complete opening tag: the construct accepted it.
 */
import type { HTMLImageSyntax } from '../syntax/inline.js';
import { assert } from '../kernel/assert.js';
import { decodeNamedCharacterReference } from '../kernel/utils/decode-named-character-reference/index.js';
import { decodeNumericCharacterReference } from '../kernel/utils/decode-numeric-character-reference/index.js';

/**
 * An opening tag: where it ends in its text, and its attributes, the first of
 * each name.
 */
export interface OpeningTag {
  /**
   * The offset after its `>`.
   */
  end: number;
  /** Kagami: source ranges for image editing, independent of decoded attribute values. */
  attributeRanges: Array<HTMLImageSyntax.AttributeRange>;
  closingStart: number;
  /**
   * Its attributes, by lowercase name; an attribute with no value is `null`.
   */
  attributes: ReadonlyMap<string, string | null>;
}

/**
 * The name of a tag, after `<`, in CommonMark’s grammar.
 */
const tagName = /^<[A-Za-z][A-Za-z0-9-]*/;

/**
 * An attribute, with its value, quoted or not, in CommonMark’s grammar.
 */
const attribute =
  /^\s+([A-Za-z_:][A-Za-z0-9_.:-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/d;

/**
 * The end of an opening tag.
 */
const close = /^\s*\/?>/;

/**
 * A character reference in a value, in the grammar CommonMark gives for one.
 */
const reference = /&(?:#[xX]([0-9A-Fa-f]{1,6})|#([0-9]{1,7})|([A-Za-z][A-Za-z0-9]{1,31}));/g;

/**
 * Read the opening tag at the start of `text`.
 *
 * @param text
 *   A complete opening tag, and what follows it.
 * @returns
 *   Opening tag.
 */
export function readOpeningTag(text: string): OpeningTag {
  const attributes = new Map<string, string | null>();
  const attributeRanges: Array<HTMLImageSyntax.AttributeRange> = [];
  const name = tagName.exec(text);
  assert(name, 'expected an opening tag');
  let at = name[0].length;
  let match = attribute.exec(text.slice(at));

  while (match) {
    const key = match[1]!.toLowerCase();
    const value = match[2] ?? match[3] ?? match[4];
    // Kagami: keep every source range; HTML meaning still uses the first attribute.
    const nameRange = match.indices![1]!;
    const valueRange = match.indices![2] ?? match.indices![3] ?? match.indices![4];
    let quote: '"' | "'" | null = null;
    if (match[2] !== undefined) quote = '"';
    else if (match[3] !== undefined) quote = "'";
    attributeRanges.push({
      name: key, nameStart: at + nameRange[0], nameEnd: at + nameRange[1],
      value: valueRange ? { start: at + valueRange[0], end: at + valueRange[1], quote } : null,
    });

    if (!attributes.has(key)) {
      attributes.set(key, value === undefined ? null : decode(value));
    }

    at += match[0].length;
    match = attribute.exec(text.slice(at));
  }

  const end = close.exec(text.slice(at));
  assert(end, 'expected the end of an opening tag');
  const closingStart = at + end[0].search(/\S/);
  return { end: at + end[0].length, attributes, attributeRanges, closingStart };
}

/**
 * A value with its character references read, as HTML reads them.
 *
 * @param value
 *   Value of an attribute.
 * @returns
 *   Decoded value.
 */
function decode(value: string): string {
  return value.replace(reference, replace);
}

/**
 * @param whole
 *   The reference.
 * @param hexadecimal
 *   Its hexadecimal digits, if it is one.
 * @param decimal
 *   Its decimal digits, if it is one.
 * @param name
 *   Its name, if it is a named one.
 * @returns
 *   What it stands for.
 */
function replace(
  whole: string,
  hexadecimal: string | undefined,
  decimal: string | undefined,
  name: string | undefined
): string {
  if (hexadecimal) {
    return decodeNumericCharacterReference(hexadecimal, 16);
  }

  if (decimal) {
    return decodeNumericCharacterReference(decimal, 10);
  }

  return decodeNamedCharacterReference(name!) || whole;
}

/**
 * A length in pixels: a positive whole number, with or without `px`.
 *
 * @param value
 *   Value of an attribute.
 * @returns
 *   Pixels, or nothing.
 */
export function pixels(value: string | null | undefined): number | null {
  const match = value ? /^([0-9]+)(?:px)?$/i.exec(value.trim()) : null;
  const result = match ? Number(match[1]) : 0;

  // Kagami: a dimension is a whole number of pixels from 1 to 4294967295, the
  // range of a Markdown image size (`image-size.ts`); any other value is none.
  return result > 0 && result <= 0xff_ff_ff_ff ? result : null;
}

/**
 * What an `<img>` says, as a Markdown image says it; an attribute with no
 * value is `""`.
 *
 * @param opening
 *   The tag's decoded attributes and source ranges.
 * @returns
 *   What the image has.
 */
export function imageAttributes(
  opening: OpeningTag
): HTMLImageSyntax.Attributes {
  const attributes = opening.attributes;
  const title = attributeValue(attributes, 'title');

  return {
    attributeRanges: opening.attributeRanges,
    closingStart: opening.closingStart,
    destination: attributeValue(attributes, 'src') || '',
    alt: attributeValue(attributes, 'alt') || '',
    title: title === undefined ? null : title,
    width: pixels(attributeValue(attributes, 'width')),
    height: pixels(attributeValue(attributes, 'height')),
  };
}

/**
 * @param attributes
 *   Attributes of the opening tag.
 * @param name
 *   Name of an attribute.
 * @returns
 *   Its value, `""` when it has none, or nothing when it is not there.
 */
function attributeValue(
  attributes: ReadonlyMap<string, string | null>,
  name: string
): string | undefined {
  const value = attributes.get(name);
  return value === undefined ? undefined : value || '';
}
