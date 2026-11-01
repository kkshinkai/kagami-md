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
  Chunk,
  Code,
  Construct,
  ConstructRecord,
  Effects,
  Event,
  InitialConstruct,
  ParseContext,
  Point,
  State,
  Token,
  TokenizeContext,
  TokenType
} from '../types/index.js';
import createDebug from 'debug';
import { assert } from './assert.js';
import { markdownLineEnding } from './utils/character/index.js';
import { push, splice } from './utils/chunked/index.js';
import { resolveAll } from './utils/resolve-all/index.js';
import { codes, values } from './utils/symbol/index.js';

/**
 * Restore the state.
 */
type Restore = () => undefined;

/**
 * Info.
 */
type Info = {
  /**
   * Restore.
   */
  restore: Restore;
  /**
   * From.
   */
  from: number;
};

/**
 * Handle a successful run.
 *
 * @param construct
 *   Construct.
 * @param info
 *   Info.
 */
type ReturnHandle = (construct: Construct, info: Info) => undefined;

const debug = createDebug('micromark');

/**
 * Create a tokenizer.
 * Tokenizers deal with one type of data (e.g., containers, flow, text).
 * The parser is the object dealing with it all.
 * `initialize` works like other constructs, except that only its `tokenize`
 * function is used, in which case it doesn’t receive an `ok` or `nok`.
 * `from` can be given to set the point before the first character, although
 * when further lines are indented, they must be set with `defineSkip`.
 *
 * @param parser
 *   Parser.
 * @param initialize
 *   Construct.
 * @param from
 *   Point (optional).
 * @returns
 *   Context.
 */
export function createTokenizer(
  parser: ParseContext,
  initialize: InitialConstruct,
  from?: Point.Source | undefined
): TokenizeContext {
  let point: Point = {
    _bufferIndex: -1,
    _index: 0,
    line: (from && from.line) || 1,
    column: (from && from.column) || 1,
    offset: (from && from.offset) || 0,
  };
  const columnStart: Record<string, number> = {};
  const resolveAllConstructs: Array<Construct> = [];
  let chunks: Array<Chunk> = [];
  let stack: Array<Token> = [];
  let consumed: boolean | undefined = true;

  /**
   * Tools used for tokenizing.
   */
  const effects: Effects = {
    attempt: constructFactory(onsuccessfulconstruct),
    check: constructFactory(onsuccessfulcheck),
    consume,
    enter,
    exit,
    interrupt: constructFactory(onsuccessfulcheck, { interrupt: true }),
  };

  /**
   * State and tools for resolving and serializing.
   */
  const context: TokenizeContext = {
    code: codes.eof,
    containerState: {},
    defineSkip,
    events: [],
    now,
    parser,
    previous: codes.eof,
    sliceSerialize,
    sliceStream,
    tabColumns,
    write,
  };

  /**
   * The state function.
   */
  let state: State | undefined = initialize.tokenize.call(context, effects);

  /**
   * Track which character we expect to be consumed, to catch bugs.
   */
  let expectedCode: Code;

  if (initialize.resolveAll) {
    resolveAllConstructs.push(initialize);
  }

  return context;

  function write(slice: Array<Chunk>): Array<Event> {
    chunks = push(chunks, slice);

    main();

    // Exit if we’re not done, resolve might change stuff.
    if (chunks[chunks.length - 1] !== codes.eof) {
      return [];
    }

    addResult(initialize, 0);

    // Otherwise, resolve, and exit.
    context.events = resolveAll(resolveAllConstructs, context.events, context);

    return context.events;
  }

  //
  // Tools.
  //

  function sliceSerialize(token: Token.Range, expandTabs?: boolean | undefined): string {
    return serializeChunks(sliceStream(token), expandTabs);
  }

  function sliceStream(token: Token.Range): Array<Chunk> {
    return sliceChunks(chunks, token);
  }

  /**
   * Kagami: points count source characters, while tab stops count columns.
   * Count the virtual columns of tabs from this stream's start of the line,
   * independently of earlier queries. Leading virtual spaces belong to a tab
   * outside this stream and serialize as ordinary spaces.
   */
  function tabColumns(point: Point): number {
    let index = point._index;
    let extra = 0;
    let atTab = false;

    while (index > 0) {
      const chunk = chunks[index - 1];
      if (typeof chunk === 'number' && markdownLineEnding(chunk)) break;
      index--;
    }

    while (index < point._index) {
      const chunk = chunks[index++];

      if (chunk === codes.virtualSpace) {
        if (atTab) extra++;
      } else {
        atTab = chunk === codes.horizontalTab;
      }
    }

    return extra;
  }

  function now(): Point {
    // This is a hot path, so we clone manually instead of `Object.assign({}, point)`
    const { _bufferIndex, _index, line, column, offset } = point;
    return { _bufferIndex, _index, line, column, offset };
  }

  function defineSkip(value: Point): undefined {
    columnStart[value.line] = value.column;
    accountForPotentialSkip();
    debug('position: define skip: `%j`', point);
  }

  //
  // State management.
  //

  /**
   * Main loop (note that `_index` and `_bufferIndex` in `point` are modified by
   * `consume`).
   * Here is where we walk through the chunks, which either include strings of
   * several characters, or numerical character codes.
   * The reason to do this in a loop instead of a call is so the stack can
   * drain.
   */
  function main(): undefined {
    let chunkIndex: number;

    while (point._index < chunks.length) {
      const chunk = chunks[point._index];

      // If we’re in a buffer chunk, loop through it.
      if (typeof chunk === 'string') {
        chunkIndex = point._index;

        if (point._bufferIndex < 0) {
          point._bufferIndex = 0;
        }

        while (
          point._index === chunkIndex &&
          point._bufferIndex < chunk.length
        ) {
          go(chunk.charCodeAt(point._bufferIndex));
        }
      } else {
        go(chunk);
      }
    }
  }

  /**
   * Deal with one code.
   *
   * @param code
   *   Code.
   */
  function go(code: Code): undefined {
    assert(consumed === true, 'expected character to be consumed');
    consumed = undefined;
    debug('main: passing `%s` to %s', code, state && state.name);
    expectedCode = code;
    assert(typeof state === 'function', 'expected state');
    state = state(code);
  }

  function consume(code: Code): undefined {
    assert(code === expectedCode, 'expected given code to equal expected code');

    debug('consume: `%s`', code);

    assert(
      consumed === undefined,
      'expected code to not have been consumed: this might be because `return x(code)` instead of `return x` was used'
    );
    assert(
      code === null
        ? context.events.length === 0 ||
            context.events[context.events.length - 1][0] === 'exit'
        : context.events[context.events.length - 1][0] === 'enter',
      'expected last token to be open'
    );

    if (markdownLineEnding(code)) {
      point.line++;
      point.column = 1;
      point.offset += code === codes.carriageReturnLineFeed ? 2 : 1;
      accountForPotentialSkip();
      debug('position: after eol: `%j`', point);
    } else if (code !== codes.virtualSpace) {
      point.column++;
      point.offset++;
    }

    // Not in a string chunk.
    if (point._bufferIndex < 0) {
      point._index++;
    } else {
      point._bufferIndex++;

      // At end of string chunk.
      if (
        point._bufferIndex ===
        // Points w/ non-negative `_bufferIndex` reference
        // strings.
        (chunks[point._index] as string).length
      ) {
        point._bufferIndex = -1;
        point._index++;
      }
    }

    // Expose the previous character.
    context.previous = code;

    // Mark as consumed.
    consumed = true;
  }

  function enter(type: TokenType, fields?: Token.Fields | undefined): Token {
    // @ts-expect-error Patch instead of assign required fields to help GC.
    const token: Token = fields || {};
    token.type = type;
    token.start = now();

    assert(typeof type === 'string', 'expected string type');
    assert(type.length > 0, 'expected non-empty string');
    debug('enter: `%s`', type);

    context.events.push(['enter', token, context]);

    stack.push(token);

    return token;
  }

  function exit(type: TokenType): Token {
    assert(typeof type === 'string', 'expected string type');
    assert(type.length > 0, 'expected non-empty string');

    const token = stack.pop();
    assert(token, 'cannot close w/o open tokens');
    token.end = now();

    // Kagami: a physical ending stops before the next line's skipped container prefix.
    // Keep the cursor (and chunk coordinates) unchanged. (proposed, 2026-10-07)
    if ((type === 'lineEnding' || type === 'lineEndingBlank') && token.end.line > token.start.line) {
      token.end.offset -= token.end.column - 1;
      token.end.column = 1;
    }

    assert(type === token.type, 'expected exit token to match current token');

    assert(
      !(
        token.start._index === token.end._index &&
        token.start._bufferIndex === token.end._bufferIndex
      ),
      'expected non-empty token (`' + type + '`)'
    );

    debug('exit: `%s`', token.type);
    context.events.push(['exit', token, context]);

    return token;
  }

  /**
   * Use results.
   */
  function onsuccessfulconstruct(construct: Construct, info: Info): undefined {
    addResult(construct, info.from);
  }

  /**
   * Discard results.
   */
  function onsuccessfulcheck(_: Construct, info: Info): undefined {
    info.restore();
  }

  /**
   * Factory to attempt/check/interrupt.
   *
   * @param onreturn
   *   Callback.
   * @param fields
   *   Fields.
   */
  function constructFactory(onreturn: ReturnHandle, fields?: {interrupt?: boolean | undefined} | undefined) {
    return hook;

    /**
     * Handle either an object mapping codes to constructs, a list of
     * constructs, or a single construct.
     *
     * @param constructs
     *   Constructs.
     * @param returnState
     *   State.
     * @param bogusState
     *   State.
     * @returns
     *   State.
     */
    function hook(
      constructs: Array<Construct> | ConstructRecord | Construct,
      returnState: State,
      bogusState?: State | undefined
    ): State {
      let listOfConstructs: ReadonlyArray<Construct>;
      let constructIndex: number;
      let currentConstruct: Construct;
      let info: Info;

      return Array.isArray(constructs)
        ? /* c8 ignore next 1 */
          handleListOfConstructs(constructs)
        : 'tokenize' in constructs
          ? // Looks like a construct.
            handleListOfConstructs([constructs as Construct])
          : handleMapOfConstructs(constructs);

      /**
       * Handle a list of construct.
       *
       * @param map
       *   Constructs.
       * @returns
       *   State.
       */
      function handleMapOfConstructs(map: ConstructRecord): State {
        return start;

        function start(code: Code): State | undefined {
          const left = code !== null && map[code];
          const all = code !== null && map.null;
          const list = [
            // To do: add more extension tests.
            /* c8 ignore next 2 */
            ...(Array.isArray(left) ? left : left ? [left] : []),
            ...(Array.isArray(all) ? all : all ? [all] : []),
          ];

          return handleListOfConstructs(list)(code);
        }
      }

      /**
       * Handle a list of construct.
       *
       * @param list
       *   Constructs.
       * @returns
       *   State.
       */
      function handleListOfConstructs(list: ReadonlyArray<Construct>): State {
        listOfConstructs = list;
        constructIndex = 0;

        if (list.length === 0) {
          assert(bogusState, 'expected `bogusState` to be given');
          return bogusState;
        }

        return handleConstruct(list[constructIndex]);
      }

      /**
       * Handle a single construct.
       *
       * @param construct
       *   Construct.
       * @returns
       *   State.
       */
      function handleConstruct(construct: Construct): State {
        return start;

        function start(code: Code): State | undefined {
          // To do: not needed to store if there is no bogus state, probably?
          // Currently doesn’t work because `inspect` in document does a check
          // w/o a bogus, which doesn’t make sense. But it does seem to help perf
          // by not storing.
          info = store();
          currentConstruct = construct;

          if (!construct.partial) {
            context.currentConstruct = construct;
          }

          // Always populated by defaults.
          assert(
            context.parser.constructs.disable.null,
            'expected `disable.null` to be populated'
          );

          if (
            construct.name &&
            context.parser.constructs.disable.null.includes(construct.name)
          ) {
            return nok(code);
          }

          return construct.tokenize.call(
            // If we do have fields, create an object w/ `context` as its
            // prototype.
            // This allows a “live binding”, which is needed for `interrupt`.
            fields ? Object.assign(Object.create(context), fields) : context,
            effects,
            ok,
            nok
          )(code);
        }
      }

      function ok(code: Code): State | undefined {
        assert(code === expectedCode, 'expected code');
        consumed = true;
        onreturn(currentConstruct, info);
        return returnState;
      }

      function nok(code: Code): State | undefined {
        assert(code === expectedCode, 'expected code');
        consumed = true;
        info.restore();

        if (++constructIndex < listOfConstructs.length) {
          return handleConstruct(listOfConstructs[constructIndex]);
        }

        return bogusState;
      }
    }
  }

  /**
   * @param construct
   *   Construct.
   * @param from
   *   From.
   */
  function addResult(construct: Construct, from: number): undefined {
    if (construct.resolveAll && !resolveAllConstructs.includes(construct)) {
      resolveAllConstructs.push(construct);
    }

    if (construct.resolve) {
      splice(
        context.events,
        from,
        context.events.length - from,
        construct.resolve(context.events.slice(from), context)
      );
    }

    if (construct.resolveTo) {
      context.events = construct.resolveTo(context.events, context);
    }

    assert(
      construct.partial ||
        context.events.length === 0 ||
        context.events[context.events.length - 1][0] === 'exit',
      'expected last token to end'
    );
  }

  /**
   * Store state.
   *
   * @returns
   *   Info.
   */
  function store(): Info {
    const startPoint = now();
    const startPrevious = context.previous;
    const startCurrentConstruct = context.currentConstruct;
    const startEventsIndex = context.events.length;
    const startStack = Array.from(stack);

    return { from: startEventsIndex, restore };

    /**
     * Restore state.
     */
    function restore(): undefined {
      point = startPoint;
      context.previous = startPrevious;
      context.currentConstruct = startCurrentConstruct;
      context.events.length = startEventsIndex;
      stack = startStack;
      accountForPotentialSkip();
      debug('position: restore: `%j`', point);
    }
  }

  /**
   * Move the current point a bit forward in the line when it’s on a column
   * skip.
   */
  function accountForPotentialSkip(): undefined {
    if (point.line in columnStart && point.column < 2) {
      point.column = columnStart[point.line];
      point.offset += columnStart[point.line] - 1;
    }
  }
}

/**
 * Get the chunks from a slice of chunks in the range of a token.
 *
 * @param chunks
 *   Chunks.
 * @param token
 *   Token.
 * @returns
 *   Chunks.
 */
function sliceChunks(chunks: ReadonlyArray<Chunk>, token: Token.Range): Array<Chunk> {
  const startIndex = token.start._index;
  const startBufferIndex = token.start._bufferIndex;
  const endIndex = token.end._index;
  const endBufferIndex = token.end._bufferIndex;
  let view: Array<Chunk>;

  if (startIndex === endIndex) {
    assert(endBufferIndex > -1, 'expected non-negative end buffer index');
    assert(startBufferIndex > -1, 'expected non-negative start buffer index');
    // @ts-expect-error `_bufferIndex` is used on string chunks.
    view = [chunks[startIndex].slice(startBufferIndex, endBufferIndex)];
  } else {
    view = chunks.slice(startIndex, endIndex);

    if (startBufferIndex > -1) {
      const head = view[0];
      if (typeof head === 'string') {
        view[0] = head.slice(startBufferIndex);
        /* c8 ignore next 4 -- used to be used, no longer */
      } else {
        assert(startBufferIndex === 0, 'expected `startBufferIndex` to be `0`');
        view.shift();
      }
    }

    if (endBufferIndex > 0) {
      // @ts-expect-error `_bufferIndex` is used on string chunks.
      view.push(chunks[endIndex].slice(0, endBufferIndex));
    }
  }

  return view;
}

/**
 * Get the string value of a slice of chunks.
 *
 * @param chunks
 *   Chunks.
 * @param expandTabs
 *   Whether to expand tabs (default: `false`).
 * @returns
 *   Result.
 */
function serializeChunks(chunks: ReadonlyArray<Chunk>, expandTabs?: boolean | undefined): string {
  let index = -1;
  const result: Array<string> = [];
  let atTab: boolean | undefined;

  while (++index < chunks.length) {
    const chunk = chunks[index];
    let value: string;

    if (typeof chunk === 'string') {
      value = chunk;
    } else
      switch (chunk) {
        case codes.carriageReturn: {
          value = values.cr;

          break;
        }

        case codes.lineFeed: {
          value = values.lf;

          break;
        }

        case codes.carriageReturnLineFeed: {
          value = values.cr + values.lf;

          break;
        }

        case codes.horizontalTab: {
          value = expandTabs ? values.space : values.ht;

          break;
        }

        case codes.virtualSpace: {
          if (!expandTabs && atTab) continue;
          value = values.space;

          break;
        }

        default: {
          assert(typeof chunk === 'number', 'expected number');
          // Currently only replacement character.
          value = String.fromCharCode(chunk);
        }
      }

    atTab = chunk === codes.horizontalTab;
    result.push(value);
  }

  return result.join('');
}
