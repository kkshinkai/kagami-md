/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Destroyable, Emitter, type Event } from '../event/index.js';

/** Space kept between a popup and its anchor. */
const gap = 6;
/** Space kept between a popup and the viewport's edge. */
const margin = 8;

/** The available viewport and the measured popup. */
interface Measurement {
  readonly anchor: Popup.Rect;
  readonly width: number;
  readonly height: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
}

/** The position chosen for a popup. */
interface Position {
  readonly side: Popup.Side;
  readonly left: number;
  readonly top: number;
}

/**
 * Something shown beside an anchor and taken away again: a menu, a picker, a list. The popup
 * puts itself in the page, takes the side of the anchor that has room, and keeps its place
 * while the page scrolls and is resized. An anchor that moves for another reason is followed
 * by calling `layout`.
 */
export class Popup extends Destroyable {
  readonly element: HTMLElement;
  private readonly closed = this._register(new Emitter<Popup.CloseReason>());
  /** Fired once, however the popup came to be closed. */
  readonly onDidClose: Event<Popup.CloseReason> = this.closed.event;
  private readonly window: Window | null;
  private open = true;

  constructor(
    private readonly anchor: Popup.Anchor,
    content: HTMLElement,
    private readonly options: Popup.Options = {},
  ) {
    super();
    const document = content.ownerDocument;
    this.window = document.defaultView;
    this.element = document.createElement('div');
    this.element.className = 'kagami-popup';
    this.element.append(content);
    document.body.append(this.element);
    if (options.dismiss !== false) {
      this.element.addEventListener('keydown', this.keyDown);
      document.addEventListener('pointerdown', this.pointerDown, true);
    }
    // Scrolling does not bubble; an ancestor that scrolls is heard while capturing.
    this.window?.addEventListener('scroll', this.onLayout, true);
    this.window?.addEventListener('resize', this.onLayout);
    this.layout();
  }

  /** Places the popup again, after its anchor has moved or its content has changed size. */
  layout(): void {
    if (!this.open) return;
    if (this.anchor instanceof Node && !this.anchor.isConnected) {
      this.close('gone');
      return;
    }
    const anchor = this.anchor.getBoundingClientRect();
    const viewportWidth = this.window?.innerWidth ?? 0;
    const viewportHeight = this.window?.innerHeight ?? 0;
    // An anchor that has scrolled out of the viewport takes its popup with it.
    if (anchor.bottom < 0 || anchor.top > viewportHeight) {
      this.element.hidden = true;
      return;
    }
    this.element.hidden = false;
    const position = place({
      anchor,
      width: this.element.offsetWidth,
      height: this.element.offsetHeight,
      viewportWidth,
      viewportHeight,
    }, this.options);
    this.element.style.left = `${position.left}px`;
    this.element.style.top = `${position.top}px`;
    this.element.dataset.side = position.side;
  }

  /** Whether a node is part of the popup or of what it was opened from. */
  contains(node: Node): boolean {
    return this.element.contains(node) || (this.anchor instanceof Node && this.anchor.contains(node));
  }

  close(reason: Popup.CloseReason = 'closed'): void {
    if (!this.open) return;
    this.open = false;
    this.element.removeEventListener('keydown', this.keyDown);
    this.element.ownerDocument.removeEventListener('pointerdown', this.pointerDown, true);
    this.window?.removeEventListener('scroll', this.onLayout, true);
    this.window?.removeEventListener('resize', this.onLayout);
    this.element.remove();
    this.closed.fire(reason);
  }

  private readonly onLayout = (): void => this.layout();

  private readonly keyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    this.close('dismissed');
  };

  /**
   * A press on the anchor is not a press outside: whatever opened the popup from there decides
   * what a second press does. An anchor that is not an element is known only by where it is.
   */
  private readonly pointerDown = (event: PointerEvent): void => {
    if (event.target instanceof Node && this.contains(event.target)) return;
    if (!(this.anchor instanceof Node)) {
      const { left, top, right, bottom } = this.anchor.getBoundingClientRect();
      if (event.clientX >= left && event.clientX <= right && event.clientY >= top && event.clientY <= bottom) return;
    }
    this.close('outside');
  };

  override destroy(): void {
    this.close();
    super.destroy();
  }
}

/** Chooses a side with room, then keeps the popup within the viewport. */
function place(measured: Measurement, options: Popup.Options): Position {
  const { anchor, width, height, viewportWidth, viewportHeight } = measured;
  const room: Record<Popup.Side, number> = {
    below: viewportHeight - margin - (anchor.bottom + gap) - height,
    above: anchor.top - gap - margin - height,
    right: viewportWidth - margin - (anchor.right + gap) - width,
    left: anchor.left - gap - margin - width,
  };
  const sides: readonly Popup.Side[] = options.sides?.length ? options.sides : ['below', 'above'];
  const side = sides.find(side => room[side] >= 0) ?? sides.reduce((best, side) => room[side] > room[best] ? side : best);
  const align = options.align ?? 'start';
  let left: number;
  let top: number;
  switch (side) {
    case 'below':
      left = along(anchor.left, anchor.right, width, align);
      top = anchor.bottom + gap;
      break;
    case 'above':
      left = along(anchor.left, anchor.right, width, align);
      top = anchor.top - gap - height;
      break;
    case 'right':
      left = anchor.right + gap;
      top = along(anchor.top, anchor.bottom, height, align);
      break;
    case 'left':
      left = anchor.left - gap - width;
      top = along(anchor.top, anchor.bottom, height, align);
      break;
    default:
      return side satisfies never;
  }
  // Where no side has room the popup covers part of its anchor and stays whole.
  return {
    side,
    left: Math.max(margin, Math.min(viewportWidth - margin - width, left)),
    top: Math.max(margin, Math.min(viewportHeight - margin - height, top)),
  };
}

/** Aligns the popup along one side of its anchor. */
function along(start: number, end: number, size: number, align: Popup.Align): number {
  switch (align) {
    case 'start': return start;
    case 'center': return (start + end - size) / 2;
    case 'end': return end - size;
    default: return align satisfies never;
  }
}

/** At most one menu or picker is open. Opening another closes the first. */
let open: HostedPopup | null = null;

/** Owns the content and notifications of a popup opened for a host. */
class HostedPopup implements Popup.Open, Popup.Anchor {
  private readonly popup: Popup;
  private rect: Popup.Rect;

  constructor(private readonly host: Popup.Host, private readonly content: Popup.Content, options: Popup.Options) {
    open?.close();
    this.rect = host.rect()!;
    this.popup = new Popup(this, content.element, options);
    open = this;
    this.popup.element.addEventListener('keydown', this.keyDown);
    this.popup.onDidClose(reason => this.closed(reason));
    content.focus();
  }

  getBoundingClientRect(): Popup.Rect {
    this.rect = this.host.rect() ?? this.rect;
    return this.rect;
  }

  layout(): void {
    if (this.host.rect()) this.popup.layout();
    else this.popup.close('gone');
  }

  close(): void {
    this.popup.close();
  }

  private readonly keyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Tab') {
      event.preventDefault();
      this.popup.close('dismissed');
    } else if (this.host.key?.(event)) {
      event.stopPropagation();
    }
  };

  private closed(reason: Popup.CloseReason): void {
    this.popup.element.removeEventListener('keydown', this.keyDown);
    if (open === this) open = null;
    this.content.destroy();
    this.popup.destroy();
    this.host.closed(reason);
  }
}

export namespace Popup {
  /** A rectangle in viewport coordinates. */
  export interface Rect {
    readonly left: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
  }

  /** Anything that can say where it is on screen: an element, or a rectangle that was measured. */
  export interface Anchor {
    /** Viewport coordinates, like Element.getBoundingClientRect(). */
    getBoundingClientRect(): Rect;
  }

  /** The side of its anchor a popup is on. */
  export type Side = 'below' | 'above' | 'right' | 'left';

  /** Placement along the chosen side of the anchor. */
  export type Align = 'start' | 'center' | 'end';

  /** Placement and dismissal of a popup. */
  export interface Options {
    /** The sides the popup may be on, in order of preference. The first that has room is taken. */
    readonly sides?: readonly Side[];
    /**
     * How the popup lies along the side it is on: its start at the anchor's start, its center at
     * the anchor's center, or its end at the anchor's end. Defaults to 'start'.
     */
    readonly align?: Align;
    /**
     * Whether Escape and a press of the pointer outside close the popup. Defaults to true. A
     * popup whose owner decides when it goes away, as a list of completions does, sets it false.
     */
    readonly dismiss?: boolean;
  }

  /**
   * Why a popup closed. `dismissed`: the user pressed Escape. `outside`: the pointer was pressed
   * somewhere else. `gone`: what it was opened from left the page. `closed`: its owner closed it.
   */
  export type CloseReason = 'dismissed' | 'outside' | 'gone' | 'closed';

  /** What whoever opens a popup says about it, and is told. */
  export interface Host {
    /** Where the popup belongs now, or null when what it was opened from is gone. */
    rect(): Rect | null;
    /** A key the popup has no use for. Returns whether it was used. */
    key?(event: KeyboardEvent): boolean;
    /** Called once, however the popup came to be closed. */
    closed(reason: CloseReason): void;
  }

  /** The controls of an open popup. */
  export interface Open {
    /** Places the popup again, and closes it when what it was opened from is gone. */
    layout(): void;
    close(): void;
  }

  /** Content whose focus and lifetime belong to a popup. */
  export interface Content {
    readonly element: HTMLElement;
    focus(): void;
    destroy(): void;
  }

  /** Shows one menu or picker at a time, closing the previous one. */
  export function show(host: Host, content: Content, options: Options): Open {
    return new HostedPopup(host, content, options);
  }
}
