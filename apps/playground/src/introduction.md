---
title: Kagami
tags:
  - markdown
  - editor
---

# Kagami

This page is a live document. Edit anywhere below, and switch to **Source** above at any point — the cursor lands at the same spot in the raw file.

## Every block has a handle

Hover a paragraph, heading, list item, quote, table or code block, and a handle appears in the margin. Drag it anywhere on the page. An item dropped into another list takes that list's marker and brings its children along. Start a selection in the margin to select several blocks at once, then delete, cut or copy them together.

- A list item with a child
  - the child goes where its parent goes.
- [x] A task item
  > holding a quote.
- [ ] Another task

* An asterisk list. Drop the first item above between these two,
* and it comes in as `*`, its child still nested under it.

> A quote whose second line
continues lazily, with a list inside it:
> - one
> - two

> [!TIP]
> A callout moves as one block.

| Drag  | rows and columns   |
|-------|--------------------|
| by    | their handles, and |
| add   | more at the edges. |

```js
console.log('Code blocks move too.');
```

Tab and Shift-Tab indent the lines you select by one level, and leave the lines below them where they are.

## Formatting is characters, not a state

In most block editors, bold or code is a wrapper around text: the cursor gets stuck on the wrong side of a boundary, you cannot edit the delimiter itself, and typing `2 * 3 * 4` slips backslashes into the file on save.

Here, the characters on the line are the text. Put the caret at the end of **bold** and delete one `*`: it becomes a literal `*` followed by *bold*. _Underscores_ stay underscores, an escaped \*asterisk\* stays escaped, and ==highlights==, `code`, [links](https://example.com), $e^{i\pi} + 1 = 0$, [[Reading list]], #idea and footnotes[^1] show their syntax only while the caret is inside them.

> [!NOTE]
> Try typing `#` or `[[` anywhere to complete a tag or page.

## Editing one line does not reformat the rest

Visual editors usually reprint the whole file when they save: `*` bullets become `-`, `1)` becomes `1.`, `~~~` becomes backticks, and a table aligned by hand is re-padded because you fixed a typo three paragraphs away.

Here, anything you did not touch stays exactly as it was in the file, and a list or code block you do edit keeps the spelling it already had.

* Bullets written with asterisks
* stay asterisks when you edit or add an item.

| Syntax | In the file       |
|:-------|------------------:|
| `*`    | kept as `*`       |
| `1)`   | kept as `1)`      |

1) Numbered with parentheses.
2) Change a word on this line, then switch to Source: this list keeps `)` and the table above keeps its hand-aligned spaces.

~~~ts
const fence = 'tildes';
~~~

## Nothing on screen turns into something else on reopen

Many block editors let the page show states that no Markdown file can actually say — a plain paragraph whose text begins with `- `, or two `-` lists pretending to sit back to back as separate lists. They look right while you edit, and change shape the next time the file is opened.

Delete the `x` below, and the paragraph immediately becomes the list item the file would read it as:

x- a paragraph only while the x is there

Delete the line between the two `-` lists below and they join into one. The `+` list after them is a separate list in Markdown, and stays separate:

- the first list

Delete this line.

- the second list

+ a list marked with a plus

When a line is only halfway typed, it waits instead of converting early: a bare `#` on its way to #draft, a `-` on its way to `-5`, or three backticks while you are still typing the language name before pressing Enter leave the rest of the page untouched.

[^1]: Clicking a footnote reference or moving the caret into it reveals the marker in place.

---

Kagami is open source under the Mozilla Public License 2.0. The code is on [GitHub](https://github.com/kkshinkai/kagami-md).
