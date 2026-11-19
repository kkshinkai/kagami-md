/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { KagamiMD } from './editor.js';

/** The live document control behind a surface click event. */
export interface ControlTarget {
  element(): Element | null;
  pos(): number | undefined;
  held(value: boolean): void;
}

/** Reference-counted open UI holds for one document surface control. */
export class ControlHold {
  private count = 0;

  constructor(private readonly target: ControlTarget) {}

  acquire(alive: () => boolean): KagamiMD.Hold | null {
    const element = this.target.element();
    if (!alive() || !element?.isConnected || this.target.pos() === undefined) return null;
    this.count++;
    if (this.count === 1) this.target.held(true);
    let active = true;
    return {
      rect: () => {
        const current = active && alive() && this.target.pos() !== undefined ? this.target.element() : null;
        return current?.isConnected ? current.getBoundingClientRect() : null;
      },
      destroy: () => {
        if (!active) return;
        active = false;
        this.count--;
        if (this.count === 0 && alive()) this.target.held(false);
      },
    };
  }
}
