/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { defineConfig, type Plugin } from 'vite';
import { appendFileSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const external = new Set([...Object.keys(pkg.dependencies), ...Object.keys(pkg.peerDependencies)]);
// Engine fixes must travel with the artifact. Tables and View share DecorationSet identity,
// so they are bundled together; state/model/transform and CM remain shared dependencies.
const bundled = ['prosemirror-history', 'prosemirror-view', 'prosemirror-tables'];
for (const name of bundled) external.delete(name);

// The stylesheet inlines KaTeX's stylesheet and fonts and Open Sans, which the bundled
// dependencies' license file, made from the script's modules, does not see.
const licenseFile = 'THIRD-PARTY-LICENSES.md';
const styleDependencies = ['katex', '@fontsource/open-sans'];

function styleLicenses(): Plugin {
  const require = createRequire(import.meta.url);
  return {
    name: 'style-licenses',
    writeBundle({ dir }) {
      for (const name of styleDependencies) {
        const { version, license } = require(`${name}/package.json`);
        const text = readFileSync(require.resolve(`${name}/LICENSE`), 'utf8').trim();
        appendFileSync(`${dir}/${licenseFile}`, `\n## ${name} - ${version} (${license})\n\n${text}\n`);
      }
    },
  };
}

export default defineConfig({
  plugins: [styleLicenses()],
  build: {
    outDir: 'dist', emptyOutDir: true, sourcemap: true, cssCodeSplit: true, license: { fileName: licenseFile },
    lib: {
      entry: { 'kagami-md': 'src/index.ts' },
      formats: ['es'], fileName: (_format, entry) => `${entry}.js`, cssFileName: 'styles',
    },
    rollupOptions: {
      input: { 'kagami-md': 'src/index.ts', styles: 'src/styles.css' },
      external: id => [...external].some(name => id === name || id.startsWith(`${name}/`)),
    },
  },
});
