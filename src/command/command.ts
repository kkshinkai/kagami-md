/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IDestroyable } from '../event/index.js';
import { NodeType } from 'prosemirror-model';
import { PluginKey, type EditorState } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import type { KagamiMD } from '../editor/editor.js';

/**
 * An action on an editor, with at most one parameter. Returns true when it
 * acted, or false when it does not apply and nothing changed. A command's
 * function identity also names the action to registered handlers.
 */
export type Command<Param = void> = (editor: KagamiMD, param: Param) => boolean;

export namespace Command {
  /** A command that can act on a document without a view. */
  export type Pure<Param = void> = (target: { readonly state: KagamiMD.State }, param: Param) => boolean;

  /** Call registered handlers, latest first, then the command itself. */
  export function dispatch(editor: KagamiMD, command: Command): boolean;
  export function dispatch<Param>(editor: KagamiMD, command: Command<Param>, param: Param): boolean;
  export function dispatch<Param>(editor: KagamiMD, command: Command<Param>, param?: Param): boolean {
    for (const handler of editor.commandHandlers(command)) {
      if (handler(editor, param as Param)) return true;
    }
    return command(editor, param as Param);
  }

  /** A host's open request, kept attached to the control that raised it. */
  export interface Hold extends IDestroyable {
    /** The control's current rectangle, or null after it leaves the document. */
    rect(): DOMRectReadOnly | null;
  }

  /** A host request identifies the feature state that keeps its control open. */
  export interface Request<Param> extends Command<Param> {
    /** @internal */
    readonly key: PluginKey<RequestState>;
  }

  /** The feature supplies a hold on the control in the requested view. */
  export interface RequestState {
    hold(view: EditorView, pos: number): Hold | null;
  }

  /** Keep a request open until its hold is destroyed. */
  export function hold<Param extends { readonly pos: number }>(
    editor: KagamiMD,
    command: Request<Param>,
    pos: number
  ): Hold | null {
    const view = editor.view;
    if (!view || editor.isDestroyed()) return null;
    return command.key.getState(view.state)?.hold(view, pos) ?? null;
  }
}

/** A request has no default action; its key connects the host to the feature. */
export function requestCommand<Param>(): Command.Request<Param> {
  return Object.assign(() => false, { key: new PluginKey<Command.RequestState>('command-request') });
}

/** The feature that drew a request supplies its current place and presentation. */
export interface CommandRequest {
  pos(): number | undefined;
  rect(): DOMRectReadOnly;
  held(value: boolean): void;
}

/** Keep a feature's request attached to its live node view. */
export function keepRequest(request: CommandRequest | null, pos: number, alive: () => boolean): Command.Hold | null {
  if (!request || !alive() || request.pos() !== pos) return null;
  request.held(true);
  let held = true;
  return {
    rect: () => held && alive() && request.pos() !== undefined ? request.rect() : null,
    destroy() {
      if (!held) return;
      held = false;
      if (alive()) request.held(false);
    },
  };
}

/** Find the owner named by an editor position, or enclosing the selection. */
export function findTarget(
  state: EditorState,
  pos: number | undefined,
  query: NodeType | ((type: NodeType) => boolean)
): number | undefined {
  const at = pos ?? state.selection.from;
  if (!Number.isSafeInteger(at) || at < 0 || at > state.doc.content.size) return undefined;
  const matches = query instanceof NodeType ? (type: NodeType) => type === query : query;
  const $pos = state.doc.resolve(at);
  const after = $pos.nodeAfter;
  if (pos !== undefined && after && matches(after.type)) return at;
  for (let depth = $pos.depth; depth > 0; depth--) {
    if (matches($pos.node(depth).type)) return $pos.before(depth);
  }
  return after && matches(after.type) ? at : undefined;
}
