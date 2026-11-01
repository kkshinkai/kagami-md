/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export { isCodeLanguage } from './syntax/code-language.js';
export { parseFile, parseBlocks, transduce } from './syntax/read.js';
export { isFootnoteLabel, isLinkLabel, isLinkDestination, isLinkTitle } from './syntax/definition.js';
export {
  parseFrontmatter,
  parseFrontmatterOpening,
  type FrontmatterMatch,
} from './constructs/flow/frontmatter.js';
// ZWSP edge mark: Expose the syntax and the reader's predicate to the unparser.
export { edgeMarkCode } from './constructs/text/edge-mark.js';
export { needsEdgeMark, type EdgeMarkKind, type EdgeMarkPlace } from './syntax/edge-mark.js';
export { repairPhrasing, type TextRepair } from './syntax/reactions.js';
export { htmlBlockEnds } from './syntax/html-block-ends.js';
export { longestClosingFence } from './syntax/closing-fence.js';
export { paragraphReactions } from './syntax/paragraph-reactions.js';
export { fitsOnMarkerLine } from './syntax/marker-line.js';
export { startsLinkTitle } from './syntax/title-opening.js';
export { fitsIndentedCode } from './syntax/indented-code.js';
export { normalizeIdentifier } from './kernel/utils/normalize-identifier/index.js';
export { measureWidth } from './compile/width.js';
export { emojiForShortcode } from './constructs/text/emoji.js';
export { Syntax, type SourceRange } from './syntax/syntax.js';
export * from './syntax/block.js';
export * from './syntax/inline.js';
export type { Frontier, FrontierPiece } from './syntax/frontier.js';
export { Bindings, ReferenceLabels } from './syntax/reading.js';
export type {
  VirtualFile,
  Phrasing,
  ReadOptions,
  TransduceOptions,
  Transduction,
} from './syntax/reading.js';
