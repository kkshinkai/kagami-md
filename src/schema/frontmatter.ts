/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { CorrectionFields } from '../state/correction.js';
import { compositionState, compositionCommit } from '../state/input.js';
import { parseFrontmatterOpening } from '../syntax/index.js';
import { Fragment, Slice, type Node, type ResolvedPos } from 'prosemirror-model';
import { isolateHistory } from '../state/history.js';
import { getParser } from '../state/parser.js';
import {
  NodeSelection, Plugin, PluginKey, Selection, TextSelection, type Command as PMCommand, type EditorState,
  type Transaction
} from 'prosemirror-state';
import { ReplaceStep } from 'prosemirror-transform';
import type { EditorView } from 'prosemirror-view';
import type { KagamiMD } from '../editor/editor.js';
import { insert, normalize, remove, replace, update } from '../transform/transform.js';
import {
  BlockSelection, blockAtPosition, commonBlockRange, selectableBlocks, selectedBlocks, type SelectableBlock,
} from '../state/selection.js';
import {
  closestInVisualRow, frontmatterInputPlugin, groupVisualRows,
} from './frontmatterinput.js';
import { propertyViews, scalarDOM } from './propertyview.js';
import type { YAMLSourceView } from './yamlsourceview.js';
import { fieldSource, frontMatterSource } from '../parse/field.js';
import { parseFrontMatter } from '../parse/parse.js';
import { inferYAMLScalar } from '../parse/scalar.js';
import { schema } from '../types/schema.js';
import { PluginDesc } from '../editor/plugin.js';

/** Structured YAML properties, their mounted view session, and input. */
export function frontmatter(): PluginDesc[] {
  return [
    PluginDesc.viewState(frontmatterState),
    PluginDesc.viewState(frontmatterInputPlugin),
    PluginDesc.view(propertyViews),
  ];
}

/** Normalize frontmatter boolean carets to NodeSelection and cross-field TextSelections to BlockSelection. */
export function normalizeFrontmatterSelection(tr: Transaction): boolean {
  const first = tr.doc.firstChild;
  if (!first?.type.isInGroup('frontMatter')) return false;
  const sel = tr.selection;
  if (sel instanceof TextSelection && sel.$from.sameParent(sel.$to) &&
      sel.$from.parent.type === schema.nodes.yamlScalar && sel.$from.parent.attrs.tag === 'boolean') {
    tr.setSelection(NodeSelection.create(tr.doc, sel.$from.before()));
    return true;
  }
  if (sel instanceof TextSelection && !sel.empty && sel.from < first.nodeSize && !sel.$from.sameParent(sel.$to)) {
    const blocks = selectableBlocks(tr.doc, { from: sel.from, to: sel.to });
    const start = blockAtPosition(blocks, sel.from);
    const end = blockAtPosition(blocks, sel.to, true);
    if (start && end) {
      const range = commonBlockRange(tr.doc, start, end);
      const forward = sel.anchor <= sel.head;
      tr.setSelection(
        BlockSelection.create(tr.doc, forward ? range.from : range.to, forward ? range.to : range.from),
      );
      return true;
    }
    if (sel.to > first.nodeSize && end) {
      tr.setSelection(BlockSelection.create(tr.doc, 0, Math.max(end.to, first.nodeSize)));
      return true;
    }
  }
  return false;
}

/** Read edited YAML fields and settle the scalar the caret left. */
export function correctFrontmatter(tr: Transaction, fields: CorrectionFields, old: EditorState): void {
  const previous = old.selection.$head;
  if (previous.parent.type === schema.nodes.yamlScalar) {
    const position = fields.mapping(tr).mapResult(previous.before(), 1);
    const scalar = tr.doc.nodeAt(position.pos);
    // Re-normalize a scalar only after the caret actually leaves it, avoiding quote rewrites mid-typing.
    if (!position.deletedAcross && scalar?.type === schema.nodes.yamlScalar &&
        (!tr.selection.$head.depth || tr.selection.$head.before() !== position.pos))
      normalize(tr, position.pos, position.pos + scalar.nodeSize);
  }
  for (const position of fields.textblocks(tr)) {
    const node = tr.doc.nodeAt(position)!;
    if (node.type === schema.nodes.yamlScalar && node.attrs.tag !== 'string') {
      const tag = inferYAMLScalar(node.textContent);
      if (tag !== node.attrs.tag) update(tr, position, { tag });
    } else if (position === 0 && node.type === schema.nodes.rawFrontMatter) {
      const parsed = getParser(old).parseFile(frontMatterSource(node)).document.frontMatter;
      if (parsed?.type === 'yamlFrontMatter')
        replace(tr, 0, node.nodeSize, new Slice(Fragment.from(parseFrontMatter(parsed, schema, node)), 0, 0));
    }
  }
}

/** A typed opening at the file head starts structured front matter in that input. */
export function frontmatterInput(old: EditorState, tr: Transaction): void {
  readOpening([tr], old, tr);
}

/** A temporary YAML source edit open in the mounted frontmatter view. */
export interface FrontmatterDraft {
  readonly initial: string;
  readonly draft: string;
  readonly selection: YAMLSourceView.Selection;
  readonly node: Node;
  readonly error: string | null;
}

/** Presentation state held while an editor view is mounted. */
export interface FrontmatterSession { readonly collapsed: boolean; readonly source: FrontmatterDraft | null }

export const frontmatterKey = new PluginKey<FrontmatterSession>('frontmatter');

/** Keep mounted frontmatter presentation state in view-state. */
function frontmatterState(): Plugin<FrontmatterSession> {
  return new Plugin<FrontmatterSession>({
    key: frontmatterKey,
    state: {
      init: () => ({ collapsed: false, source: null }),
      apply(tr, previous) {
        if (tr.doc.firstChild?.type !== schema.nodes.yamlFrontMatter) return { collapsed: false, source: null };
        return tr.getMeta(frontmatterKey) as FrontmatterSession | undefined ?? previous;
      },
    },
  });
}

/** The displayed type of a structured value. */
export function frontmatterValueType(node: Node): KagamiMD.FrontmatterValueType {
  if (node.type === schema.nodes.yamlMapping) return 'object';
  if (node.type === schema.nodes.yamlSequence) return 'array';
  switch (node.attrs.tag) {
    case 'integer': case 'float': return 'number';
    case 'boolean': return 'boolean';
    case 'null': return 'null';
    default: return 'string';
  }
}

/** Whether a node is a YAML mapping or sequence collection. */
export function isYAMLCollection(node: Node): boolean {
  return node.type.isInGroup('yamlCollection');
}

/** Whether a YAML node is a collection rendered in flow style. */
export function isFlowCollection(node: Node): boolean {
  return isYAMLCollection(node) && node.attrs.flow === true;
}

/** Collection conversion retains values and flow layout; only a single unnamed value can unwrap. */
export function convertedFrontmatterValue(value: Node, type: KagamiMD.FrontmatterValueType): Node | null {
  if (frontmatterValueType(value) === type) return value;
  if (isYAMLCollection(value)) {
    const flow = isFlowCollection(value);
    if (type === 'array' && value.type === schema.nodes.yamlMapping)
      return schema.nodes.yamlSequence.create({ flow }, value.content.content.map(pair => pair.child(1)));
    if (type === 'object' && value.type === schema.nodes.yamlSequence)
      return schema.nodes.yamlMapping.create({ flow },
        value.content.content.map(child => schema.nodes.yamlPair.create(null, [newValue('string'), child])));
    if (!value.childCount) return newValue(type);
    if (value.childCount !== 1) return null;
    const only = value.firstChild!;
    if (value.type === schema.nodes.yamlMapping &&
      (only.firstChild!.textContent || only.firstChild!.type !== schema.nodes.yamlScalar)) return null;
    const inner = value.type === schema.nodes.yamlMapping ? only.child(1) : only;
    return convertedFrontmatterValue(inner, type);
  }
  if (type === 'array') return schema.nodes.yamlSequence.create({ flow: true }, value);
  if (type === 'object')
    return schema.nodes.yamlMapping.create(null, schema.nodes.yamlPair.create(null, [newValue('string'), value]));
  const text = value.textContent;
  const tag = inferYAMLScalar(text);
  const inferred = tag === 'integer' || tag === 'float' ? 'number' : tag;
  if (type !== 'string' && text && inferred !== type) return null;
  if (!text) return newValue(type);
  const targetTag = type === 'number' ? tag : type;
  return schema.nodes.yamlScalar.create({ tag: targetTag }, value.content);
}

/** Convert a property's value, or replace it with the chosen type's empty value. */
export function changeFrontmatterType(state: EditorState, pos: number,
  type: KagamiMD.FrontmatterValueType): Transaction | null {
  const entry = entryAt(state.doc, pos);
  if (!entry) return null;
  const { value } = entry;
  const candidate = convertedFrontmatterValue(value.node, type) ?? newValue(type);
  // Anything inserted inside a flow ancestor must stay in flow layout so block syntax never breaks inline capsules.
  const next = hasFlowAncestor(state.doc, pos) ? withFlowSubtree(candidate) : candidate;
  if (next.eq(value.node)) return null;
  const tr = isolateHistory(state.tr);
  if (next.type === value.node.type && next.content.eq(value.node.content)) {
    update(tr, value.pos, { tag: next.attrs.tag });
  } else {
    replace(tr, value.pos, value.pos + value.node.nodeSize, new Slice(Fragment.from(next), 0, 0));
  }
  return edit(focusChangedEntry(tr, pos));
}

/** Switch a collection value between inline flow capsules and multiline block layout. */
export function setFrontmatterFlow(state: EditorState, pos: number, flow: boolean): Transaction | null {
  const entry = entryAt(state.doc, pos);
  if (!entry) return null;
  const { value } = entry;
  if (!isYAMLCollection(value.node) || isFlowCollection(value.node) === flow) return null;
  if (!flow && value.node.childCount === 0) return null;
  const tr = isolateHistory(state.tr);
  if (flow) {
    // Closing a subtree into flow layout forces nested collections to flow so no block syntax embeds in inline brackets.
    update(tr, value.pos, { flow: true });
    const emptySequenceNulls: number[] = [];
    value.node.descendants((child, offset, parent) => {
      const childPos = value.pos + 1 + offset;
      if (isYAMLCollection(child) && !isFlowCollection(child)) update(tr, childPos, { flow: true });
      if (parent?.type === schema.nodes.yamlSequence && child.type === schema.nodes.yamlScalar &&
          child.attrs.tag === 'null' && child.content.size === 0) {
        emptySequenceNulls.push(childPos);
      }
    });
    for (let index = emptySequenceNulls.length - 1; index >= 0; index--) {
      tr.insertText('null', emptySequenceNulls[index]! + 1);
    }
  } else {
    // Expanding a nested collection to block layout must also expand any enclosing flow chains above it.
    const $val = state.doc.resolve(value.pos);
    for (let depth = 1; depth <= $val.depth; depth++) {
      const ancestor = $val.node(depth);
      if (isFlowCollection(ancestor)) update(tr, $val.before(depth), { flow: false });
    }
    update(tr, value.pos, { flow: false });
  }
  return edit(focusChangedEntry(tr, pos));
}

/** Insert an unnamed property or an empty array item at the given child index. */
export function insertFrontmatterEntry(state: EditorState, pos: number, index: number): Transaction | null {
  const tr = isolateHistory(state.tr);
  const insertedPos = insertBlankCollectionEntry(tr, pos, index);
  if (insertedPos === null) return null;
  return edit(focusSubtree(tr, insertedPos, 1));
}

/** Remove one property or item and select the nearest remaining field. */
export function removeFrontmatterEntry(state: EditorState, pos: number, bias: -1 | 1 = -1): Transaction | null {
  const entry = entryAt(state.doc, pos);
  if (!entry) return null;
  const tr = isolateHistory(state.tr);
  remove(tr, pos, pos + entry.node.nodeSize);
  return edit(focusAfterRemoval(tr, pos, bias));
}

/** Set the text of an atomic boolean value in its own history event. */
export function setFrontmatterBoolean(state: EditorState, pos: number, checked: boolean): Transaction | null {
  const node = state.doc.nodeAt(pos);
  if (node?.type !== schema.nodes.yamlScalar || node.attrs.tag !== 'boolean' ||
    node.textContent.toLowerCase() === String(checked)) return null;
  const tr = isolateHistory(state.tr).insertText(String(checked), pos + 1, pos + node.nodeSize - 1);
  return edit(tr.setSelection(NodeSelection.create(tr.doc, pos)));
}

/** Visit scalar fields in document order, appending a field at the final Tab. */
export function navigateFrontmatter(backward = false): PMCommand {
  return (state, dispatch) => {
    const focus = readScalarFocus(state);
    if (!focus) return false;
    if (focus.kind === 'text' && !focus.empty) return false;
    const grid = new FieldGrid(state.doc);
    if (!grid.contains(focus.pos)) return false;
    const step = backward ? -1 : 1;
    const next = grid.neighborField(focus.pos, step);
    if (next) {
      return applyStepOutcome(state, scalarSelection(state.doc, next, 1), dispatch);
    }
    if (!backward) {
      const tr = insertSiblingEntry(state, focus.entry);
      if (tr) dispatch?.(tr);
    }
    return true;
  };
}

/** Step across adjacent YAML scalar capsules and boundaries with Left and Right arrows. */
export function frontmatterArrow(direction: -1 | 1): PMCommand {
  return (state, dispatch) => {
    const frontmatterNode = state.doc.firstChild;
    if (frontmatterNode?.type !== schema.nodes.yamlFrontMatter) return false;
    const focus = readScalarFocus(state);
    if (!focus) {
      if (!state.selection.empty || direction > 0) return false;
      if (!isStartOfBodyAfterFrontmatter(state, state.selection.$head)) return false;
      const last = new FieldGrid(state.doc).fields.at(-1);
      if (!last) return false;
      return applyStepOutcome(state, scalarSelection(state.doc, last, -1), dispatch);
    }
    if (focus.kind === 'text') {
      if (!focus.empty) return false;
      const atBoundary = direction < 0 ? focus.atStart : focus.atEnd;
      if (!atBoundary) return false;
    }
    const grid = new FieldGrid(state.doc);
    if (!grid.contains(focus.pos)) return false;
    const next = grid.neighborField(focus.pos, direction);
    if (next) {
      return applyStepOutcome(state, scalarSelection(state.doc, next, direction), dispatch);
    }
    if (direction > 0) {
      const after = Selection.near(state.doc.resolve(frontmatterNode.nodeSize), 1);
      return applyStepOutcome(state, after, dispatch);
    }
    // At the very start of front matter, Left arrow stays clamped inside the first scalar.
    return true;
  };
}

/** Scalar node measured with its viewport bounding box for 2D visual-row grouping. */
interface MeasuredField {
  readonly field: ValuePosition;
  readonly rect: DOMRect;
}

/** Result of a navigation or Shift+Arrow step: a new selection, `'clamp'` to consume at the edge, or `null` to pass. */
type StepOutcome = Selection | 'clamp' | null;

/** Step vertically across visual YAML field rows and the body boundary by horizontal coordinate. */
export function frontmatterVerticalArrow(direction: -1 | 1): PMCommand {
  return (state, dispatch, view) => {
    const frontmatterNode = state.doc.firstChild;
    if (frontmatterNode?.type !== schema.nodes.yamlFrontMatter || !view) return false;
    const session = frontmatterKey.getState(state);
    if (session?.collapsed || session?.source) return false;
    const grid = new FieldGrid(state.doc, view);
    const outcome = state.selection.from < frontmatterNode.nodeSize
      ? verticalInsideYAML(state, view, grid, direction)
      : stepUpFromBody(state, view, grid, frontmatterNode.nodeSize, direction);
    return applyStepOutcome(state, outcome, dispatch);
  };
}

/** Compute the vertical step outcome when the caret starts inside `yamlFrontMatter`. */
function verticalInsideYAML(
  state: EditorState,
  view: EditorView,
  grid: FieldGrid,
  direction: -1 | 1,
): StepOutcome {
  const focus = readScalarFocus(state);
  if (!focus) return null;
  if (focus.kind === 'text') {
    if (!focus.empty) return null;
    const atBoundaryLine = direction < 0 ? focus.onFirstLine : focus.onLastLine;
    if (!atBoundaryLine) return null;
    if (!view.endOfTextblock(direction < 0 ? 'up' : 'down', state)) return null;
  }
  const origin = grid.rowItem(focus.pos);
  if (!origin) return null;
  let x: number;
  if (focus.kind === 'boolean') {
    x = (origin.item.rect.left + origin.item.rect.right) / 2;
  } else {
    x = view.coordsAtPos(state.selection.head).left;
  }
  const targetRow = grid.rows[origin.rowIndex + direction];
  if (targetRow) {
    const target = closestInVisualRow(targetRow, x);
    return fieldSelectionAtX(state.doc, view, target, x, direction);
  }
  if (direction > 0) {
    return bodyEntrySelection(state, view, state.doc.firstChild!.nodeSize, x);
  }
  if (state.selection instanceof TextSelection && state.selection.$head.parentOffset > 0) {
    return TextSelection.create(state.doc, state.selection.$head.start());
  }
  return 'clamp';
}

/** Pick a `TextSelection` on the top visual line of the first body block aligned horizontally with `x`. */
function bodyEntrySelection(state: EditorState, view: EditorView, frontmatterSize: number, x: number): Selection {
  const after = Selection.near(state.doc.resolve(frontmatterSize), 1);
  const bodyDOM = view.nodeDOM(frontmatterSize) as HTMLElement | null;
  if (!bodyDOM || !(after instanceof TextSelection)) return after;
  const bodyRect = bodyDOM.getBoundingClientRect();
  if (bodyRect.height <= 0 || bodyRect.width <= 0) return after;
  const hit = view.posAtCoords({
    left: Math.max(bodyRect.left + 1, Math.min(bodyRect.right - 1, x)),
    top: Math.min(bodyRect.bottom - 1, bodyRect.top + 8),
  });
  if (hit && hit.pos >= frontmatterSize && state.doc.resolve(hit.pos).sameParent(after.$from)) {
    return TextSelection.create(state.doc, hit.pos);
  }
  return after;
}

/** Step upward from the first line or node of the Markdown body into the bottom visual row of `yamlFrontMatter`. */
function stepUpFromBody(
  state: EditorState,
  view: EditorView,
  grid: FieldGrid,
  frontmatterSize: number,
  direction: -1 | 1,
): StepOutcome {
  // Check body-boundary preconditions before touching `grid` so ArrowDown anywhere in the body stays O(1).
  if (direction > 0) return null;
  const { selection } = state;
  if (selection instanceof NodeSelection) {
    if (selection.from !== frontmatterSize) return null;
    const bottomRow = grid.rows.at(-1);
    if (!bottomRow) return null;
    const rect = (view.nodeDOM(selection.from) as HTMLElement | null)?.getBoundingClientRect();
    const x = rect ? rect.left : 0;
    return fieldSelectionAtX(state.doc, view, closestInVisualRow(bottomRow, x), x, -1);
  }
  if (!selection.empty) return null;
  const firstBody = TextSelection.near(state.doc.resolve(frontmatterSize), 1);
  if (!selection.$head.sameParent(firstBody.$from)) return null;
  if (selection.$head.parent.textBetween(0, selection.$head.parentOffset, '\n', '\n').includes('\n')) return null;
  if (!view.endOfTextblock('up', state)) return null;
  const bottomRow = grid.rows.at(-1);
  if (!bottomRow) return null;
  const x = view.coordsAtPos(selection.head).left;
  return fieldSelectionAtX(state.doc, view, closestInVisualRow(bottomRow, x), x, -1);
}

/** Extend or clamp Shift+Arrow selections within front matter or before its body boundary. */
export function frontmatterShiftArrow(axis: 'horizontal' | 'vertical', direction: -1 | 1): PMCommand {
  return (state, dispatch, view) => {
    const first = state.doc.firstChild;
    if (!first?.type.isInGroup('frontMatter')) return false;
    const { selection } = state;
    if (selection.anchor >= first.nodeSize) {
      return applyStepOutcome(state, clampShiftFromBody(state, view, first.nodeSize, axis, direction), dispatch);
    }
    if (first.type !== schema.nodes.yamlFrontMatter) return false;
    const blocks = selectableBlocks(state.doc, { from: 0, to: first.nodeSize }).filter(b => b.to <= first.nodeSize);
    if (!blocks.length) return false;
    const grid = new FieldGrid(state.doc, view);
    const outcome = selection instanceof BlockSelection
      ? extendBlockShift(state, grid, blocks, selection, axis, direction)
      : extendScalarShift(state, view, grid, blocks, axis, direction);
    return applyStepOutcome(state, outcome, dispatch);
  };
}

/** Prevent Shift+Arrow from pulling a body-anchored selection into front matter across its leading edge. */
function clampShiftFromBody(
  state: EditorState,
  view: EditorView | undefined,
  frontmatterSize: number,
  axis: 'horizontal' | 'vertical',
  direction: -1 | 1,
): StepOutcome {
  const { selection } = state;
  if (direction > 0 || !(selection instanceof TextSelection)) return null;
  const bodyStart = TextSelection.near(state.doc.resolve(frontmatterSize), 1).from;
  if (axis === 'horizontal' && selection.head <= bodyStart) return 'clamp';
  const $head = selection.$head;
  if (axis === 'vertical' && $head.sameParent(state.doc.resolve(bodyStart)) &&
      !$head.parent.textBetween(0, $head.parentOffset, '\n', '\n').includes('\n') &&
      (!view || view.endOfTextblock('up', state))) {
    if (selection.head > bodyStart) {
      return TextSelection.create(state.doc, selection.anchor, bodyStart);
    }
    return 'clamp';
  }
  return null;
}

/** Extend an existing YAML `BlockSelection` along sibling order or vertically across visual field rows. */
function extendBlockShift(
  state: EditorState,
  grid: FieldGrid,
  blocks: readonly SelectableBlock[],
  selection: BlockSelection,
  axis: 'horizontal' | 'vertical',
  direction: -1 | 1,
): StepOutcome {
  const frontmatterSize = state.doc.firstChild!.nodeSize;
  if (selection.anchorBlock.to > frontmatterSize) return null;
  const frontier = selectedBlocks(state.doc, selection).filter(b => b.to <= frontmatterSize);
  if (!frontier.length) return null;
  const currentHead = selection.anchor <= selection.head ? frontier.at(-1)! : frontier[0]!;
  let target: SelectableBlock | null = null;
  if (axis === 'vertical' && grid.rows.length > 0) {
    const headFields = grid.fields.filter(f => f.pos >= currentHead.from && f.pos < currentHead.to);
    const refField = direction > 0 ? headFields.at(-1) : headFields[0];
    if (refField) {
      target = grid.stepBlockVertically(blocks, refField.pos, direction);
    }
  }
  if (!target) {
    target = stepBlockInSiblingsOrFlat(blocks, currentHead, direction);
  }
  return target ? selection.extend(target) : 'clamp';
}

/** Step one sibling forward/backward within `currentHead.parent`, skipping nested descendants on step-out. */
function stepBlockInSiblingsOrFlat(
  blocks: readonly SelectableBlock[],
  currentHead: SelectableBlock,
  direction: -1 | 1,
): SelectableBlock | null {
  const siblings = currentHead.parent ? currentHead.parent.children : blocks.filter(b => b.depth === 0);
  const idx = siblings.findIndex(b => b.from === currentHead.from);
  if (idx >= 0 && idx + direction >= 0 && idx + direction < siblings.length) {
    return siblings[idx + direction]!;
  }
  const flatIdx = blocks.findIndex(b => b.from === currentHead.from);
  if (flatIdx < 0) return null;
  // Preorder `blocks` places `currentHead`'s descendants right after `flatIdx` and its ancestors right before it;
  // advance strictly past `currentHead.to` or strictly before `currentHead.from` so step-out never loops in place.
  if (direction > 0) {
    for (let i = flatIdx + 1; i < blocks.length; i++) {
      if (blocks[i]!.from >= currentHead.to) return blocks[i]!;
    }
    return null;
  }
  for (let i = flatIdx - 1; i >= 0; i--) {
    if (blocks[i]!.to <= currentHead.from) return blocks[i]!;
  }
  return null;
}

/** Extend a single-scalar Shift+Arrow gesture, promoting to `BlockSelection` once crossing an entry boundary. */
function extendScalarShift(
  state: EditorState,
  view: EditorView | undefined,
  grid: FieldGrid,
  blocks: readonly SelectableBlock[],
  axis: 'horizontal' | 'vertical',
  direction: -1 | 1,
): StepOutcome {
  const focus = readScalarFocus(state);
  if (!focus) return null;
  if (focus.kind === 'text') {
    if (axis === 'horizontal') {
      const atBoundary = direction < 0 ? focus.atStart : focus.atEnd;
      if (!atBoundary) return null;
    } else {
      const atBoundaryLine = direction < 0 ? focus.onFirstLine : focus.onLastLine;
      if (!atBoundaryLine) return null;
      if (view && !view.endOfTextblock(direction < 0 ? 'up' : 'down', state)) return null;
    }
  }
  const anchorPos = focus.kind === 'boolean' ? focus.pos : state.selection.anchor;
  const anchorBlock = blockAtPosition(blocks, anchorPos);
  if (!anchorBlock || !grid.contains(focus.pos)) return null;
  if (focus.kind === 'text') {
    const atBoundaryRow = axis === 'vertical' && grid.isBoundaryRow(focus.pos, direction);
    if (atBoundaryRow || grid.isBoundaryField(focus.pos, direction)) {
      // On the outermost row or scalar edge, clamp within the starting scalar rather than crossing into body text.
      const $head = state.selection.$head;
      const scalarStart = $head.start();
      const scalarEnd = $head.end();
      const edge = direction < 0 ? scalarStart : scalarEnd;
      if (state.selection.anchor >= scalarStart && state.selection.anchor <= scalarEnd && state.selection.head !== edge) {
        return TextSelection.create(state.doc, state.selection.anchor, edge);
      }
      return 'clamp';
    }
  }
  const target = grid.adjacentBlock(blocks, anchorBlock, focus.pos, axis, direction);
  return BlockSelection.between(state.doc, anchorBlock, target);
}

/** Enter advances from a key to its value, continues multiline strings, exits blank nested entries, or adds a sibling. */
export const enterFrontmatter: PMCommand = (state, dispatch) => {
  const focus = readScalarFocus(state);
  if (!focus) return false;
  if (isEmptyEntry(focus.entry.node)) {
    const exit = exitBlankEntry(state, focus.entry);
    if (exit) {
      dispatch?.(exit);
      return true;
    }
  }
  if (focus.slot === 'key' && focus.entry.kind === 'pair') {
    const { value } = focus.entry;
    if (isYAMLCollection(value.node) && value.node.childCount === 0) {
      const tr = insertFrontmatterEntry(state, value.pos, 0);
      if (tr) dispatch?.(tr);
    } else {
      dispatch?.(focusSubtree(state.tr, value.pos, 1).scrollIntoView());
    }
    return true;
  }
  if (
    focus.kind === 'text' &&
    focus.node.attrs.tag === 'string' &&
    !hasFlowAncestor(state.doc, focus.entry.pos) &&
    focus.node.textContent.includes('\n')
  ) {
    dispatch?.(state.tr.insertText('\n').scrollIntoView());
    return true;
  }
  const sibling = insertSiblingEntry(state, focus.entry);
  if (sibling) dispatch?.(sibling);
  return true;
};

/** Shift-Enter inserts a literal line break in scalar values, or moves from a key to its value. */
export const insertFrontmatterNewline: PMCommand = (state, dispatch) => {
  const focus = readScalarFocus(state);
  if (!focus) return false;
  if (focus.slot === 'key' && focus.entry.kind === 'pair') {
    dispatch?.(focusSubtree(state.tr, focus.entry.value.pos, 1).scrollIntoView());
    return true;
  }
  if (focus.kind === 'text') {
    dispatch?.(state.tr.insertText('\n').scrollIntoView());
    return true;
  }
  const sibling = insertSiblingEntry(state, focus.entry);
  if (sibling) dispatch?.(sibling);
  return true;
};

/** Mod-Enter adds the next property or item regardless of the current value's type. */
export const insertAfterFrontmatter: PMCommand = (state, dispatch) => {
  const entry = activeEntry(state);
  if (!entry) return false;
  const sibling = insertSiblingEntry(state, entry);
  if (sibling) dispatch?.(sibling);
  return true;
};

/** Backspace steps from a value start back to its key, and removes empty items, properties, or empty frontmatter. */
export const frontmatterBackspace: PMCommand = (state, dispatch) => {
  const focus = readScalarFocus(state);
  if (!focus) return false;
  switch (focus.kind) {
    case 'boolean': {
      const tr = deleteBooleanScalar(state, focus, -1);
      if (!tr) return false;
      dispatch?.(tr);
      return true;
    }
    case 'text': {
      if (!focus.empty || !focus.atStart) return false;
      switch (focus.slot) {
        case 'value':
          if (focus.entry.kind === 'pair') {
            dispatch?.(focusSubtree(state.tr, focus.entry.key.pos, -1).scrollIntoView());
          }
          return true;
        case 'key':
          if (isEmptyEntry(focus.entry.node)) {
            const tr = removeEntryOrEmptyFrontmatter(state, focus.entry, -1);
            if (tr) dispatch?.(tr);
          }
          return true;
        case 'item':
          if (isEmptyEntry(focus.entry.node)) {
            const tr = removeFrontmatterEntry(state, focus.entry.pos, -1);
            if (tr) dispatch?.(tr);
          }
          return true;
      }
    }
  }
};

/** Delete steps from a key end into its value, and removes empty items or properties forward. */
export const frontmatterDelete: PMCommand = (state, dispatch) => {
  const focus = readScalarFocus(state);
  if (!focus) return false;
  switch (focus.kind) {
    case 'boolean': {
      const tr = deleteBooleanScalar(state, focus, 1);
      if (!tr) return false;
      dispatch?.(tr);
      return true;
    }
    case 'text': {
      if (!focus.empty || !focus.atEnd) return false;
      switch (focus.entry.kind) {
        case 'pair': {
          if (isEmptyEntry(focus.entry.node)) {
            const tr = removeEntryOrEmptyFrontmatter(state, focus.entry, 1);
            if (tr) dispatch?.(tr);
            return true;
          }
          if (focus.slot === 'key') {
            const { value } = focus.entry;
            if (!isYAMLCollection(value.node) || value.node.childCount > 0) {
              dispatch?.(focusSubtree(state.tr, value.pos, 1).scrollIntoView());
            }
          }
          return true;
        }
        case 'item':
          if (isEmptyEntry(focus.entry.node)) {
            const tr = removeFrontmatterEntry(state, focus.entry.pos, 1);
            if (tr) dispatch?.(tr);
          }
          return true;
      }
    }
  }
};

/** Space toggles the selected atomic boolean. */
export const toggleFrontmatterBoolean: PMCommand = (state, dispatch) => {
  const focus = readScalarFocus(state);
  if (!focus || focus.kind !== 'boolean') return false;
  const tr = setFrontmatterBoolean(state, focus.pos, focus.node.textContent.toLowerCase() !== 'true');
  if (tr) dispatch?.(tr);
  return true;
};

/** Property type icons are shared by the live view and the drag preview. */
export const frontmatterTypeIcons: Record<KagamiMD.FrontmatterValueType, string> = {
  string: '<path d="M12 4v16" /><path d="M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2" /><path d="M9 20h6" />',
  number: '<line x1="4" x2="20" y1="9" y2="9" /><line x1="4" x2="20" y1="15" y2="15" /><line x1="10" x2="8" y1="3" y2="21" /><line x1="16" x2="14" y1="3" y2="21" />',
  boolean: '<circle cx="9" cy="12" r="3" /><rect width="20" height="14" x="2" y="5" rx="7" />',
  null: '<path d="M5 12h14" />',
  array: '<path d="M16 3h3a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1h-3" /><path d="M8 21H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h3" />',
  object: '<path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1" /><path d="M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1" />',
};

/** A YAML node together with its document position. */
export interface ValuePosition {
  readonly node: Node;
  readonly pos: number;
}

/** A YAML mapping property or sequence item inside structured front matter. */
export type YAMLEntry = YAMLEntry.Pair | YAMLEntry.Item;

export namespace YAMLEntry {
  /** A key/value property inside a `yamlMapping` container. */
  export interface Pair {
    readonly kind: 'pair';
    readonly node: Node;
    readonly pos: number;
    readonly parent: Node;
    readonly parentPos: number;
    readonly index: number;
    readonly depth: number;
    readonly key: ValuePosition;
    readonly value: ValuePosition;
  }

  /** An element inside a `yamlSequence` container (scalar or nested collection). */
  export interface Item {
    readonly kind: 'item';
    readonly node: Node;
    readonly pos: number;
    readonly parent: Node;
    readonly parentPos: number;
    readonly index: number;
    readonly depth: number;
    readonly value: ValuePosition;
  }
}

/** Role of the focused `yamlScalar` inside its owning `YAMLEntry`. */
type YAMLScalarSlot = 'key' | 'value' | 'item';

/** Selection inside a single YAML scalar, discriminating atomic booleans (`NodeSelection`) from text fields. */
type YAMLScalarFocus = YAMLScalarFocus.Boolean | YAMLScalarFocus.Text;

namespace YAMLScalarFocus {
  /** Atomic `NodeSelection` over a `tag: 'boolean'` scalar. */
  export interface Boolean {
    readonly kind: 'boolean';
    readonly pos: number;
    readonly node: Node;
    readonly entry: YAMLEntry;
    readonly slot: YAMLScalarSlot;
  }

  /** Caret or intra-scalar `TextSelection` inside a non-boolean `yamlScalar`. */
  export interface Text {
    readonly kind: 'text';
    readonly pos: number;
    readonly node: Node;
    readonly entry: YAMLEntry;
    readonly slot: YAMLScalarSlot;
    readonly empty: boolean;
    readonly offset: number;
    readonly atStart: boolean;
    readonly atEnd: boolean;
    readonly onFirstLine: boolean;
    readonly onLastLine: boolean;
  }
}

/**
 * Resolve the mapping pair or sequence element whose node starts directly at `pos`, or `null` for
 * `yamlFrontMatter`, collections themselves, pair key/value children, or body blocks.
 */
export function entryAt(doc: Node, pos: number): YAMLEntry | null {
  if (pos < 0 || pos > doc.content.size) return null;
  const $pos = doc.resolve(pos);
  const node = doc.nodeAt(pos);
  if (!node || $pos.depth < 2 || $pos.node(1).type !== schema.nodes.yamlFrontMatter) return null;
  const parent = $pos.parent;
  if (!isYAMLCollection(parent)) return null;
  const parentPos = $pos.before();
  const index = $pos.index();
  const depth = $pos.depth;
  if (parent.type === schema.nodes.yamlMapping) {
    if (node.type !== schema.nodes.yamlPair) return null;
    const keyNode = node.child(0);
    const keyPos = pos + 1;
    const valuePos = keyPos + keyNode.nodeSize;
    return {
      kind: 'pair',
      node,
      pos,
      parent,
      parentPos,
      index,
      depth,
      key: { node: keyNode, pos: keyPos },
      value: { node: node.child(1), pos: valuePos },
    };
  }
  return {
    kind: 'item',
    node,
    pos,
    parent,
    parentPos,
    index,
    depth,
    value: { node, pos },
  };
}

/** Position of the focused `yamlScalar` inside structured front matter, if any. */
export function activeScalarPos(state: EditorState): number | null {
  return readScalarFocus(state)?.pos ?? null;
}

/** Walk upward from an interior `pos` (inside a pair key/value or nested collection) to its innermost enclosing entry. */
function enclosingEntry(doc: Node, pos: number): YAMLEntry | null {
  if (pos < 0 || pos > doc.content.size) return null;
  const $pos = doc.resolve(pos);
  if ($pos.depth < 3 || $pos.node(1).type !== schema.nodes.yamlFrontMatter) return null;
  for (let depth = $pos.depth; depth >= 3; depth--) {
    if (isYAMLCollection($pos.node(depth - 1))) {
      return entryAt(doc, $pos.before(depth));
    }
  }
  return null;
}

/** Resolve either an entry starting at `pos` (sequence item) or the entry containing `pos` (pair scalar / nested container). */
function entryContaining(doc: Node, pos: number): YAMLEntry | null {
  // Sequence items satisfy `entryAt` right at their start position (`$pos.parent` is `yamlSequence`), while
  // pair keys/values and nested collections sit inside a pair or outer entry and fall back to `enclosingEntry`.
  return entryAt(doc, pos) ?? enclosingEntry(doc, pos);
}

/** Return the active YAML entry at `state.selection`, whether selected atomically or via caret. */
function activeEntry(state: EditorState): YAMLEntry | null {
  if (state.doc.firstChild?.type !== schema.nodes.yamlFrontMatter) return null;
  if (state.selection instanceof NodeSelection) return entryContaining(state.doc, state.selection.from);
  return enclosingEntry(state.doc, state.selection.head);
}

/** Identify whether `scalarPos` is a pair key, a pair value, or a sequence item within `entry`. */
function scalarSlot(entry: YAMLEntry, scalarPos: number): YAMLScalarSlot {
  switch (entry.kind) {
    case 'item':
      return 'item';
    case 'pair':
      return scalarPos === entry.key.pos ? 'key' : 'value';
  }
}

/** Classify a selection inside a single `yamlScalar` with its owning entry, slot, and line-edge flags. */
function readScalarFocus(state: EditorState): YAMLScalarFocus | null {
  if (state.doc.firstChild?.type !== schema.nodes.yamlFrontMatter) return null;
  const { selection } = state;
  if (selection instanceof NodeSelection) {
    const { node } = selection;
    if (node.type !== schema.nodes.yamlScalar || node.attrs.tag !== 'boolean') return null;
    const entry = entryContaining(state.doc, selection.from);
    if (!entry) return null;
    return {
      kind: 'boolean',
      pos: selection.from,
      node,
      entry,
      slot: scalarSlot(entry, selection.from),
    };
  }
  if (selection instanceof TextSelection && selection.$from.sameParent(selection.$to)) {
    const { $head } = selection;
    const node = $head.parent;
    if (node.type !== schema.nodes.yamlScalar || node.attrs.tag === 'boolean') return null;
    const pos = $head.before();
    const entry = entryContaining(state.doc, pos);
    if (!entry) return null;
    const text = node.textContent;
    const offset = $head.parentOffset;
    return {
      kind: 'text',
      pos,
      node,
      entry,
      slot: scalarSlot(entry, pos),
      empty: selection.empty,
      offset,
      atStart: offset === 0,
      atEnd: offset === node.content.size,
      onFirstLine: !text.slice(0, offset).includes('\n'),
      onLastLine: !text.slice(offset).includes('\n'),
    };
  }
  return null;
}

/** Lazily collected YAML scalars and their visual DOM rows for a single navigation or Shift+Arrow step. */
class FieldGrid {
  private fieldsCache: readonly ValuePosition[] | null = null;
  private rowsCache: readonly (readonly MeasuredField[])[] | null = null;

  constructor(
    private readonly doc: Node,
    private readonly view?: EditorView,
  ) {}

  /** All `yamlScalar` nodes inside `yamlFrontMatter` in document preorder. */
  get fields(): readonly ValuePosition[] {
    if (this.fieldsCache) return this.fieldsCache;
    const first = this.doc.firstChild;
    this.fieldsCache = first?.type === schema.nodes.yamlFrontMatter
      ? collectSubtreeFields(this.doc, 0, first.nodeSize)
      : [];
    return this.fieldsCache;
  }

  /** Mounted scalars grouped into left-to-right visual rows, measured at most once per instance. */
  get rows(): readonly (readonly MeasuredField[])[] {
    if (this.rowsCache) return this.rowsCache;
    if (!this.view) {
      this.rowsCache = [];
      return this.rowsCache;
    }
    const measured: MeasuredField[] = [];
    for (const field of this.fields) {
      const rect = scalarDOM(this.view, field.pos)?.getBoundingClientRect();
      if (rect && rect.height > 0 && rect.width > 0) measured.push({ field, rect });
    }
    this.rowsCache = groupVisualRows(measured).map(row => row.items);
    return this.rowsCache;
  }

  /** Whether `scalarPos` is one of the front matter scalars in this grid. */
  contains(scalarPos: number): boolean {
    return this.fields.some(field => field.pos === scalarPos);
  }

  /** Return the previous or next scalar in document order, or `undefined` past the end. */
  neighborField(scalarPos: number, direction: -1 | 1): ValuePosition | undefined {
    const index = this.fields.findIndex(field => field.pos === scalarPos);
    return index >= 0 ? this.fields[index + direction] : undefined;
  }

  /** Whether `scalarPos` is the first (`direction = -1`) or last (`direction = 1`) scalar in front matter. */
  isBoundaryField(scalarPos: number, direction: -1 | 1): boolean {
    const index = this.fields.findIndex(field => field.pos === scalarPos);
    if (index < 0) return false;
    return direction < 0 ? index === 0 : index === this.fields.length - 1;
  }

  /** Return the visual row index and measured box containing `scalarPos`, or `null` when unmounted. */
  rowItem(scalarPos: number): { readonly rowIndex: number; readonly item: MeasuredField } | null {
    const rowIndex = this.rows.findIndex(row => row.some(item => item.field.pos === scalarPos));
    if (rowIndex < 0) return null;
    const item = this.rows[rowIndex]!.find(entry => entry.field.pos === scalarPos)!;
    return { rowIndex, item };
  }

  /** Whether `scalarPos` lies on the topmost (`direction = -1`) or bottommost (`direction = 1`) visual row. */
  isBoundaryRow(scalarPos: number, direction: -1 | 1): boolean {
    const found = this.rowItem(scalarPos);
    return found !== null && !this.rows[found.rowIndex + direction];
  }

  /** Pick the block owning the scalar one step vertically (when mounted) or horizontally from `fieldPos`. */
  adjacentBlock(
    blocks: readonly SelectableBlock[],
    anchorBlock: SelectableBlock,
    fieldPos: number,
    axis: 'horizontal' | 'vertical',
    direction: -1 | 1,
  ): SelectableBlock {
    if (axis === 'vertical' && this.view) {
      const vertical = this.stepBlockVertically(blocks, fieldPos, direction);
      if (vertical) return vertical;
    }
    const nextField = this.neighborField(fieldPos, direction);
    return (nextField && blockAtPosition(blocks, nextField.pos)) ?? anchorBlock;
  }

  /** Resolve the selectable block one visual row above or below `refPos` by its horizontal center. */
  stepBlockVertically(
    blocks: readonly SelectableBlock[],
    refPos: number,
    direction: -1 | 1,
  ): SelectableBlock | null {
    const origin = this.rowItem(refPos);
    if (!origin) return null;
    const nextRow = this.rows[origin.rowIndex + direction];
    if (!nextRow) return null;
    const centerX = (origin.item.rect.left + origin.item.rect.right) / 2;
    const picked = closestInVisualRow(nextRow, centerX);
    return blockAtPosition(blocks, picked.field.pos) ?? null;
  }
}

/** Apply a `StepOutcome` to `dispatch`, returning `false` when the key belongs to another handler. */
function applyStepOutcome(
  state: EditorState,
  outcome: StepOutcome,
  dispatch?: (tr: Transaction) => void,
): boolean {
  if (!outcome) return false;
  if (outcome !== 'clamp') {
    dispatch?.(state.tr.setSelection(outcome).scrollIntoView());
  }
  return true;
}

/** Insert an empty pair or scalar item at `index` in `container` (`collectionPos`), returning its position. */
function insertBlankCollectionEntry(tr: Transaction, collectionPos: number, index: number): number | null {
  const container = tr.doc.nodeAt(collectionPos);
  if (!container || !isYAMLCollection(container) || index < 0 || index > container.childCount) return null;
  let at = collectionPos + 1;
  for (let i = 0; i < index; i++) {
    at += container.child(i).nodeSize;
  }
  if (container.type === schema.nodes.yamlMapping) {
    insert(tr, at, schema.nodes.yamlPair, {}, Fragment.fromArray([newValue('string'), newValue('string')]));
  } else {
    insert(tr, at, schema.nodes.yamlScalar, { tag: 'string' });
  }
  return at;
}

/** Build an isolated transaction appending a blank sibling immediately after `entry`. */
function insertSiblingEntry(state: EditorState, entry: YAMLEntry): Transaction | null {
  return insertFrontmatterEntry(state, entry.parentPos, entry.index + 1);
}

/** Recursively mark all collections inside `node` as `flow: true` while leaving leaf text unchanged. */
function withFlowSubtree(node: Node): Node {
  if (node.isLeaf || node.isTextblock) return node;
  const children = node.content.content.map(withFlowSubtree);
  const unchanged = children.every((child, index) => child === node.child(index));
  if (isYAMLCollection(node)) {
    if (isFlowCollection(node) && unchanged) return node;
    return node.type.create({ flow: true }, Fragment.fromArray(children));
  }
  return unchanged ? node : node.copy(Fragment.fromArray(children));
}

/** Whether `pos` has an enclosing flow `yamlMapping` or `yamlSequence` ancestor. */
function hasFlowAncestor(doc: Node, pos: number): boolean {
  const $pos = doc.resolve(pos);
  for (let depth = 1; depth <= $pos.depth; depth++) {
    if (isFlowCollection($pos.node(depth))) return true;
  }
  return false;
}

/** Construct an empty default value node matching a front matter property `type`. */
function newValue(type: KagamiMD.FrontmatterValueType): Node {
  switch (type) {
    case 'object': return schema.nodes.yamlMapping.create({ flow: true });
    case 'array': return schema.nodes.yamlSequence.create({ flow: true });
    case 'number': return schema.nodes.yamlScalar.create({ tag: 'integer' }, schema.text('0'));
    case 'boolean': return schema.nodes.yamlScalar.create({ tag: 'boolean' }, schema.text('false'));
    case 'null': return schema.nodes.yamlScalar.create({ tag: 'null' }, schema.text('null'));
    case 'string': return schema.nodes.yamlScalar.create({ tag: 'string' });
  }
}

/** Collect every `yamlScalar` position within `[from, to]` in document preorder. */
function collectSubtreeFields(doc: Node, from: number, to: number): ValuePosition[] {
  const fields: ValuePosition[] = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (node.type === schema.nodes.yamlScalar) {
      fields.push({ node, pos });
      return false;
    }
    return true;
  });
  return fields;
}

/** Construct a `NodeSelection` on booleans or an intra-scalar `TextSelection` at viewport X within `target`. */
function fieldSelectionAtX(
  doc: Node,
  view: EditorView,
  target: MeasuredField,
  x: number,
  direction: -1 | 1,
): Selection {
  const { field, rect } = target;
  if (field.node.attrs.tag === 'boolean') {
    return NodeSelection.create(doc, field.pos);
  }
  const minPos = field.pos + 1;
  const maxPos = field.pos + field.node.nodeSize - 1;
  const clampedX = Math.max(rect.left + 1, Math.min(rect.right - 1, x));
  const probeY = rect.height > 16
    ? (direction > 0 ? Math.min(rect.bottom - 1, rect.top + 6) : Math.max(rect.top + 1, rect.bottom - 6))
    : (rect.top + rect.bottom) / 2;
  const hit = view.posAtCoords({ left: clampedX, top: probeY });
  if (hit && hit.pos >= minPos && hit.pos <= maxPos) {
    return TextSelection.create(doc, hit.pos);
  }
  const centerX = (rect.left + rect.right) / 2;
  const fallbackSide = x <= centerX ? 1 : direction;
  return scalarSelection(doc, field, fallbackSide);
}

/** Create the canonical selection at the start (`side = 1`) or end (`side = -1`) of a YAML scalar. */
function scalarSelection(doc: Node, field: ValuePosition, side: -1 | 1): Selection {
  if (field.node.attrs.tag === 'boolean') return NodeSelection.create(doc, field.pos);
  const offset = side > 0 ? field.pos + 1 : field.pos + field.node.nodeSize - 1;
  return TextSelection.create(doc, offset);
}

/** Move `tr`'s selection to the first (`side = 1`) or last (`side = -1`) scalar inside the node at `pos`. */
function focusSubtree(tr: Transaction, pos: number, side: -1 | 1): Transaction {
  const node = tr.doc.nodeAt(pos);
  if (!node) return tr;
  const fields = collectSubtreeFields(tr.doc, pos, pos + node.nodeSize);
  const target = side > 0 ? fields[0] : fields.at(-1);
  if (target) return tr.setSelection(scalarSelection(tr.doc, target, side));
  return tr.setSelection(Selection.near(tr.doc.resolve(Math.min(pos + 1, tr.doc.content.size)), side));
}

/** Place focus inside the updated value of `entryPos`, or on its key/nearest neighbor if empty. */
function focusChangedEntry(tr: Transaction, entryPos: number): Transaction {
  const entry = entryAt(tr.doc, entryPos);
  if (!entry) return focusAfterRemoval(tr, entryPos, -1);
  const fields = collectSubtreeFields(tr.doc, entry.value.pos, entry.value.pos + entry.value.node.nodeSize);
  if (fields.length > 0) return tr.setSelection(scalarSelection(tr.doc, fields[0]!, 1));
  if (entry.kind === 'pair') return focusSubtree(tr, entry.key.pos, -1);
  return focusAfterRemoval(tr, entry.value.pos, -1);
}

/** Pick the scalar immediately before or after `removedPos` within `fields`, respecting `bias`. */
function focusNearestField(
  tr: Transaction,
  fields: readonly ValuePosition[],
  removedPos: number,
  bias: -1 | 1,
): Transaction | null {
  if (!fields.length) return null;
  let before: ValuePosition | undefined;
  let after: ValuePosition | undefined;
  for (const field of fields) {
    if (field.pos < removedPos) before = field;
    else if (!after) after = field;
  }
  const preferred = bias < 0 ? before ?? after : after ?? before;
  if (!preferred) return null;
  const side = preferred === before ? -1 : 1;
  return tr.setSelection(scalarSelection(tr.doc, preferred, side));
}

/** Restore focus after deleting an entry inside `yamlFrontMatter`, preferring siblings in the same collection. */
function focusAfterRemoval(tr: Transaction, removedPos: number, bias: -1 | 1): Transaction {
  const frontmatterNode = tr.doc.firstChild;
  if (frontmatterNode?.type !== schema.nodes.yamlFrontMatter) {
    return tr.setSelection(Selection.near(tr.doc.resolve(Math.min(removedPos, tr.doc.content.size)), 1));
  }
  const $at = tr.doc.resolve(Math.min(removedPos, frontmatterNode.nodeSize - 1));
  const parent = $at.parent;
  if (isYAMLCollection(parent)) {
    const parentPos = $at.before();
    const within = collectSubtreeFields(tr.doc, parentPos, parentPos + parent.nodeSize);
    const localFocus = focusNearestField(tr, within, removedPos, bias);
    if (localFocus) return localFocus;
    const owner = entryContaining(tr.doc, parentPos);
    if (owner?.kind === 'pair') return focusSubtree(tr, owner.key.pos, -1);
  }
  const allFocus = focusNearestField(tr, collectSubtreeFields(tr.doc, 0, frontmatterNode.nodeSize), removedPos, bias);
  if (allFocus) return allFocus;
  return tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(removedPos, tr.doc.content.size)), -1));
}

/** Whether a YAML scalar, collection, or key/value pair holds no user content (booleans are never empty). */
function isEmptyEntry(node: Node): boolean {
  if (node.type === schema.nodes.yamlScalar) return node.attrs.tag !== 'boolean' && node.content.size === 0;
  if (isYAMLCollection(node)) return node.childCount === 0;
  if (node.type === schema.nodes.yamlPair) return isEmptyEntry(node.child(0)) && isEmptyEntry(node.child(1));
  return false;
}

/** Exit a trailing blank nested entry to a sibling in its outer container, or leave the trailing root property into body. */
function exitBlankEntry(state: EditorState, entry: YAMLEntry): Transaction | null {
  if (entry.depth > 2 && entry.index === entry.parent.childCount - 1) {
    const outer = entryContaining(state.doc, entry.parentPos);
    if (!outer) return null;
    const tr = isolateHistory(state.tr);
    remove(tr, entry.pos, entry.pos + entry.node.nodeSize);
    const outerParentPos = tr.mapping.map(outer.parentPos, -1);
    const insertedPos = insertBlankCollectionEntry(tr, outerParentPos, outer.index + 1);
    if (insertedPos === null) return null;
    return edit(focusSubtree(tr, insertedPos, 1));
  }
  if (entry.depth === 2 && entry.index === entry.parent.childCount - 1) {
    const tr = isolateHistory(state.tr);
    // Double-Enter on a sole root pair keeps the empty `yamlFrontMatter` shell when moving to the body;
    // removing an empty front matter block requires explicit Backspace or Delete.
    if (entry.parent.childCount > 1) remove(tr, entry.pos, entry.pos + entry.node.nodeSize);
    const bodyPos = tr.doc.firstChild!.nodeSize;
    return edit(tr.setSelection(Selection.near(tr.doc.resolve(bodyPos), 1)));
  }
  return null;
}

/** Remove `entry`, dissolving the whole `yamlFrontMatter` shell when `entry` is the sole root property. */
function removeEntryOrEmptyFrontmatter(state: EditorState, entry: YAMLEntry, bias: -1 | 1): Transaction | null {
  const frontmatterNode = state.doc.firstChild!;
  if (entry.depth === 2 && entry.parent.childCount === 1) {
    const tr = isolateHistory(state.tr);
    remove(tr, 0, frontmatterNode.nodeSize);
    return edit(tr.setSelection(Selection.near(tr.doc.resolve(0), 1)));
  }
  return removeFrontmatterEntry(state, entry.pos, bias);
}

/** Delete or reset a selected atomic boolean inside structured front matter for shared selection commands. */
export function deleteSelectedFrontmatterBoolean(state: EditorState, bias: -1 | 1 = 1): Transaction | null {
  const focus = readScalarFocus(state);
  return focus?.kind === 'boolean' ? deleteBooleanScalar(state, focus, bias) : null;
}

/** Delete an atomic boolean sequence item, or reset a boolean property value to an empty string scalar. */
function deleteBooleanScalar(
  state: EditorState,
  focus: YAMLScalarFocus.Boolean,
  bias: -1 | 1,
): Transaction | null {
  switch (focus.entry.kind) {
    case 'item':
      return removeFrontmatterEntry(state, focus.entry.pos, bias);
    case 'pair': {
      const tr = isolateHistory(state.tr);
      replace(tr, focus.pos, focus.pos + focus.node.nodeSize, new Slice(Fragment.from(newValue('string')), 0, 0));
      return edit(focusSubtree(tr, focus.pos, 1));
    }
  }
}

/** Whether `$head` sits at offset 0 of the first textblock in the body immediately following front matter. */
function isStartOfBodyAfterFrontmatter(state: EditorState, $head: ResolvedPos): boolean {
  const session = frontmatterKey.getState(state);
  if (session?.collapsed || session?.source) return false;
  if ($head.parentOffset > 0 || $head.depth < 1 || $head.index(0) !== 1) return false;
  for (let depth = $head.depth; depth > 1; depth--) {
    if ($head.index(depth - 1) !== 0) return false;
  }
  return true;
}

/** Mark a frontmatter transaction with isolated history and scroll-into-view behavior. */
function edit(tr: Transaction): Transaction { return isolateHistory(tr).scrollIntoView(); }

/** Only a text input opening at the file's head creates structured front matter. */
function readOpening(transactions: readonly Transaction[], old: EditorState, tr: Transaction): Transaction | null {
  const first = tr.doc.firstChild;
  const selected = tr.selection;
  if (first?.type !== schema.nodes.paragraph || !(selected instanceof TextSelection) ||
      !selected.empty || selected.$head.depth !== 1 || selected.$head.index(0)) return null;
  const composition = compositionState(old);
  const committed = transactions.some(tr => tr.getMeta(compositionCommit)) &&
    composition?.activeTextblockPos === 0 && composition.inputHistory !== null;
  // Require an inline text step (or IME commit) in the leading paragraph so undo or programmatic inserts
  // that recreate a `---` line do not unexpectedly collapse back into structured front matter.
  let edited: number | null = null;
  for (const tr of transactions) {
    for (let i = 0; i < tr.steps.length; i++) {
      const step = tr.steps[i]!;
      if (step instanceof ReplaceStep && !step.slice.openStart && !step.slice.openEnd &&
          step.slice.content.content.every(node => node.isInline)) {
        const doc = tr.docs[i]!;
        const from = doc.resolve(step.from);
        const to = doc.resolve(step.to);
        if (from.depth === 1 && !from.index(0) && from.parent.type === schema.nodes.paragraph && from.sameParent(to))
          edited = 0;
      }
      if (edited !== null) {
        const mapped = step.getMap().mapResult(edited, 1);
        edited = mapped.deletedAfter ? null : mapped.pos;
      }
    }
  }
  if (edited !== 0 && !committed || parseFrontmatterOpening(fieldSource(first))?.marker !== '---') return null;
  const pair = schema.nodes.yamlPair.create(null, [newValue('string'), newValue('string')]);
  insert(tr, 0, schema.nodes.yamlFrontMatter, {}, Fragment.from(schema.nodes.yamlMapping.create(null, pair)));
  const block = tr.doc.firstChild!;
  remove(tr, block.nodeSize, block.nodeSize + first.nodeSize);
  return focusSubtree(tr, 0, 1).scrollIntoView();
}
