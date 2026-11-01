/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-FileCopyrightText: Titus Wormer <tituswormer@gmail.com>
 * SPDX-License-Identifier: MPL-2.0 AND MIT
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Derived from micromark, https://github.com/micromark/micromark. */

// Note: this file is authored manually, not generated from `index.js`.

import type { Bindings, Target } from '../syntax/reading.js';

/**
 * A character code.
 *
 * This is often the same as what `String#charCodeAt()` yields but micromark
 * adds meaning to certain other values.
 *
 * `null` represents the end of the input stream (called eof).
 * Negative integers are used instead of certain sequences of characters (such
 * as line endings and tabs).
 */
export type Code = number | null;

/**
 * A chunk is either a character code or a slice of a buffer in the form of a
 * string.
 *
 * Chunks are used because strings are more efficient storage that character
 * codes, but limited in what they can represent.
 */
export type Chunk = Code | string;

/**
 * Enumeration of the content types.
 *
 * Technically `document` is also a content type, which includes containers
 * (lists, block quotes) and flow.
 * As `ContentType` is used on tokens to define the type of subcontent but
 * `document` is the highest level of content, so it’s not listed here.
 *
 * Containers in markdown come from the margin and include more constructs
 * on the lines that define them.
 * Take for example a block quote with a paragraph inside it (such as
 * `> asd`).
 *
 * `flow` represents the sections, such as headings, code, and content, which
 * is also parsed per line
 * An example is HTML, which has a certain starting condition (such as
 * `<script>` on its own line), then continues for a while, until an end
 * condition is found (such as `</style>`).
 * If that line with an end condition is never found, that flow goes until
 * the end.
 *
 * `content` is zero or more definitions, and then zero or one paragraph.
 * It’s a weird one, and needed to make certain edge cases around definitions
 * spec compliant.
 * Definitions are unlike other things in markdown, in that they behave like
 * `text` in that they can contain arbitrary line endings, but *have* to end
 * at a line ending.
 * If they end in something else, the whole definition instead is seen as a
 * paragraph.
 *
 * The content in markdown first needs to be parsed up to this level to
 * figure out which things are defined, for the whole document, before
 * continuing on with `text`, as whether a link or image reference forms or
 * not depends on whether it’s defined.
 * This unfortunately prevents a true streaming markdown to HTML compiler.
 *
 * `text` contains phrasing content such as attention (emphasis, strong),
 * media (links, images), and actual text.
 *
 * `string` is a limited `text` like content type which only allows character
 * references and character escapes.
 * It exists in things such as identifiers (media references, definitions),
 * titles, or URLs.
 */
export type ContentType = 'content' | 'document' | 'flow' | 'string' | 'text';

/**
 * A location in the document (`line`/`column`/`offset`) and chunk (`_index`,
 * `_bufferIndex`).
 *
 * `_bufferIndex` is `-1` when `_index` points to a code chunk and it’s a
 * non-negative integer when pointing to a string chunk.
 *
 * The interface for the location in the document comes from unist `Point`:
 * <https://github.com/syntax-tree/unist#point>
 */
export interface Point extends Point.Source {
  /**
   * Position in a string chunk (or `-1` when pointing to a numeric chunk).
   */
  _bufferIndex: number;

  /**
   * Position in a list of chunks.
   */
  _index: number;
}

export namespace Point {
  /** A source position without tokenizer stream coordinates. */
  export interface Source {
    /**
     * 1-indexed column number.
     */
    column: number;

    /**
     * 1-indexed line number.
     */
    line: number;

    /**
     * 0-indexed position in the document.
     */
    offset: number;
  }
}

/** HTML block category selected by the flow construct. */
export type HTMLFlowCondition = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/**
 * A token: a span of chunks.
 *
 * Tokens are what the core of micromark produces: the built in HTML compiler
 * or other tools can turn them into different things.
 *
 * Tokens are essentially names attached to a slice of chunks, such as
 * `lineEndingBlank` for certain line endings, or `codeFenced` for a whole
 * fenced code.
 *
 * Sometimes, more info is attached to tokens, such as `_open` and `_close`
 * by `attention` (strong, emphasis) to signal whether the sequence can open
 * or close an attention run.
 *
 * Linked tokens are used because outer constructs are parsed first.
 * Take for example:
 *
 * ```markdown
 * > *a
 * b*.
 * ```
 *
 * 1.  The block quote marker and the space after it is parsed first
 * 2.  The rest of the line is a `chunkFlow` token
 * 3.  The two spaces on the second line are a `linePrefix`
 * 4.  The rest of the line is another `chunkFlow` token
 *
 * The two `chunkFlow` tokens are linked together.
 * The chunks they span are then passed through the flow tokenizer.
 */
export interface Token extends Token.Fields {
  /** Token type. */
  type: TokenType;
  /** Point where the token starts. */
  start: Point;
  /** Point where the token ends. */
  end: Point;
}

export namespace Token {
  /** Alignment read from a table delimiter cell. */
  export type Align = 'center' | 'left' | 'none' | 'right';

  /** A span in the tokenizer stream. */
  export interface Range {
    start: Point;
    end: Point;
  }

  /** Optional fields supplied when entering a token. */
  export interface Fields {
    start?: Point | undefined;
    end?: Point | undefined;
    /** HTML block category chosen by its construct. (proposed, 2026-10-07) */
    _htmlKind?: HTMLFlowCondition;
    /** Whether the HTML construct reached its explicit terminal sequence. */
    _htmlClosed?: boolean;
    /** Whether this content opening can be a definition title, including an unfinished title. */
    _startsLinkTitle?: boolean;
    /** Whether a thematic break is also a setext underline when it follows paragraph text. */
    _thematicBreakCanSetext?: boolean;

    /**
     * Kagami: what a piece of inline HTML is, set on its `htmlText` when it is a comment or an
     * opening tag on Kagami's list (`htmlReadTag`); unset for any other token.
     */
    _htmlTextKind?: 'comment' | 'lineBreak' | 'image' | undefined;

    /**
     * Kagami: the tag on Kagami's list that an HTML block of the seventh kind opens with, set on
     * its `htmlFlow`; unset otherwise.
     */
    _htmlFlowTag?: 'lineBreak' | 'image' | undefined;

    /**
     * Whether a blank line stands between the items of a list or inside one, set by the pass that
     * finds list items, as `mdast-util-from-markdown` sets it.
     */
    _spread?: boolean | undefined;

    /** The code of a list item's marker, set on its `listItemMarker`: `-`, `*`, `+`, `.` or `)`. */
    _listMarker?: Code | undefined;

    /**
     * Kagami: what the syntax tree's compiler finds of the lines around a block
     * and leaves on its token, as `_spread` is left on a list
     * (`compile/lines.ts`, `prepareLines`): the blank lines before and after it,
     * the spaces before it on its first line, and of a container the blank lines
     * it holds with no child, whether its first block starts on its first line,
     * and how far the lines continuing a paragraph in it are indented.
     */
    _leadingBlankLines?: number | undefined;
    _trailingBlankLines?: number | undefined;
    _startBlankLines?: number | undefined;
    _endBlankLines?: number | undefined;
    _spacesBeforeBlock?: number | undefined;
    _startsOnFirstLine?: boolean | undefined;
    _continuationIndent?: number | null | undefined;
    /** End of the last explicit quote prefix, found by the compiler's line ownership pass. */
    _lastPrefixEnd?: number | undefined;
    /** Kagami: an ending or container prefix proves a final blank literal row beyond its token. */
    _literalFinalBlankLine?: boolean | undefined;

    /** The level of a Setext heading, set on its underline's sequence: 1 for `=`, 2 for `-`. */
    _setextLevel?: 1 | 2 | undefined;

    /** Alignment of each column of a GFM table, set on its `table` token. */
    _align?: Array<Align> | undefined;


    /**
     * The previous token in a list of linked tokens.
     */
    previous?: Token | undefined;

    /**
     * The next token in a list of linked tokens.
     */
    next?: Token | undefined;

    /**
     * Declares a token as having content of a certain type.
     */
    contentType?: ContentType | undefined;

    /**
     * Declares that trailing whitespace is sensitive,
     * is allowed,
     * when `contentType` is `text` (or `string`).
     * Normally,
     * trailing spaces and tabs are dropped.
     */
    _contentTypeTextTrailing?: boolean | undefined;

    /**
     * Connected tokenizer.
     *
     * Used when dealing with linked tokens.
     * A child tokenizer is needed to tokenize them, which is stored on those
     * tokens.
     */
    _tokenizer?: TokenizeContext | undefined;

    /**
     * Field to help parse attention.
     *
     * Depending on the character before sequences (`**`), the sequence can open,
     * close, both, or none.
     */
    _open?: boolean | undefined;

    /**
     * Field to help parse attention.
     *
     * Depending on the character before sequences (`**`), the sequence can open,
     * close, both, or none.
     */
    _close?: boolean | undefined;

    /**
     * Field to help parse GFM task lists.
     *
     * This boolean is used internally to figure out if a token is in the first
     * content of a list item construct.
     */
    _isInFirstContentOfListItem?: boolean | undefined;

    /**
     * Field to help parse containers.
     *
     * This boolean is used internally to figure out if a token is a container
     * token.
     */
    _container?: boolean | undefined;

    /**
     * Field to help parse lists.
     *
     * This boolean is used internally to figure out if a list is loose or not.
     */
    _loose?: boolean | undefined;

    /**
     * Field to help parse links.
     *
     * This boolean is used internally to figure out if a link opening
     * can’t be used (because links in links are incorrect).
     */
    _inactive?: boolean | undefined;

    /**
     * Field to help parse links.
     *
     * This boolean is used internally to figure out if a link opening is
     * balanced: it’s not a link opening but has a balanced closing.
     */
    _balanced?: boolean | undefined;

    /**
     * Field to help parse GFM autolink literals.
     */
    _gfmAutolinkLiteralWalkedInto?: boolean | undefined;
  }
}

/**
 * The start or end of a token amongst other events.
 *
 * Tokens can “contain” other tokens, even though they are stored in a flat
 * list, through `enter`ing before them, and `exit`ing after them.
 */
export type Event = ['enter' | 'exit', Token, TokenizeContext];

/**
 * Open a token.
 *
 * @param type
 *   Token type.
 * @param fields
 *   Extra fields.
 * @returns
 *   Token.
 */
export type Enter = (type: TokenType, fields?: Token.Fields | undefined) => Token;

/**
 * Close a token.
 *
 * @param type
 *   Token type.
 * @returns
 *   Token.
 */
export type Exit = (type: TokenType) => Token;

/**
 * Deal with the character and move to the next.
 *
 * @param code
 *   Current code.
 */
export type Consume = (code: Code) => undefined;

/**
 * Attempt deals with several values, and tries to parse according to those
 * values.
 *
 * If a value resulted in `ok`, it worked, the tokens that were made are used,
 * and `ok` is switched to.
 * If the result is `nok`, the attempt failed, so we revert to the original
 * state, and `nok` is used.
 *
 * @param construct
 *   Construct(s) to try.
 * @param ok
 *   State to move to when successful.
 * @param nok
 *   State to move to when unsuccessful.
 * @returns
 *   Next state.
 */
export type Attempt = (
  construct: Array<Construct> | ConstructRecord | Construct,
  ok: State,
  nok?: State | undefined
) => State;

/**
 * A context object to transition the state machine.
 */
export interface Effects {
  /**
   * Try to tokenize a construct.
   */
  attempt: Attempt;

  /**
   * Attempt, then revert.
   */
  check: Attempt;

  /**
   * Deal with the character and move to the next.
   */
  consume: Consume;

  /**
   * Start a new token.
   */
  enter: Enter;

  /**
   * End a started token.
   */
  exit: Exit;

  /**
   * Interrupt is used for stuff right after a line of content.
   */
  interrupt: Attempt;
}

/**
 * The main unit in the state machine: a function that gets a character code
 * and has certain effects.
 *
 * A state function should return another function: the next
 * state-as-a-function to go to.
 *
 * But there is one case where they return `undefined`: for the eof character
 * code (at the end of a value).
 * The reason being: well, there isn’t any state that makes sense, so
 * `undefined` works well.
 * Practically that has also helped: if for some reason it was a mistake, then
 * an exception is throw because there is no next function, meaning it
 * surfaces early.
 *
 * @param code
 *   Current code.
 * @returns
 *   Next state.
 */
export type State = (code: Code) => State | undefined;

/**
 * A resolver handles and cleans events coming from `tokenize`.
 *
 * @param events
 *   List of events.
 * @param context
 *   Tokenize context.
 * @returns
 *   The given, modified, events.
 */
export type Resolver = (events: Array<Event>, context: TokenizeContext) => Array<Event>;

/**
 * A tokenize function sets up a state machine to handle character codes streaming in.
 *
 * @param this
 *   Tokenize context.
 * @param effects
 *   Effects.
 * @param ok
 *   State to go to when successful.
 * @param nok
 *   State to go to when unsuccessful.
 * @returns
 *   First state.
 */
export type Tokenizer = (this: TokenizeContext, effects: Effects, ok: State, nok: State) => State;

/**
 * Like a tokenizer, but without `ok` or `nok`.
 *
 * @param this
 *   Tokenize context.
 * @param effects
 *   Effects.
 * @returns
 *   First state.
 */
export type Initializer = (this: TokenizeContext, effects: Effects) => State;

/**
 * Like a tokenizer, but without `ok` or `nok`, and returning `undefined`.
 *
 * This is the final hook when a container must be closed.
 *
 * @param this
 *   Tokenize context.
 * @param effects
 *   Effects.
 */
export type Exiter = (this: TokenizeContext, effects: Effects) => undefined;

/**
 * Guard whether `code` can come before the construct.
 *
 * In certain cases a construct can hook into many potential start characters.
 * Instead of setting up an attempt to parse that construct for most
 * characters, this is a speedy way to reduce that.
 *
 * @param this
 *   Tokenize context.
 * @param code
 *   Previous code.
 * @returns
 *   Whether `code` is allowed before.
 */
export type Previous = (this: TokenizeContext, code: Code) => boolean;

/**
 * An object describing how to parse a markdown construct.
 */
export interface Construct extends Construct.Hooks {
  /**
   * Set up a state machine to handle character codes streaming in.
   */
  tokenize: Tokenizer;
}

export namespace Construct {
  /** Hooks shared by constructs and their initializers. */
  export interface Hooks extends Resolvable {
    /**
     * Whether the construct, when in a `ConstructRecord`, precedes over existing
     * constructs for the same character code when merged.
     *
     * The default is that new constructs precede over existing ones.
     */
    add?: 'after' | 'before' | undefined;

    /**
     * Concrete constructs cannot be interrupted by more containers.
     *
     * For example, when parsing the document (containers, such as block quotes
     * and lists) and this construct is parsing fenced code:
     *
     * ````markdown
     * > ```js
     * > - list?
     * ````
     *
     * …then `- list?` cannot form if this fenced code construct is concrete.
     *
     * An example of a construct that is not concrete is a GFM table:
     *
     * ````markdown
     * | a |
     * | - |
     * > | b |
     * ````
     *
     * …`b` is not part of the table.
     */
    concrete?: boolean | undefined;

    /**
     * For containers, a continuation construct.
     */
    continuation?: Construct | undefined;

    /**
     * For containers, a final hook.
     */
    exit?: Exiter | undefined;

    /**
     * Kagami: flow confirmed by a document-level lookahead.
     *
     * A document construct with this field checks that this flow construct can
     * succeed before concrete flow suppresses container recognition. Its
     * tokenizer must leave the input and events unchanged on success, as with
     * `effects.check`. It opens no container and has no continuation or exit.
     *
     * The document starts a flow tokenizer at the checked position and records
     * this exact construct in `_checkedConstruct`. The flow construct can use
     * that identity to reject attempts without a successful document check.
     */
    flow?: Construct | undefined;

    /**
     * Name of the construct, used to toggle constructs off.
     *
     * Named constructs must not be `partial`.
     */
    name?: string | undefined;

    /**
     * Whether this construct represents a partial construct.
     *
     * Partial constructs must not have a `name`.
     */
    partial?: boolean | undefined;

    /**
     * Guard whether the previous character can come before the construct.
     */
    previous?: Previous | undefined;



    /**
     * Resolve the events from the start of the content (which includes other
     * constructs) to the last one parsed by `tokenize`.
     *
     * For example, if we’re currently parsing a link title and this construct
     * parses character references, then `resolveTo` is called with the events
     * ranging from the start of the link title to the end of a character
     * reference each time one is found.
     */
    resolveTo?: Resolver | undefined;

    /**
     * Resolve the events parsed by `tokenize`.
     *
     * For example, if we’re currently parsing a link title and this construct
     * parses character references, then `resolve` is called with the events
     * ranging from the start to the end of a character reference each time one is
     * found.
     */
    resolve?: Resolver | undefined;
  }

  /** A construct that can resolve events after tokenization. */
  export interface Resolvable {
    /**
     * Resolve all events when the content is complete, from the start to the end.
     * Only used if `tokenize` is successful once in the content.
     *
     * For example, if we’re currently parsing a link title and this construct
     * parses character references, then `resolveAll` is called *if* at least one
     * character reference is found, ranging from the start to the end of the link
     * title to the end.
     */
    resolveAll?: Resolver | undefined;
  }
}

/**
 * Like a construct, but `tokenize` does not accept `ok` or `nok`.
 */
export interface InitialConstruct extends Construct.Hooks {
  tokenize: Initializer;
}

/**
 * Several constructs, mapped from their initial codes.
 */
export type ConstructRecord = Record<string, Array<Construct> | Construct | undefined>;

/**
 * State shared between container calls.
 */
export interface ContainerState {
  /**
   * Special field to close the current flow (or containers).
   */
  _closeFlow?: boolean | undefined;

  /**
   * Whether there are further blank lines, used by lists.
   */
  furtherBlankLines?: boolean | undefined;

  /**
   * Whether there first line is blank, used by lists.
   */
  initialBlankLine?: boolean | undefined;

  /**
   * Current marker, used by lists.
   */
  marker?: Code | undefined;

  /**
   * Used by block quotes.
   */
  open?: boolean | undefined;

  /**
   * Current size, used by lists.
   */
  size?: number | undefined;

  /**
   * Current token type, used by lists.
   */
  type?: TokenType | undefined;
}

/**
 * A context object that helps w/ tokenizing markdown constructs.
 */
export interface TokenizeContext {
  /** Kagami: virtual columns added by physical tabs before a point in this stream. */
  tabColumns(point: Point): number;
  /** Kagami: the flow construct confirmed by the document at this flow's start. */
  _checkedConstruct?: Construct | undefined;
  /** Whether the current text chunk is owned by a GFM table cell. */
  _gfmTableCell?: boolean;
  /** ZWSP edge mark: whether the current text chunk is the title of a callout, which has no mark. */
  _calloutTitle?: boolean;
  // To do: next major: remove `_gfmTableDynamicInterruptHack` (no longer
  // needed in micromark-extension-gfm-table@1.0.6).
  /**
   * Internal boolean shared with `micromark-extension-gfm-table` whose body
   * rows are not affected by normal interruption rules.
   * “Normal” rules are, for example, that an empty list item can’t interrupt:
   *
   * ````markdown
   * a
   * *
   * ````
   *
   * The above is one paragraph.
   * These rules don’t apply to table body rows:
   *
   * ````markdown
   * | a |
   * | - |
   * *
   * ````
   *
   * The above list interrupts the table.
   */
  _gfmTableDynamicInterruptHack?: boolean;

  /**
   * Internal boolean shared with `micromark-extension-gfm-task-list-item` to
   * signal whether the tokenizer is tokenizing the first content of a list item
   * construct.
   */
  _gfmTasklistFirstContentOfListItem?: boolean | undefined;

  /**
   * Whether the flow is at the first line of the content of a block quote, where the head of a
   * callout may open (Kagami).
   */
  _calloutFirstContentOfBlockQuote?: boolean | undefined;

  /**
   * Declares that trailing whitespace is sensitive,
   * is allowed,
   * when tokenizing `text` (or `string`).
   * Normally,
   * trailing spaces and tabs are dropped.
   */
  _contentTypeTextTrailing?: boolean | undefined;

  /**
   * Current code.
   */
  code: Code;

  /**
   * Share state set when parsing containers.
   *
   * Containers are parsed in separate phases: their first line (`tokenize`),
   * continued lines (`continuation.tokenize`), and finally `exit`.
   * This record can be used to store some information between these hooks.
   */
  containerState?: ContainerState | undefined;

  /**
   * The current construct.
   *
   * Constructs that are not `partial` are set here.
   */
  currentConstruct?: Construct | undefined;

  /**
   * Current list of events.
   */
  events: Array<Event>;

  /**
   * Whether we’re currently interrupting.
   *
   * Take for example:
   *
   * ```markdown
   * a
   * # b
   * ```
   *
   * At 2:1, we’re “interrupting”.
   */
  interrupt?: boolean | undefined;

  /**
   * The relevant parsing context.
   */
  parser: ParseContext;

  /**
   * The previous code.
   */
  previous: Code;

  /**
   * Define a skip
   *
   * As containers (block quotes, lists), “nibble” a prefix from the margins,
   * where a line starts after that prefix is defined here.
   * When the tokenizers moves after consuming a line ending corresponding to
   * the line number in the given point, the tokenizer shifts past the prefix
   * based on the column in the shifted point.
   *
   * @param point
   *   Skip.
   */
  defineSkip(point: Point): undefined;

  /**
   * Get the current place.
   *
   * @returns
   *   Current point.
   */
  now(): Point;

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

  /**
   * Get the chunks that span a token (or location).
   *
   * @param token
   *   Start/end in stream.
   * @returns
   *   List of chunks.
   */
  sliceStream(token: Token.Range): Array<Chunk>;

  /**
   * Write a slice of chunks.
   *
   * The eof code (`null`) can be used to signal the end of the stream.
   *
   * @param slice
   *   Chunks.
   * @returns
   *   Events.
   */
  write(slice: Array<Chunk>): Array<Event>;
}

/**
 * Encodings supported by `TextEncoder`.
 *
 * Arbitrary encodings can be supported depending on how the engine is built.
 * So any string *could* be valid.
 * But you probably want `utf-8`.
 */
export type Encoding =
  // Encodings supported in Node by default or when built with the small-icu option.
  // Does not include aliases.
  | 'utf-8' // Always supported in Node.
  | 'utf-16le' // Always supported in Node.
  | 'utf-16be' // Not supported when ICU is disabled.
  // Everything else (depends on browser, or full ICU data).
  | (string & {});

/**
 * Contents of the file.
 *
 * Can either be text, or a `Uint8Array` like structure.
 */
export type Value = Uint8Array | string;

/**
 * A syntax extension changes how markdown is tokenized.
 *
 * See: <https://github.com/micromark/micromark#syntaxextension>
 */
export interface Extension {
  attentionMarkers?: { null?: Array<Code> | undefined } | undefined;
  contentInitial?: ConstructRecord | undefined;
  disable?: { null?: Array<string> | undefined } | undefined;
  document?: ConstructRecord | undefined;
  flowInitial?: ConstructRecord | undefined;
  flow?: ConstructRecord | undefined;
  insideSpan?: { null?: Array<Construct.Resolvable> | undefined } | undefined;
  string?: ConstructRecord | undefined;
  text?: ConstructRecord | undefined;
}

/** A grammar with every construct table present. */
export interface FullNormalizedExtension {
  attentionMarkers: { null?: Array<Code> | undefined };
  contentInitial: ConstructRecord;
  disable: { null?: Array<string> | undefined };
  document: ConstructRecord;
  flowInitial: ConstructRecord;
  flow: ConstructRecord;
  insideSpan: { null?: Array<Construct.Resolvable> | undefined };
  string: ConstructRecord;
  text: ConstructRecord;
}

/**
 * Create a context.
 *
 * @param from
 *   Where to create from.
 * @returns
 *   Context.
 */
export type Create = (from?: Point.Source | undefined) => TokenizeContext;

/**
 * Config defining how to parse.
 */
export interface ParseOptions {
  /**
   * Array of syntax extensions (default: `[]`).
   */
  extensions?: Array<Extension> | null | undefined;
}

/**
 * A context object that helps w/ parsing markdown.
 */
export interface ReferenceQuestion {
  kind: 'definitions' | 'footnotes';
  label: string;
  offset: number;
}

export interface ParseContext {
  /** Kagami: attempts survive tokenizer rollback, since misses are dependencies too. */
  references: Array<ReferenceQuestion>;

  /** Apply the explicitly enabled CJK delimiter extension. */
  cjkFriendly?: boolean;
  /** Kagami: what the text is read for. */
  target?: Target | undefined;
  /**
   * All constructs.
   */
  constructs: FullNormalizedExtension;

  /**
   * List of defined identifiers.
   */
  defined: Array<string>;

  /**
   * Registered GFM footnote identifiers.
   */
  gfmFootnotes?: Array<string> | undefined;

  /** Kagami: bindings outside this reading, looked up only at a reference. */
  bindings?: Bindings | undefined;

  /**
   * Map of line numbers to whether they are lazy (as opposed to the line before
   * them).
   * Take for example:
   *
   * ```markdown
   * > a
   * b
   * ```
   *
   * L1 here is not lazy, L2 is.
   */
  lazy: Record<number, boolean>;

  /**
   * Create a content tokenizer.
   */
  content: Create;

  /**
   * Create a document tokenizer.
   */
  document: Create;

  /**
   * Create a flow tokenizer.
   */
  flow: Create;

  /**
   * Create a string tokenizer.
   */
  string: Create;

  /**
   * Create a text tokenizer.
   */
  text: Create;
}

/**
 * HTML compiler context.
 */
export interface CompileContext extends CompileContext.Document {
  /**
   * Get the string value of a token.
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
  /** HTML output context available outside an individual token. */
  export interface Document {
    /**
     * Configuration passed by the user.
     */
    options: CompileOptions;

    /**
     * Capture some of the output data.
     */
    buffer(): undefined;

    /**
     * Make a value safe for injection in HTML (except w/ `ignoreEncode`).
     *
     * @param value
     *   Raw value.
     * @returns
     *   Safe value.
     */
    encode(value: string): string;

    /**
     * Get data from the key-value store.
     *
     * @param key
     *   Key.
     * @returns
     *   Value at `key` in compile data.
     */
    getData<Key extends keyof CompileData>(key: Key): CompileData[Key];

    /**
     * Output an extra line ending if the previous value wasn’t EOF/EOL.
     */
    lineEndingIfNeeded(): undefined;

    /**
     * Output raw data.
     *
     * @param value
     *   Raw value.
     */
    raw(value: string): undefined;

    /**
     * Stop capturing and access the output data.
     *
     * @returns
     *   Captured data.
     */
    resume(): string;

    /**
     * Set data into the key-value store.
     *
     * @param key
     *   Key.
     * @param value
     *   Value.
     */
    setData<Key extends keyof CompileData>(key: Key, value?: CompileData[Key]): undefined;



    /**
     * Output (parts of) HTML tags.
     *
     * @param value
     *   Raw value.
     */
    tag(value: string): undefined;
  }
}

/**
 * Serialize micromark events as HTML.
 */
export type Compile = (events: Array<Event>) => string;

/**
 * Handle one token.
 *
 * @param token
 *   Token.
 */
export type Handle = (this: CompileContext, token: Token) => undefined;

/**
 * Handle the whole document.
 */
export type DocumentHandle = (this: CompileContext.Document) => undefined;

/**
 * Token types mapping to handles.
 */
export interface Handles extends Partial<Record<TokenType, Handle>> {
  /**
   * Document handle.
   */
  null?: DocumentHandle;
}

/**
 * Normalized extenion.
 */
export interface HTMLExtension {
  enter?: Handles | undefined;
  exit?: Handles | undefined;
}

/**
 * An HTML extension changes how markdown tokens are serialized.
 */
export interface NormalizedHTMLExtension {
  enter: Handles;
  exit: Handles;
}

/**
 * Definition.
 */
export interface Definition {
  /**
   * Destination.
   */
  destination?: string | undefined;
  /**
   * Title.
   */
  title?: string | undefined;
}

/**
 * State tracked to compile events as HTML.
 */
export interface CompileData {
  /**
   * Whether the first list item is expected, used by lists.
   */
  expectFirstItem?: boolean | undefined;

  /**
   * Current character reference kind.
   */
  characterReferenceType?: string | undefined;

  /**
   * Collected definitions.
   */
  definitions: Record<string, Definition>;

  /**
   * Whether we’re in fenced code, used by code (fenced).
   */
  fencedCodeInside?: boolean | undefined;

  /**
   * Number of fences that were seen, used by code (fenced).
   */
  fencesCount?: number | undefined;

  /**
   * Whether we’ve seen code data, used by code (fenced, indented).
   */
  flowCodeSeenData?: boolean | undefined;

  /**
   * Current heading rank, used by heading (atx, setext).
   */
  headingRank?: number | undefined;

  /**
   * Ignore encoding unsafe characters, used for example for URLs which are
   * first percent encoded, or by HTML when supporting it.
   */
  ignoreEncode?: boolean | undefined;

  /**
   * Whether we’re in code data, used by code (text).
   */
  inCodeText?: boolean | undefined;

  /**
   * Whether the last emitted value was a tag.
   */
  lastWasTag?: boolean | undefined;

  /**
   * Whether to slurp all future line endings (has to be unset manually).
   */
  slurpAllLineEndings?: boolean | undefined;

  /**
   * Whether to slurp the next line ending (resets itself on the next line
   * ending).
   */
  slurpOneLineEnding?: boolean | undefined;

  /**
   * Stack of containers, whether they’re tight or not.
   */
  tightStack: Array<boolean>;
}

/**
 * Type of line ending in markdown.
 */
export type LineEnding = '\r' | '\n' | '\r\n';

/**
 * Compile options.
 */
export interface CompileOptions {
  /**
   * Whether to allow (dangerous) HTML (`boolean`, default: `false`).
   *
   * The default is `false`, which still parses the HTML according to
   * `CommonMark` but shows the HTML as text instead of as elements.
   *
   * Pass `true` for trusted content to get actual HTML elements.
   */
  allowDangerousHTML?: boolean | null | undefined;

  /**
   * Whether to allow dangerous protocols in links and images (`boolean`,
   * default: `false`).
   *
   * The default is `false`, which drops URLs in links and images that use
   * dangerous protocols.
   *
   * Pass `true` for trusted content to support all protocols.
   *
   * URLs that have no protocol (which means it’s relative to the current page,
   * such as `./some/page.html`) and URLs that have a safe protocol (for
   * images: `http`, `https`; for links: `http`, `https`, `irc`, `ircs`,
   * `mailto`, `xmpp`), are safe.
   * All other URLs are dangerous and dropped.
   */
  allowDangerousProtocol?: boolean | null | undefined;

  /**
   * Default line ending to use when compiling to HTML, for line endings not in
   * `value`.
   *
   * Generally, `micromark` copies line endings (`\r`, `\n`, `\r\n`) in the
   * markdown document over to the compiled HTML.
   * In some cases, such as `> a`, CommonMark requires that extra line endings
   * are added: `<blockquote>\n<p>a</p>\n</blockquote>`.
   *
   * To create that line ending, the document is checked for the first line
   * ending that is used.
   * If there is no line ending, `defaultLineEnding` is used.
   * If that isn’t configured, `\n` is used.
   */
  defaultLineEnding?: LineEnding | null | undefined;

  /**
   * Array of HTML extensions (default: `[]`).
   */
  htmlExtensions?: Array<HTMLExtension> | null | undefined;
}

/**
 * Configuration.
 */
export type Options = CompileOptions & ParseOptions;

/**
 * Enum of allowed token types.
 */
export type TokenType = keyof TokenTypeMap;

// Note: when changing the next interface, you likely also have to change
// `micromark-util-symbol`.
/**
 * Map of allowed token types.
 */
export interface TokenTypeMap {
  // Token names from the table and math constructs taken into this package.
  table: 'table';
  tableHead: 'tableHead';
  tableBody: 'tableBody';
  tableRow: 'tableRow';
  tableHeader: 'tableHeader';
  tableData: 'tableData';
  tableContent: 'tableContent';
  tableDelimiterRow: 'tableDelimiterRow';
  tableDelimiter: 'tableDelimiter';
  tableDelimiterMarker: 'tableDelimiterMarker';
  tableDelimiterFiller: 'tableDelimiterFiller';
  tableCellDivider: 'tableCellDivider';
  mathFlow: 'mathFlow';
  mathFlowFence: 'mathFlowFence';
  mathFlowFenceSequence: 'mathFlowFenceSequence';
  mathFlowFenceMeta: 'mathFlowFenceMeta';
  mathFlowValue: 'mathFlowValue';
  mathText: 'mathText';
  mathTextSequence: 'mathTextSequence';
  mathTextData: 'mathTextData';
  mathTextPadding: 'mathTextPadding';

  // Kagami: the front matter of a document.
  frontmatter: 'frontmatter';
  frontmatterFence: 'frontmatterFence';
  frontmatterData: 'frontmatterData';

  // Kagami: constructs for the text of one field read on its own.
  atxHeadingClosing: 'atxHeadingClosing';
  atxHeadingClosingSequence: 'atxHeadingClosingSequence';
  atxHeadingClosingWhitespace: 'atxHeadingClosingWhitespace';
  atxHeadingClosingWhitespaceBefore: 'atxHeadingClosingWhitespaceBefore';
  inlineSourceLinkDefinitionTitleCandidate: 'inlineSourceLinkDefinitionTitleCandidate';
  inlineSourceLinkDefinitionTitleDelimiter: 'inlineSourceLinkDefinitionTitleDelimiter';
  inlineSourceLinkDefinitionTitleWhitespace: 'inlineSourceLinkDefinitionTitleWhitespace';
  inlineSourceTaskMarker: 'inlineSourceTaskMarker';
  inlineSourceTaskMarkerBoundary: 'inlineSourceTaskMarkerBoundary';
  inlineSourceTaskMarkerChecked: 'inlineSourceTaskMarkerChecked';
  inlineSourceTaskMarkerUnchecked: 'inlineSourceTaskMarkerUnchecked';
  inlineSourceTaskMarkerWhitespace: 'inlineSourceTaskMarkerWhitespace';

  // Note: these are compiled away.
  attentionSequence: 'attentionSequence'; // To do: remove.
  space: 'space'; // To do: remove.

  data: 'data';
  // ZWSP edge mark: The file-only token is a candidate; only projection decides its ownership.
  edgeMarkCandidate: 'edgeMarkCandidate';
  whitespace: 'whitespace';
  lineEnding: 'lineEnding';
  lineEndingBlank: 'lineEndingBlank';
  linePrefix: 'linePrefix';
  lineSuffix: 'lineSuffix';
  atxHeading: 'atxHeading';
  atxHeadingSequence: 'atxHeadingSequence';
  atxHeadingText: 'atxHeadingText';
  autolink: 'autolink';
  autolinkEmail: 'autolinkEmail';
  autolinkMarker: 'autolinkMarker';
  autolinkProtocol: 'autolinkProtocol';
  characterEscape: 'characterEscape';
  characterEscapeValue: 'characterEscapeValue';
  characterReference: 'characterReference';
  characterReferenceMarker: 'characterReferenceMarker';
  characterReferenceMarkerNumeric: 'characterReferenceMarkerNumeric';
  characterReferenceMarkerHexadecimal: 'characterReferenceMarkerHexadecimal';
  characterReferenceValue: 'characterReferenceValue';
  codeFenced: 'codeFenced';
  codeFencedFence: 'codeFencedFence';
  codeFencedFenceSequence: 'codeFencedFenceSequence';
  codeFencedFenceInfo: 'codeFencedFenceInfo';
  codeFencedFenceMeta: 'codeFencedFenceMeta';
  codeFlowValue: 'codeFlowValue';
  codeIndented: 'codeIndented';
  codeText: 'codeText';
  codeTextData: 'codeTextData';
  codeTextPadding: 'codeTextPadding';
  codeTextSequence: 'codeTextSequence';
  content: 'content';
  definition: 'definition';
  definitionDestination: 'definitionDestination';
  definitionDestinationLiteral: 'definitionDestinationLiteral';
  definitionDestinationLiteralMarker: 'definitionDestinationLiteralMarker';
  definitionDestinationRaw: 'definitionDestinationRaw';
  definitionDestinationString: 'definitionDestinationString';
  definitionLabel: 'definitionLabel';
  definitionLabelMarker: 'definitionLabelMarker';
  definitionLabelString: 'definitionLabelString';
  definitionMarker: 'definitionMarker';
  definitionTitle: 'definitionTitle';
  definitionTitleMarker: 'definitionTitleMarker';
  definitionTitleString: 'definitionTitleString';
  emphasis: 'emphasis';
  emphasisSequence: 'emphasisSequence';
  emphasisText: 'emphasisText';
  escapeMarker: 'escapeMarker';
  hardBreakEscape: 'hardBreakEscape';
  hardBreakTrailing: 'hardBreakTrailing';
  htmlFlow: 'htmlFlow';
  htmlFlowData: 'htmlFlowData';
  htmlText: 'htmlText';
  htmlTextData: 'htmlTextData';
  image: 'image';
  label: 'label';
  labelText: 'labelText';
  labelLink: 'labelLink';
  labelImage: 'labelImage';
  labelMarker: 'labelMarker';
  labelImageMarker: 'labelImageMarker';
  labelEnd: 'labelEnd';
  link: 'link';
  paragraph: 'paragraph';
  reference: 'reference';
  referenceMarker: 'referenceMarker';
  referenceString: 'referenceString';
  resource: 'resource';
  resourceDestination: 'resourceDestination';
  resourceDestinationLiteral: 'resourceDestinationLiteral';
  resourceDestinationLiteralMarker: 'resourceDestinationLiteralMarker';
  resourceDestinationRaw: 'resourceDestinationRaw';
  resourceDestinationString: 'resourceDestinationString';
  resourceMarker: 'resourceMarker';
  resourceTitle: 'resourceTitle';
  resourceTitleMarker: 'resourceTitleMarker';
  resourceTitleString: 'resourceTitleString';
  setextHeading: 'setextHeading';
  setextHeadingText: 'setextHeadingText';
  setextHeadingLine: 'setextHeadingLine';
  setextHeadingLineSequence: 'setextHeadingLineSequence';
  strong: 'strong';
  strongSequence: 'strongSequence';
  strongText: 'strongText';
  thematicBreak: 'thematicBreak';
  thematicBreakSequence: 'thematicBreakSequence';
  blockQuote: 'blockQuote';
  blockQuotePrefix: 'blockQuotePrefix';
  blockQuoteMarker: 'blockQuoteMarker';
  blockQuotePrefixWhitespace: 'blockQuotePrefixWhitespace';
  listOrdered: 'listOrdered';
  listUnordered: 'listUnordered';
  listItemIndent: 'listItemIndent';
  listItemMarker: 'listItemMarker';
  listItemPrefix: 'listItemPrefix';
  listItemPrefixWhitespace: 'listItemPrefixWhitespace';
  listItemValue: 'listItemValue';
  // Kagami: no construct makes it. The pass that finds list items inserts it, as
  // `mdast-util-from-markdown` does (`prepareList` in `compile/tree.ts`).
  listItem: 'listItem';
  chunkDocument: 'chunkDocument';
  chunkContent: 'chunkContent';
  chunkFlow: 'chunkFlow';
  chunkText: 'chunkText';
  chunkString: 'chunkString';
  gfmFootnoteCall: 'gfmFootnoteCall';
  gfmFootnoteCallLabelMarker: 'gfmFootnoteCallLabelMarker';
  gfmFootnoteCallMarker: 'gfmFootnoteCallMarker';
  gfmFootnoteCallString: 'gfmFootnoteCallString';
  gfmFootnoteDefinition: 'gfmFootnoteDefinition';
  gfmFootnoteDefinitionIndent: 'gfmFootnoteDefinitionIndent';
  gfmFootnoteDefinitionLabel: 'gfmFootnoteDefinitionLabel';
  gfmFootnoteDefinitionLabelMarker: 'gfmFootnoteDefinitionLabelMarker';
  gfmFootnoteDefinitionLabelString: 'gfmFootnoteDefinitionLabelString';
  gfmFootnoteDefinitionMarker: 'gfmFootnoteDefinitionMarker';
  gfmFootnoteDefinitionWhitespace: 'gfmFootnoteDefinitionWhitespace';
  literalAutolink: 'literalAutolink';
  literalAutolinkEmail: 'literalAutolinkEmail';
  literalAutolinkHTTP: 'literalAutolinkHTTP';
  literalAutolinkWWW: 'literalAutolinkWWW';
  strikethrough: 'strikethrough';
  strikethroughSequence: 'strikethroughSequence';
  strikethroughSequenceTemporary: 'strikethroughSequenceTemporary';
  strikethroughText: 'strikethroughText';
  taskListCheck: 'taskListCheck';
  taskListCheckMarker: 'taskListCheckMarker';
  taskListCheckValueChecked: 'taskListCheckValueChecked';
  taskListCheckValueUnchecked: 'taskListCheckValueUnchecked';
  wikilink: 'wikilink';
  wikilinkAlias: 'wikilinkAlias';
  wikilinkAliasMarker: 'wikilinkAliasMarker';
  wikilinkData: 'wikilinkData';
  wikilinkMarker: 'wikilinkMarker';
  wikilinkTarget: 'wikilinkTarget';
}
