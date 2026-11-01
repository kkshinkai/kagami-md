/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { history } from '../state/history.js';
import { isCodeLanguage } from '../syntax/index.js';
import type { Node } from 'prosemirror-model';
import { Plugin, PluginKey, TextSelection, type Command, type EditorState, type PluginView } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView, type ViewMutationRecord } from 'prosemirror-view';
import type { HighlighterCore } from 'shiki/core';
import * as command from '../command/command.js';
import { update } from '../transform/transform.js';
import { decorateBlocks } from '../editor/decoration.js';
import { findEditor, type DOMNode } from '../editor/dom.js';
import { input } from '../editor/input.js';
import { registerBlockView, type BlockView } from '../editor/blockview.js';
import { canRunCommand, compositionState } from '../state/input.js';
import { schema } from '../types/schema.js';

/** The browser's grammar bundle, loaded one language at a time. */
const grammars = [
  { id: 'javascript', label: 'JavaScript', aliases: ['js'], load: () => import('shiki/langs/javascript.mjs') },
  { id: 'typescript', label: 'TypeScript', aliases: ['ts'], load: () => import('shiki/langs/typescript.mjs') },
  { id: 'jsx', label: 'JSX', aliases: [], load: () => import('shiki/langs/jsx.mjs') },
  { id: 'tsx', label: 'TSX', aliases: [], load: () => import('shiki/langs/tsx.mjs') },
  { id: 'python', label: 'Python', aliases: ['py'], load: () => import('shiki/langs/python.mjs') },
  { id: 'rust', label: 'Rust', aliases: ['rs'], load: () => import('shiki/langs/rust.mjs') },
  { id: 'go', label: 'Go', aliases: ['golang'], load: () => import('shiki/langs/go.mjs') },
  { id: 'java', label: 'Java', aliases: [], load: () => import('shiki/langs/java.mjs') },
  { id: 'c', label: 'C', aliases: [], load: () => import('shiki/langs/c.mjs') },
  { id: 'cpp', label: 'C++', aliases: ['c++'], load: () => import('shiki/langs/cpp.mjs') },
  { id: 'csharp', label: 'C#', aliases: ['cs', 'c#'], load: () => import('shiki/langs/csharp.mjs') },
  { id: 'swift', label: 'Swift', aliases: [], load: () => import('shiki/langs/swift.mjs') },
  { id: 'kotlin', label: 'Kotlin', aliases: ['kt'], load: () => import('shiki/langs/kotlin.mjs') },
  { id: 'ruby', label: 'Ruby', aliases: ['rb'], load: () => import('shiki/langs/ruby.mjs') },
  { id: 'php', label: 'PHP', aliases: [], load: () => import('shiki/langs/php.mjs') },
  {
    id: 'shellscript', label: 'Shell', aliases: ['sh', 'bash', 'shell', 'zsh'],
    load: () => import('shiki/langs/shellscript.mjs')
  },
  { id: 'html', label: 'HTML', aliases: [], load: () => import('shiki/langs/html.mjs') },
  { id: 'css', label: 'CSS', aliases: [], load: () => import('shiki/langs/css.mjs') },
  { id: 'json', label: 'JSON', aliases: [], load: () => import('shiki/langs/json.mjs') },
  { id: 'jsonc', label: 'JSON with comments', aliases: [], load: () => import('shiki/langs/jsonc.mjs') },
  { id: 'yaml', label: 'YAML', aliases: ['yml'], load: () => import('shiki/langs/yaml.mjs') },
  { id: 'toml', label: 'TOML', aliases: [], load: () => import('shiki/langs/toml.mjs') },
  { id: 'sql', label: 'SQL', aliases: [], load: () => import('shiki/langs/sql.mjs') },
  { id: 'markdown', label: 'Markdown', aliases: ['md'], load: () => import('shiki/langs/markdown.mjs') },
];

/** Code bodies, their language label, syntax colors, and isolated indentation edits. */
export function codeBlock(): Plugin[] {
  return [codeBlock.state(), codeBlock.view()];
}

export namespace codeBlock {
  /** A highlighted range, measured in UTF-16 offsets in the code body. */
  export interface Token {
    readonly from: number;
    readonly to: number;
    readonly style: string;
  }

  /** One view's lease on syntax highlighting resources. */
  export interface Highlighter {
    highlight(code: string, language: string | null): Promise<readonly Token[]>;
    dispose(): void;
  }

  /** Completed colors are state, so attaching another view does not discard them. */
  export function state(): Plugin<Highlights> {
    return new Plugin<Highlights>({
      key: highlightKey,
      state: {
        init() { return { entries: [], decorations: DecorationSet.empty }; },
        apply(transaction, value) {
          const change = transaction.getMeta(highlightKey) as HighlightChange | undefined;
          const refresh: decorateBlocks.Range[] = [];
          let entries = value.entries;
          if (change?.kind === 'highlight' && change.doc === transaction.doc) {
            entries = change.entries;
            const complete = new Set(value.entries.map(entry => entry.node));
            for (const block of change.blocks) {
              if (complete.has(block.node)) continue;
              refresh.push({ from: block.position, to: block.position + block.node.nodeSize - 1 });
            }
          } else if (!transaction.docChanged) return value;
          const colors = new CodeColors(entries);
          const decorations = decorateBlocks.update(value.decorations, transaction,
            (node, position) => colors.draw(node, position), refresh, node => colors.clear(node));
          return { entries: entries.filter(entry => !colors.removed.has(entry.node)), decorations };
        },
      },
      props: { decorations(state) { return highlightKey.getState(state)!.decorations; } },
    });
  }

  /** Each native view owns its code DOM and asynchronous highlighting work. */
  export function view(highlighter: () => Highlighter = codeBlock.createHighlighter): Plugin {
    const labels = new Set<CodeView>();
    return new Plugin<command.Command.RequestState>({
      key: CodeBlock.chooseLanguage.key,
      state: {
        init: () => ({ hold(view, position) {
          for (const label of labels) {
            if (label.view !== view) continue;
            const request = command.keepRequest(label.request(), position,
              () => labels.has(label) && !view.isDestroyed);
            if (request) return request;
          }
          return null;
        } }),
        apply: (_tr, value) => value,
      },
      props: { nodeViews: { codeBlock(node, view, getPos) {
        const label = new CodeView(node, view, getPos, () => labels.delete(label));
        labels.add(label);
        return registerBlockView(node, label);
      } } },
      view(view) {
        const colors = new HighlightView(view, highlighter(), labels);
        return {
          update() {
            for (const label of labels) if (label.view === view) label.sync();
            colors.update();
          },
          destroy() { colors.destroy(); },
        };
      },
    });
  }

  /** Choose a language and let structure assign the fence its meaning needs. */
  export function setLanguage(position: number, language: string | null): Command {
    return (state, dispatch, view) => {
      if (view?.editable === false || position < 0 || position >= state.doc.content.size) return false;
      const block = state.doc.nodeAt(position);
      if (block?.type !== schema.nodes.codeBlock || language !== null && !isCodeLanguage(language)) return false;
      // Markdown has no metadata slot without a preceding language. Preserve metadata by spelling
      // the plain-text choice explicitly, so reload cannot reinterpret metadata as the language.
      const value = language === null && block.attrs.meta ? 'text' : language;
      if (block.attrs.language === value || !dispatch) return true;
      const transaction = history.isolate(state.tr);
      update(transaction, position, { language: value });
      dispatch(transaction);
      return true;
    };
  }

  /** Tab edits the touched lines. A range ending at a line start excludes that line. */
  export function indent(direction: 'indent' | 'dedent'): Command {
    return (state, dispatch, view) => {
      if (view?.editable === false) return false;
      const selection = codeSelection(state);
      if (!selection) return false;
      if (!dispatch) return true;
      const from = selection.$from;
      const text = from.parent.textContent;
      const last = lineStart(text, selection.empty ? selection.$to.parentOffset : selection.$to.parentOffset - 1);
      const starts: number[] = [];
      for (let start = lineStart(text, from.parentOffset); start <= last;) {
        starts.push(start);
        if (start === last) break;
        start = text.indexOf('\n', start) + 1;
      }
      const transaction = state.tr;
      for (const start of starts.reverse()) {
        if (direction === 'indent') {
          const offset = selection.empty && /^[ \t]*$/.test(text.slice(start, from.parentOffset))
            ? from.parentOffset : start;
          transaction.insertText('  ', from.start() + offset, from.start() + offset);
        } else {
          const length = indentation(text, start);
          if (length) transaction.insertText('', from.start() + start, from.start() + start + length);
        }
      }
      if (transaction.docChanged) dispatch(history.isolate(transaction).scrollIntoView());
      return true;
    };
  }

  /** Enter copies only the indentation before the first endpoint of the selection. */
  export const enterInCode: Command = (state, dispatch, view) => {
    if (view?.editable === false) return false;
    const selection = codeSelection(state);
    if (!selection) return false;
    const from = selection.$from;
    const text = from.parent.textContent;
    const prefix = text.slice(lineStart(text, from.parentOffset), from.parentOffset);
    if (dispatch) dispatch(state.tr.insertText('\n' + /^[ \t]*/.exec(prefix)![0]).scrollIntoView());
    return true;
  };

  /** Share grammar resources across live editors, releasing them with the last lease. */
  export function createHighlighter(): Highlighter {
    const owner = shared ??= { highlighter: new ShikiHighlighter(), references: 0 };
    owner.references++;
    let released = false;
    return {
      async highlight(text, language) {
        if (released) return [];
        const tokens = await owner.highlighter.highlight(text, language);
        return released ? [] : tokens;
      },
      dispose() {
        if (released) return;
        released = true;
        owner.references--;
        if (owner.references !== 0) return;
        owner.highlighter.dispose();
        if (shared === owner) shared = undefined;
      },
    };
  }
}

/** The language of a code block. */
export namespace CodeBlock {
  /** One language label offered by the code-block language command. */
  export interface LanguageChoice {
    readonly value: string;
    readonly label: string;
  }

  /** Raised when the language label is pressed; the host answers with setLanguage. */
  export const chooseLanguage = command.requestCommand<{
    readonly pos: number;
    readonly rect: DOMRectReadOnly;
    readonly language: string;
  }>();

  /** Set the named block's language, or that of the block containing the selection. */
  export const setLanguage: command.Command.Pure<{ readonly pos?: number; readonly language: string }> = ({ state },
    value) => {
    const position = command.findTarget(state.editorState, value.pos, schema.nodes.codeBlock);
    if (position === undefined) return false;
    return state.runCommand(codeBlock.setLanguage(position, value.language || null));
  };

  /** The highlighted languages, with plain text first; other fence labels remain valid. */
  export const languages: readonly LanguageChoice[] = Object.freeze([
    { value: '', label: 'Plain text' },
    ...[...grammars].sort((a, b) => a.label.localeCompare(b.label))
      .map(grammar => ({ value: grammar.id, label: grammar.label })),
  ].map(value => Object.freeze(value)));
}

interface Code {
  readonly node: Node;
  readonly position: number;
}
interface Highlight {
  readonly node: Node;
  readonly tokens: readonly codeBlock.Token[];
}
interface Highlights {
  readonly entries: readonly Highlight[];
  readonly decorations: DecorationSet;
}
interface HighlightChange {
  readonly kind: 'highlight';
  readonly doc: Node;
  readonly blocks: readonly Code[];
  readonly entries: readonly Highlight[];
};
interface Request {
  readonly node: Node;
  readonly result: Promise<Highlight>;
}
interface SharedHighlighter {
  readonly highlighter: codeBlock.Highlighter;
  references: number;
}

const highlightKey = new PluginKey<Highlights>('code-block');
let shared: SharedHighlighter | undefined;

function codeSelection(state: EditorState): TextSelection | null {
  const selection = state.selection;
  if (!(selection instanceof TextSelection) || !selection.$from.sameParent(selection.$to) ||
      selection.$from.parent.type !== schema.nodes.codeBlock) return null;
  return selection;
}

function lineStart(text: string, position: number): number {
  return position === 0 ? 0 : text.lastIndexOf('\n', position - 1) + 1;
}

function indentation(text: string, start: number): number {
  if (text[start] === '\t') return 1;
  if (text[start] !== ' ') return 0;
  return text[start + 1] === ' ' ? 2 : 1;
}

class CodeColors {
  readonly removed = new Set<Node>();
  private readonly known: ReadonlyMap<Node, Highlight>;

  constructor(entries: readonly Highlight[]) {
    this.known = new Map(entries.map(entry => [entry.node, entry]));
  }

  clear(node: Node): void {
    if (node.type === schema.nodes.codeBlock) this.removed.add(node);
    else if (!node.isTextblock) node.forEach(child => this.clear(child));
  }

  draw(node: Node, position: number): Decoration[] {
    const result: Decoration[] = [];
    if (node.type === schema.nodes.codeBlock) {
      this.removed.delete(node);
      for (const token of this.known.get(node)?.tokens ?? []) {
        if (token.from < 0 || token.to <= token.from || token.to > node.content.size) continue;
        result.push(Decoration.inline(position + 1 + token.from, position + 1 + token.to,
          { class: 'md-code-block-token', style: token.style }));
      }
    } else if (!node.isTextblock) {
      node.forEach((child, offset) => result.push(...this.draw(child, position + offset + 1)));
    }
    return result;
  }
}

/** Pending work follows the current document; completed work lives in plugin state. */
class HighlightView implements PluginView {
  private pending: Request[] = [];
  private generation = 0;
  private destroyed = false;
  private doc: Node | undefined;
  private composing = false;

  constructor(readonly view: EditorView, readonly highlighter: codeBlock.Highlighter,
    readonly labels: ReadonlySet<CodeView>) {
    view.dom.addEventListener('compositionstart', this.start);
    view.dom.addEventListener('compositionend', this.end);
    this.update();
  }

  update(): void {
    const { view } = this;
    const doc = view.state.doc;
    const composing = view.composing || compositionState(view.state)?.isComposing === true;
    if (this.doc === doc && this.composing === composing) return;
    this.doc = doc;
    this.composing = composing;
    const generation = ++this.generation;
    if (composing) return;
    const blocks: Code[] = [];
    for (const label of this.labels) {
      if (label.view !== view) continue;
      const block = label.block;
      if (block) blocks.push(block);
    }
    blocks.sort((a, b) => a.position - b.position);
    const complete = new Map(highlightKey.getState(view.state)!.entries.map(entry => [entry.node, entry]));
    this.pending = this.pending.filter(request => blocks.some(block => block.node === request.node));
    if (blocks.every(block => complete.has(block.node))) return;
    const promises = blocks.map(block => {
      const known = complete.get(block.node);
      return known ? Promise.resolve(known) : this.request(block.node);
    });
    void Promise.all(promises).then(entries => {
      if (this.destroyed || view.isDestroyed || this.generation !== generation || view.state.doc !== doc ||
          view.composing || compositionState(view.state)?.isComposing) return;
      this.pending = [];
      const change: HighlightChange = { kind: 'highlight', doc, blocks, entries };
      view.dispatch(view.state.tr.setMeta('addToHistory', false).setMeta(highlightKey, change));
    });
  }

  private request(node: Node): Promise<Highlight> {
    const known = this.pending.find(request => request.node === node);
    if (known) return known.result;
    const result = this.highlighter.highlight(node.textContent, node.attrs.language)
      .catch(() => []).then(tokens => ({ node, tokens }));
    this.pending.push({ node, result });
    return result;
  }

  private start = (): void => this.update();
  private end = (): void => {
    queueMicrotask(() => {
      if (!this.destroyed && !this.view.isDestroyed) this.update();
    });
  };

  destroy(): void {
    this.destroyed = true;
    this.generation++;
    this.pending = [];
    this.view.dom.removeEventListener('compositionstart', this.start);
    this.view.dom.removeEventListener('compositionend', this.end);
    this.highlighter.dispose();
  }
}

/** ProseMirror keeps the code content while the language label updates around it. */
class CodeView implements BlockView {
  readonly dom: HTMLDivElement;
  readonly contentDOM: HTMLElement;
  private readonly toolbar: HTMLDivElement;
  private readonly button: HTMLButtonElement;
  private readonly label: HTMLSpanElement;
  private readonly pre: HTMLPreElement;

  constructor(private node: Node, readonly view: EditorView,
    readonly getPos: () => number | undefined, private readonly remove: () => void) {
    const document = view.dom.ownerDocument;
    this.dom = document.createElement('div');
    this.dom.className = 'md-code-block';
    this.toolbar = this.dom.appendChild(document.createElement('div'));
    this.toolbar.className = 'md-code-block-toolbar';
    this.toolbar.contentEditable = 'false';
    this.button = this.toolbar.appendChild(document.createElement('button'));
    this.button.type = 'button';
    this.button.className = 'code-language-button';
    this.button.setAttribute('aria-label', 'Code block language');
    this.label = this.button.appendChild(document.createElement('span'));
    this.button.insertAdjacentHTML('beforeend', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>');
    this.button.onclick = () => {
      if (view.isDestroyed || !canRunCommand(view.state, view)) return;
      const editor = findEditor(view.dom);
      const pos = getPos();
      if (editor && pos !== undefined) command.Command.dispatch(editor, CodeBlock.chooseLanguage,
        { pos, rect: this.button.getBoundingClientRect(), language: this.language });
    };
    this.button.onkeydown = event => {
      if (!view.isDestroyed && input.historyKey(view, event)) event.stopPropagation();
    };
    this.pre = this.dom.appendChild(document.createElement('pre'));
    this.pre.spellcheck = false;
    this.contentDOM = this.pre.appendChild(document.createElement('code'));
    this.sync();
  }

  get box(): HTMLElement { return this.dom; }
  get content(): HTMLElement { return this.pre; }

  get block(): Code | null {
    const position = this.getPos();
    return position === undefined ? null : { node: this.node, position };
  }

  private get language(): string {
    const value: string = this.node.attrs.language ?? '';
    const grammar = language(value);
    if (grammar) return grammar.id;
    return ['', 'text', 'txt', 'plain', 'plaintext'].includes(value.toLowerCase()) ? '' : value;
  }

  request(): command.CommandRequest {
    return {
      pos: this.getPos,
      rect: () => this.button.getBoundingClientRect(),
      held: value => {
        if (value) this.button.setAttribute('aria-expanded', 'true');
        else this.button.removeAttribute('aria-expanded');
      },
    };
  }

  sync(): void {
    const value: string | null = this.node.attrs.language;
    if (value) this.pre.dataset.lang = value;
    else this.pre.removeAttribute('data-lang');
    this.button.disabled = !this.view.editable;
    const selected = this.language;
    const label = CodeBlock.languages.find(choice => choice.value === selected)?.label ?? selected;
    if (this.label.textContent !== label) this.label.textContent = label;
  }

  update(node: Node): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.sync();
    return true;
  }

  stopEvent(event: Event): boolean {
    if (!this.button.contains(event.target as DOMNode)) return false;
    if (event.type !== 'keydown') return true;
    const key = event as KeyboardEvent;
    return key.altKey || !(key.metaKey || key.ctrlKey) || !['z', 'y'].includes(key.key.toLowerCase());
  }

  ignoreMutation(mutation: ViewMutationRecord): boolean {
    return mutation.type !== 'selection' && (this.toolbar.contains(mutation.target) ||
      mutation.type === 'attributes' && mutation.target === this.pre && mutation.attributeName === 'data-lang');
  }

  destroy(): void {
    this.remove();
    this.button.onclick = this.button.onkeydown = null;
  }
}

/** Lazy grammar loading keeps unsupported labels editable as plain text. */
class ShikiHighlighter implements codeBlock.Highlighter {
  private disposed = false;
  private instance: HighlighterCore | undefined;
  private initialization: Promise<HighlighterCore> | undefined;
  private readonly languages = new Map<string, Promise<void>>();

  private initialize(): Promise<HighlighterCore> {
    if (!this.initialization) {
      this.initialization = Promise.all([import('shiki/core'), import('shiki/engine/oniguruma')])
        .then(async ([core, engine]) => {
        const highlighter = await core.createHighlighterCore({
          themes: [import('shiki/themes/github-light.mjs'), import('shiki/themes/github-dark-default.mjs')],
          langs: [], engine: engine.createOnigurumaEngine(import('shiki/wasm')),
        });
        if (this.disposed) highlighter.dispose();
        else this.instance = highlighter;
        return highlighter;
      });
    }
    return this.initialization;
  }

  async highlight(code: string, name: string | null): Promise<readonly codeBlock.Token[]> {
    const grammar = language(name);
    if (this.disposed || !grammar || !code) return [];
    try {
      const highlighter = await this.initialize();
      if (this.disposed) return [];
      let loading = this.languages.get(grammar.id);
      if (!loading) {
        loading = highlighter.loadLanguage(grammar.load);
        this.languages.set(grammar.id, loading);
      }
      await loading;
      if (this.disposed) return [];
      // Shiki owns tokenization, including multiline grammar state and absolute UTF-16 offsets.
      // Both palettes share token ranges; a theme switch never replaces editable DOM.
      const lines = highlighter.codeToTokensWithThemes(code, {
        lang: grammar.id, themes: { light: 'github-light', dark: 'github-dark-default' },
      });
      const result: codeBlock.Token[] = [];
      for (const line of lines) {
        for (const token of line) {
          if (!token.content) continue;
          const light = token.variants.light;
          const style = [
            `--editor-shiki-light:${light.color ?? 'inherit'}`,
            `--editor-shiki-dark:${token.variants.dark.color ?? 'inherit'}`,
            'color:var(--editor-shiki-light)',
            'color:light-dark(var(--editor-shiki-light),var(--editor-shiki-dark))',
          ];
          const font = light.fontStyle ?? 0;
          if (font > 0) {
            if (font & 1) style.push('font-style:italic');
            if (font & 2) style.push('font-weight:bold');
            if (font & 4) style.push('text-decoration:underline');
          }
          result.push({ from: token.offset, to: token.offset + token.content.length, style: style.join(';') });
        }
      }
      return result;
    } catch {
      // Failed resource promises remain settled, so typing cannot start a retry loop.
      return [];
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.instance) this.instance.dispose();
    this.instance = undefined;
    this.languages.clear();
  }
}

function language(name: string | null) {
  if (name === null) return undefined;
  const normalized = name.toLowerCase();
  return grammars.find(grammar => grammar.id === normalized || grammar.aliases.includes(normalized));
}
