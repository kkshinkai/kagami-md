/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-FileCopyrightText: Titus Wormer <tituswormer@gmail.com>
 * SPDX-License-Identifier: MPL-2.0 AND MIT
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Derived from mdast-util-from-markdown, https://github.com/syntax-tree/mdast-util-from-markdown. */

import { ReferenceLabels } from '../syntax/reading.js';
import { Syntax } from '../syntax/syntax.js';
import { DocumentSyntax } from '../syntax/block.js';
import { InlineSyntax } from '../syntax/inline.js';
import type { Event, FullNormalizedExtension, ParseOptions, Point, Token } from '../types/index.js';
import type { Bindings, Target } from '../syntax/reading.js';
import type { Width } from './width.js';

/**
 * Compiler context.
 */
export interface CompileContext extends CompileContext.Shared {
  /** Kagami: virtual columns added by physical tabs before a tokenizer point. */
  tabColumns(point: Point): number;
  /**
   * Get the source text that spans a token (or location).
   *
   * @param token
   *   Start/end in stream.
   * @param expandTabs
   *   Whether to expand tabs.
   * @returns
   *   Serialized chunks.
   */
  sliceSerialize(token: Token.Range, expandTabs?: boolean | undefined): string;
}

export namespace CompileContext {
  /** Compilation state shared by every tokenizer event context. */
  export interface Shared {
    /** Kagami: the complete input shared by the handlers of this compilation. */
    source: string;
    /** Kagami: the grammar of this reading, including its field boundaries. */
    grammar: FullNormalizedExtension | null | undefined;
    /** Kagami: whether outer paragraph whitespace is authored inline content. */
    authoredParagraph: boolean;
    /** Which reading the caller requested. */
    target?: Target | undefined;
    /**
     * Configuration.
     */
    config: Config;
    /**
     * Info passed around;
     * key/value store.
     */
    data: CompileData;
    /**
     * Stack of nodes.
     */
    stack: Array<Fragment | Syntax>;
    /**
     * Stack of tokens.
     */
    tokenStack: Array<TokenTuple>;

    /**
     * Capture some of the output data.
     *
     * @param this
     *   Context.
     * @returns
     *   Nothing.
     */
    buffer(this: CompileContext): undefined;

    /**
     * Enter a node.
     *
     * @param this
     *   Context.
     * @param node
     *   Node.
     * @param token
     *   Token.
     * @param onError
     *   Error handler.
     * @returns
     *   Nothing.
     */
    enter(
      this: CompileContext,
      node: Syntax,
      token: Token,
      onError?: OnEnterError | null | undefined
    ): undefined;

    /**
     * Exit a node.
     *
     * @param this
     *   Context.
     * @param token
     *   Token.
     * @param onError
     *   Error handler.
     * @returns
     *   Nothing.
     */
    exit(this: CompileContext, token: Token, onError?: OnExitError | null | undefined): undefined;

    /**
     * Stop capturing and access the output data.
     *
     * @param this
     *   Context.
     * @returns
     *   Nothing.
     */
    resume(this: CompileContext): string;
  }
}

/**
 * Interface of tracked data.
 *
 * When working on extensions that use more data, extend the corresponding
 * interface to register their types:
 *
 * ```ts
 * declare module './types.js' {
 *   interface CompileData {
 *     // Register a new field.
 *     mathFlowInside?: boolean | undefined
 *   }
 * }
 * ```
 */
export interface CompileData {
  /** Most recent physical line ending, before blank-line ownership extends block ranges. */
  lineEnding?: Token | undefined;
  /** Open prefix levels: a list and its item share one level. */
  containerDepth?: number | undefined;

  /** Container prefixes seen on the current line. */
  containerPrefixes?: number | undefined;

  /** Start of the prefix waiting for the next content or line ending. */
  prefixStart?: number | undefined;

  /** Start of the pending blank lines and of their last line. */
  blankStart?: number | undefined;
  lastBlankStart?: number | undefined;

  /**
   * Whether we’re inside a hard break.
   */
  atHardBreak?: boolean | undefined;

  /**
   * Current character reference type.
   */
  characterReferenceType?:
    | 'characterReferenceMarkerHexadecimal'
    | 'characterReferenceMarkerNumeric'
    | undefined;

  /**
   * Whether a first list item value (`1` in `1. a`) is expected.
   */
  expectingFirstListItemValue?: boolean | undefined;

  /**
   * Whether we’re expecting a line ending from a setext heading, which can be slurped.
   */
  setextHeadingSlurpLineEnding?: boolean | undefined;

  /**
   * Current reference.
   */
  referenceType?: 'collapsed' | 'full' | undefined;

  /**
   * Whether we’re in a string: a label, a destination, or a title, where a
   * line ending is a node of its own.
   */
  inString?: boolean | undefined;

  /**
   * Whether the prefix on the first line of a block quote is expected.
   */
  expectingFirstBlockQuotePrefix?: boolean | undefined;

  /**
   * The last line prefix, for a closing fence that comes after it.
   */
  linePrefix?: Token | undefined;

  /**
   * The last whitespace, for the construct it comes in.
   */
  whitespace?: Token | undefined;

  /**
   * The widest text line of the setext heading being made, for its underline.
   */
  setextHeadingWidth?: Width | undefined;

  /**
   * Where the text of the ATX heading being made ends: at its closing
   * sequence, or with the heading.
   */
  atxHeadingClosing?: Token | undefined;

  /** Start of a container prefix before the next intermediate part. */
  intermediateStart?: number | undefined;

  /**
   * The colon of the definition being made, and its destination, for the
   * whitespace after each.
   */
  definitionMarker?: Token | undefined;
  definitionDestination?: Token | undefined;

  /**
   * The declaration of the callout being made.
   */
  calloutDeclaration?: Token | undefined;
}

/**
 * Configuration.
 *
 * We have our defaults, but extensions will add more.
 */
export interface Config {
  /**
   * Token types where line endings are used.
   */
  canContainEOLs: Array<string>;
  /**
   * Opening handles.
   */
  enter: Handles;
  /**
   * Closing handles.
   */
  exit: Handles;
  /**
   * Tree transforms.
   */
  transforms: Array<Transform>;
}

/**
 * Change how markdown tokens from micromark are turned into a tree.
 */
export interface Extension {
  /**
   * Token types where line endings are used.
   */
  canContainEOLs?: Array<string> | null | undefined;
  /**
   * Opening handles.
   */
  enter?: Handles | null | undefined;
  /**
   * Closing handles.
   */
  exit?: Handles | null | undefined;
  /**
   * Tree transforms.
   */
  transforms?: Array<Transform> | null | undefined;
}

/**
 * Internal fragment.
 */
export class Fragment {
  readonly references = new ReferenceLabels();
  /**
   * Node type.
   */
  readonly type = 'fragment' as const;
  /**
   * Children.
   */
  children: Array<InlineSyntax> = [];
}

/**
 * Token types mapping to handles
 */
export type Handles = Record<string, Handle>;

/**
 * Handle a token.
 *
 * @param this
 *   Context.
 * @param token
 *   Current token.
 * @returns
 *   Nothing.
 */
export type Handle = (this: CompileContext, token: Token) => undefined | void;

/**
 * Handle the case where the `right` token is open, but it is closed (by the
 * `left` token) or because we reached the end of the document.
 *
 * @param this
 *   Context.
 * @param left
 *   Left token.
 * @param right
 *   Right token.
 * @returns
 *   Nothing.
 */
export type OnEnterError = (
  this: CompileContext.Shared,
  left: Token | undefined,
  right: Token
) => undefined;

/**
 * Handle the case where the `right` token is open but it is closed by
 * exiting the `left` token.
 *
 * @param this
 *   Context.
 * @param left
 *   Left token.
 * @param right
 *   Right token.
 * @returns
 *   Nothing.
 */
export type OnExitError = (
  this: CompileContext.Shared,
  left: Token,
  right: Token
) => undefined;

/**
 * Configuration.
 */
export interface Options extends ParseOptions {
  /** What the text is read for. */
  target?: Target | undefined;
  /**
   * Extensions for this utility to change how tokens are turned into a tree.
   */
  mdastExtensions?: Array<Extension | Array<Extension>> | null | undefined;
  /**
   * Kagami: the grammar the value is read with (default: a whole document).
   */
  grammar?: FullNormalizedExtension | null | undefined;
  /**
   * Kagami: what the value is (default: `'document'`); the text of a field
   * is `'text'` or `'string'`, with no block around it.
   */
  contentType?: 'document' | 'string' | 'text' | null | undefined;
  /**
   * Kagami: the definitions and footnotes elsewhere, which references in the
   * value may resolve to.
   */
  bindings?: Bindings | null | undefined;
  /**
   * Kagami: whether the value is the content of a table cell.
   */
  tableCell?: boolean | null | undefined;
}

/**
 * Open token on the stack,
 * with an optional error handler for when that token isn’t closed properly.
 */
export type TokenTuple = [token: Token, onError: OnEnterError | undefined];

/**
 * Extra transform, to change the tree afterwards.
 *
 * @param tree
 *   Tree to transform.
 * @returns
 *   New tree or nothing (in which case the current tree is used).
 */
export type Transform = (tree: DocumentSyntax) => DocumentSyntax | null | undefined | void;

/** Compiler input forms, named where their content type is fixed. */
export namespace Options {
  /** Inline content compiled without a surrounding document block. */
  export interface Inline extends Options {
    contentType: 'text' | 'string';
  }
  /** Phrasing content compiled with text constructs. */
  export interface Text extends Options {
    contentType: 'text';
  }
  /** Complete document content. */
  export interface Document extends Options {
    contentType?: 'document' | null;
  }
}

/** Compile a complete event stream and its source into the requested tree. */
export type Compiler<Result extends DocumentSyntax | Fragment = DocumentSyntax | Fragment> = (
  events: Array<Event>,
  value: string
) => Result;
