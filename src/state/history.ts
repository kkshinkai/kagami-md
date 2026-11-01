/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { closeHistory, isHistoryTransaction, history as nativeHistory } from 'prosemirror-history';
import { PluginKey, type EditorState, type Plugin, type Transaction } from 'prosemirror-state';

const boundary = new PluginKey('command-history-boundary');

/** Install native history, including the corrections that follow each document edit. */
export function history(): Plugin {
  return nativeHistory();
}

export namespace history {
  /** History and its appended transactions restore an earlier document. */
  export function restoring(transactions: readonly Transaction[]): boolean {
    return transactions.some(tr => {
      if (isHistoryTransaction(tr)) return true;
      const appended: Transaction | undefined = tr.getMeta('appendedTransaction');
      return appended !== undefined && isHistoryTransaction(appended);
    });
  }

  /** Start an undo event that ends after the document's corrections have run. */
  export function isolate(transaction: Transaction): Transaction {
    return closeHistory(transaction).setMeta(boundary, true);
  }

  /** Close the event after every correction sweep, before the result is published. */
  export function finish(state: EditorState, transactions: readonly Transaction[]): EditorState {
    if (!transactions.some(transaction => transaction.getMeta(boundary))) return state;
    // Native correction hooks run in rounds. Only the state owner knows when every
    // feature has finished, so it closes the command's event after the native loop.
    return state.applyTransaction(closeHistory(state.tr)).state;
  }
}
