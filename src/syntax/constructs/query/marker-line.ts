/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type {
  Code,
  Construct,
  Effects,
  InitialConstruct,
  Point,
  State,
  Token,
  TokenizeContext
} from '../../types/index.js';
import { assert } from '../../kernel/assert.js';
import { list } from '../document/list.js';
import { text as taskChecks } from '../text/gfm-task-list-item.js';
import { blankLine } from '../../kernel/blank-line.js';
import { content } from '../../kernel/content.js';
import { factorySpace } from '../../kernel/factories/space/index.js';
import { codes, constants, types } from '../../kernel/utils/symbol/index.js';

/** Report the first construct opened and its position in the tokenizer stream. */
type OpeningHandler = (construct: Construct, point: Point) => void;

/** Ask about both openings at their positions in one preprocessed marker line. */
export function markerLine(prefixSize: number): InitialConstruct {
  return { tokenize: initializeMarkerLine };

  function initializeMarkerLine(this: TokenizeContext, effects: Effects): State {
    const self = this;
    const item: Construct = { partial: true, tokenize: tokenizeItem };
    const fit: Construct = { partial: true, tokenize: tokenizeFit };
    const attached = opening(prefixSize, remember);
    const child = opening(undefined, compare);
    let attachedConstruct: Construct;
    let attachedPoint: Point;
    let matches = false;
    let result: 'data' | 'markerLineFit' = types.data;

    return effects.check(fit, fits, dataStart);

    /** Remember the opening after the actual item prefix. */
    function remember(construct: Construct, point: Point): void {
      attachedConstruct = construct;
      attachedPoint = point;
    }

    /** Compare the opening at the supplied child boundary in the same stream. */
    function compare(construct: Construct, point: Point): void {
      // Stream positions also distinguish virtual spaces within one source tab.
      matches = construct === attachedConstruct &&
        point._index === attachedPoint._index &&
        point._bufferIndex === attachedPoint._bufferIndex;
    }

    function tokenizeFit(effects: Effects, ok: State, nok: State): State {
      return effects.check(item, prefixStart, nok);

      /**
       * Before replaying the supplied prefix after the item check rewinds.
       *
       * ```markdown
       * > | - [ ] text
       *     ^
       * ```
       */
      function prefixStart(code: Code): State | undefined {
        effects.enter(types.data);
        return prefix(code);
      }

      /**
       * Move to the child's supplied boundary in the same stream. Finish the
       * virtual spaces of a tab belonging to the prefix before asking there.
       *
       * ```markdown
       * > | - [ ] text
       *           ^
       * ```
       */
      function prefix(code: Code): State | undefined {
        if (self.now().offset === prefixSize && code !== codes.virtualSpace) {
          effects.exit(types.data);
          return effects.check(child, afterChild, nok)(code);
        }

        effects.consume(code);
        return prefix;
      }

      /**
       * At the supplied child boundary after its opening check has rewound.
       *
       * ```markdown
       * > | - [ ] text
       *           ^
       * ```
       */
      function afterChild(code: Code): State | undefined {
        return matches ? ok(code) : nok(code);
      }
    }

    function tokenizeItem(effects: Effects, ok: State, nok: State): State {
      self.containerState = {};
      return factorySpace(
        effects,
        effects.attempt(self.parser.constructs.document, afterList, nok),
        types.linePrefix,
        constants.tabSize,
      );

      /**
       * The list itself decides thematic-break precedence and how much of the
       * following whitespace it owns. Ask about the child exactly where it stops.
       *
       * ```markdown
       * > | -     code
       *       ^
       * ```
       */
      function afterList(code: Code): State | undefined {
        return self.currentConstruct === list
          ? effects.attempt(attached, ok, nok)(code)
          : nok(code);
      }
    }

    /**
     * Before the line, after both readings agreed on the child opening.
     *
     * ```markdown
     * > | - [ ] text
     *     ^
     * ```
     */
    function fits(code: Code): State | undefined {
      result = 'markerLineFit';
      return dataStart(code);
    }

    /**
     * Before the marker line, after the fit check has rewound.
     *
     * ```markdown
     * > | - [ ] text
     *     ^
     * ```
     */
    function dataStart(code: Code): State | undefined {
      effects.enter(result);
      return data(code);
    }

    /**
     * In the marker line, with its query answer recorded on the token.
     *
     * ```markdown
     * > | - [ ] text
     *           ^
     * ```
     */
    function data(code: Code): State | undefined {
      if (code === codes.eof) {
        effects.exit(result);
        effects.consume(code);
        return;
      }

      effects.consume(code);
      return data;
    }
  }
}

/** Follow document, flow and content opening order, stopping at the first child. */
function opening(
  taskBefore: number | undefined,
  found: OpeningHandler,
): Construct {
  return { partial: true, tokenize: tokenizeOpening };

  function tokenizeOpening(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
    const self = this;
    const container: Construct = { partial: true, tokenize: tokenizeContainer };
    const check: Construct = { partial: true, tokenize: tokenizeCheck };
    const eventStart = self.events.length;
    let start = self.now();
    self.containerState = {};
    return effects.check(container, ok, flowStart);

    function tokenizeContainer(effects: Effects, ok: State, nok: State): State {
      return factorySpace(effects, beforeContainer, types.linePrefix, constants.tabSize);

      /**
       * At the child opening, after optional container indentation.
       *
       * ```markdown
       * > | - > a
       *       ^
       * ```
       */
      function beforeContainer(code: Code): State | undefined {
        start = self.now();
        return effects.attempt(self.parser.constructs.document, containerOpened, nok)(code);
      }

      /**
       * After the recognized container prefix.
       *
       * ```markdown
       * > | - > a
       *         ^
       * ```
       */
      function containerOpened(code: Code): State | undefined {
        assert(self.currentConstruct, 'expected a container construct');
        found(self.currentConstruct, start);
        return ok(code);
      }
    }

    /**
     * At the child boundary, before checking blank and indented lines.
     *
     * ```markdown
     * > | - text
     *       ^
     * ```
     */
    function flowStart(code: Code): State | undefined {
      return effects.attempt(
        blankLine,
        blank,
        effects.attempt(self.parser.constructs.flowInitial, indented, prefixed),
      )(code);
    }

    /**
     * At the end of a blank child line.
     *
     * ```markdown
     * > | -␠
     *       ^
     * ```
     */
    function blank(code: Code): State | undefined {
      found(blankLine, self.now());
      return ok(code);
    }

    /**
     * After the indented-code content; its first value token gives the
     * opening.
     *
     * ```markdown
     * > | -     code
     *               ^
     * ```
     */
    function indented(code: Code): State | undefined {
      assert(self.currentConstruct, 'expected an initial flow construct');
      // The code recognizer reports where indentation ends and retained code
      // begins. Equal kinds alone would lose a space in `-  ` + `    code`.
      let index = eventStart;
      let value: Token | undefined;

      while (index < self.events.length) {
        const event = self.events[index];

        if (event[0] === 'enter' && event[1].type === types.codeFlowValue) {
          value = event[1];
          break;
        }

        index++;
      }

      assert(value, 'expected code content on a nonblank line');
      found(self.currentConstruct, value.start);
      return ok(code);
    }

    /**
     * Before the optional indentation of flow or content.
     *
     * ```markdown
     * > | -   text
     *       ^
     * ```
     */
    function prefixed(code: Code): State | undefined {
      return factorySpace(effects, beforeFlow, types.linePrefix)(code);
    }

    /**
     * At the flow or content opening, after its indentation.
     *
     * ```markdown
     * > | -   text
     *         ^
     * ```
     */
    function beforeFlow(code: Code): State | undefined {
      start = self.now();
      return effects.attempt(
        self.parser.constructs.flow,
        opened,
        effects.attempt(self.parser.constructs.contentInitial, opened, paragraph),
      )(code);
    }

    /**
     * After the recognized flow or content construct.
     *
     * ```markdown
     * > | - # a
     *          ^
     * ```
     */
    function opened(code: Code): State | undefined {
      assert(self.currentConstruct, 'expected a flow or content construct');
      found(self.currentConstruct, start);
      return ok(code);
    }

    /**
     * At a paragraph opening, before an optional task check.
     *
     * ```markdown
     * > | - [ ] text
     *       ^
     * ```
     */
    function paragraph(code: Code): State | undefined {
      return taskBefore === undefined
        ? paragraphOpened(code)
        : effects.attempt(check, afterCheck, paragraphOpened)(code);
    }

    /**
     * A task check is read at the start of the item's first paragraph, in the
     * context its text tokenizer would supply. Its success gives the position
     * after the check's separator, before any outer lookahead rewinds.
     *
     * ```markdown
     * > | - [ ] text
     *       ^   ^
     * ```
     */
    function tokenizeCheck(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
      const context: TokenizeContext = Object.assign(Object.create(this), {
        previous: codes.eof,
        _gfmTasklistFirstContentOfListItem: true,
      });
      return checkStart;

      /**
       * At the start of a possible task check.
       *
       * ```markdown
       * > | - [ ] text
       *       ^
       * ```
       */
      function checkStart(code: Code): State | undefined {
        return code === codes.leftSquareBracket
          ? taskChecks[codes.leftSquareBracket].tokenize.call(context, effects, ok, nok)(code)
          : nok(code);
      }
    }

    /**
     * After the task check and its separator, before paragraph content.
     *
     * ```markdown
     * > | - [ ] text
     *           ^
     * ```
     */
    function afterCheck(code: Code): State | undefined {
      assert(taskBefore !== undefined, 'expected an item paragraph');
      // A check in the child's text would turn its parent into a task item.
      if (start.offset >= taskBefore) {
        return nok(code);
      }

      start = self.now();
      return code === codes.eof ? blank(code) : paragraphOpened(code);
    }

    /**
     * At the paragraph content, after any task check.
     *
     * ```markdown
     * > | - [ ] text
     *           ^
     * ```
     */
    function paragraphOpened(code: Code): State | undefined {
      found(content, start);
      return ok(code);
    }
  }
}

declare module '../../types/index.js' {
  interface TokenTypeMap {
    markerLineFit: 'markerLineFit';
  }
}
