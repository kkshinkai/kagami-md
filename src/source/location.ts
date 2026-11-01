/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** A ProseMirror position, distinct from a physical source offset. */
export type EditorLoc = number & { readonly __editorLoc: unique symbol };

/** A UTF-16 offset in the LF-normalized source. */
export type SourceLoc = number & { readonly __sourceLoc: unique symbol };
