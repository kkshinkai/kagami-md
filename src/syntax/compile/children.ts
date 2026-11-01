/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Syntax, EMPTY_CHILDREN } from '../syntax/syntax.js';
import {
  BlockQuoteSyntax,
  BlockSyntax,
  BulletListSyntax,
  OrderedListSyntax,
  ListItemSyntax,
  LinkDestinationSyntax,
  CalloutSyntax,
  CalloutTitleSyntax,
  ContainerBlockSyntax,
  DocumentSyntax,
  FrontMatterSyntax,
  InlineFieldClauseSyntax,
  StringFieldClauseSyntax,
  TableCellSyntax,
  TableDelimiterRowSyntax,
  TableRowSyntax,
  TableSyntax,
  TextBlockSyntax,
} from '../syntax/block.js';
import {
  BackslashEscapeSyntax,
  CalloutDeclarationSyntax,
  CharacterReferenceSyntax,
  CodeSpanSyntax,
  DelimitedSyntax,
  FootnoteReferenceSyntax,
  HTMLCommentSyntax,
  HTMLImageSyntax,
  HTMLLineBreakSyntax,
  ImageSyntax,
  InlineMathSyntax,
  InlineSyntax,
  LinkSyntax,
  LinkTitleStartSyntax,
  PendingHTMLBlockSyntax,
  RawHTMLSyntax,
  TextTokenSyntax,
  TriviaTokenSyntax,
} from '../syntax/inline.js';
import { assert } from '../kernel/assert.js';

import { Fragment, type CompileContext } from './types.js';

/** Array slots already available while their owner is being compiled. */
export function children(node: Syntax | Fragment): ReadonlyArray<Syntax> {
  if (
    node instanceof Fragment ||
    node instanceof DocumentSyntax ||
    node instanceof ContainerBlockSyntax ||
    node instanceof TextBlockSyntax ||
    node instanceof InlineFieldClauseSyntax ||
    node instanceof StringFieldClauseSyntax ||
    node instanceof TableSyntax ||
    node instanceof TableRowSyntax ||
    node instanceof TableDelimiterRowSyntax ||
    node instanceof LinkSyntax ||
    node instanceof ImageSyntax ||
    node instanceof DelimitedSyntax ||
    node instanceof CodeSpanSyntax ||
    node instanceof InlineMathSyntax ||
    node instanceof RawHTMLSyntax ||
    node instanceof HTMLCommentSyntax ||
    node instanceof HTMLImageSyntax ||
    node instanceof HTMLLineBreakSyntax ||
    node instanceof FootnoteReferenceSyntax ||
    node instanceof PendingHTMLBlockSyntax
  )
    return node.children;
  return EMPTY_CHILDREN;
}

/** Place an event's node in its grammatical slot, even while its parent is open. */
export function append(context: CompileContext, parent: Syntax | Fragment, node: Syntax): void {
  if (parent instanceof DocumentSyntax) {
    if (node instanceof FrontMatterSyntax) parent.frontMatter = node;
    else {
      assert(node instanceof BlockSyntax, 'expected document block');
      parent.children.push(node);
    }
  } else if (parent instanceof BlockQuoteSyntax && node instanceof CalloutDeclarationSyntax) {
    // The declaration determines the quote's replacement; it is not a body block.
  } else if (parent instanceof CalloutSyntax && node instanceof CalloutTitleSyntax) {
    parent.title = node;
  } else if (parent instanceof BulletListSyntax || parent instanceof OrderedListSyntax) {
    assert(node instanceof ListItemSyntax, 'expected list item');
    parent.children.push(node);
  } else if (parent instanceof ContainerBlockSyntax) {
    assert(node instanceof BlockSyntax, 'expected container block');
    parent.children.push(node);
  } else if (parent instanceof TableSyntax) {
    if (node instanceof TableDelimiterRowSyntax) parent.delimiterRow = node;
    else {
      assert(node instanceof TableRowSyntax, 'expected table row');
      if (context.data.inTableHead) parent.headerRow = node;
      else parent.children.push(node);
    }
  } else if (parent instanceof TableRowSyntax) {
    assert(node instanceof TableCellSyntax, 'expected table cell');
    parent.children.push(node);
  } else {
    assert(node instanceof InlineSyntax, 'expected inline child');
    appendInline(parent, node);
  }
}

export function appendInline(parent: Syntax | Fragment, node: InlineSyntax): void {
  if (
    parent instanceof Fragment ||
    parent instanceof TextBlockSyntax ||
    parent instanceof InlineFieldClauseSyntax ||
    parent instanceof LinkSyntax ||
    parent instanceof ImageSyntax ||
    parent instanceof DelimitedSyntax ||
    parent instanceof PendingHTMLBlockSyntax
  ) {
    parent.children.push(node);
  } else if (node instanceof LinkTitleStartSyntax) {
    assert(parent instanceof LinkDestinationSyntax, 'expected destination field');
    parent.children.push(node);
  } else if (
    parent instanceof StringFieldClauseSyntax ||
    parent instanceof FootnoteReferenceSyntax
  ) {
    assert(
      node instanceof TriviaTokenSyntax ||
        node instanceof BackslashEscapeSyntax ||
        node instanceof CharacterReferenceSyntax ||
        (node instanceof TextTokenSyntax && (node.type === 'text' || node.type === 'lineEnding')),
      'expected string segment'
    );
    parent.children.push(node);
  } else {
    assert(
      parent instanceof CodeSpanSyntax ||
        parent instanceof InlineMathSyntax ||
        parent instanceof RawHTMLSyntax ||
        parent instanceof HTMLCommentSyntax ||
        parent instanceof HTMLLineBreakSyntax ||
        parent instanceof HTMLImageSyntax,
      'expected raw string owner'
    );
    assert(
      node instanceof TriviaTokenSyntax ||
        (node instanceof TextTokenSyntax && (node.type === 'text' || node.type === 'lineEnding')),
      'expected raw string segment'
    );
    parent.children.push(node);
  }
}

/** Replace the active node when a later token establishes its concrete class. */
export function replaceCurrent(context: CompileContext, replacement: Syntax): void {
  const index = context.stack.length - 1;
  const previous = context.stack[index];
  const parent = context.stack[index - 1];
  assert(previous instanceof Syntax && parent, 'expected active node and parent');
  replacement.start = previous.start;
  replacement.end = previous.end;
  context.stack[index] = replacement;
  if (replacement instanceof BlockSyntax) {
    assert(previous instanceof BlockSyntax, 'expected a block being replaced');
    replacement.bodyStart = previous.bodyStart;
    assert(
      parent instanceof DocumentSyntax || parent instanceof ContainerBlockSyntax,
      'expected block parent'
    );
    assert(
      parent.children[parent.children.length - 1] === previous,
      'expected active block at tail'
    );
    parent.children[parent.children.length - 1] = replacement;
  } else {
    assert(replacement instanceof InlineSyntax, 'expected inline replacement');
    assert(
      parent instanceof Fragment ||
        parent instanceof TextBlockSyntax ||
        parent instanceof InlineFieldClauseSyntax ||
        parent instanceof LinkSyntax ||
        parent instanceof ImageSyntax ||
        parent instanceof DelimitedSyntax ||
        parent instanceof PendingHTMLBlockSyntax,
      'expected inline parent'
    );
    assert(
      parent.children[parent.children.length - 1] === previous,
      'expected active inline node at tail'
    );
    parent.children[parent.children.length - 1] = replacement;
  }
}
