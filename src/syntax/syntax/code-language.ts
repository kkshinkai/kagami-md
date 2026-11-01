/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { queryEvents } from '../compile/query.js';
import { codeLanguage } from '../constructs/query/code-language.js';

/** Whether a language name can be written literally in the editor's code-fence info slot. */
export function isCodeLanguage(text: string): boolean {
  return queryEvents(text, codeLanguage).some(([kind, token]) =>
    kind === 'enter' && token.type === 'codeFencedFenceInfo');
}
