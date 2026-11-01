/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { KagamiMD, type SourceLoc, type Tag } from 'kagami-md';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { attachEditorUI, completionList } from './editorui.js';
import initial from './introduction.md?raw';
import 'kagami-md/styles.css';
import './main.css';

const mount = document.getElementById('editor')!;
const sourceMount = document.getElementById('source')!;
const editorButton = document.getElementById('editor-mode')!;
const sourceButton = document.getElementById('source-mode')!;

const tags = ['idea', 'todo', 'draft', 'reading'];
const pages = ['Home', 'Projects', 'Reading list'];

/** Search the sample tag or page names through the editor's completion API. */
function matching(names: readonly string[]): Tag.Completer {
  return query => {
    const wanted = query.toLowerCase();
    return names.filter(name => name.toLowerCase().includes(wanted)).map(name => ({ id: name, value: name }));
  };
}

const spec = {
  parent: mount,
  completeTag: matching(tags),
  completeWikilink: matching(pages),
  completionList,
};

/** Create each document with the same completion providers and error reporting. */
function createEditor(doc: string): KagamiMD {
  const editor = KagamiMD.create({ ...spec, doc });
  editor.onDidError(error => console.error(error));
  return editor;
}

let editor = createEditor(initial);
let ui = attachEditorUI(editor);
/** The source's colors are the editor's own, so that both modes read as one page. */
const sourceHighlight = HighlightStyle.define([
  { tag: [t.heading, t.strong], fontWeight: '600' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: [t.processingInstruction, t.contentSeparator, t.meta], color: 'var(--editor-html-punctuation-color)' },
  { tag: t.link, color: 'var(--editor-link-color)' },
  { tag: [t.url, t.quote], color: 'var(--editor-muted-color)' },
  { tag: t.comment, color: 'var(--editor-html-comment-color)' },
  { tag: t.tagName, color: 'var(--editor-html-name-color)' },
  { tag: t.attributeName, color: 'var(--editor-html-attribute-color)' },
  { tag: t.attributeValue, color: 'var(--editor-html-value-color)' },
]);

const sourceExtensions = [
  lineNumbers(),
  markdown({ base: markdownLanguage }),
  syntaxHighlighting(sourceHighlight),
  history(),
  keymap.of([...defaultKeymap, ...historyKeymap]),
  EditorView.lineWrapping,
  EditorView.contentAttributes.of({ 'aria-label': 'Markdown source' }),
];
const source = new EditorView({ parent: sourceMount, extensions: sourceExtensions });

/** Show one of the two panes and press its button. */
function showPane(showSource: boolean): void {
  mount.hidden = showSource;
  sourceMount.hidden = !showSource;
  editorButton.setAttribute('aria-pressed', String(!showSource));
  sourceButton.setAttribute('aria-pressed', String(showSource));
}

/** Show the Markdown text, with the editor's selection at the same places in it. */
function showSource(): void {
  if (!sourceMount.hidden) return;
  const { state } = editor;
  source.setState(EditorState.create({
    doc: state.doc,
    selection: { anchor: state.editorToSource(state.selection.anchor), head: state.editorToSource(state.selection.head) },
    extensions: sourceExtensions,
  }));
  showPane(true);
  source.dispatch({ effects: EditorView.scrollIntoView(source.state.selection.main.head, { yMargin: 48 }) });
  source.focus();
}

/** Show the editor, reading the text again if it was changed, with the source's selection. */
function showEditor(): void {
  if (!mount.hidden) return;
  const doc = source.state.doc.toString();
  if (doc !== editor.state.doc) {
    ui.destroy();
    editor.destroy();
    editor = createEditor(doc);
    ui = attachEditorUI(editor);
  }
  showPane(false);
  // CodeMirror's offsets are UTF-16 offsets in LF text, which is what a source location is.
  const { anchor, head } = source.state.selection.main;
  editor.state.select(editor.state.sourceToEditor(anchor as SourceLoc), editor.state.sourceToEditor(head as SourceLoc));
  editor.focus();
}

editorButton.addEventListener('click', showEditor);
sourceButton.addEventListener('click', showSource);

/** Release the editor and its controls when this page is discarded or replaced by development reload. */
const destroy = () => {
  window.removeEventListener('pagehide', pagehide);
  editorButton.removeEventListener('click', showEditor);
  sourceButton.removeEventListener('click', showSource);
  source.destroy();
  ui.destroy();
  editor.destroy();
};

function pagehide(event: PageTransitionEvent): void {
  if (!event.persisted) destroy();
}

window.addEventListener('pagehide', pagehide);
import.meta.hot?.dispose(destroy);
