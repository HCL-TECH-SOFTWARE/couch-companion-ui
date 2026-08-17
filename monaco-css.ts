/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *   https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

/*
 * One alias, needed by both vite.config.ts and vitest.config.ts, which share nothing else.
 *
 * Monaco renders into a shadow root, so it needs its stylesheet *inside* that root: the CSS
 * Monaco's own ESM modules pull in lands in the document, and the shadow boundary stops it there.
 * `cca-monaco-editor.ts` therefore imports the bundled `editor.main.css` with `?inline` and writes
 * it into its own <style>. Without it the editor renders as unstyled text — no gutter, no
 * highlighting, no cursor.
 *
 * Monaco 0.56 made that import unresolvable. Its new `exports` map is a catch-all:
 *
 *     "./*.js": "./esm/vs/*.js",   "./*": "./esm/vs/*.js"
 *
 * Every subpath is answered with a `.js` file under `esm/vs/`, so
 * `min/vs/editor/editor.main.css` resolves to `esm/vs/min/vs/editor/editor.main.css.js` and no
 * `.css` in the package can be reached by name at all. The file is still shipped — only the door
 * is shut — so the specifier is aliased straight to it.
 *
 * This deliberately does NOT use the `require.resolve('<pkg>/package.json')` idiom that
 * vite.config.ts uses for Font Awesome: the same catch-all swallows `monaco-editor/package.json`
 * too (MODULE_NOT_FOUND). Resolving the entry point and walking up out of `min/vs/` is what is
 * left, and the guard below turns a future layout change into a startup error that names the
 * cause, rather than an editor that quietly renders unstyled.
 */

import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import type { Plugin } from 'vite';

const require = createRequire(import.meta.url);

/** The specifier `cca-monaco-editor.ts` imports — the real file name, kept readable at the import site. */
export const MONACO_CSS_SPECIFIER = 'monaco-editor/min/vs/editor/editor.main.css';

/** Absolute path to that stylesheet, resolved out of the installed package. */
export const MONACO_CSS_FILE = path.join(
  path.resolve(path.dirname(require.resolve('monaco-editor')), '../..'),
  'min/vs/editor/editor.main.css'
);

if (!fs.existsSync(MONACO_CSS_FILE)) {
  throw new Error(
    `monaco-editor's bundled stylesheet is not at ${MONACO_CSS_FILE}. The package layout changed: ` +
      'find editor.main.css inside monaco-editor and update MONACO_CSS_FILE in monaco-css.ts, ' +
      'or cca-monaco-editor will render unstyled.'
  );
}

/*
 * Ready to spread into a Vite/Vitest `resolve.alias`.
 *
 * A regex rather than the plain `{ specifier: file }` object form, because Vite matches an alias
 * against the *whole* import specifier — query and all. The import site needs `?inline` (it wants
 * the stylesheet as a string to put in a <style>, not a side-effecting stylesheet import), and
 * `…editor.main.css?inline` neither equals `…editor.main.css` nor starts with `…editor.main.css/`,
 * so the object form silently does not match and the build fails as if there were no alias at all.
 * The capture group carries any query through to the replacement; with no query it expands empty.
 */
export const monacoCssAlias = [
  {
    find: new RegExp(
      `^${MONACO_CSS_SPECIFIER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\?.*)?$`
    ),
    replacement: `${MONACO_CSS_FILE}$1`
  }
];

/**
 * The one `@font-face` in that stylesheet: codicon, with the whole TTF base64-inlined.
 *
 * `[^}]*` is safe on this rule specifically — a font-face body has no nested braces and the base64
 * alphabet contains none either.
 */
const CODICON_FONT_FACE = /@font-face\s*\{[^}]*\}/g;

/**
 * Strips that rule out of the copy we inline into the shadow root — 188,044 B raw, 90,666 B gzip,
 * 77% of the stylesheet's compressed weight, and it does nothing whatsoever.
 *
 * Measured in headless Chrome: an `@font-face` declared inside a shadow root is ignored outright.
 * The face is not registered (`document.fonts.size` stays 0) and the glyph renders at the fallback
 * width. A document-level `@font-face`, on the other hand, DOES apply to shadow content. So the
 * codicons in our editor have always been rendered by the document stylesheet — the one Vite
 * extracts from Monaco's own ESM modules, pointing at the emitted `codicon.ttf` — and never by the
 * copy inside the shadow root. We were shipping the same font twice and using it once.
 *
 * That makes `features/codicon/register` load-bearing in a way it does not look: it is what puts
 * the surviving face in the document. monaco-imports.ts refuses to let it be denied.
 *
 * A build-time transform and not a `.replace()` at the import site, because the point is the bytes:
 * a runtime strip would leave all 350 kB sitting in the bundle as a string and save nothing.
 *
 * Both vite.config.ts and vitest.config.ts install this, so what the tests assert and what ships
 * are the same string — `test/cca-monaco-editor.test.ts` checks that no `@font-face` survives and
 * that the real rules do.
 */
export const monacoCssPlugin: Plugin = {
  name: 'cca-monaco-css',
  // Ahead of Vite's own CSS handling, which would otherwise hand us a JS module instead of CSS.
  enforce: 'pre',
  transform(code: string, id: string) {
    if (id.split('?')[0] !== MONACO_CSS_FILE) return null;
    const stripped = code.replace(CODICON_FONT_FACE, '');
    if (stripped === code) {
      throw new Error(
        `no @font-face found in ${MONACO_CSS_FILE}. Either monaco-editor stopped inlining the ` +
          'codicon font — in which case delete monacoCssPlugin, it has nothing left to do — or the ' +
          'rule is written in a form this regex does not match, and the shadow-root stylesheet ' +
          'just grew ~188 kB again without anyone noticing. Check which before removing this guard.'
      );
    }
    return { code: stripped, map: null };
  }
};
