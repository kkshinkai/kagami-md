# Changelog

## 0.0.0-alpha.2

- Tags are redesigned in the common nested form, `#tag` and `#tag/sub`. The paired form `#a b#`, a tag with spaces closed by a second `#`, is removed: it was convenient, but no tool other than Bear reads it, so it was not needed and was not compatible. `#a b#` now reads as the tag `a` followed by the text ` b#`.
- Kagami used to write a zero-width space (`U+200B`) into the Markdown wherever it was needed to keep an empty paragraph or the spaces that begin a text. New settings let you give up that fidelity to avoid the zero-width spaces: `keepEmptyParagraph`, `keepEmptySetextHeading` and `keepStartingSpaceOrTab`. By default, empty paragraphs at the end of the document are no longer written.

## 0.0.0-alpha.1

- The first release.
