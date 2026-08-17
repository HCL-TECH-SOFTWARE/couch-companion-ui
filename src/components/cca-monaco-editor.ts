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

import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { createRef, Ref, ref } from 'lit/directives/ref.js';
import { getLogger } from '../services/log-service.js';

const log = getLogger('components/cca-monaco-editor');

// `monaco-editor/editor` is the API and NOTHING else: no languages, no editor contributions, not
// even the cursor keybindings. What the editor can do is decided entirely by the side-effect
// imports in monaco-registrations.ts, which is where the reasoning lives (#148). Importing
// `monaco-editor` instead would quietly bring back all 80 grammars and every contribution.
import * as monaco from 'monaco-editor/editor';
import '../monaco-registrations.js';
// Monaco 0.56 added an `exports` map whose catch-all rewrites EVERY subpath to
// `./esm/vs/<subpath>.js`, so the old `monaco-editor/esm/vs/...` spelling now
// resolves to `esm/vs/esm/vs/...` — a path that does not exist. The files did
// not move; the package simply stopped answering to their full names. Dropping
// the `esm/vs/` prefix is the supported spelling, and it is what the map turns
// back into the very same files.
//
// `language/<x>/` (singular) is 0.56's compatibility shim for `languages/features/<x>/`, where the
// registers in monaco-registrations.ts come from: `language/json/json.worker.js` is a one-line
// re-export of the very file the new layout ships. Same worker, older name, so client and worker
// cannot drift apart.
import editorWorker from 'monaco-editor/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/language/json/json.worker?worker';
import tsWorker from 'monaco-editor/language/typescript/ts.worker?worker';
// The bundled stylesheet cannot come through that map at all: the catch-all
// appends `.js`, so no `.css` file in the package is reachable by name any
// more. It is aliased to its real path in vite.config.ts / vitest.config.ts,
// which is also where the reason for the alias is written down. This import
// still names the file it actually gets — minus its `@font-face`, which
// monacoCssPlugin strips at build time because a shadow root ignores one
// anyway; the document stylesheet is what renders our codicons.
import monacoStyles from 'monaco-editor/min/vs/editor/editor.main.css?inline';
import * as prettier from 'prettier/standalone';
import * as prettierPluginBabel from 'prettier/plugins/babel';
import * as prettierPluginEstree from 'prettier/plugins/estree';
import {
  EDITOR_THEME_ID,
  EDITOR_TOKENS,
  buildEditorTheme,
} from '../services/editor-theme.js';
import { resolveWaColors } from '../services/wa-color.js';
import { resolveWaTypography } from '../services/wa-typography.js';

self.MonacoEnvironment = {
  getWorker(_: any, label: string) {
    if (label === 'json') return new jsonWorker();
    if (label === 'javascript' || label === 'typescript') return new tsWorker();
    return new editorWorker();
  }
};

@customElement('cca-monaco-editor')
export class CcaMonacoEditor extends LitElement {
  static styles = css`
    :host {
      display: block;
      width: 100%;
      height: 100%;
    }

    .editor-container {
      width: 100%;
      height: 100%;
      position: relative;
    }
  `;

  @property({ type: String }) value = '';
  @property({ type: String }) language = 'javascript';
  @property({ type: Boolean }) readOnly = false;
  @property({ type: Boolean }) diffMode = false;
  @property({ type: String }) originalValue = '';
  @property({ attribute: false }) completionProvider?: monaco.languages.CompletionItemProvider;
  private _themeObserver?: MutationObserver;
  /**
   * Cache key from the last `_applyTheme()` call that did real work — see
   * `_themeCacheKey()`. Starts `undefined` so the construction-time call always runs.
   */
  private _themeKey?: string;
  private containerRef: Ref<HTMLDivElement> = createRef();
  private editor?: monaco.editor.IStandaloneCodeEditor;
  private diffEditor?: monaco.editor.IStandaloneDiffEditor;
  private _originalModel?: monaco.editor.ITextModel;
  private _modifiedModel?: monaco.editor.ITextModel;
  private _suppressChange = false;
  private _completionDisposable?: monaco.IDisposable;
  private _resizeObserver?: ResizeObserver;

  private async formatWithPrettier(code: string): Promise<string> {
    try {
      // Check if it's a CouchDB function (starts with "function(" without a name)
      const isCouchDBFunction = /^\s*function\s*\(/.test(code);

      // Wrap in parentheses to make it a valid expression for Prettier
      const codeToFormat = isCouchDBFunction ? `(${code})` : code;

      const formatted = await prettier.format(codeToFormat, {
        parser: 'babel',
        plugins: [prettierPluginBabel, prettierPluginEstree],
        semi: true,
        singleQuote: false,
        tabWidth: 2,
        printWidth: 80
      });

      // Remove the wrapping parentheses and semicolon if we added them
      if (isCouchDBFunction) {
        return formatted
          .trim()
          .replace(/^\(/, '') // Remove leading (
          .replace(/\);?\s*$/, '') // Remove trailing ) and optional ;
          .trim();
      }

      return formatted;
    } catch {
      // If formatting fails, return original code unchanged
      return code;
    }
  }

  private _buildStandardEditor(container: HTMLDivElement) {
    const monacoTheme = this._applyTheme();

    this.editor = monaco.editor.create(container, {
      value: this.value,
      language: this.language,
      theme: monacoTheme,
      minimap: { enabled: false },
      automaticLayout: true,
      ...this._typographyOptions(),
      scrollBeyondLastLine: false,
      wordWrap: 'on',
      lineNumbers: 'on',
      glyphMargin: false,
      folding: true,
      lineDecorationsWidth: 0,
      lineNumbersMinChars: 3,
      wordBasedSuggestions: 'currentDocument',
      quickSuggestions: true,
      suggestOnTriggerCharacters: true,
      suggest: {
        showProperties: true,
        showKeywords: true,
        showWords: true,
        localityBonus: true
      },
      formatOnPaste: true,
      formatOnType: true,
      readOnly: this.readOnly
    });

    // Dispatch change events
    this.editor.onDidChangeModelContent(() => {
      if (this._suppressChange) return;
      const newValue = this.editor!.getValue();
      this.dispatchEvent(
        new CustomEvent('change', {
          detail: { value: newValue },
          bubbles: true,
          composed: true
        })
      );
    });

    // Format on paste
    this.editor.onDidPaste(() => {
      setTimeout(async () => {
        if (this.language === 'javascript' && this.editor) {
          const content = this.editor.getValue();
          const formatted = await this.formatWithPrettier(content);
          if (formatted !== content) {
            this._suppressChange = true;
            this.editor.setValue(formatted);
            this._suppressChange = false;
          }
        }
      }, 150);
    });

    // Format on blur
    this.editor.onDidBlurEditorText(() => {
      if (this.language === 'javascript' && this.editor) {
        const content = this.editor.getValue();
        if (content.trim().length > 0) {
          this.formatWithPrettier(content).then((formatted) => {
            if (formatted !== content && this.editor) {
              this._suppressChange = true;
              this.editor.setValue(formatted);
              this._suppressChange = false;
            }
          });
        }
      }
    });
  }

  private _buildDiffEditor(container: HTMLDivElement) {
    const monacoTheme = this._applyTheme();

    this.diffEditor = monaco.editor.createDiffEditor(container, {
      // Applies to the modified pane; the original one is held read-only by
      // `originalEditable` below regardless. This used to be a hardcoded `false`, so a user
      // without write access could switch to "Show Diff" and type into a pane whose contents
      // no Save button exists to persist (#6, item 15).
      readOnly: this.readOnly,
      originalEditable: false,
      renderSideBySide: true,
      automaticLayout: true,
      ...this._typographyOptions(),
      scrollBeyondLastLine: false,
      wordWrap: 'on',
      minimap: { enabled: false },
      ignoreTrimWhitespace: false,
      theme: monacoTheme
    });

    this._originalModel = monaco.editor.createModel(
      this.originalValue || this.value,
      this.language
    );
    this._modifiedModel = monaco.editor.createModel(this.value, this.language);

    this.diffEditor.setModel({
      original: this._originalModel,
      modified: this._modifiedModel
    });

    const modifiedEditor = this.diffEditor.getModifiedEditor();

    // Forward changes from the modified pane
    modifiedEditor.onDidChangeModelContent(() => {
      if (this._suppressChange) return;
      const newValue = modifiedEditor.getValue();
      this.dispatchEvent(
        new CustomEvent('change', {
          detail: { value: newValue },
          bubbles: true,
          composed: true
        })
      );
    });

    // Format on paste (modified pane)
    modifiedEditor.onDidPaste(() => {
      setTimeout(async () => {
        if (this.language === 'javascript' && this.diffEditor) {
          const content = modifiedEditor.getValue();
          const formatted = await this.formatWithPrettier(content);
          if (formatted !== content) {
            this._suppressChange = true;
            modifiedEditor.setValue(formatted);
            this._suppressChange = false;
          }
        }
      }, 150);
    });

    // Format on blur (modified pane)
    modifiedEditor.onDidBlurEditorText(() => {
      if (this.language === 'javascript' && this.diffEditor) {
        const content = modifiedEditor.getValue();
        if (content.trim().length > 0) {
          this.formatWithPrettier(content).then((formatted) => {
            if (formatted !== content && this.diffEditor) {
              this._suppressChange = true;
              modifiedEditor.setValue(formatted);
              this._suppressChange = false;
            }
          });
        }
      }
    });
  }

  private _teardown() {
    this._completionDisposable?.dispose();
    this._completionDisposable = undefined;

    this._originalModel?.dispose();
    this._modifiedModel?.dispose();
    this._originalModel = undefined;
    this._modifiedModel = undefined;

    this.diffEditor?.dispose();
    this.diffEditor = undefined;

    this.editor?.dispose();
    this.editor = undefined;

    this._resizeObserver?.disconnect();
    this._resizeObserver = undefined;
  }

  /**
   * The subset of `<html>`'s classes that actually affect the resolved theme, sorted so
   * that class order can never cause a spurious cache miss: `wa-dark` for appearance,
   * `wa-theme-*`/`wa-palette-*` for the active Web Awesome theme.
   *
   * Web Awesome also toggles unrelated classes on the same element — notably
   * `wa-scroll-lock`, added and removed by every `wa-dialog`/`wa-drawer` open and close
   * (`lockBodyScrolling`/`unlockBodyScrolling`) — which would otherwise defeat a cache
   * keyed on the whole `className`.
   */
  private _themeCacheKey(): string {
    const relevant: string[] = [];
    for (const cls of document.documentElement.classList) {
      if (cls === 'wa-dark' || cls.startsWith('wa-theme-') || cls.startsWith('wa-palette-')) {
        relevant.push(cls);
      }
    }
    return relevant.sort().join(',');
  }

  /**
   * Re-derives the editor theme from the active Web Awesome theme and applies it —
   * unless neither axis has actually changed since the last call, in which case this is
   * a cheap no-op.
   *
   * Called on every `class` mutation of `<html>`, which is how `theme-service` switches
   * *both* axes: `wa-dark` for appearance and `wa-theme-*`/`wa-palette-*` for the theme.
   * But the observer also fires on every unrelated `class` mutation of the same element
   * (see `_themeCacheKey()`), and without the cache each of those would still pay for a
   * fresh canvas readback, 11 forced style recalcs, and a `defineTheme` call that
   * re-renders every open Monaco editor on the page.
   *
   * Appearance is read directly off `<html>`'s `wa-dark` class rather than
   * `getEffectiveAppearance()` (which reads `localStorage` and `matchMedia`):
   * `theme-service.applyTheme()` derives `wa-dark` from that same function, so the class
   * *is* the actual determinant of what the tokens below resolve to. Reading it here
   * keeps a single source of truth and is what the cache key is built from.
   *
   * Tokens are resolved to hex here, at switch time, because Monaco's theme API takes
   * concrete hex and cannot consume CSS custom properties.
   *
   * Redefining the *active* theme re-applies it to every open editor
   * (`standaloneThemeService.defineTheme`), so no rebuild is needed.
   *
   * @returns the theme id, for use as `theme` in the editor's construction options
   */
  private _applyTheme(): string {
    const key = this._themeCacheKey();
    if (key === this._themeKey) return EDITOR_THEME_ID;
    this._themeKey = key;

    const appearance: 'light' | 'dark' = document.documentElement.classList.contains(
      'wa-dark'
    )
      ? 'dark'
      : 'light';
    const resolved = resolveWaColors(EDITOR_TOKENS);
    monaco.editor.defineTheme(
      EDITOR_THEME_ID,
      buildEditorTheme(appearance, resolved)
    );
    monaco.editor.setTheme(EDITOR_THEME_ID);

    // Type is part of the theme too (#774): the tokens the sizes and family resolve
    // from can differ per theme, so re-resolve on the same cache-miss that redefines
    // the colours. During construction neither editor exists yet and both calls no-op;
    // the construction path passes the same options to `create` instead.
    const typography = this._typographyOptions();
    this.editor?.updateOptions(typography);
    this.diffEditor?.updateOptions(typography);

    return EDITOR_THEME_ID;
  }

  /**
   * Monaco's slice of the active theme's typography, with the pre-#774 hardcode as the
   * size fallback. `fontFamily` is omitted when unresolved so Monaco's own default
   * stack stands in — an explicit `undefined` would still override it.
   */
  private _typographyOptions(): { fontSize: number; fontFamily?: string } {
    const { fontSize, fontFamily } = resolveWaTypography();
    return fontFamily === undefined
      ? { fontSize: fontSize ?? 14 }
      : { fontSize: fontSize ?? 14, fontFamily };
  }

  /**
   * Points Monaco at the current `completionProvider`, replacing any earlier registration.
   *
   * Registration is global (`monaco.languages`), keyed by language rather than by editor, but
   * its lifetime is tied to ours: `_teardown()` disposes it, so every path that tears down has
   * to come back through here. Both inputs it captures — the provider *and* `this.language` —
   * can change after mount, so a stale registration is a wrong-language one, not just an old
   * object.
   */
  private _registerCompletionProvider() {
    this._completionDisposable?.dispose();
    this._completionDisposable = undefined;
    if (!this.completionProvider) return;

    this._completionDisposable = monaco.languages.registerCompletionItemProvider(
      this.language,
      this.completionProvider
    );
  }

  private _observeResize(container: HTMLDivElement) {
    this._resizeObserver = new ResizeObserver(([entry]) => {
      if (this.diffMode && this.diffEditor) {
        const narrow = entry.contentRect.width < 500;
        this.diffEditor.updateOptions({ renderSideBySide: !narrow });
      } else if (!this.diffMode && this.editor) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          this.editor.layout({ width, height });
        }
      }
    });
    this._resizeObserver.observe(container);
  }

  /**
   * Brings the live editor in line with `diffMode`, building it if the right one is not up yet,
   * along with everything `_teardown()` disposes alongside it.
   *
   * Deliberately idempotent and driven by observed state rather than by a `changedProperties`
   * entry (#23). `updated()` runs immediately after `firstUpdated()` on the very first cycle,
   * with a `changedProperties` that holds every class-field initializer — Lit records an
   * initializer as a change from `undefined` — so a `changedProperties.has('diffMode')` test
   * fires on mount and rebuilt an editor that had just been built. Nor can `hasUpdated`
   * separate the two: Lit sets it *before* calling `firstUpdated()`, so it is already true in
   * `updated()`. Asking "is the editor `diffMode` calls for already up?" has no such blind
   * spot, and cannot be fooled by however Lit chooses to report the change.
   *
   * The `ResizeObserver` and the completion provider are (re)created here rather than once at
   * mount because `_teardown()` destroys them: leaving them behind is what disposed the view
   * editor's completion provider on every mount and never registered it again.
   *
   * @returns true when it (re)built — the caller can then skip reconciling properties, since a
   *   fresh editor already reflects all of them.
   */
  private _syncEditor(): boolean {
    const container = this.containerRef.value;
    if (!container) return false;
    if (this.diffMode ? this.diffEditor : this.editor) return false;

    this._teardown();
    if (this.diffMode) {
      this._buildDiffEditor(container);
    } else {
      this._buildStandardEditor(container);
    }
    this._observeResize(container);
    this._registerCompletionProvider();
    return true;
  }

  /**
   * Everything that belongs to the *element* rather than to a build of the editor.
   *
   * The editor itself is built by `updated()`, which Lit calls right after this on the same
   * cycle: one owner for the build puts mount and later `diffMode` toggles on the same path,
   * and is what stops the two from racing to build one each (#23).
   */
  firstUpdated() {
    // Watch for theme changes. Survives editor rebuilds; torn down in `disconnectedCallback`.
    this._themeObserver = new MutationObserver(() => {
      this._applyTheme();
    });
    this._themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class']
    });

    if (!this.diffMode) {
      setTimeout(async () => {
        this.editor?.layout();

        // Format the initial content with Prettier
        if (
          this.language === 'javascript' &&
          this.editor &&
          this.value.trim().length > 0
        ) {
          const formatted = await this.formatWithPrettier(this.value);
          if (formatted !== this.value) {
            this._suppressChange = true;
            this.editor.setValue(formatted);
            this._suppressChange = false;
          }
        }

        this.editor?.focus();
      }, 200);
    }
  }

  updated(changedProperties: Map<string, unknown>) {
    // Builds on mount and rebuilds on a `diffMode` toggle; a no-op otherwise. A freshly built
    // editor was handed every current property value at construction, so there is nothing
    // below for it to reconcile — models included.
    if (this._syncEditor()) return;

    // Whichever editor is live — exactly one of the two ever is. Handled here rather than
    // inside the per-mode branches below because it lived in the `!this.diffMode` one, so
    // the diff editor never heard about a `readOnly` that changed after it was built (#6,
    // item 15). A property this small has no business being mode-specific.
    if (changedProperties.has('readOnly')) {
      this.editor?.updateOptions({ readOnly: this.readOnly });
      this.diffEditor?.updateOptions({ readOnly: this.readOnly });
    }

    // Also mode-independent, and for the same reason as `readOnly` above: the registration is
    // global to `monaco.languages`, so it has no more business inside the `!diffMode` branch it
    // used to live in than `readOnly` did. `language` is an input to it, not just to the model —
    // a provider registered for `javascript` contributes nothing once the editor switches to
    // `json` (the "raw" toggle in the view editor does exactly that).
    if (
      changedProperties.has('completionProvider') ||
      changedProperties.has('language')
    ) {
      this._registerCompletionProvider();
    }

    if (!this.diffMode && this.editor) {
      if (changedProperties.has('language')) {
        const model = this.editor.getModel();
        if (model) {
          monaco.editor.setModelLanguage(model, this.language);
        }
      }

      // Update value if changed externally
      if (changedProperties.has('value')) {
        const newValue = typeof this.value === 'string' ? this.value : '';
        const currentValue = this.editor.getValue();

        if (newValue !== currentValue) {
          this._suppressChange = true;
          this.editor.setValue(newValue);
          this._suppressChange = false;

          // Auto-format after value change - only if there's content
          if (this.language === 'javascript' && newValue.trim().length > 0) {
            setTimeout(async () => {
              if (this.editor) {
                const formatted = await this.formatWithPrettier(newValue);
                if (formatted !== newValue) {
                  this._suppressChange = true;
                  this.editor.setValue(formatted);
                  this._suppressChange = false;
                }
              }
            }, 100);
          }
        }
      }
    }

    if (this.diffMode && this.diffEditor) {
      if (changedProperties.has('originalValue') && this._originalModel) {
        this._originalModel.setValue(this.originalValue);
      }
      if (changedProperties.has('value') && this._modifiedModel) {
        const newValue = typeof this.value === 'string' ? this.value : '';
        if (newValue !== this._modifiedModel.getValue()) {
          this._suppressChange = true;
          this._modifiedModel.setValue(newValue);
          this._suppressChange = false;
        }
      }
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._teardown();

    this._themeObserver?.disconnect();
    this._themeObserver = undefined;
  }

  /**
   * Get the current editor value
   */
  getValue(): string {
    if (this.diffMode && this.diffEditor) {
      return this.diffEditor.getModifiedEditor().getValue();
    }
    return this.editor?.getValue() ?? '';
  }

  /**
   * Set the editor value programmatically
   */
  setValue(value: string) {
    if (this.diffMode && this.diffEditor) {
      this._suppressChange = true;
      this.diffEditor.getModifiedEditor().setValue(value);
      this._suppressChange = false;
    } else if (this.editor) {
      this._suppressChange = true;
      this.editor.setValue(value);
      this._suppressChange = false;
    }
  }

  focus() {
    if (this.diffMode && this.diffEditor) {
      this.diffEditor.getModifiedEditor().focus();
    } else {
      this.editor?.focus();
    }
  }

  format() {
    if (this.diffMode && this.diffEditor) {
      this.diffEditor
        .getModifiedEditor()
        .getAction('editor.action.formatDocument')
        ?.run();
    } else {
      this.editor?.getAction('editor.action.formatDocument')?.run();
    }
  }

  render() {
    return html`
      <style>
        ${monacoStyles}
      </style>
      <div class="editor-container" ${ref(this.containerRef)}></div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'cca-monaco-editor': CcaMonacoEditor;
  }
}
