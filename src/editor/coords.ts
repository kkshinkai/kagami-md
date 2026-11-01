/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export function localScale(host: HTMLElement) {
  const rect = host.getBoundingClientRect();
  const style = host.ownerDocument.defaultView!.getComputedStyle(host);
  const borderBox = (axis: 'width' | 'height') => {
    const size = parseFloat(style[axis]);
    if (!Number.isFinite(size)) return axis === 'width' ? host.offsetWidth : host.offsetHeight;
    const sides = axis === 'width' ? (['Left', 'Right'] as const) : (['Top', 'Bottom'] as const);
    return (
      size +
      (style.boxSizing === 'border-box'
        ? 0
        : sides.reduce(
            (sum, side) =>
              sum + parseFloat(style[`padding${side}`]) + parseFloat(style[`border${side}Width`]),
            0,
          ))
    );
  };
  // offsetWidth/Height round to integer CSS pixels. Dividing a fractional layout height by
  // that rounded height invents a transform even at 100%, accumulating error down the page.
  return { x: rect.width / borderBox('width') || 1, y: rect.height / borderBox('height') || 1 };
}
/** Convert a viewport point to the host's scrolled padding-box coordinates. */
export function overlayPoint(host: HTMLElement, x: number, y: number) {
  const origin = host.getBoundingClientRect();
  const scale = localScale(host);
  const style = host.ownerDocument.defaultView!.getComputedStyle(host);
  return {
    x: (x - origin.left) / scale.x - parseFloat(style.borderLeftWidth) + host.scrollLeft,
    y: (y - origin.top) / scale.y - parseFloat(style.borderTopWidth) + host.scrollTop,
  };
}
/** Convert a point in the host's scrolled padding box to viewport coordinates. */
export function viewportPoint(host: HTMLElement, point: { x: number; y: number }) {
  const origin = host.getBoundingClientRect();
  const scale = localScale(host);
  const style = host.ownerDocument.defaultView!.getComputedStyle(host);
  return {
    x: origin.left + (point.x + parseFloat(style.borderLeftWidth) - host.scrollLeft) * scale.x,
    y: origin.top + (point.y + parseFloat(style.borderTopWidth) - host.scrollTop) * scale.y,
  };
}
export function positionOverlay(host: HTMLElement, element: HTMLElement, rect: Rect) {
  const point = overlayPoint(host, rect.left, rect.top);
  const scale = localScale(host);
  Object.assign(element.style, {
    left: `${point.x}px`,
    top: `${point.y}px`,
    width: `${(rect.right - rect.left) / scale.x}px`,
    height: `${(rect.bottom - rect.top) / scale.y}px`,
  });
}

/** Scroll the nearest ancestor that can move in the requested direction. A saturated inner
 * scroller hands over to its parent; the document viewport participates like any other scroller.
 * Return whether geometry changed, so the caller remeasures before resolving the next intent. */
export function autoScroll(host: HTMLElement, y: number): boolean {
  const win = host.ownerDocument.defaultView!;
  for (let node: HTMLElement | null = host; node; node = node.parentElement) {
    const root = node === host.ownerDocument.scrollingElement;
    if (
      node.scrollHeight <= node.clientHeight ||
      (!root && !/(auto|scroll)/.test(win.getComputedStyle(node).overflowY))
    )
      continue;
    const rect = node.getBoundingClientRect();
    const top = root ? 0 : Math.max(0, rect.top);
    const bottom = root ? win.innerHeight : Math.min(win.innerHeight, rect.bottom);
    let speed = 0;
    if (y < top + 32) speed = -Math.min(18, (top + 32 - y) / 3);
    else if (y > bottom - 32) speed = Math.min(18, (y - bottom + 32) / 3);
    const before = node.scrollTop;
    node.scrollTop += speed;
    if (node.scrollTop !== before) return true;
  }
  return false;
}

/** The editor's destination region includes its handle gutter and the first/last insertion
 * edge, but not neighboring panels or toolbars. Intersect actual clipping ancestors so a hidden
 * scrolled-out row cannot accept a release through the UI covering it. */
export function visibleDropRegion(editor: HTMLElement): Rect {
  const win = editor.ownerDocument.defaultView!;
  const rect = editor.getBoundingClientRect();
  const scale = rect.width / editor.offsetWidth || 1;
  const result = {
    left: Math.max(0, rect.left - 48 * scale),
    right: Math.min(win.innerWidth, rect.right),
    top: Math.max(0, rect.top - 4 * scale),
    bottom: Math.min(win.innerHeight, rect.bottom + 4 * scale),
  };
  for (let node = editor.parentElement; node; node = node.parentElement) {
    const style = win.getComputedStyle(node);
    const bounds = node.getBoundingClientRect();
    if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
      result.left = Math.max(result.left, bounds.left);
      result.right = Math.min(result.right, bounds.right);
    }
    if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
      result.top = Math.max(result.top, bounds.top);
      result.bottom = Math.min(result.bottom, bounds.bottom);
    }
  }
  return result;
}

export interface Rect {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}
export function unionRects(rects: readonly Rect[]): Rect {
  return {
    left: Math.min(...rects.map((r) => r.left)),
    right: Math.max(...rects.map((r) => r.right)),
    top: Math.min(...rects.map((r) => r.top)),
    bottom: Math.max(...rects.map((r) => r.bottom)),
  };
}
