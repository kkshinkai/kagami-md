/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  Callout, CodeBlock, Command, Completion, CompletionList, DestroyableStore, Frontmatter, Menu, Picker,
  Table, calloutIcons, copy, cut, icons, redo, undo, valueTypeIcons, type IDestroyable, type KagamiMD,
  type Popup,
} from 'kagami-md';

/** The list ID shared by the editor's accessibility attributes and its completion UI. */
export const completionList = 'completions';

/** Connect the editor's control commands to the UI package. */
export function attachEditorUI(editor: KagamiMD): IDestroyable {
  return new EditorUI(editor);
}

/** A control request with an open popup and a hold on its editor button. */
interface OpenControl {
  readonly command: unknown;
  readonly pos: number;
  readonly hold: Command.Hold;
  readonly popup: Popup.Open;
}

/** The editor position named by a control request. */
interface ControlRequest {
  readonly pos: number;
}

/** How changing a property's type affects its value. */
type Conversion = 'convert' | 'reset';

/** A property type and the label shown in its menu. */
type PropertyType = readonly [type: Frontmatter.ValueType, label: string];

/** Property types in the order the host offers them. */
const valueTypes: readonly PropertyType[] = [
  ['string', 'Text'], ['number', 'Number'], ['boolean', 'Boolean'],
  ['null', 'Null'], ['array', 'Array'], ['object', 'Object'],
];

/** The playground's command and event wiring; rendering belongs to the UI package. */
class EditorUI implements IDestroyable {
  private readonly store = new DestroyableStore();
  private readonly document: Document;
  private readonly completions: CompletionList;
  private open: OpenControl | null = null;

  constructor(private readonly editor: KagamiMD) {
    this.document = editor.dom.ownerDocument;
    this.answer(CodeBlock.chooseLanguage, ({ pos, language }, host) => this.language(pos, language, host));
    this.answer(Callout.chooseKind, ({ pos, kind }, host) => this.callout(pos, kind, host));
    this.answer(Frontmatter.choosePropertyType, ({ pos, type, conversions }, host) =>
      this.property(pos, type, conversions, host));
    this.answer(Table.chooseAction, ({ axis, align }, host) => this.table(axis, align, host),
      (event, close) => this.tableKey(event, close));
    this.store.add(editor.onDidUpdate(() => this.open?.popup.layout()));
    this.completions = new CompletionList(this.document, {
      choose: index => Completion.accept(editor, index),
      point: index => Completion.activate(editor, index),
    });
    this.store.add(editor.onDidUpdate(() => this.showCompletion()));
    this.showCompletion();
    this.store.add({ destroy: () => {
      this.open?.popup.close();
      this.completions.destroy();
    } });
  }

  /**
   * Answers a command the editor dispatched by opening a popup. The request is held for as long
   * as the popup is open, so that the editor shows what was pressed as pressed and says where
   * it is. A second request for the same thing closes the popup.
   */
  private answer<Param extends ControlRequest>(
    command: Command.Request<Param>,
    show: (param: Param, host: Popup.Host) => Popup.Open,
    key?: (event: KeyboardEvent, close: () => void) => boolean,
  ): void {
    this.store.add(this.editor.handle(command, (_editor, param) => {
      if (this.open?.command === command && this.open.pos === param.pos) {
        this.open.popup.close();
        return true;
      }
      const hold = Command.hold(this.editor, command, param.pos);
      if (!hold) return false;
      const popup = show(param, {
        rect: () => hold.rect(),
        // Undo and redo work from inside a popup, on the document.
        key: event => {
          const history = this.historyKey(event);
          const used = history === null ? key?.(event, () => popup.close()) ?? false : history;
          if (used) event.preventDefault();
          return used;
        },
        closed: reason => {
          if (this.open?.hold === hold) this.open = null;
          hold.destroy();
          // The focus goes back to the document unless the user has put it somewhere else.
          if (reason !== 'outside' && this.editor.dom.isConnected) this.editor.focus();
        },
      });
      this.open = { command, pos: param.pos, hold, popup };
      return true;
    }));
  }

  /** Handle document history keys while a popup has focus. */
  private historyKey(event: KeyboardEvent): boolean | null {
    if (modifier(event, 'z')) return event.shiftKey ? redo(this.editor) : undo(this.editor);
    if (modifier(event, 'y')) return redo(this.editor);
    return null;
  }

  /** Offer the known languages and a custom language name. */
  private language(pos: number, language: string, host: Popup.Host): Popup.Open {
    // A code block may be in any language, so a name that is not listed can be chosen as typed,
    // and the present one is listed even when it is not one the editor highlights.
    const listed = CodeBlock.languages.some(item => item.value === language);
    return Picker.open(this.document, host, {
      label: 'Code block language', placeholder: 'Search languages…',
      items: listed ? CodeBlock.languages : [...CodeBlock.languages, { value: language, label: language }],
      current: language, custom: typed => `Use “${typed}”`,
      choose: chosen => CodeBlock.setLanguage(this.editor, { pos, language: chosen }),
    }, { align: 'end' });
  }

  /** Offer the callout kinds and conversion to a quote. */
  private callout(pos: number, kind: Callout.Kind, host: Popup.Host): Popup.Open {
    return Menu.open(this.document, host, 'Callout type', [
      ...Callout.kinds.map(({ value, label }): Menu.Item => ({
        type: 'action', label, icon: calloutIcons[value], checked: value === kind,
        run: () => Callout.setKind(this.editor, { pos, kind: value }),
      })),
      { type: 'separator' },
      { type: 'action', label: 'Convert to quote', icon: icons.quote, run: () => Callout.toQuote(this.editor, { pos }) },
    ]);
  }

  /** Group property types by whether the existing value can survive. */
  private property(
    pos: number, type: Frontmatter.ValueType,
    conversions: Readonly<Record<Frontmatter.ValueType, Conversion>>, host: Popup.Host,
  ): Popup.Open {
    // The types are in two groups: those the present value can be converted to, and those that
    // can only be had by starting the value again.
    const convert = this.propertyGroup(pos, type, valueTypes.filter(([each]) => conversions[each] === 'convert'), 'Convert to');
    const reset = this.propertyGroup(pos, type, valueTypes.filter(([each]) => conversions[each] === 'reset'), 'Reset to');
    const items: Menu.Item[] = [...convert];
    if (convert.length && reset.length) items.push({ type: 'separator' });
    items.push(...reset,
      { type: 'separator' },
      { type: 'action', label: 'Insert above', icon: icons.above,
        run: () => Frontmatter.insertProperty(this.editor, { pos, side: 'above' }) },
      { type: 'action', label: 'Insert below', icon: icons.below,
        run: () => Frontmatter.insertProperty(this.editor, { pos, side: 'below' }) },
      { type: 'separator' },
      { type: 'action', label: 'Delete', icon: icons.remove, destructive: true,
        run: () => Frontmatter.deleteProperty(this.editor, { pos }) },
    );
    return Menu.open(this.document, host, 'Property type', items);
  }

  /** Add one nonempty group of property types. */
  private propertyGroup(pos: number, current: Frontmatter.ValueType, choices: readonly PropertyType[], label: string): Menu.Item[] {
    if (!choices.length) return [];
    return [{ type: 'heading', label }, ...choices.map(([type, label]): Menu.Item => ({
      type: 'action', label, icon: valueTypeIcons[type], checked: type === current,
      run: () => Frontmatter.setPropertyType(this.editor, { pos, type }),
    }))];
  }

  /** The row or column is selected when the request is raised; actions use that selection. */
  private table(axis: 'row' | 'column', align: Table.Align | null, host: Popup.Host): Popup.Open {
    const row = axis === 'row';
    const items: Menu.Item[] = row ? [
      { type: 'action', label: 'Insert row above', icon: icons.rowAbove, run: () => Table.addRowBefore(this.editor) },
      { type: 'action', label: 'Insert row below', icon: icons.rowBelow, run: () => Table.addRowAfter(this.editor) },
    ] : [
      { type: 'action', label: 'Insert column left', icon: icons.columnLeft, run: () => Table.addColumnBefore(this.editor) },
      { type: 'action', label: 'Insert column right', icon: icons.columnRight, run: () => Table.addColumnAfter(this.editor) },
      { type: 'separator' },
      // A column that was given no alignment has none of the three checked.
      { type: 'action', label: 'Align left', icon: icons.alignLeft, checked: align === 'left', run: () => Table.setColumnAlign(this.editor, 'left') },
      { type: 'action', label: 'Align center', icon: icons.alignCenter, checked: align === 'center', run: () => Table.setColumnAlign(this.editor, 'center') },
      { type: 'action', label: 'Align right', icon: icons.alignRight, checked: align === 'right', run: () => Table.setColumnAlign(this.editor, 'right') },
    ];
    items.push(
      { type: 'separator' },
      { type: 'action', label: `Copy ${axis}`, icon: icons.copy, run: () => copy(this.editor) },
      { type: 'action', label: `Cut ${axis}`, icon: icons.cut, run: () => cut(this.editor) },
      { type: 'separator' },
      { type: 'action', label: `Delete ${axis}`, icon: icons.remove, destructive: true,
        run: () => row ? Table.deleteRow(this.editor) : Table.deleteColumn(this.editor) },
    );
    return Menu.open(this.document, host, row ? 'Row actions' : 'Column actions', items,
      { sides: row ? ['right', 'left'] : ['below', 'above'], align: 'center' });
  }

  /** Clipboard keys in a table menu act on the selected row or column. */
  private tableKey(event: KeyboardEvent, close: () => void): boolean {
    // Pasting is the browser's to do, in the document: the menu gets out of the way and does not use the key.
    if (modifier(event, 'c') || modifier(event, 'x')) {
      (modifier(event, 'c') ? copy : cut)(this.editor);
      close();
      return true;
    }
    if (modifier(event, 'v')) close();
    return false;
  }

  /** Translate each feature's typed completion into its list presentation. */
  private showCompletion(): void {
    const completion = Completion.current(this.editor);
    if (!completion) {
      this.completions.show(null);
      return;
    }
    const common = {
      kind: completion.kind, listId: completionList,
      optionId: (index: number) => `${completionList}-${index}`,
      active: completion.active, rect: completion.rect,
    };
    switch (completion.kind) {
      case 'tag':
        this.completions.show({ ...common, label: 'Tag suggestions',
          items: completion.items.map(item => ({ label: item.label ?? item.value, description: item.description, icon: icons.tag })),
          status: completion.pending ? 'Finding tags…' : 'No matching tags.',
        });
        break;
      case 'wikilink':
        this.completions.show({ ...common, label: 'Wikilink suggestions',
          items: completion.items.map(item => ({ label: item.label ?? item.value, description: item.description, icon: icons.page })),
          status: completion.pending ? 'Finding notes…' : 'No matching notes.',
        });
        break;
      case 'callout':
        this.completions.show({ ...common, label: 'Callout suggestions',
          items: completion.items.map(item => ({ label: item.label ?? item.value, description: item.description, icon: calloutIcons[item.value] })),
          status: completion.pending ? 'Callout…' : 'No matching callout types.',
        });
        break;
    }
  }

  /** Disconnect the host and take away its open UI. */
  destroy(): void {
    this.store.destroy();
  }
}

/** Match a host command shortcut without consuming an Alt combination. */
function modifier(event: KeyboardEvent, key: string): boolean {
  return !event.altKey && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === key;
}
