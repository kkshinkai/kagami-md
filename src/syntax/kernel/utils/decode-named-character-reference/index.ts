/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-FileCopyrightText: Titus Wormer <tituswormer@gmail.com>
 * SPDX-License-Identifier: MPL-2.0 AND MIT
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Derived from micromark, https://github.com/micromark/micromark. */

import { characterEntities } from '../../../data/named-character-references.js';

/** Local dependency removal: decode a name without its surrounding ampersand and semicolon. */
export function decodeNamedCharacterReference(value: string): string | false {
  return Object.hasOwn(characterEntities, value) ? characterEntities[value]! : false;
}
