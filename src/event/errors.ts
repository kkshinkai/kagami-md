/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-FileCopyrightText: Microsoft Corporation
 * SPDX-License-Identifier: MPL-2.0 AND MIT
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Derived from Visual Studio Code, https://github.com/microsoft/vscode. */

/** Reports an error to the host without interrupting the current operation. */
export function reportError(error: unknown): void {
	if (typeof globalThis.reportError === 'function') {
		globalThis.reportError(error);
	} else {
		setTimeout(() => { throw error; }, 0);
	}
}
