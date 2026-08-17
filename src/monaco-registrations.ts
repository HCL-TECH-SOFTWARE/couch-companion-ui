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

/**
 * Everything Monaco must register before `cca-monaco-editor` creates an editor — and nothing else.
 *
 * Until 0.55 the package had one door: `import 'monaco-editor'`, which registers all 80 language
 * grammars, all four rich language services, every editor contribution, and an LSP client we never
 * call. 0.56 broke it into addressable pieces. This file is the list we chose (#148); the component
 * imports it for its side effects and then talks to `monaco-editor/editor`, which is the API alone
 * and registers nothing at all.
 *
 * A DENYLIST, NOT AN ALLOWLIST. Every editor feature Monaco ships is registered below except those
 * named in `DENIED_FEATURES` in monaco-imports.ts, each with a reason. Measured: an allowlist of
 * the ~46 features we could actually argue for saves 34 kB gzip over this — against 46 chances to
 * lose a keybinding silently, because a missing contribution is not an error. It is a menu entry
 * that never appears and a shortcut that does nothing, on a screen nobody happened to open.
 *
 * ADDING TO THIS FILE IS NOT OPTIONAL WHEN MONACO GROWS. `assertMonacoImports()` reads this file
 * at build time and fails if the package ships a feature that is neither imported here nor
 * explicitly denied. Without that, an upgrade could add a feature and we would simply never
 * register it — the one real weakness of a denylist, closed by a gate rather than by vigilance.
 *
 * THE DEEP PATHS AT THE BOTTOM ARE LOAD-BEARING. `esm/vs/index.js` imports eight modules that no
 * `features/<x>/register` covers, and `features/register.all.js` does not cover them either. The
 * sharpest is `suggestController`: `features/suggest/register` contains only
 * `suggestInlineCompletions.js`, so without it the suggest widget does not exist and
 * `registerCompletionItemProvider` — which view-editor.ts uses for CouchDB field completion —
 * renders nothing, with no error anywhere. They resolve only because 0.56's `exports` map is a
 * catch-all rather than a published entry point, which makes them the fragile part of this file.
 * assertMonacoImports() resolves every one of them at build time for that reason.
 */

/*
 * LANGUAGES. Two, where the everything-entry registered eighty.
 *
 * JSON has no `languages/definitions/json` to import — its tokenizer lives in the rich service, so
 * the service is not optional for us and neither is json.worker. JavaScript is the reverse: the
 * monarch grammar stands alone, and the TypeScript service on top of it is what gives view
 * functions their error squiggles and member completion. It is kept deliberately (#148): a syntax
 * error caught before the design-doc write is worth more than the 6.9 MB ts.worker, which is
 * fetched only when someone actually edits a view.
 *
 * Not registered, and this is the point: the CSS and HTML language services. Nothing in the app
 * edits either, and `MonacoEnvironment.getWorker` never handed them a worker of their own — yet
 * registering them made the build emit css.worker (1,074,991 B) and html.worker (740,015 B) into
 * dist/, shipped in every tarball and container image, fetched by nobody.
 */
import 'monaco-editor/languages/features/json/register';
import 'monaco-editor/languages/definitions/javascript/register';
import 'monaco-editor/languages/features/typescript/register';

/*
 * FEATURES. Every one Monaco ships except the denied list in monaco-imports.ts.
 */
import 'monaco-editor/features/anchorSelect/register';
import 'monaco-editor/features/bracketMatching/register';
import 'monaco-editor/features/caretOperations/register';
import 'monaco-editor/features/clipboard/register';
import 'monaco-editor/features/codeAction/register';
import 'monaco-editor/features/codeEditor/register';
import 'monaco-editor/features/codelens/register';
import 'monaco-editor/features/codicon/register'; // the document-level @font-face — see the warning above; never drop this one
import 'monaco-editor/features/colorPicker/register';
import 'monaco-editor/features/comment/register';
import 'monaco-editor/features/contextmenu/register';
import 'monaco-editor/features/cursorUndo/register';
import 'monaco-editor/features/diffEditor/register';
import 'monaco-editor/features/diffEditorBreadcrumbs/register';
import 'monaco-editor/features/dnd/register';
import 'monaco-editor/features/documentSymbols/register';
import 'monaco-editor/features/dropOrPasteInto/register';
import 'monaco-editor/features/find/register'; // also patches the find widget's tabindex handling
import 'monaco-editor/features/floatingMenu/register';
import 'monaco-editor/features/folding/register';
import 'monaco-editor/features/fontZoom/register';
import 'monaco-editor/features/format/register';
import 'monaco-editor/features/gotoError/register';
import 'monaco-editor/features/gotoLine/register';
import 'monaco-editor/features/gotoSymbol/register';
import 'monaco-editor/features/gpu/register';
import 'monaco-editor/features/hover/register';
import 'monaco-editor/features/indentation/register';
import 'monaco-editor/features/inlayHints/register';
import 'monaco-editor/features/inlineProgress/register';
import 'monaco-editor/features/inPlaceReplace/register';
import 'monaco-editor/features/insertFinalNewLine/register';
import 'monaco-editor/features/inspectTokens/register';
import 'monaco-editor/features/iPadShowKeyboard/register';
import 'monaco-editor/features/lineSelection/register';
import 'monaco-editor/features/linesOperations/register';
import 'monaco-editor/features/linkedEditing/register';
import 'monaco-editor/features/links/register';
import 'monaco-editor/features/longLinesHelper/register';
import 'monaco-editor/features/middleScroll/register';
import 'monaco-editor/features/multicursor/register';
import 'monaco-editor/features/parameterHints/register';
import 'monaco-editor/features/placeholderText/register';
import 'monaco-editor/features/quickCommand/register';
import 'monaco-editor/features/quickHelp/register';
import 'monaco-editor/features/quickOutline/register';
import 'monaco-editor/features/readOnlyMessage/register';
import 'monaco-editor/features/referenceSearch/register';
import 'monaco-editor/features/rename/register';
import 'monaco-editor/features/sectionHeaders/register';
import 'monaco-editor/features/semanticTokens/register';
import 'monaco-editor/features/smartSelect/register';
import 'monaco-editor/features/snippet/register';
import 'monaco-editor/features/stickyScroll/register';
import 'monaco-editor/features/suggest/register'; // widget itself is suggestController, below
import 'monaco-editor/features/toggleHighContrast/register';
import 'monaco-editor/features/toggleTabFocusMode/register';
import 'monaco-editor/features/tokenization/register';
import 'monaco-editor/features/unicodeHighlighter/register';
import 'monaco-editor/features/unusualLineTerminators/register';
import 'monaco-editor/features/wordHighlighter/register';
import 'monaco-editor/features/wordOperations/register';
import 'monaco-editor/features/wordPartOperations/register';

/*
 * THE EIGHT WITH NO GRANULAR DOOR. Imported by esm/vs/index.js, covered by no feature register.
 * Deep paths into the package, reachable only through 0.56's catch-all `exports` map; resolved at
 * build time by assertMonacoImports() so an upstream move fails loudly instead of quietly removing
 * a widget. They have no type declarations either, hence the wildcard in src/global.d.ts.
 */
import 'monaco-editor/editor/browser/coreCommands'; // cursor commands and their keybindings
import 'monaco-editor/editor/common/standaloneStrings'; // localized strings for all of the above
import 'monaco-editor/editor/contrib/suggest/browser/suggestController'; // the suggest widget itself
import 'monaco-editor/editor/contrib/gotoSymbol/browser/goToCommands';
import 'monaco-editor/editor/contrib/gotoError/browser/markerSelectionStatus';
import 'monaco-editor/editor/contrib/semanticTokens/browser/documentSemanticTokens';
import 'monaco-editor/editor/contrib/caretOperations/browser/caretOperations';
import 'monaco-editor/editor/contrib/dropOrPasteInto/browser/copyPasteContribution';
