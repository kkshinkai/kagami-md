/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Plugin } from 'prosemirror-state';
import type { KagamiMD } from './editor.js';

/**
 * Coarse precedence tiers within each plugin lifetime. Features are listed in
 * execution order, so most plugins omit `rank` and stay in `Default`.
 */
export enum PluginRank {
  Highest = 0,
  High = 1,
  Default = 2,
  Low = 3,
  Lowest = 4,
}

/** A deferred plugin declaration tagged by its lifetime and coarse rank. */
export type PluginDesc =
  | PluginDesc.State
  | PluginDesc.ViewState
  | PluginDesc.View;

export namespace PluginDesc {
  export enum Type {
    /** Persistent document truth and reading corrections held on `KagamiMD.State`. */
    State = 0,
    /** View-bound state and props installed on `EditorState` while mounted. */
    ViewState = 1,
    /** Stateless view plugins passed directly to `EditorView`. */
    View = 2,
  }

  export interface State {
    readonly type: Type.State;
    readonly rank: PluginRank;
    create(state?: KagamiMD.State): Plugin | null;
  }

  export interface ViewState {
    readonly type: Type.ViewState;
    readonly rank: PluginRank;
    create(editor?: KagamiMD): Plugin | null;
  }

  export interface View {
    readonly type: Type.View;
    readonly rank: PluginRank;
    create(editor?: KagamiMD): Plugin | null;
  }

  export function state(
    create: (state?: KagamiMD.State) => Plugin | null,
    rank = PluginRank.Default,
  ): State {
    return { type: Type.State, rank, create };
  }

  export function viewState(
    create: (editor?: KagamiMD) => Plugin | null,
    rank = PluginRank.Default,
  ): ViewState {
    return { type: Type.ViewState, rank, create };
  }

  export function view(
    create: (editor?: KagamiMD) => Plugin | null,
    rank = PluginRank.Default,
  ): View {
    return { type: Type.View, rank, create };
  }

  /** Sort descriptors by `(type, rank, declarationOrder)` and partition them once. */
  export function compile(descs: readonly PluginDesc[]): CompiledPlugins {
    const sorted = [...descs].sort((a, b) => a.type - b.type || a.rank - b.rank);
    const stateDescs: State[] = [];
    const viewStateDescs: ViewState[] = [];
    const viewDescs: View[] = [];
    for (const desc of sorted) {
      switch (desc.type) {
        case Type.State: stateDescs.push(desc); break;
        case Type.ViewState: viewStateDescs.push(desc); break;
        case Type.View: viewDescs.push(desc); break;
      }
    }
    return new CompiledPlugins(stateDescs, viewStateDescs, viewDescs);
  }
}

/** Pre-sorted plugin descriptors split across `State`, `ViewState`, and `View`. */
export class CompiledPlugins {
  /** @internal */
  constructor(
    private readonly stateDescs: readonly PluginDesc.State[],
    private readonly viewStateDescs: readonly PluginDesc.ViewState[],
    private readonly viewDescs: readonly PluginDesc.View[],
  ) {}

  state(state?: KagamiMD.State): Plugin[] {
    return createPlugins(this.stateDescs, state);
  }

  viewState(editor?: KagamiMD): Plugin[] {
    return createPlugins(this.viewStateDescs, editor);
  }

  view(editor?: KagamiMD): Plugin[] {
    return createPlugins(this.viewDescs, editor);
  }
}

function createPlugins<Arg>(
  descs: readonly { create(arg?: Arg): Plugin | null }[],
  arg?: Arg,
): Plugin[] {
  const plugins: Plugin[] = [];
  for (const desc of descs) {
    const plugin = desc.create(arg);
    if (plugin) plugins.push(plugin);
  }
  return plugins;
}
