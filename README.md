# kagami-md

Kagami is a Markdown editor built on ProseMirror. Blocks are structured editor
nodes; inline content remains editable Markdown source. Its parser is a fork of
micromark.

Try it in the [playground](https://kkshinkai.github.io/kagami-md/).

## Install

```sh
npm install kagami-md@alpha
```

Kagami is not ready to be used. Releases are `0.0.0-alpha.N`, published under the `alpha` tag.

`@codemirror/commands`, `@codemirror/state` and `@codemirror/view` are optional
peer dependencies.

## Use

```ts
import { KagamiMD } from 'kagami-md';
import 'kagami-md/styles.css';

const editor = KagamiMD.create({ parent: document.body, doc: '# Hello\n' });
editor.onDidUpdate(update => {
  if (update.docChanged) console.log(update.state.doc);
});
```

The package has one entry point, `kagami-md`, and one stylesheet,
`kagami-md/styles.css`. Release the editor with `editor.destroy()`.

## License

kagami-md is licensed under the [Mozilla Public License 2.0](LICENSE).

The MPL is a file-level copyleft license. You may use kagami-md in any project,
open or proprietary. If you distribute a modified version of one of its files,
that file stays under the MPL and its source must be made available. Your own
files are not affected.

Some files are derived from other projects and keep their notices. Each file's
header names its copyright holders and licenses in
[SPDX](https://spdx.dev) form, and the license texts are in
[LICENSES](LICENSES):

- the parser, from [micromark](https://github.com/micromark/micromark), its
  extensions and the `mdast-util-*` modules, by Titus Wormer (MIT), with CJK
  rules from [markdown-cjk-friendly](https://github.com/tats-u/markdown-cjk-friendly)
  by Tatsunori Uchino (MIT);
- character tables generated from the
  [Unicode Character Database](https://www.unicode.org/ucd/) (Unicode License
  v3) and [get-east-asian-width](https://github.com/sindresorhus/get-east-asian-width)
  by Sindre Sorhus (MIT);
- the event library, from [Visual Studio Code](https://github.com/microsoft/vscode)
  by Microsoft (MIT);
- part of the paste handling, from
  [prosemirror-view](https://github.com/ProseMirror/prosemirror-view) by Marijn
  Haverbeke (MIT);
- the icons, from [Lucide](https://lucide.dev) (ISC) and Feather (MIT).

The built package bundles `prosemirror-view`, `prosemirror-history` and
`prosemirror-tables`, with patches in [patches](patches), and its stylesheet
includes KaTeX and the Open Sans font. Their licenses are listed in
`dist/THIRD-PARTY-LICENSES.md`.
