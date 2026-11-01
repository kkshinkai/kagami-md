/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { history } from '../state/history.js';
import { type Command } from 'prosemirror-state';

/** Give a deliberate table command its own native history event. */
export function tableHistory(command: Command): Command {
  return (state, dispatch, view) => {
    if (!dispatch) return command(state, undefined, view);
    return command(state, transaction => {
      if (transaction.docChanged) history.isolate(transaction);
      dispatch(transaction);
    }, view);
  };
}
