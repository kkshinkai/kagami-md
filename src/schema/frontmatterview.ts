/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { DOMNode } from '../editor/dom.js';
import { Fragment, Slice, type Node } from 'prosemirror-model';
import { closeHistory } from 'prosemirror-history';
import { isolateHistory } from '../state/history.js';
import { TextSelection, type EditorState } from 'prosemirror-state';
import type { EditorView, ViewMutationRecord } from 'prosemirror-view';
import { routeHistoryKey } from '../editor/input.js';
import { compositionState } from '../state/input.js';
import { getParser } from '../state/parser.js';
import { parseFrontMatter } from '../parse/parse.js';
import { replace } from '../transform/transform.js';
import { schema } from '../types/schema.js';
import { unparseYAMLBody } from '../unparse/yaml.js';
import { frontmatterKey, type FrontmatterDraft, type FrontmatterSession } from './frontmatter.js';
import { YAMLSourceView } from './yamlsourceview.js';
import { propertyIcon, type PropertyView } from './propertyview.js';

let contentId = 0;

/** The property subtree stays mounted while its temporary source draft is edited. */
export class FrontmatterView implements PropertyView {
  readonly dom: HTMLElement;
  private readonly header: HTMLDivElement;
  private readonly body: HTMLDivElement;
  readonly contentDOM: HTMLDivElement;
  private readonly mount: HTMLDivElement;
  private readonly disclosure: HTMLButtonElement;
  private readonly sourceButton: HTMLButtonElement;
  private readonly sourceIcon: Element;
  private readonly sourceLabel: Text;
  private readonly cancelButton: HTMLButtonElement;
  private readonly errorMessage: HTMLDivElement;
  private source: YAMLSourceView | null = null;

  constructor(private node: Node, readonly view: EditorView, private readonly getPos: () => number | undefined,
    private readonly forget: (node: PropertyView) => void) {
    const doc = view.dom.ownerDocument;
    this.dom = doc.createElement('section');
    this.dom.className = 'md-frontmatter';
    this.dom.dataset.frontmatter = '';
    this.header = this.dom.appendChild(doc.createElement('div'));
    this.header.className = 'md-frontmatter-heading frontmatter-header';
    this.header.contentEditable = 'false';
    this.disclosure = this.header.appendChild(doc.createElement('button'));
    this.disclosure.type = 'button';
    this.disclosure.className = 'frontmatter-disclosure';
    this.disclosure.append(propertyIcon(doc, '<path d="m9 18 6-6-6-6" />', '2'), 'Properties');
    const actions = this.header.appendChild(doc.createElement('div'));
    actions.className = 'frontmatter-header-actions';
    this.cancelButton = actions.appendChild(doc.createElement('button'));
    this.cancelButton.type = 'button';
    this.cancelButton.textContent = 'Cancel';
    this.sourceButton = actions.appendChild(doc.createElement('button'));
    this.sourceButton.type = 'button';
    this.sourceIcon = propertyIcon(doc, '<path d="m18 16 4-4-4-4m-12 0-4 4 4 4m8.5-12-5 16" />', '2');
    this.sourceLabel = doc.createTextNode('YAML source');
    this.sourceButton.append(this.sourceIcon, this.sourceLabel);
    this.errorMessage = this.header.appendChild(doc.createElement('div'));
    this.errorMessage.className = 'frontmatter-source-error';
    this.errorMessage.setAttribute('role', 'alert');
    // Native blur/compositionend settles before a header action changes input ownership.
    this.disclosure.onclick = () => queueMicrotask(() => {
      if (!this.view.isDestroyed) this.setCollapsed(!this.collapsed);
    });
    this.sourceButton.onclick = () => queueMicrotask(() => {
      if (!this.view.isDestroyed) this.setSourceMode(!this.sourceMode);
    });
    this.cancelButton.onclick = () => queueMicrotask(() => {
      if (!this.view.isDestroyed) this.cancelSource();
    });
    this.header.onkeydown = event => {
      if (this.handleKeyDown(event)) event.stopPropagation();
    };
    this.body = this.dom.appendChild(doc.createElement('div'));
    this.body.id = `md-frontmatter-content-${++contentId}`;
    this.disclosure.setAttribute('aria-controls', this.body.id);
    this.contentDOM = this.body.appendChild(doc.createElement('div'));
    this.contentDOM.className = 'md-frontmatter-content';
    this.mount = this.body.appendChild(doc.createElement('div'));
    this.mount.className = 'md-frontmatter-yaml-source';
    this.mount.contentEditable = 'false';
    this.mount.hidden = true;
    if (this.session.source) this.openSource(this.session.source);
    this.render();
  }

  private get session(): FrontmatterSession {
    return frontmatterKey.getState(this.view.state)!;
  }

  private get collapsed(): boolean {
    return this.session.collapsed;
  }

  private get sourceMode(): boolean {
    return this.session.source !== null;
  }

  private get error(): string | null {
    return this.session.source?.error ?? null;
  }

  private isComposing(): boolean {
    return this.view.composing || compositionState(this.view.state)?.isComposing === true ||
      this.source?.isComposing() === true;
  }

  /** Relocate selection into the document body before collapsing or hiding properties. */
  private moveSelectionOutside(): void {
    const pos = this.getPos();
    const selected = this.view.state.selection;
    if (pos === undefined || selected.to <= pos || selected.from >= pos + this.node.nodeSize) return;
    this.view.dispatch(this.view.state.tr.setSelection(
      TextSelection.near(this.view.state.doc.resolve(pos + this.node.nodeSize), 1)));
  }

  /** Toggle folded presentation for front matter in view state. */
  private setCollapsed(collapsed: boolean): void {
    if (this.view.isDestroyed || this.isComposing() || collapsed === this.collapsed) return;
    if (collapsed) this.moveSelectionOutside();
    this.store({ ...this.session, collapsed });
  }

  /** Switch between structured property capsules and the embedded YAML source editor. */
  private setSourceMode(source: boolean): boolean {
    if (this.view.isDestroyed || this.isComposing()) return false;
    if (source === this.sourceMode) return true;
    if (!source) return this.applySource();
    this.moveSelectionOutside();
    const initial = this.node.type === schema.nodes.rawFrontMatter ? this.node.textContent : unparseYAMLBody(this.node);
    const draft: FrontmatterDraft = {
      initial, draft: initial, selection: { anchor: 0, head: 0 }, node: this.node, error: null
    };
    this.openSource(draft);
    this.view.dispatch(closeHistory(this.view.state.tr)
      .setMeta(frontmatterKey, { collapsed: false, source: draft } satisfies FrontmatterSession)
      .setMeta('addToHistory', false));
    this.source!.focus();
    return true;
  }

  /** Mount the CodeMirror YAML source editor for `draft`. */
  private openSource(draft: FrontmatterDraft): void {
    this.mount.hidden = false;
    this.source = new YAMLSourceView(this.mount, draft.draft, draft.selection,
      () => this.sourceChanged(), error => this.setError(String(error)), { readOnly: !this.view.editable });
    this.source.inputElement.setAttribute('aria-label', 'YAML source');
  }

  /** Mirror draft text and selection edits from the embedded YAML source editor into plugin state. */
  private sourceChanged(): void {
    const draft = this.session.source;
    if (!draft || !this.source) return;
    const { markdown, selection } = this.source.read();
    if (markdown === draft.draft && selection.anchor === draft.selection.anchor &&
      selection.head === draft.selection.head) return;
    this.store({
      ...this.session,
      source: { ...draft, draft: markdown, selection, error: markdown === draft.draft ? draft.error : null }
    });
  }

  /** Persist updated frontmatter presentation state without adding a history step. */
  private store(session: FrontmatterSession): void {
    this.view.dispatch(this.view.state.tr.setMeta(frontmatterKey, session).setMeta('addToHistory', false));
  }

  /** Show a validation or read-only banner error inside the active YAML source session. */
  private setError(error: string): void {
    const draft = this.session.source;
    if (draft) this.store({ ...this.session, source: { ...draft, error } });
  }

  /** Parse and apply edited YAML source, rejecting syntax errors or embedded delimiter lines. */
  private applySource(): boolean {
    const session = this.session.source!;
    const draft = this.source!.read().markdown;
    const pos = this.getPos();
    if (pos === undefined) return false;
    if (draft !== session.initial) {
      if (!this.view.editable) {
        this.setError('The editor is read-only. Changes have not been applied.');
        return false;
      }
      if (!session.node.eq(this.node)) {
        this.setError(
          'Properties changed while this draft was open. Cancel and reopen the source to edit the current properties.');
        return false;
      }
      const parsedDocument = getParser(this.view.state).parseFile(
        '---\n' + draft + (draft.endsWith('\n') ? '' : '\n') + '---').document;
      if (parsedDocument.frontMatter?.type !== 'yamlFrontMatter' || parsedDocument.children.length > 0) {
        this.setError('YAML is incomplete or contains unsupported syntax. Correct the draft before applying it.');
        return false;
      }
      const next = parseFrontMatter(parsedDocument.frontMatter, this.view.state.schema, this.node);
      this.closeSource();
      const tr = closeHistory(this.view.state.tr);
      replace(tr, pos, pos + this.node.nodeSize, new Slice(Fragment.from(next), 0, 0));
      this.view.dispatch(isolateHistory(tr).setMeta(frontmatterKey,
        { ...this.session, source: null } satisfies FrontmatterSession));
    } else {
      this.closeSource();
      this.store({ ...this.session, source: null });
    }
    this.view.dispatch(closeHistory(this.view.state.tr));
    this.view.focus();
    return true;
  }

  /** Discard unsaved YAML source edits and restore the capsule view. */
  private cancelSource(): void {
    if (this.view.isDestroyed || !this.source || this.isComposing()) return;
    this.closeSource();
    this.view.dispatch(closeHistory(this.view.state.tr)
      .setMeta(frontmatterKey, { ...this.session, source: null } satisfies FrontmatterSession)
      .setMeta('addToHistory', false));
    this.view.focus();
  }

  /** Destroy the embedded YAML source editor instance if mounted. */
  private closeSource(): void {
    this.source?.destroy();
    this.source = null;
  }

  private render(): void {
    const collapsed = this.collapsed;
    const source = this.sourceMode;
    const error = this.error;
    this.body.hidden = collapsed;
    this.contentDOM.hidden = source;
    this.mount.hidden = !source;
    this.dom.dataset.collapsed = String(collapsed);
    this.disclosure.setAttribute('aria-expanded', String(!collapsed));
    this.disclosure.setAttribute('aria-label', collapsed ? 'Expand properties' : 'Collapse properties');
    this.sourceButton.setAttribute('aria-pressed', String(source));
    // Pressed, the switch ends the edit beside Cancel, and is labelled as that.
    this.sourceIcon.toggleAttribute('hidden', source);
    this.sourceLabel.data = source ? 'Done' : 'YAML source';
    this.cancelButton.hidden = !source;
    this.errorMessage.hidden = !error;
    this.errorMessage.textContent = error ?? '';
  }

  /** Update the mounted frontmatter node when its ProseMirror type remains `yamlFrontMatter`. */
  update(node: Node): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    return true;
  }

  /** Reconcile the embedded YAML source editor and header controls with `this.session`. */
  sync(): void {
    const draft = this.session.source;
    if (draft && !this.source) this.openSource(draft);
    if (!draft && this.source) this.closeSource();
    this.source?.updateOptions({ readOnly: !this.view.editable });
    this.render();
  }

  /** Sync root, source state, and auto-reveal folded front matter when selection enters it. */
  refresh(previous: EditorState, force = false): void {
    this.source?.view.setRoot(this.view.root);
    if (force || frontmatterKey.getState(previous) !== this.session) this.sync();
    const selected = this.view.state.selection;
    const pos = this.getPos();
    // Navigation and undo that explicitly select a folded field reveal it.
    if (
      !selected.eq(previous.selection) &&
      pos !== undefined &&
      selected.from < pos + this.node.nodeSize &&
      selected.to > pos
    ) {
      if (this.collapsed) this.store({ ...this.session, collapsed: false });
      this.source?.focus();
    }
  }

  /** Route undo/redo shortcuts to the active YAML source editor or editor history. */
  handleKeyDown(event: KeyboardEvent): boolean {
    if (!this.source) return !this.view.isDestroyed && routeHistoryKey(this.view, event);
    if (event.altKey || !(event.metaKey || event.ctrlKey) || !['z', 'y'].includes(event.key.toLowerCase())) {
      return false;
    }
    event.preventDefault();
    if (this.view.editable) {
      if (event.key.toLowerCase() === 'y' || event.shiftKey) this.source.redo();
      else this.source.undo();
    }
    return true;
  }

  /** Prevent ProseMirror from handling pointer/key events inside header controls or the YAML source editor. */
  stopEvent(event: Event): boolean {
    const target = event.target as DOMNode;
    return this.header.contains(target) || this.mount.contains(target);
  }

  /** Ignore DOM mutations inside the non-editable header, source editor, or container state attributes. */
  ignoreMutation(mutation: ViewMutationRecord): boolean {
    return this.header.contains(mutation.target) || this.mount.contains(mutation.target) ||
      mutation.type === 'attributes' && [this.dom, this.contentDOM, this.body].includes(mutation.target as HTMLElement);
  }

  /** Detach DOM handlers and unregister the frontmatter view on teardown. */
  destroy(): void {
    this.disclosure.onclick = this.sourceButton.onclick = this.cancelButton.onclick = this.header.onkeydown = null;
    this.closeSource();
    this.forget(this);
  }
}
