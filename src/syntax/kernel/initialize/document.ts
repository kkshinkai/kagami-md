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
  Code,
  Construct,
  ContainerState,
  Effects,
  InitialConstruct,
  Point,
  State,
  Token,
  TokenizeContext
} from '../../types/index.js';
import { assert } from '../assert.js';
import { factorySpace } from '../factories/space/index.js';
import { markdownLineEnding } from '../utils/character/index.js';
import { splice } from '../utils/chunked/index.js';
import { codes, constants, types } from '../utils/symbol/index.js';

/**
 * Construct and its state.
 */
type StackItem = [Construct, ContainerState];

export const document: InitialConstruct = { tokenize: initializeDocument };

const containerConstruct: Construct = { tokenize: tokenizeContainer };

function initializeDocument(this: TokenizeContext, effects: Effects): State {
  const self = this;
  const stack: Array<StackItem> = [];
  let continued = 0;
  let childFlow: TokenizeContext | undefined;
  let childToken: Token | undefined;
  let lineStartOffset: number;

  return start;

  function start(code: Code): State | undefined {
    // First we iterate through the open blocks, starting with the root
    // document, and descending through last children down to the last open
    // block.
    // Each block imposes a condition that the line must satisfy if the block is
    // to remain open.
    // For example, a block quote requires a `>` character.
    // A paragraph requires a non-blank line.
    // In this phase we may match all or just some of the open blocks.
    // But we cannot close unmatched blocks yet, because we may have a lazy
    // continuation line.
    if (continued < stack.length) {
      const item = stack[continued];
      self.containerState = item[1];
      assert(
        item[0].continuation,
        'expected `continuation` to be defined on container construct'
      );
      return effects.attempt(
        item[0].continuation,
        documentContinue,
        checkNewContainers
      )(code);
    }

    // Done.
    return checkNewContainers(code);
  }

  function documentContinue(code: Code): State | undefined {
    assert(
      self.containerState,
      'expected `containerState` to be defined after continuation'
    );

    continued++;

    // Note: this field is called `_closeFlow` but it also closes containers.
    // Perhaps a good idea to rename it but it’s already used in the wild by
    // extensions.
    if (self.containerState._closeFlow) {
      self.containerState._closeFlow = undefined;

      if (childFlow) {
        closeFlow();
      }

      // Note: this algorithm for moving events around is similar to the
      // algorithm when dealing with lazy lines in `writeToChild`.
      const indexBeforeExits = self.events.length;
      let indexBeforeFlow = indexBeforeExits;
      let point: Point | undefined;

      // Find the flow chunk.
      while (indexBeforeFlow--) {
        if (
          self.events[indexBeforeFlow][0] === 'exit' &&
          self.events[indexBeforeFlow][1].type === types.chunkFlow
        ) {
          point = self.events[indexBeforeFlow][1].end;
          break;
        }
      }

      assert(point, 'could not find previous flow chunk');

      exitContainers(continued);

      // Fix positions.
      let index = indexBeforeExits;

      while (index < self.events.length) {
        self.events[index][1].end = { ...point };
        index++;
      }

      // Inject the exits earlier (they’re still also at the end).
      splice(
        self.events,
        indexBeforeFlow + 1,
        0,
        self.events.slice(indexBeforeExits)
      );

      // Discard the duplicate exits.
      self.events.length = index;

      return checkNewContainers(code);
    }

    return start(code);
  }

  function checkNewContainers(code: Code): State | undefined {
    // Next, after consuming the continuation markers for existing blocks, we
    // look for new block starts (e.g. `>` for a block quote).
    // If we encounter a new block start, we close any blocks unmatched in
    // step 1 before creating the new block as a child of the last matched
    // block.
    if (continued === stack.length) {
      // No need to `check` whether there’s a container, of `exitContainers`
      // would be moot.
      // We can instead immediately `attempt` to parse one.
      if (!childFlow) {
        return documentContinued(code);
      }

      // If we have concrete content, such as block HTML or fenced code,
      // we can’t have containers “pierce” into them, so we can immediately
      // start.
      if (childFlow.currentConstruct && childFlow.currentConstruct.concrete) {
        return flowStart(code);
      }

      // If we do have flow, it could still be a blank line,
      // but we’d be interrupting it w/ a new container if there’s a current
      // construct.
      // To do: next major: remove `_gfmTableDynamicInterruptHack` (no longer
      // needed in micromark-extension-gfm-table@1.0.6).
      self.interrupt = Boolean(
        // Kagami: a nonindented container opening ends indented code; it is
        // not a paragraph interruption (CommonMark 4.4 and 5.2). The code's
        // lookahead can still be active across the preceding blank lines.
        childFlow.currentConstruct && childFlow.currentConstruct.name !== 'codeIndented' &&
        !childFlow._gfmTableDynamicInterruptHack
      );
    }

    // Check if there is a new container.
    self.containerState = {};
    return effects.check(
      containerConstruct,
      thereIsANewContainer,
      thereIsNoNewContainer
    )(code);
  }

  function thereIsANewContainer(code: Code): State | undefined {
    if (childFlow) closeFlow();
    exitContainers(continued);
    return documentContinued(code);
  }

  function thereIsNoNewContainer(code: Code): State | undefined {
    self.parser.lazy[self.now().line] = continued !== stack.length;
    lineStartOffset = self.now().offset;
    return flowStart(code);
  }

  function documentContinued(code: Code): State | undefined {
    // Try new containers.
    self.containerState = {};
    return effects.attempt(
      containerConstruct,
      containerContinue,
      flowStart
    )(code);
  }

  function containerContinue(code: Code): State | undefined {
    assert(
      self.currentConstruct,
      'expected `currentConstruct` to be defined on tokenizer'
    );
    assert(
      self.containerState,
      'expected `containerState` to be defined on tokenizer'
    );
    // Kagami: a document lookahead opens no container. Pass the flow it
    // confirmed to the child, leaving token production at the checked point.
    if (self.currentConstruct.flow) {
      childFlow = self.parser.flow(self.now());
      childFlow._checkedConstruct = self.currentConstruct.flow;
      return flowStart(code);
    }

    continued++;
    stack.push([self.currentConstruct, self.containerState]);
    // Try another.
    return documentContinued(code);
  }

  function flowStart(code: Code): State | undefined {
    if (code === codes.eof) {
      if (childFlow) closeFlow();
      exitContainers(0);
      effects.consume(code);
      return;
    }

    childFlow = childFlow || self.parser.flow(self.now());
    effects.enter(types.chunkFlow, {
      _tokenizer: childFlow,
      contentType: constants.contentTypeFlow,
      previous: childToken,
    });

    return flowContinue(code);
  }

  function flowContinue(code: Code): State | undefined {
    if (code === codes.eof) {
      writeToChild(effects.exit(types.chunkFlow), true);
      exitContainers(0);
      effects.consume(code);
      return;
    }

    if (markdownLineEnding(code)) {
      effects.consume(code);
      writeToChild(effects.exit(types.chunkFlow));
      // Get ready for the next line.
      continued = 0;
      self.interrupt = undefined;
      return start;
    }

    effects.consume(code);
    return flowContinue;
  }

  /**
   * @param token
   *   Token.
   * @param endOfFile
   *   Whether the token is at the end of the file (default: `false`).
   */
  function writeToChild(token: Token, endOfFile?: boolean | undefined): undefined {
    assert(childFlow, 'expected `childFlow` to be defined when continuing');
    const stream = self.sliceStream(token);
    if (endOfFile) stream.push(null);
    token.previous = childToken;
    if (childToken) childToken.next = token;

    // Kagami: the head of a callout is read only on the first line of the
    // content of a block quote: the first line of a flow that opened in it.
    if (!childToken && stack.length > 0 && stack[stack.length - 1][0].name === types.blockQuote) {
      childFlow._calloutFirstContentOfBlockQuote = true;
    }

    childToken = token;
    childFlow.defineSkip(token.start);
    childFlow.write(stream);
    childFlow._calloutFirstContentOfBlockQuote = undefined;

    // Alright, so we just added a lazy line:
    //
    // ```markdown
    // > a
    // b.
    //
    // Or:
    //
    // > ~~~c
    // d
    //
    // Or:
    //
    // > | e |
    // f
    // ```
    //
    // The construct in the second example (fenced code) does not accept lazy
    // lines, so it marked itself as done at the end of its first line, and
    // then the content construct parses `d`.
    // Most constructs in markdown match on the first line: if the first line
    // forms a construct, a non-lazy line can’t “unmake” it.
    //
    // The construct in the third example is potentially a GFM table, and
    // those are *weird*.
    // It *could* be a table, from the first line, if the following line
    // matches a condition.
    // In this case, that second line is lazy, which “unmakes” the first line
    // and turns the whole into one content block.
    //
    // We’ve now parsed the non-lazy and the lazy line, and can figure out
    // whether the lazy line started a new flow block.
    // If it did, we exit the current containers between the two flow blocks.
    if (self.parser.lazy[token.start.line]) {
      let index = childFlow.events.length;

      while (index--) {
        if (
          // The token starts before the line ending…
          childFlow.events[index][1].start.offset < lineStartOffset &&
          // …and either is not ended yet…
          (!childFlow.events[index][1].end ||
            // …or ends after it.
            childFlow.events[index][1].end.offset > lineStartOffset)
        ) {
          // Exit: there’s still something open, which means it’s a lazy line
          // part of something.
          return;
        }
      }

      // Note: this algorithm for moving events around is similar to the
      // algorithm when closing flow in `documentContinue`.
      const indexBeforeExits = self.events.length;
      let indexBeforeFlow = indexBeforeExits;
      let seen: boolean | undefined;
      let point: Point | undefined;

      // Find the previous chunk (the one before the lazy line).
      while (indexBeforeFlow--) {
        if (
          self.events[indexBeforeFlow][0] === 'exit' &&
          self.events[indexBeforeFlow][1].type === types.chunkFlow
        ) {
          if (seen) {
            point = self.events[indexBeforeFlow][1].end;
            break;
          }

          seen = true;
        }
      }

      assert(point, 'could not find previous flow chunk');

      exitContainers(continued);

      // Fix positions.
      index = indexBeforeExits;

      while (index < self.events.length) {
        self.events[index][1].end = { ...point };
        index++;
      }

      // Inject the exits earlier (they’re still also at the end).
      splice(
        self.events,
        indexBeforeFlow + 1,
        0,
        self.events.slice(indexBeforeExits)
      );

      // Discard the duplicate exits.
      self.events.length = index;
    }
  }

  /**
   * @param size
   *   Size.
   */
  function exitContainers(size: number): undefined {
    let index = stack.length;

    // Exit open containers.
    while (index-- > size) {
      const entry = stack[index];
      self.containerState = entry[1];
      assert(
        entry[0].exit,
        'expected `exit` to be defined on container construct'
      );
      entry[0].exit.call(self, effects);
    }

    stack.length = size;
  }

  function closeFlow() {
    assert(
      self.containerState,
      'expected `containerState` to be defined when closing flow'
    );
    assert(childFlow, 'expected `childFlow` to be defined when closing it');
    childFlow.write([codes.eof]);
    childToken = undefined;
    childFlow = undefined;
    self.containerState._closeFlow = undefined;
  }
}

function tokenizeContainer(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
  // Always populated by defaults.
  assert(
    this.parser.constructs.disable.null,
    'expected `disable.null` to be populated'
  );
  return factorySpace(
    effects,
    effects.attempt(this.parser.constructs.document, ok, nok),
    types.linePrefix,
    this.parser.constructs.disable.null.includes('codeIndented')
      ? undefined
      : constants.tabSize
  );
}
