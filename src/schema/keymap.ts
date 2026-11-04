/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { compositionState } from '../state/input.js';
import {
  chainCommands, selectNodeBackward, selectNodeForward, selectTextblockEnd,
  selectTextblockStart
} from 'prosemirror-commands';
import { redo, undo } from 'prosemirror-history';
import { keydownHandler } from 'prosemirror-keymap';
import { Plugin, type Command } from 'prosemirror-state';

import { selectAll, toggleStrong, toggleEmphasis, toggleStrikethrough, toggleHighlight,
  createParagraphNear, exitCode, insertSourceLineBreak, liftEmptyBlock,
  splitSelection, splitTextblock, deleteSelection } from '../command/commands.js';
import {
  TextblockContext, applyTransaction, ownsTextblock, joinBeside, removeEmpty,
  liftOut
} from './textblockcontext.js';
import { tables } from '../table/table.js';
import { completion } from '../editor/completion.js';
import { pending } from './pending.js';
import { codeBlock } from './code.js';
import { callout } from './callout.js';
import { frontmatter } from './frontmatter.js';
import { heading } from './heading.js';
import { link } from './link.js';
import { list } from './list.js';
import { math } from './math.js';
import { convert } from '../transform/transform.js';

/** The platform-specific shortcuts follow ProseMirror's base keymap. */
const mac = typeof navigator !== 'undefined' && /Mac|iP(hone|[oa]d)/.test(navigator.platform);

/** Even an unavailable Markdown format owns its shortcut, so the browser cannot add a
 * native rich-text mark without corresponding Markdown source. */
function format(command: Command): Command {
  return (state, dispatch, view) => {
    command(state, dispatch, view);
    return true;
  };
}

/** The shared editor keys. Feature-specific navigation stays with its feature. */
export function baseKeymap(): Plugin {
  const backward = chainCommands(frontmatter.backspace, baseKeymap.deleteBackward());
  const bindings: Record<string, Command> = {
    'Mod-a': selectAll, 'Mod-z': undo, 'Shift-Mod-z': redo, 'Mod-y': redo,
    Enter: baseKeymap.enter, 'Shift-Enter': baseKeymap.insertLineBreak,
    'Ctrl-Enter': mac ? frontmatter.insertAfter : baseKeymap.exitBlock,
    'Meta-Enter': mac ? baseKeymap.exitBlock : frontmatter.insertAfter,
    'Shift-Ctrl-Enter': frontmatter.insertAfter,
    'Shift-Meta-Enter': frontmatter.insertAfter,
    'Alt-Ctrl-Enter': frontmatter.insertAfter,
    'Alt-Meta-Enter': frontmatter.insertAfter,
    'Ctrl-Meta-Enter': frontmatter.insertAfter,
    'Shift-Alt-Ctrl-Enter': frontmatter.insertAfter,
    'Shift-Alt-Meta-Enter': frontmatter.insertAfter,
    'Shift-Ctrl-Meta-Enter': frontmatter.insertAfter,
    'Alt-Ctrl-Meta-Enter': frontmatter.insertAfter,
    'Shift-Alt-Ctrl-Meta-Enter': frontmatter.insertAfter,
    Tab: baseKeymap.indent, 'Shift-Tab': baseKeymap.dedent,
    Backspace: baseKeymap.deleteUnit('backward'),
    'Shift-Backspace': chainCommands(frontmatter.backspace, callout.backspace, baseKeymap.deleteBackward()),
    'Ctrl-Backspace': mac ? frontmatter.backspace : backward,
    'Meta-Backspace': mac ? backward : frontmatter.backspace,
    'Alt-Backspace': mac ? backward : frontmatter.backspace,
    'Shift-Ctrl-Backspace': frontmatter.backspace,
    'Shift-Meta-Backspace': frontmatter.backspace,
    'Shift-Alt-Backspace': frontmatter.backspace,
    'Ctrl-Meta-Backspace': frontmatter.backspace,
    'Alt-Ctrl-Backspace': mac ? chainCommands(frontmatter.backspace, baseKeymap.deleteForward) : frontmatter.backspace,
    'Alt-Meta-Backspace': frontmatter.backspace,
    'Shift-Ctrl-Meta-Backspace': frontmatter.backspace,
    'Shift-Alt-Ctrl-Backspace': frontmatter.backspace,
    'Shift-Alt-Meta-Backspace': frontmatter.backspace,
    'Alt-Ctrl-Meta-Backspace': frontmatter.backspace,
    'Shift-Alt-Ctrl-Meta-Backspace': frontmatter.backspace,
    Delete: baseKeymap.deleteUnit('forward'), 'Mod-Delete': baseKeymap.deleteForward,
    Space: frontmatter.toggleBoolean, 'Shift-Space': frontmatter.toggleBoolean,
    'Mod-b': format(toggleStrong), 'Mod-i': format(toggleEmphasis),
    'Mod-Shift-x': format(toggleStrikethrough), 'Mod-Shift-h': format(toggleHighlight),
  };
  if (mac) Object.assign(bindings, {
    'Ctrl-h': backward, 'Ctrl-d': baseKeymap.deleteForward,
    'Alt-Delete': baseKeymap.deleteForward, 'Alt-d': baseKeymap.deleteForward,
    'Ctrl-a': chainCommands(link.lineStart, selectTextblockStart),
    'Ctrl-e': chainCommands(link.lineEnd, selectTextblockEnd),
  });
  const handleKeyDown = keydownHandler(bindings);
  return new Plugin({ props: { handleKeyDown(view, event) {
    if (event.isComposing || compositionState(view.state)?.isComposing) return false;
    return handleKeyDown(view, event);
  } } });
}

export namespace baseKeymap {
  /** Backspace at the start of a textblock. */
  export const joinBackward: Command = (state, dispatch) => {
    const context = TextblockContext.read(state);
    if (!context?.isAtStart) return false;
    const { $from, textblock } = context;
    const { nodes } = state.schema;
    if (context.linkDefinition !== undefined) {
      return applyTransaction(state, dispatch, link.joinBackward(state, context));
    }
    if (textblock.type === nodes.footnoteLabel) {
      return applyTransaction(state, dispatch,
        textblock.content.size ? state.tr : link.dissolveFootnote(state, context));
    }
    if (textblock.type === nodes.codeBlock || textblock.type === nodes.mathBlock) {
      const tr = state.tr;
      convert(tr, $from.before(), tr.doc.type.schema.nodes.paragraph, {});
      return applyTransaction(state, dispatch, tr);
    }
    const afterDefinition = link.joinAfter(state, context);
    if (afterDefinition) return applyTransaction(state, dispatch, afterDefinition);
    const item = context.listItem;
    if (ownsTextblock(context, item)) {
      const index = $from.index(item);
      if (index === 0) return applyTransaction(state, dispatch, list.unwrapItem(state, context));
      if (index === $from.node(item).childCount - 1) {
        return applyTransaction(state, dispatch, list.moveItems(state, 'dedent'));
      }
      return applyTransaction(state, dispatch, joinBeside(state, context, -1) ?? removeEmpty(state, context, -1));
    }
    const quote = context.blockquote;
    if (ownsTextblock(context, quote)) {
      const index = $from.index(quote);
      if (!textblock.content.size && index !== 0 && index !== $from.node(quote).childCount - 1) {
        return applyTransaction(state, dispatch, removeEmpty(state, context, -1));
      }
      return applyTransaction(state, dispatch, liftOut(state, context, quote));
    }
    const footnote = context.footnoteDefinition;
    if (ownsTextblock(context, footnote) && $from.index(footnote) === 1) {
      return applyTransaction(state, dispatch, link.dissolveFootnote(state, context));
    }
    return applyTransaction(state, dispatch, joinBeside(state, context, -1) ?? removeEmpty(state, context, -1));
  };

  /** Backward deletion. `boundary` is a feature command for the caret's own boundary; it runs
   * after the join and before the neighbor selection. */
  export function deleteBackward(boundary?: Command): Command {
    return chainCommands(deleteSelection, joinBackward,
      ...(boundary ? [boundary] : []), selectNodeBackward);
  }

  /** Delete at the end of a textblock. */
  export const joinForward: Command = (state, dispatch) => {
    const context = TextblockContext.read(state);
    if (!context?.isAtEnd) return false;
    if (context.textblock.type === state.schema.nodes.footnoteLabel) return true;
    let tr = link.joinForward(state, context) ?? link.joinBefore(state, context);
    const item = context.listItem;
    if (!tr && item !== undefined) {
      const empty = context.textblock.content.size === 0;
      tr = empty && ownsTextblock(context, item) && context.$from.node(item).childCount === 1
        ? list.unwrapItem(state, context)
        : list.joinForward(state, context);
    }
    return applyTransaction(state, dispatch, tr ?? joinBeside(state, context, 1) ?? removeEmpty(state, context, 1));
  };

  /** Delete forward through the structural boundary shared by deletion shortcuts. */
  export const deleteForward: Command = chainCommands(deleteSelection, joinForward, selectNodeForward);

  /** Enter gives each feature its case before the ordinary textblock split. */
  export const enter: Command = (state, dispatch, view) => chainCommands(
    frontmatter.enter, pending.enter, callout.enter, completion.accept(),
    math.enter, tables.enterTable, codeBlock.enterInCode, splitSelection, tables.enterInTypedTable,
    link.enter, link.enterFootnote, liftEmptyBlock, list.splitItem, splitTextblock, createParagraphNear,
  )(state, dispatch, view);

  /** Shift-Enter opens a callout body only from its structural title. */
  const enterCalloutTitle: Command = (state, dispatch, view) =>
    state.selection.$from.parent.type === state.schema.nodes.calloutTitle && callout.enter(state, dispatch, view);

  /** Insert the line break appropriate to a literal body, a table cell, or Markdown text. */
  export const insertLineBreak: Command = (state, dispatch, view) => chainCommands(
    frontmatter.enter, enterCalloutTitle, math.insertText('\n'), tables.insertTableLineBreak, insertSourceLineBreak,
  )(state, dispatch, view);

  /** Leave a literal body or a table at its own container depth. */
  export const exitBlock: Command = (state, dispatch, view) =>
    chainCommands(frontmatter.insertAfter, math.exit, tables.exitTable(1), exitCode)(state, dispatch, view);

  /** Plain Backspace and Delete also handle feature-specific field boundaries. */
  export function deleteUnit(direction: 'backward' | 'forward'): Command {
    return (state, dispatch, view) => (direction === 'backward' ? chainCommands(
      frontmatter.backspace, callout.backspace, tables.guardCellBoundary(-1), link.deleteBackward,
      baseKeymap.deleteBackward(heading.toParagraph),
    ) : chainCommands(tables.guardCellBoundary(1), link.deleteForward,
      baseKeymap.deleteForward))(state, dispatch, view);
  }

  /** Tab belongs to the editor even when no document operation applies. */
  const keepFocus: Command = () => true;

  /** Indent the current literal field or selected structural units. */
  export const indent: Command = (state, dispatch, view) => chainCommands(
    frontmatter.navigate(), completion.accept(), math.insertText('  '), tables.navigateTableCell(1),
    codeBlock.indent('indent'), list.indent, keepFocus,
  )(state, dispatch, view);

  /** Dedent the current literal field or selected structural units. */
  export const dedent: Command = (state, dispatch, view) => chainCommands(
    frontmatter.navigate(true), math.dedent, tables.navigateTableCell(-1), codeBlock.indent('dedent'), list.dedent,
    keepFocus,
  )(state, dispatch, view);
}
