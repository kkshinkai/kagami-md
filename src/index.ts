/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export { KagamiMD } from './editor/editor.js';
export { KagamiState } from './state/state.js';
export type { EditorLoc, SourceLoc } from './source/index.js';

// The editor's events and registrations, and a store a host releases its registrations with.
export { Destroyable, DestroyableStore, Emitter, type Event, type IDestroyable } from './event/index.js';

// The demonstration controls.
export { Menu, List, Picker, Popup, CompletionList, createIcon, calloutIcons, valueTypeIcons, icons } from './ui/index.js';
