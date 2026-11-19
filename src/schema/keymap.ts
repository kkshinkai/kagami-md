/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { compositionState } from '../state/input.js';
import { chainCommands, selectTextblockEnd, selectTextblockStart } from 'prosemirror-commands';
import { redo, undo } from 'prosemirror-history';
import { keydownHandler } from 'prosemirror-keymap';
import type { ResolvedPos } from 'prosemirror-model';
import { NodeSelection, Plugin, type Command } from 'prosemirror-state';

import { selectAll, toggleStrong, toggleEmphasis, toggleStrikethrough, toggleHighlight,
  createParagraphNear, exitCode, insertSourceLineBreak, liftEmptyBlock,
  splitSelection, splitTextblock, deleteSelection } from '../command/commands.js';
import {
  TextblockContext, applyTransaction, cutAfter, cutBefore, joinAcross, liftOut, ownsTextblock
} from './textblockcontext.js';
import {
  enterInTypedTable, enterTable, exitTable, guardCellBoundary, insertTableLineBreak, navigateTableCell,
} from '../table/table.js';
import { acceptCompletion } from '../editor/completion.js';
import { enterPending } from './pending.js';
import { enterInCode, indentCodeBlock } from './code.js';
import { calloutBackspace, enterCallout } from './callout.js';
import {
  enterFrontmatter, frontmatterBackspace, insertAfterFrontmatter, navigateFrontmatter, toggleFrontmatterBoolean,
} from './frontmatter.js';
import { headingToParagraph } from './heading.js';
import {
  deleteDefinitionBackward, deleteDefinitionForward, definitionLineEnd, definitionLineStart, dissolveFootnote,
  enterDefinition, enterFootnote, joinDefinitionBackward, joinDefinitionForward,
} from './link.js';
import { dedentList, indentList, joinListForward, moveListItems, splitListItem, unwrapListItem } from './list.js';
import { dedentMath, enterMath, exitMath, insertMathText } from './math.js';
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
  const backward = chainCommands(frontmatterBackspace, deleteBackward());
  const bindings: Record<string, Command> = {
    'Mod-a': selectAll, 'Mod-z': undo, 'Shift-Mod-z': redo, 'Mod-y': redo,
    Enter: enter, 'Shift-Enter': insertLineBreak,
    'Ctrl-Enter': mac ? insertAfterFrontmatter : exitBlock,
    'Meta-Enter': mac ? exitBlock : insertAfterFrontmatter,
    'Shift-Ctrl-Enter': insertAfterFrontmatter,
    'Shift-Meta-Enter': insertAfterFrontmatter,
    'Alt-Ctrl-Enter': insertAfterFrontmatter,
    'Alt-Meta-Enter': insertAfterFrontmatter,
    'Ctrl-Meta-Enter': insertAfterFrontmatter,
    'Shift-Alt-Ctrl-Enter': insertAfterFrontmatter,
    'Shift-Alt-Meta-Enter': insertAfterFrontmatter,
    'Shift-Ctrl-Meta-Enter': insertAfterFrontmatter,
    'Alt-Ctrl-Meta-Enter': insertAfterFrontmatter,
    'Shift-Alt-Ctrl-Meta-Enter': insertAfterFrontmatter,
    Tab: indent, 'Shift-Tab': dedent,
    Backspace: deleteUnit('backward'),
    'Shift-Backspace': chainCommands(frontmatterBackspace, calloutBackspace, deleteBackward()),
    'Ctrl-Backspace': mac ? frontmatterBackspace : backward,
    'Meta-Backspace': mac ? backward : frontmatterBackspace,
    'Alt-Backspace': mac ? backward : frontmatterBackspace,
    'Shift-Ctrl-Backspace': frontmatterBackspace,
    'Shift-Meta-Backspace': frontmatterBackspace,
    'Shift-Alt-Backspace': frontmatterBackspace,
    'Ctrl-Meta-Backspace': frontmatterBackspace,
    'Alt-Ctrl-Backspace': mac ? chainCommands(frontmatterBackspace, deleteForward) : frontmatterBackspace,
    'Alt-Meta-Backspace': frontmatterBackspace,
    'Shift-Ctrl-Meta-Backspace': frontmatterBackspace,
    'Shift-Alt-Ctrl-Backspace': frontmatterBackspace,
    'Shift-Alt-Meta-Backspace': frontmatterBackspace,
    'Alt-Ctrl-Meta-Backspace': frontmatterBackspace,
    'Shift-Alt-Ctrl-Meta-Backspace': frontmatterBackspace,
    Delete: deleteUnit('forward'), 'Mod-Delete': deleteForward,
    Space: toggleFrontmatterBoolean, 'Shift-Space': toggleFrontmatterBoolean,
    'Mod-b': format(toggleStrong), 'Mod-i': format(toggleEmphasis),
    'Mod-Shift-x': format(toggleStrikethrough), 'Mod-Shift-h': format(toggleHighlight),
  };
  if (mac) Object.assign(bindings, {
    'Ctrl-h': backward, 'Ctrl-d': deleteForward,
    'Alt-Delete': deleteForward, 'Alt-d': deleteForward,
    'Ctrl-a': chainCommands(definitionLineStart, selectTextblockStart),
    'Ctrl-e': chainCommands(definitionLineEnd, selectTextblockEnd),
  });
  const handleKeyDown = keydownHandler(bindings);
  return new Plugin({ props: { handleKeyDown(view, event) {
    if (event.isComposing || compositionState(view.state)?.isComposing) return false;
    return handleKeyDown(view, event);
  } } });
}

/** Backspace at the start of a textblock. */
export const joinBackward: Command = (state, dispatch) => {
  const context = TextblockContext.read(state);
  if (!context?.isAtStart) return false;
  const { $from, textblock } = context;
  const { nodes } = state.schema;
  if (context.linkDefinition !== undefined) {
    return applyTransaction(state, dispatch, joinDefinitionBackward(state, context));
  }
  if (textblock.type === nodes.footnoteLabel) {
    return applyTransaction(state, dispatch,
      textblock.content.size ? state.tr : dissolveFootnote(state, context));
  }
  if (textblock.type === nodes.codeBlock || textblock.type === nodes.mathBlock) {
    const tr = state.tr;
    convert(tr, $from.before(), tr.doc.type.schema.nodes.paragraph, {});
    return applyTransaction(state, dispatch, tr);
  }
  const item = context.listItem;
  if (ownsTextblock(context, item)) {
    const index = $from.index(item);
    if (index === 0) return applyTransaction(state, dispatch, unwrapListItem(state, context));
    if (index === $from.node(item).childCount - 1) {
      return applyTransaction(state, dispatch, moveListItems(state, 'dedent'));
    }
  }
  const quote = context.blockquote;
  if (ownsTextblock(context, quote)) {
    const index = $from.index(quote);
    if (textblock.content.size || index === 0 || index === $from.node(quote).childCount - 1) {
      return applyTransaction(state, dispatch, liftOut(state, context, quote));
    }
  }
  const footnote = context.footnoteDefinition;
  if (ownsTextblock(context, footnote) && $from.index(footnote) === 1) {
    return applyTransaction(state, dispatch, dissolveFootnote(state, context));
  }
  return applyTransaction(state, dispatch, joinAcross(state, context, -1));
};

/** Select an adjacent atomic block when no structural join applies across the cut. */
function selectAtom(direction: -1 | 1): Command {
  return (state, dispatch, view) => {
    const { selection } = state;
    if (!selection.empty) return false;
    let $cut: ResolvedPos | null = selection.$head;
    if ($cut.parent.isTextblock) {
      const edge = direction < 0 ? $cut.parentOffset === 0 : $cut.parentOffset === $cut.parent.content.size;
      const atEdge = view ? view.endOfTextblock(direction < 0 ? 'backward' : 'forward', state) : edge;
      if (!atEdge) return false;
      $cut = direction < 0 ? cutBefore($cut) : cutAfter($cut);
    }
    if (!$cut) return false;
    const node = direction < 0 ? $cut.nodeBefore : $cut.nodeAfter;
    if (!node || !node.isAtom || !NodeSelection.isSelectable(node)) return false;
    if (dispatch) {
      const pos = direction < 0 ? $cut.pos - node.nodeSize : $cut.pos;
      dispatch(state.tr.setSelection(NodeSelection.create(state.doc, pos)).scrollIntoView());
    }
    return true;
  };
}

/** Backward deletion. `boundary` is a feature command for the caret's own boundary; it runs
 * after the join and before the atomic-neighbor selection. */
function deleteBackward(boundary?: Command): Command {
  return chainCommands(guardCellBoundary(-1), deleteDefinitionBackward, deleteSelection, joinBackward,
    ...(boundary ? [boundary] : []), selectAtom(-1));
}

/** Delete at the end of a textblock. */
export const joinForward: Command = (state, dispatch) => {
  const context = TextblockContext.read(state);
  if (!context?.isAtEnd) return false;
  if (context.textblock.type === state.schema.nodes.footnoteLabel) return true;
  let tr = joinDefinitionForward(state, context);
  const item = context.listItem;
  if (!tr && item !== undefined) {
    const empty = context.textblock.content.size === 0;
    tr = empty && ownsTextblock(context, item) && context.$from.node(item).childCount === 1
      ? unwrapListItem(state, context)
      : joinListForward(state, context);
  }
  return applyTransaction(state, dispatch, tr ?? joinAcross(state, context, 1));
};

/** Delete forward through the structural boundary shared by deletion shortcuts. */
const deleteForward: Command = chainCommands(guardCellBoundary(1), deleteDefinitionForward,
  deleteSelection, joinForward, selectAtom(1));

/** Enter gives each feature its case before the ordinary textblock split. */
export const enter: Command = (state, dispatch, view) => chainCommands(
  enterFrontmatter, enterPending, enterCallout, acceptCompletion(),
  enterMath, enterTable, enterInCode, splitSelection, enterInTypedTable,
  enterDefinition, enterFootnote, liftEmptyBlock, splitListItem, splitTextblock, createParagraphNear,
)(state, dispatch, view);

/** Shift-Enter opens a callout body only from its structural title. */
const enterCalloutTitle: Command = (state, dispatch, view) =>
  state.selection.$from.parent.type === state.schema.nodes.calloutTitle && enterCallout(state, dispatch, view);

/** Insert the line break appropriate to a literal body, a table cell, or Markdown text. */
const insertLineBreak: Command = (state, dispatch, view) => chainCommands(
  enterFrontmatter, enterCalloutTitle, insertMathText('\n'), insertTableLineBreak, insertSourceLineBreak,
)(state, dispatch, view);

/** Leave a literal body or a table at its own container depth. */
const exitBlock: Command = (state, dispatch, view) =>
  chainCommands(insertAfterFrontmatter, exitMath, exitTable(1), exitCode)(state, dispatch, view);

/** Plain Backspace and Delete also handle feature-specific field boundaries. */
function deleteUnit(direction: 'backward' | 'forward'): Command {
  if (direction === 'backward') {
    return chainCommands(frontmatterBackspace, calloutBackspace, deleteBackward(headingToParagraph));
  }
  return deleteForward;
}

/** Tab belongs to the editor even when no document operation applies. */
const keepFocus: Command = () => true;

/** Indent the current literal field or selected structural units. */
const indent: Command = (state, dispatch, view) => chainCommands(
  navigateFrontmatter(), acceptCompletion(), insertMathText('  '), navigateTableCell(1),
  indentCodeBlock('indent'), indentList, keepFocus,
)(state, dispatch, view);

/** Dedent the current literal field or selected structural units. */
const dedent: Command = (state, dispatch, view) => chainCommands(
  navigateFrontmatter(true), dedentMath, navigateTableCell(-1), indentCodeBlock('dedent'), dedentList,
  keepFocus,
)(state, dispatch, view);
