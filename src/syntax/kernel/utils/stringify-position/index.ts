/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-FileCopyrightText: Titus Wormer <tituswormer@gmail.com>
 * SPDX-License-Identifier: MPL-2.0 AND MIT
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Derived from unist-util-stringify-position, https://github.com/syntax-tree/unist-util-stringify-position. */

export interface PointLike {
  line?: number | null | undefined;
  column?: number | null | undefined;
  offset?: number | null | undefined;
}

export interface PositionLike {
  start?: PointLike | null | undefined;
  end?: PointLike | null | undefined;
}

/**
 * Serialize the positional info of a point or position (start and end
 * points).
 *
 * @param value
 *   Position, or point.
 * @returns
 *   Pretty printed positional info (`string`).
 *
 *   In the format of a range `ls:cs-le:ce` (when given `position`) or a point
 *   `l:c` (when given `point`), where `l` stands for line, `c` for column, `s`
 *   for `start`, and `e` for end.
 *   An empty string (`''`) is returned if the given value is neither
 *   `position`, nor `point`.
 */
export function stringifyPosition(value?: PointLike | PositionLike | null | undefined): string {
  // Nothing.
  if (!value || typeof value !== 'object') {
    return '';
  }

  // Position.
  if ('start' in value || 'end' in value) {
    return position(value as PositionLike);
  }

  // Point.
  if ('line' in value || 'column' in value) {
    return point(value as PointLike);
  }

  // ?
  return '';
}

function point(point: PointLike | null | undefined): string {
  return index(point && point.line) + ':' + index(point && point.column);
}

function position(pos: PositionLike | null | undefined): string {
  return point(pos && pos.start) + '-' + point(pos && pos.end);
}

function index(value: number | null | undefined): number {
  return value && typeof value === 'number' ? value : 1;
}
