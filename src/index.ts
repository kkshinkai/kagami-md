/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export { KagamiMD } from './editor/editor.js';
export type { EditorLoc, SourceLoc } from './source/index.js';
export { Command } from './command/command.js';
export { Completion } from './editor/completion.js';

// Commands that belong to no one feature of a document.
export { copy, cut, redo, undo } from './command/commands.js';

// One namespace for each feature of a document that has commands of its own.
export { CodeBlock } from './schema/code.js';
export { Callout } from './schema/callout.js';
export { Table } from './table/table.js';
export { Frontmatter } from './schema/frontmatter.js';
export { Image } from './schema/image.js';
export type { Tag } from './schema/tag.js';
export type { Wikilink } from './schema/wikilink.js';

// The editor's events and registrations, and a store a host releases its registrations with.
export { DestroyableStore, type Event, type IDestroyable } from './event/index.js';

// The demonstration controls.
export { Menu, List, Picker, Popup, CompletionList, createIcon, calloutIcons, valueTypeIcons, icons } from './ui/index.js';
