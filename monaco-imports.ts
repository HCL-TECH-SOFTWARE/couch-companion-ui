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
 * Build-time guard over `src/monaco-registrations.ts`.
 *
 * That file replaced `import 'monaco-editor'` with an explicit list of Monaco 0.56's granular
 * entry points (#148). The list buys us the editor we actually use instead of the editor Microsoft
 * ships, and it has two failure modes that nothing else here can see — both silent, both shipping:
 *
 *   A SPECIFIER STOPS RESOLVING. Eight of the imports are deep paths that work only because
 *   0.56's `exports` map is a catch-all (`"./*": "./esm/vs/*.js"`), not because they are published
 *   entry points. #147 already watched this package break every import we had without moving a
 *   single file. A bundler resolve error is not a terrible outcome — but "cannot resolve
 *   .../suggestController" does not tell the reader that completion is about to disappear, and the
 *   catch-all makes it easy to believe deep paths always work. They do not: no `.css` in the
 *   package can be reached by name at all, which is exactly how this was discovered.
 *
 *   MONACO GROWS A FEATURE. The list is a denylist — everything except what we name — so a new
 *   `features/<x>/` directory in a future release would simply never be registered, and there
 *   would be nothing to notice. That is the one real weakness of a denylist, and it is closed here
 *   rather than by remembering to look.
 *
 * Called from vite.config.ts, so it runs on every build and every `vite dev` start.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** The file this guards. Its imports are the source of truth; nothing here restates them. */
export const MONACO_REGISTRATIONS_FILE = path.join(
  import.meta.dirname,
  'src',
  'monaco-registrations.ts'
);

/**
 * Editor features deliberately NOT registered, and why. Anything Monaco ships that is neither
 * imported by monaco-registrations.ts nor listed here fails the build.
 */
export const DENIED_FEATURES: Record<string, string> = {
  inlineCompletions:
    'ghost-text completions. Nothing in the app registers an inline-completion provider, and ' +
    'registering it anyway costs 248,090 B raw / 64,650 B gzip in the editor chunk — measured by ' +
    'adding the import back and rebuilding. The suggest widget is a different feature and IS ' +
    'registered; the two are separable, which is the part worth checking rather than assuming (#148).'
};

/**
 * `features/codicon/register` may never be denied, whatever else is.
 *
 * It is what puts the codicon `@font-face` into the *document* stylesheet, and that is the only
 * copy the browser honours: an `@font-face` inside a shadow root is ignored outright — measured,
 * which is why cca-monaco-editor no longer inlines one. Deny codicon and every icon in the editor
 * — the find widget, folding chevrons, suggest kinds — silently becomes a blank box.
 */
const NEVER_DENY = 'codicon';

function monacoDir(): string {
  // `require.resolve('monaco-editor/package.json')` does not work: the same catch-all answers it
  // with `esm/vs/package.json.js` and throws MODULE_NOT_FOUND. Resolve the API entry instead —
  // `esm/vs/editor.js` — and read the layout from there. See monaco-css.ts, which has the same
  // problem for the same reason.
  return path.dirname(require.resolve('monaco-editor/editor'));
}

/** Every `monaco-editor/...` specifier monaco-registrations.ts imports, in file order. */
function declaredSpecifiers(): string[] {
  if (!fs.existsSync(MONACO_REGISTRATIONS_FILE)) {
    throw new Error(
      `${MONACO_REGISTRATIONS_FILE} is missing. It is what registers Monaco's languages and ` +
        'editor features; without it the editor mounts with no highlighting, no suggest widget ' +
        'and no keybindings, and nothing throws. See #148.'
    );
  }
  const source = fs.readFileSync(MONACO_REGISTRATIONS_FILE, 'utf8');
  return [...source.matchAll(/^import\s+'(monaco-editor\/[^']+)';/gm)].map((m) => m[1]);
}

export function assertMonacoImports(): void {
  const specifiers = declaredSpecifiers();

  // A sanity floor rather than an exact count, which would need editing every time the list moves
  // by one. Below this, something has gutted the file rather than adjusted it.
  if (specifiers.length < 60) {
    throw new Error(
      `${path.basename(MONACO_REGISTRATIONS_FILE)} declares only ${specifiers.length} monaco-editor ` +
        'imports. That is far fewer than the editor needs to work; if the list really is meant to ' +
        'shrink that far, lower the floor in monaco-imports.ts in the same commit and say why.'
    );
  }

  for (const specifier of specifiers) {
    try {
      require.resolve(specifier);
    } catch {
      throw new Error(
        `monaco-registrations.ts imports '${specifier}', which monaco-editor no longer resolves.\n` +
          "The package's exports map is a catch-all, so this is how it announces that something " +
          'moved — see #147, where 0.56 broke every Monaco import we had without moving a file.\n' +
          'Find where that module lives now and update monaco-registrations.ts. Do not simply ' +
          'delete the line: each one registers something the editor visibly needs, and losing one ' +
          'is silent at runtime.'
      );
    }
  }

  const featureDir = path.join(monacoDir(), 'features');
  if (!fs.existsSync(featureDir)) {
    throw new Error(
      `monaco-editor no longer has ${featureDir}. The granular feature entry points this app ` +
        'depends on have been reorganised; re-read the package and update monaco-registrations.ts.'
    );
  }
  const shipped = fs
    .readdirSync(featureDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  const registered = new Set(
    specifiers
      .map((s) => /^monaco-editor\/features\/(.+)\/register$/.exec(s)?.[1])
      .filter((name): name is string => name !== undefined)
  );

  if (Object.prototype.hasOwnProperty.call(DENIED_FEATURES, NEVER_DENY)) {
    throw new Error(
      `'${NEVER_DENY}' is in DENIED_FEATURES. It cannot be: it is what puts the codicon @font-face ` +
        'into the document stylesheet, and a shadow-root @font-face is ignored by the browser, so ' +
        'this is the only copy that renders. Denying it makes every icon in the editor a blank ' +
        'box, with no error. See #148.'
    );
  }

  const unregistered = shipped.filter(
    (name) => !registered.has(name) && !Object.prototype.hasOwnProperty.call(DENIED_FEATURES, name)
  );
  if (unregistered.length > 0) {
    throw new Error(
      `monaco-editor ships editor features this app neither registers nor denies: ` +
        `${unregistered.join(', ')}.\n` +
        'This is what the denylist in monaco-imports.ts exists to catch — an upgrade added a ' +
        'feature, and without this the app would simply never register it.\n' +
        'Add an import to src/monaco-registrations.ts, or add it to DENIED_FEATURES with a reason.'
    );
  }

  const staleDenials = Object.keys(DENIED_FEATURES).filter((name) => !shipped.includes(name));
  if (staleDenials.length > 0) {
    throw new Error(
      `DENIED_FEATURES names features monaco-editor no longer ships: ${staleDenials.join(', ')}. ` +
        'Remove them, so the list keeps describing a real decision rather than an old one.'
    );
  }

  const contradictions = Object.keys(DENIED_FEATURES).filter((name) => registered.has(name));
  if (contradictions.length > 0) {
    throw new Error(
      `${contradictions.join(', ')} appears both in DENIED_FEATURES and as an import in ` +
        'monaco-registrations.ts. The import wins at runtime, so the denial is a comment that ' +
        'is not true. Remove one.'
    );
  }
}
