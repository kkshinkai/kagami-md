/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  CollapsedReferenceImageSyntax, HTMLImageSyntax, HTMLTagBlockSyntax, ImageSyntax,
  ShortcutReferenceImageSyntax, WikiEmbedSyntax,
} from '../syntax/index.js';
import { isolateHistory } from '../state/history.js';
import type { Attrs, MarkType, Node } from 'prosemirror-model';
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import type { KagamiMD } from '../editor/editor.js';
import { decorateBlocks, updateBlockDecorations } from '../editor/decoration.js';
import { observeLayout, type LayoutSubscription } from '../editor/layout.js';
import { PluginDesc } from '../editor/plugin.js';
import { registerRenderedSource } from '../editor/renderedsource.js';
import { standIn } from '../editor/reveal.js';
import { BindingState } from '../state/bindings.js';
import { getParser } from '../state/parser.js';
import { fieldSource, readField } from '../parse/field.js';
import { walkInline } from '../parse/inline.js';
import { compositionState } from '../state/input.js';
import { normalizationKey } from '../state/normalization.js';

const presentationKey = new PluginKey<DecorationSet>('image-widgets');
let nextId = 0;

/** Present Markdown and HTML images while their source remains native document text. */
export function image(): PluginDesc[] {
  return [PluginDesc.viewState(imagePresentation)];
}

export interface ImageOccurrence {
  from: number;
  to: number;
  src: string;
  title: string;
  alt?: string;
  width?: number | null;
  height?: number | null;
}

/** Read Markdown image occurrences from the parser's marks, including nested images. */
export function readImages(textblock: Node, start: number): ImageOccurrence[] {
  const marks = textblock.type.schema.marks;
  return readMarkedImages(textblock, start, [marks.inlineImage, marks.fullReferenceImage,
    marks.collapsedReferenceImage, marks.shortcutReferenceImage]);
}

/** The parser-owned HTML images shared by widgets and source concealment. */
export function htmlImages(textblock: Node, start: number): ImageOccurrence[] {
  const { nodes, marks } = textblock.type.schema;
  const result = readMarkedImages(textblock, start, [marks.htmlImage]);
  if (textblock.type === nodes.htmlTagBlock && textblock.attrs.tag === 'htmlImage' && textblock.attrs.destination) {
    result.push(readOccurrence(textblock.attrs, start, start + textblock.content.size));
  }
  return result;
}

/** Create the image element used by both document and drag-preview decorations. */
export function imageWidget(document: Document, occurrence: ImageOccurrence): HTMLImageElement {
  const element = document.createElement('img');
  element.className = 'md-image-object';
  element.src = occurrence.src;
  element.alt = '';
  element.referrerPolicy = 'no-referrer';
  element.contentEditable = 'false';
  element.spellcheck = false;
  element.dataset.imageWidget = 'true';
  if (occurrence.title) element.title = occurrence.title;
  element.addEventListener('error', () => element.classList.add('md-image-broken'));
  element.addEventListener('load', () => element.classList.remove('md-image-broken'));
  return element;
}

/** A height-only image uses its intrinsic ratio so max-width can shrink both axes. */
function applyImageSize(dom: HTMLImageElement, width?: number | null, height?: number | null): void {
  if (!width && height && dom.naturalWidth > 0 && dom.naturalHeight > 0) {
    width = height * dom.naturalWidth / dom.naturalHeight;
    height = undefined;
  }
  const cssWidth = width ? `${width}px` : '';
  const cssHeight = height ? `${height}px` : '';
  const fit = height ? 'contain' : '';
  if (dom.style.width !== cssWidth) dom.style.width = cssWidth;
  if (dom.style.height !== cssHeight) dom.style.height = cssHeight;
  if (dom.style.objectFit !== fit) dom.style.objectFit = fit;
}

/** Edit this occurrence's dimensions, preserving its other authored source. */
export function resizeImage(state: EditorState, from: number, to: number, width: number,
  height: number): Transaction | null {
  if (from < 0 || to > state.doc.content.size || from >= to ||
      ![width, height].every(value => Number.isInteger(value) && value > 0 && value <= 0xffffffff)) return null;
  return new ImageEdit(state, from, to, width, height).apply();
}

/** Image widgets and their gesture/resize lifetime belong to this plugin. */
export function imagePresentation(editor?: KagamiMD): Plugin<DecorationSet> {
  // Widgets are drawn before the plugin's view exists, so the attached view's presentation is made
  // on first use. A mounted view creates its own view-state plugins.
  let images: ImagePresentation | null = null;
  const attach = (view: EditorView) =>
    images?.view === view ? images : images = new ImagePresentation(view, editor);
  const drawWith = (node: Node, position: number, previous: DecorationSet) =>
    draw(node, position, previous, attach, (id, occurrence) => images?.noteOccurrence(id, occurrence));
  return new Plugin({
    key: presentationKey,
    state: {
      init(_config, state) { return decorateBlocks(state.doc, drawWith); },
      apply(tr, previous) { return updateBlockDecorations(previous, tr, drawWith); },
    },
    props: {
      decorations: state => presentationKey.getState(state) ?? null,
      handleDOMEvents: {
        click: (view, event) => attach(view).click(event),
        contextmenu: (view, event) => attach(view).contextmenu(event),
        dragstart: (view, event) => attach(view).dragstart(event),
      },
    },
    view(view) {
      const presentation = attach(view);
      presentation.connect();
      return {
        update: (view, previous) => presentation.update(view, previous),
        destroy() {
          presentation.destroy();
          if (images === presentation) images = null;
        },
      };
    },
    presentation: attach,
  });
}

/** Refresh mounted images after their image providers or external URL mappings change. */
export function refreshImages(editor: KagamiMD): void {
  const view = editor.view;
  const plugin = view && presentationKey.get(view.state);
  if (!view || !plugin) return;
  plugin.spec.presentation(view).refresh(true);
}

/** State owns decoration identities; the native view supplies each mounted widget. */
function draw(node: Node, position: number, previous: DecorationSet,
  attach: (view: EditorView) => ImagePresentation,
  note?: (id: string, occurrence: ImageOccurrence) => void): Decoration[] {
  const occurrences: ImageOccurrence[] = [];
  collect(node, position, occurrences);
  const retained = previous.find(position, position + node.nodeSize);
  return occurrences.map(occurrence => {
    const old = retained.find(decoration => decoration.from === occurrence.to);
    const id: string = old?.spec.key ?? `image-occurrence:${++nextId}`;
    note?.(id, occurrence);
    return standIn(occurrence.to, (view, getPos) => attach(view).mount(id, getPos, occurrence), {
      key: id, side: 1, ignoreSelection: false, occurrence,
      destroy: dom => {
        const widget = (dom as WidgetDOM).imageWidget;
        widget?.presentation.release(id, widget);
      },
    });
  });
}

interface SourceChange {
  readonly from: number;
  readonly to: number;
  readonly text: string;
}

/** The source edit owns the syntax reading and the reverse-ordered text replacements. */
class ImageEdit {
  readonly text: string;
  readonly changes: SourceChange[] = [];

  constructor(readonly state: EditorState, readonly from: number, readonly to: number,
    readonly width: number, readonly height: number) {
    this.text = state.doc.textBetween(from, to, '\n', '\n');
  }

  apply(): Transaction | null {
    const at = this.state.doc.resolve(this.from);
    const offset = this.from - at.start();
    const syntax = imageSyntax(this.state, this.from, this.to);
    if (syntax instanceof ImageSyntax) this.markdown(syntax, offset);
    else if (syntax instanceof HTMLImageSyntax && syntax.destination) this.html(syntax);
    else return null;
    const tr = this.state.tr;
    this.changes.sort((a, b) => b.from - a.from);
    for (const change of this.changes) {
      if (this.text.slice(change.from, change.to) === change.text) continue;
      tr.insertText(change.text, this.from + change.from, this.from + change.to);
    }
    return tr.docChanged ? isolateHistory(tr) : null;
  }

  private markdown(syntax: ImageSyntax, offset: number): void {
    const size = syntax.size;
    let from = syntax.closingBracket.start - offset;
    let to = from;
    let space = from > syntax.openingBracket.end - offset ? ' ' : '';
    if (size) {
      from = size.equalsSign.start - offset;
      to = Math.max(size.equalsSign.end, size.width?.end ?? 0, size.height?.end ?? 0,
        size.separator?.end ?? 0) - offset;
      space = '';
    }
    this.changes.push({ from, to, text: `${space}=${this.width}x${this.height}` });
    if (syntax instanceof ShortcutReferenceImageSyntax || syntax instanceof CollapsedReferenceImageSyntax) {
      const label = this.text.slice(syntax.openingBracket.end - offset, syntax.closingBracket.start - offset);
      this.changes.push({ from: syntax.closingBracket.end - offset, to: this.text.length, text: `[${label}]` });
    }
  }

  private html(syntax: HTMLImageSyntax): void {
    let missing = '';
    for (const [name, value] of [['width', this.width], ['height', this.height]] as const) {
      const attributes = syntax.attributeRanges.filter(attribute => attribute.name === name);
      if (!attributes.length) missing += ` ${name}="${value}"`;
      for (const attribute of attributes) {
        if (!attribute.value) {
          this.changes.push({ from: attribute.nameEnd, to: attribute.nameEnd, text: `="${value}"` });
        } else {
          const text = attribute.value.quote ? String(value) : `"${value}"`;
          this.changes.push({ from: attribute.value.start, to: attribute.value.end, text });
        }
      }
    }
    if (missing) this.changes.push({ from: syntax.closingStart, to: syntax.closingStart, text: missing });
  }
}

/** The parser's image attributes supply presentation without reading the raw tag. */
function readOccurrence(attrs: Attrs, from: number, to: number): ImageOccurrence {
  return {
    from, to,
    src: attrs.destination,
    title: attrs.title ?? '',
    alt: attrs.alt,
    width: attrs.width,
    height: attrs.height,
  };
}

/** Pieces carrying the same parser occurrence make one image, including nested marks. */
function readMarkedImages(textblock: Node, start: number, types: readonly MarkType[]): ImageOccurrence[] {
  const found = new Map<MarkType, Map<number, ImageOccurrence>>();
  const result: ImageOccurrence[] = [];
  textblock.forEach((child, offset) => {
    for (const mark of child.marks) {
      if (!types.includes(mark.type)) continue;
      let occurrences = found.get(mark.type);
      if (!occurrences) {
        occurrences = new Map();
        found.set(mark.type, occurrences);
      }
      let occurrence = occurrences.get(mark.attrs.occurrence);
      if (occurrence) occurrence.to = start + offset + child.nodeSize;
      else {
        occurrence = readOccurrence(mark.attrs, start + offset, start + offset + child.nodeSize);
        occurrences.set(mark.attrs.occurrence, occurrence);
        result.push(occurrence);
      }
    }
  });
  return result.filter(occurrence => occurrence.src);
}

function readAll(textblock: Node, start: number): ImageOccurrence[] {
  const result = readImages(textblock, start);
  result.push(...htmlImages(textblock, start));
  return result.sort((a, b) => a.from - b.from);
}

function collect(node: Node, position: number, result: ImageOccurrence[]): void {
  if (node.isTextblock) {
    result.push(...readAll(node, position + 1));
  } else {
    node.forEach((child, offset) => collect(child, position + 1 + offset, result));
  }
}

/** A widget keeps its current position while the decoration maps through edits. */
interface WidgetDOM extends HTMLImageElement { imageWidget?: ImageWidget }

interface ResolvedImageSource {
  readonly destination: string;
  readonly generation: number;
  readonly settled: boolean;
  readonly src: string;
}

interface PendingImageLookup {
  readonly destination: string;
  readonly generation: number;
  readonly controller: AbortController;
}

class ImageWidget {
  readonly dom: WidgetDOM;
  private unregister: (() => void) | null = null;
  private resolved: ResolvedImageSource | null = null;
  private pending: PendingImageLookup | null = null;
  private lookupId = 0;
  private destroyed = false;

  constructor(readonly presentation: ImagePresentation,
    public getPos: () => number | undefined, public occurrence: ImageOccurrence) {
    this.dom = imageWidget(presentation.view.dom.ownerDocument, occurrence);
    this.dom.imageWidget = this;
    this.dom.addEventListener('load', this.loaded);
    registerRenderedSource(this.dom, () => {
      const value = this.read();
      return value ? { from: value.from, to: value.to } : undefined;
    });
  }

  read(): ImageOccurrence | null {
    const view = this.presentation.view;
    const position = this.getPos();
    if (view.isDestroyed || !view.dom.contains(this.dom) || position === undefined ||
        position < 0 || position > view.state.doc.content.size) return null;
    const at = view.state.doc.resolve(position);
    return at.parent.isTextblock ? readAll(at.parent, at.start()).find(value => value.to === position) ?? null : null;
  }

  paint(value: ImageOccurrence): void {
    this.occurrence = value;
    const dom = this.dom;
    this.syncSource(value.src);
    if (dom.title !== value.title) {
      if (value.title) dom.title = value.title;
      else dom.removeAttribute('title');
    }
    if (dom.alt !== (value.alt ?? '')) dom.alt = value.alt ?? '';
    if (!this.presentation.resizing?.active(this)) applyImageSize(dom, value.width, value.height);
  }

  abort(): void {
    if (!this.pending) return;
    const pending = this.pending;
    this.pending = null;
    pending.controller.abort();
  }

  retireStale(): void {
    if (!this.pending) return;
    if (!this.presentation.view.dom.contains(this.dom) ||
        this.occurrence.src !== this.pending.destination ||
        this.presentation.generation !== this.pending.generation) {
      this.abort();
    }
  }

  private syncSource(destination: string): void {
    const generation = this.presentation.generation;
    if (this.resolved?.destination === destination && this.resolved.generation === generation) {
      if (this.resolved.settled && this.dom.getAttribute('src') !== this.resolved.src) {
        this.dom.setAttribute('src', this.resolved.src);
      }
      return;
    }
    this.abort();
    const id = ++this.lookupId;
    const controller = new AbortController();
    const pending: PendingImageLookup = { destination, generation, controller };
    this.pending = pending;
    const stale = () => controller.signal.aborted || this.destroyed || this.presentation.view.isDestroyed ||
      (this.presentation.editor?.isDestroyed() ?? false) || this.lookupId !== id ||
      this.presentation.generation !== generation;
    const resolution = this.presentation.resolve(destination, controller.signal);
    switch (resolution.kind) {
      case 'sync':
        if (this.pending === pending) this.pending = null;
        if (stale()) return;
        this.resolved = { destination, generation, settled: true, src: resolution.src };
        if (this.dom.getAttribute('src') !== resolution.src) this.dom.setAttribute('src', resolution.src);
        return;
      case 'async':
        if (stale()) {
          if (this.pending === pending) this.pending = null;
          controller.abort();
          return;
        }
        this.resolved = { destination, generation, settled: false, src: destination };
        if (this.dom.getAttribute('src') !== destination) this.dom.setAttribute('src', destination);
        void resolution.promise.then(src => {
          if (this.pending === pending) this.pending = null;
          if (stale() || this.occurrence.src !== destination) return;
          this.resolved = { destination, generation, settled: true, src };
          if (!this.presentation.frozen() && this.dom.getAttribute('src') !== src) {
            this.dom.setAttribute('src', src);
          }
        });
        return;
    }
  }

  attach(resizing: ImageResizing | null): void {
    this.unregister?.();
    this.unregister = resizing?.register(this) ?? null;
  }

  private loaded = (): void => {
    if (this.destroyed || !this.presentation.view.dom.contains(this.dom) || this.presentation.frozen()) return;
    this.paint(this.occurrence);
  };

  destroy(): void {
    this.destroyed = true;
    this.lookupId++;
    this.abort();
    this.attach(null);
    this.dom.removeEventListener('load', this.loaded);
    this.dom.imageWidget = undefined;
  }
}

interface Gesture {
  readonly x: number;
  readonly y: number;
  moved: boolean;
}

type ImageResolution = { readonly kind: 'sync'; readonly src: string }
  | { readonly kind: 'async'; readonly promise: Promise<string> };

/** One native view owns the image gestures, resolver and mounted widgets it shows. */
class ImagePresentation {
  resizing: ImageResizing | null = null;
  gesture: Gesture | null = null;
  generation = 0;
  private readonly widgets = new Map<string, ImageWidget>();
  private readonly dirty = new Set<string>();
  private lastDecorations: DecorationSet | null = null;
  private window: Window | null = null;

  constructor(readonly view: EditorView, readonly editor?: KagamiMD) {}

  update(_view: EditorView, previous: EditorState): void {
    if (previous.doc !== this.view.state.doc) this.gesture = null;
    const before = presentationKey.getState(previous) ?? null;
    const after = presentationKey.getState(this.view.state) ?? null;
    if (after && before !== this.lastDecorations) {
      for (const decoration of after.find()) {
        const id = decoration.spec.key as string | undefined;
        const occurrence = decoration.spec.occurrence as ImageOccurrence | undefined;
        if (id && occurrence) this.noteOccurrence(id, occurrence);
      }
    }
    this.lastDecorations = after;
    this.refresh();
  }

  noteOccurrence(id: string, occurrence: ImageOccurrence): void {
    const widget = this.widgets.get(id);
    if (!widget || widget.occurrence === occurrence) return;
    widget.occurrence = occurrence;
    this.dirty.add(id);
  }

  mount(id: string, getPos: () => number | undefined, occurrence: ImageOccurrence): HTMLImageElement {
    const known = this.widgets.get(id);
    if (known) {
      known.getPos = getPos;
      this.noteOccurrence(id, occurrence);
      if (!this.frozen()) {
        this.dirty.delete(id);
        known.paint(occurrence);
      }
      return known.dom;
    }
    const widget = new ImageWidget(this, getPos, occurrence);
    this.widgets.set(id, widget);
    widget.attach(this.resizing);
    if (this.frozen()) this.dirty.add(id);
    else widget.paint(occurrence);
    return widget.dom;
  }

  release(id: string, widget: ImageWidget): void {
    // A mapped decoration can reuse a widget after its old parent is removed.
    if (!this.view.isDestroyed &&
        presentationKey.getState(this.view.state)?.find().some(decoration => decoration.spec.key === id)) return;
    widget.destroy();
    this.widgets.delete(id);
    this.dirty.delete(id);
  }

  resolve(destination: string, signal: AbortSignal): ImageResolution {
    const providers = this.editor?.getImageProviders() ?? [];
    for (let index = 0; index < providers.length; index++) {
      if (this.stopped(signal)) return { kind: 'sync', src: destination };
      let candidate: string | null | Promise<string | null>;
      try {
        candidate = providers[index]!.resolveImageURL(destination, signal);
      } catch (error) {
        if (this.stopped(signal)) return { kind: 'sync', src: destination };
        this.report(error, signal);
        continue;
      }
      if (this.stopped(signal)) return { kind: 'sync', src: destination };
      if (candidate === null) continue;
      if (typeof candidate === 'string') return { kind: 'sync', src: candidate };
      return { kind: 'async', promise: this.resolveAsync(destination, providers, index, candidate, signal) };
    }
    return { kind: 'sync', src: destination };
  }

  private async resolveAsync(
    destination: string,
    providers: readonly KagamiMD.ImageProvider[],
    startIndex: number,
    firstPromise: Promise<string | null>,
    signal: AbortSignal,
  ): Promise<string> {
    try {
      const first = await firstPromise;
      if (this.stopped(signal)) return destination;
      if (typeof first === 'string') return first;
    } catch (error) {
      if (this.stopped(signal)) return destination;
      this.report(error, signal);
    }
    for (let index = startIndex + 1; index < providers.length; index++) {
      if (this.stopped(signal)) return destination;
      try {
        const next = await providers[index]!.resolveImageURL(destination, signal);
        if (this.stopped(signal)) return destination;
        if (typeof next === 'string') return next;
      } catch (error) {
        if (this.stopped(signal)) return destination;
        this.report(error, signal);
      }
    }
    return destination;
  }

  private stopped(signal: AbortSignal): boolean {
    return signal.aborted || this.view.isDestroyed || (this.editor?.isDestroyed() ?? false);
  }

  private report(error: unknown, signal?: AbortSignal): void {
    const view = this.view;
    const editor = this.editor;
    queueMicrotask(() => {
      if (!signal?.aborted && !view.isDestroyed && editor && !editor.isDestroyed()) editor._onDidError.fire(error);
    });
  }

  frozen(): boolean {
    const view = this.view;
    const pointer = normalizationKey.getState(view.state);
    return !!(pointer?.isPointerActive || pointer?.isPointerSelecting || view.composing ||
      compositionState(view.state)?.isComposing);
  }

  refresh(providersChanged = false): void {
    if (this.view.isDestroyed) return;
    if (providersChanged) {
      this.generation++;
      for (const [id, widget] of this.widgets) {
        this.dirty.add(id);
        widget.retireStale();
      }
    } else {
      for (const id of this.dirty) this.widgets.get(id)?.retireStale();
    }
    if (this.window !== this.view.dom.ownerDocument.defaultView) {
      this.connect();
      return;
    }
    this.resizing?.update();
    if (this.frozen() || !this.dirty.size) return;
    const ids = [...this.dirty];
    this.dirty.clear();
    for (const id of ids) {
      const widget = this.widgets.get(id);
      if (widget && this.view.dom.contains(widget.dom)) widget.paint(widget.occurrence);
    }
  }

  /** Adoption changes the event window without changing the plugin or node views. */
  connect(): void {
    this.disconnect();
    const view = this.view;
    this.window = view.dom.ownerDocument.defaultView!;
    this.lastDecorations = presentationKey.getState(view.state) ?? null;
    this.resizing = new ImageResizing(view);
    for (const widget of this.widgets.values()) widget.attach(this.resizing);
    view.dom.addEventListener('mousedown', this.down, true);
    this.window.addEventListener('mousemove', this.move);
    this.window.addEventListener('pointercancel', this.cancel);
    this.window.addEventListener('blur', this.cancel);
    this.refresh();
  }

  private disconnect(): void {
    this.view.dom.removeEventListener('mousedown', this.down, true);
    this.window?.removeEventListener('mousemove', this.move);
    this.window?.removeEventListener('pointercancel', this.cancel);
    this.window?.removeEventListener('blur', this.cancel);
    for (const widget of this.widgets.values()) widget.attach(null);
    this.resizing?.destroy();
    this.resizing = null;
    this.window = null;
    this.gesture = null;
  }

  private occurrence(target: EventTarget | null): ImageOccurrence | null {
    if (!(target instanceof this.view.dom.ownerDocument.defaultView!.Element)) return null;
    const dom = target.closest<HTMLElement>("[data-image-widget='true']");
    return dom ? (dom as WidgetDOM).imageWidget?.read() ?? null : null;
  }

  private down = (event: MouseEvent): void => {
    this.gesture = event.button === 0 && this.occurrence(event.target)
      ? { x: event.clientX, y: event.clientY, moved: false } : null;
  };

  private move = (event: MouseEvent): void => {
    const gesture = this.gesture;
    if (gesture && Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) >= 5) gesture.moved = true;
  };

  private cancel = (): void => {
    if (this.gesture) this.gesture.moved = true;
  };

  click(event: MouseEvent): boolean {
    if (event.button !== 0 || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey ||
        event.defaultPrevented || !interactive(this.view)) return false;
    const occurrence = this.occurrence(event.target);
    const moved = this.gesture?.moved ?? false;
    this.gesture = null;
    if (!occurrence || moved) return false;
    select(this.view, occurrence, 'alt');
    event.preventDefault();
    return true;
  }

  contextmenu(event: MouseEvent): boolean {
    if (event.defaultPrevented || !interactive(this.view)) return false;
    const occurrence = this.occurrence(event.target);
    if (!occurrence) return false;
    this.gesture = null;
    select(this.view, occurrence, 'full');
    event.preventDefault();
    return true;
  }

  dragstart(event: DragEvent): boolean {
    if (event.button !== 0 || event.defaultPrevented || !event.dataTransfer || !interactive(this.view)) return false;
    const occurrence = this.occurrence(event.target);
    if (!occurrence) return false;
    this.gesture = { x: event.clientX, y: event.clientY, moved: true };
    const selection = this.view.state.selection;
    if (selection.from > occurrence.from || selection.to < occurrence.to) select(this.view, occurrence, 'full');
    return false;
  }

  destroy(): void {
    this.disconnect();
    for (const widget of this.widgets.values()) widget.destroy();
    this.widgets.clear();
  }
}

function interactive(view: EditorView): boolean {
  return view.editable && !view.composing && !compositionState(view.state)?.isComposing;
}

function select(view: EditorView, occurrence: ImageOccurrence, kind: 'alt' | 'full'): void {
  let from = occurrence.from;
  let to = occurrence.to;
  if (kind === 'alt') {
    const syntax = imageSyntax(view.state, from, to);
    const base = view.state.doc.resolve(from).start();
    if (syntax instanceof HTMLImageSyntax) {
      const alt = syntax.attributeRanges.find(attribute => attribute.name === 'alt')?.value;
      from = alt ? occurrence.from + alt.start : occurrence.to;
      to = alt ? occurrence.from + alt.end : occurrence.to;
    } else if (syntax instanceof ImageSyntax) {
      from = base + syntax.openingBracket.end;
      to = base + syntax.closingBracket.start;
    } else if (syntax instanceof WikiEmbedSyntax) {
      const children = (syntax.alias ?? syntax.target).children;
      from = base + (children[0]?.start ?? syntax.closingBrackets.start);
      to = base + (children.at(-1)?.end ?? syntax.closingBrackets.start);
    }
  }
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)));
}

/** Read an image at an action boundary; presentation never supplies its grammar or ranges. */
function imageSyntax(state: EditorState, from: number,
  to: number): ImageSyntax | HTMLImageSyntax | WikiEmbedSyntax | null {
  const at = state.doc.resolve(from);
  if (!at.parent.isTextblock || at.parent.type.spec.code || to > at.end()) return null;
  const currentParser = getParser(state);
  if (at.parent.type === state.schema.nodes.htmlTagBlock) {
    if (from !== at.start() || to !== at.end()) return null;
    const blocks = currentParser.parseBlocks(fieldSource(at.parent));
    const block = blocks[0];
    return blocks.length === 1 && block instanceof HTMLTagBlockSyntax && block.tag instanceof HTMLImageSyntax
      ? block.tag : null;
  }
  const reading = readField(at, currentParser, BindingState.get(state));
  if (reading.kind === 'blocks') return null;
  let found: ImageSyntax | HTMLImageSyntax | WikiEmbedSyntax | null = null;
  walkInline(reading.children, node => {
    if (node.start === from - at.start() && node.end === to - at.start() &&
        (node instanceof ImageSyntax || node instanceof HTMLImageSyntax || node instanceof WikiEmbedSyntax)) {
      found = node;
      return false;
    }
  });
  return found;
}

/** One resize gesture owns its initial geometry, live width and temporary style. */
class ResizeDrag {
  readonly doc: Node;
  readonly pointerId: number;
  readonly startX: number;
  readonly ratio: number;
  readonly original: string;
  width: number;
  moved = false;

  constructor(view: EditorView, readonly image: ImageWidget, readonly handle: HTMLElement,
    event: PointerEvent, readonly startWidth: number, readonly maxWidth: number,
    readonly zoom: number, readonly direction: number) {
    this.doc = view.state.doc;
    this.pointerId = event.pointerId;
    this.startX = event.clientX;
    this.ratio = image.dom.naturalWidth / image.dom.naturalHeight;
    this.original = image.dom.style.cssText;
    this.width = startWidth;
  }

  move(clientX: number): boolean {
    const delta = (clientX - this.startX) / this.zoom;
    if (Math.abs(delta) < 1 && !this.moved) return false;
    this.width = Math.max(1, Math.min(this.maxWidth, this.startWidth + this.direction * delta));
    this.moved = true;
    const style = this.image.dom.style;
    style.width = `${this.width}px`;
    style.height = `${this.width / this.ratio}px`;
    style.objectFit = 'contain';
    return true;
  }

  restore(): void {
    this.image.dom.style.cssText = this.original;
    if (this.handle.hasPointerCapture?.(this.pointerId)) this.handle.releasePointerCapture(this.pointerId);
  }

  commit(state: EditorState, occurrence: ImageOccurrence): Transaction | null {
    return resizeImage(state, occurrence.from, occurrence.to,
      Math.max(1, Math.round(this.width)), Math.max(1, Math.round(this.width / this.ratio)));
  }
}

/** One pair of hover handles lives outside the editable DOM of each mounted view. */
class ImageResizing {
  readonly window: Window;
  readonly dom: HTMLElement;
  readonly layout: LayoutSubscription;
  private target: ImageWidget | null = null;
  private drag: ResizeDrag | null = null;

  constructor(readonly view: EditorView) {
    const document = view.dom.ownerDocument;
    this.window = document.defaultView!;
    this.dom = document.createElement('div');
    this.dom.className = 'md-image-resize';
    this.dom.hidden = true;
    this.handle('left', -1);
    this.handle('right', 1);
    this.dom.addEventListener('pointerleave', this.leave);
    this.layout = observeLayout(view.dom, this.position);
    this.window.addEventListener('scroll', this.position, true);
    this.window.addEventListener('resize', this.position);
  }

  private handle(side: 'left' | 'right', direction: number): void {
    const handle = this.dom.ownerDocument.createElement('div');
    handle.className = `md-image-resizer-container md-image-resizer-container--${side}`;
    handle.title = 'Resize image';
    handle.appendChild(this.dom.ownerDocument.createElement('div')).className = 'md-image-resizer';
    handle.addEventListener('pointerdown', event => this.start(event, handle, direction));
    handle.addEventListener('lostpointercapture', () => { if (this.drag) this.hide(); });
    this.dom.append(handle);
  }

  register(widget: ImageWidget): () => void {
    const enter = () => {
      if (this.drag || !this.enabled() || !widget.dom.naturalWidth || widget.dom.hidden) return;
      this.target = widget;
      if (!this.dom.isConnected) this.view.dom.ownerDocument.body.append(this.dom);
      this.position();
    };
    widget.dom.addEventListener('pointerenter', enter);
    widget.dom.addEventListener('pointerleave', this.leave);
    return () => {
      widget.dom.removeEventListener('pointerenter', enter);
      widget.dom.removeEventListener('pointerleave', this.leave);
      if (this.target === widget) this.hide();
    };
  }

  active(widget: ImageWidget): boolean {
    return this.drag !== null && this.target === widget;
  }

  update(): void {
    if (!this.enabled() || this.drag && this.drag.doc !== this.view.state.doc ||
        this.target && (!this.target.read() || this.target.dom.hidden)) this.hide();
    this.layout.schedule();
  }

  private enabled(): boolean {
    const pointer = normalizationKey.getState(this.view.state);
    return !this.view.isDestroyed && interactive(this.view) && !pointer?.isPointerActive &&
      !pointer?.isPointerSelecting;
  }

  private leave = (event: PointerEvent): void => {
    if (this.drag) return;
    const next = event.relatedTarget;
    if (next instanceof this.view.dom.ownerDocument.defaultView!.Node &&
        (this.dom.contains(next) || this.target?.dom === next)) return;
    this.hide();
  };

  private position = (): void => {
    const target = this.target?.dom;
    if (!target || !this.view.dom.contains(target) || target.hidden) {
      this.dom.hidden = true;
      return;
    }
    const rect = target.getBoundingClientRect();
    this.dom.hidden = rect.width <= 0 || rect.height <= 0;
    this.dom.style.left = `${rect.left}px`;
    this.dom.style.top = `${rect.top}px`;
    this.dom.style.width = `${rect.width}px`;
    this.dom.style.height = `${rect.height}px`;
  };

  private start(event: PointerEvent, handle: HTMLElement, direction: number): void {
    if (event.button !== 0 || event.isPrimary === false || this.drag || !this.target || !this.enabled()) return;
    const dom = this.target.dom;
    if (!this.target.read() || !dom.naturalWidth || !dom.naturalHeight) return;
    const rect = dom.getBoundingClientRect();
    const width = parseFloat(this.window.getComputedStyle(dom).width);
    if (!width || !rect.width) return;
    let column = dom.parentElement!;
    while (column !== this.view.dom && ['inline', 'contents'].includes(this.window.getComputedStyle(column).display))
      column = column.parentElement!;
    const style = this.window.getComputedStyle(column);
    const maxWidth = column.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
    if (maxWidth <= 0) return;
    event.preventDefault();
    event.stopPropagation();
    this.drag = new ResizeDrag(this.view, this.target, handle, event, width, maxWidth, rect.width / width, direction);
    handle.setPointerCapture?.(event.pointerId);
    this.window.addEventListener('pointermove', this.move, true);
    this.window.addEventListener('pointerup', this.finish, true);
    this.window.addEventListener('pointercancel', this.cancel, true);
    this.window.addEventListener('keydown', this.keydown, true);
    this.window.addEventListener('blur', this.cancel);
  }

  private move = (event: PointerEvent): void => {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId || !this.target) return;
    if (this.view.state.doc !== drag.doc || !this.enabled()) {
      this.hide();
      return;
    }
    event.preventDefault();
    if (drag.move(event.clientX)) this.position();
  };

  private finish = (event: PointerEvent): void => {
    if (!this.drag || event.pointerId !== this.drag.pointerId) return;
    this.move(event);
    const drag = this.drag;
    const occurrence = this.target?.read();
    event.preventDefault();
    event.stopPropagation();
    this.end();
    if (drag?.moved && occurrence && this.view.state.doc === drag.doc && this.enabled()) {
      const tr = drag.commit(this.view.state, occurrence);
      if (tr) this.view.dispatch(tr);
    }
    this.position();
    const rect = this.target?.dom.getBoundingClientRect();
    if (rect && (event.clientX < rect.left || event.clientX > rect.right ||
        event.clientY < rect.top || event.clientY > rect.bottom)) this.hide();
  };

  private keydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    this.hide();
  };

  private cancel = (): void => this.hide();

  private end(): void {
    const drag = this.drag;
    this.drag = null;
    drag?.restore();
    this.window.removeEventListener('pointermove', this.move, true);
    this.window.removeEventListener('pointerup', this.finish, true);
    this.window.removeEventListener('pointercancel', this.cancel, true);
    this.window.removeEventListener('keydown', this.keydown, true);
    this.window.removeEventListener('blur', this.cancel);
  }

  private hide(): void {
    this.end();
    this.target = null;
    this.dom.hidden = true;
  }

  destroy(): void {
    this.hide();
    this.layout.destroy();
    this.window.removeEventListener('scroll', this.position, true);
    this.window.removeEventListener('resize', this.position);
    this.dom.remove();
  }
}
