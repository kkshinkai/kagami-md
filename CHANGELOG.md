# Changelog

## 0.0.0-alpha.3

- `KagamiState` (`KagamiMD.State`) is now exported at the top level (`KagamiState.create(spec)`), letting a caller hold and edit document state without a view or attach a view with `KagamiMD.fromState(state, spec)`. `KagamiMD.Spec` combines `KagamiState.Spec` and `KagamiMD.View.Spec`.
- Queries and operations are now methods on `KagamiMD` and `KagamiState` (`state.getMarkdown()`, `state.getSelection()`, `state.setSelection()`, `state.undo()`, `state.redo()`, `editor.isReadOnly()`, `editor.setReadOnly()`, `editor.hasFocus()`, `editor.undo()`, `editor.redo()`, `editor.copy()`, `editor.cut()`, `editor.getCompletion()`), replacing `editor.handle`, top-level `copy`/`cut`/`undo`/`redo`, and the `Command`, `CodeBlock`, `Callout`, `Table`, `Frontmatter`, `Tag`, `Wikilink`, and `Image` namespaces.
- Built-in surface controls fire typed events (`onDidClickCodeBlockLanguage`, `onDidClickCalloutType`, `onDidClickFrontmatterPropertyType`, and `onDidClickTableHandle`, where `KagamiMD.TableAlign` is `'default' | 'left' | 'center' | 'right'`) carrying `hold()` and bound action methods. Completion publishes `KagamiMD.Completion | null` through `onDidChangeCompletion` and `getCompletion()`, and host lookups are registered with `registerTagCompletionProvider`, `registerWikilinkCompletionProvider`, and `registerImageProvider` (errors routed to `onDidError`). `Destroyable` and `Emitter` are exported alongside `DestroyableStore`, `Event`, and `IDestroyable`.
- `#tag` and `[[wikilink]]` syntax are now opt-in through `tag` and `wikilink` on `KagamiState.Spec`. A new `cjkFriendly` option (enabled by default) selects CJK-friendly inline delimiter boundaries, aligning `==highlight==` with GFM `~~strikethrough~~` and emphasis boundaries with upstream micromark; `drawnSelection` (`false` by default) makes Kagami-drawn text selection opt-in.
- `Backspace` and `Delete` at block and container boundaries now join compatible textblocks directly and across container boundaries instead of stopping on intermediate block selections.
- `@codemirror/commands`, `@codemirror/state`, and `@codemirror/view` are now regular dependencies instead of optional peer dependencies, and `@fontsource/open-sans` has been removed from `kagami-md/styles.css`.

## 0.0.0-alpha.2

- Tags are redesigned in the common nested form, `#tag` and `#tag/sub`. The paired form `#a b#`, a tag with spaces closed by a second `#`, is removed: it was convenient, but no tool other than Bear reads it, so it was not needed and was not compatible. `#a b#` now reads as the tag `a` followed by the text ` b#`.
- Kagami used to write a zero-width space (`U+200B`) into the Markdown wherever it was needed to keep an empty paragraph or the spaces that begin a text. New settings let you give up that fidelity to avoid the zero-width spaces: `keepEmptyParagraph`, `keepEmptySetextHeading` and `keepStartingSpaceOrTab`. By default, empty paragraphs at the end of the document are no longer written.

## 0.0.0-alpha.1

- The first release.
