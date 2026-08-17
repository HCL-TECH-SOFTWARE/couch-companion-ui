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

// Type-only: this module must stay free of Monaco at runtime so it can be unit-tested
// under happy-dom, where importing Monaco crashes on canvas pixel-ratio.
import type * as monaco from 'monaco-editor/editor';

/** The one theme id. Redefining the *active* theme is what re-styles live editors. */
export const EDITOR_THEME_ID = 'cca-editor';

/**
 * Monaco colour ID → the Web Awesome token that drives it.
 *
 * Chrome only. `rules: []` with `inherit: true` leaves syntax highlighting to stock
 * `vs` / `vs-dark`: Web Awesome ships semantic ramps (brand/neutral/success/…), not a
 * syntax palette, and deriving one per theme risks contrast regressions.
 *
 * These names are checked against the real Web Awesome token set in
 * `test/editor-theme.test.ts` — the `cca/no-undefined-wa-token` lint rule cannot see
 * them, because it only scans CSS text.
 */
export const EDITOR_COLOR_TOKENS = {
  'editor.background': '--wa-color-surface-default',
  'editorGutter.background': '--wa-color-surface-default',
  'editor.foreground': '--wa-color-text-normal',
  'editor.lineHighlightBackground': '--wa-color-surface-lowered',
  'editorLineNumber.foreground': '--wa-color-text-quiet',
  'editorLineNumber.activeForeground': '--wa-color-text-normal',
  'editor.selectionBackground': '--wa-color-brand-fill-quiet',
  'editor.inactiveSelectionBackground': '--wa-color-neutral-fill-quiet',
  'editorCursor.foreground': '--wa-color-brand-fill-loud',
  'editorWidget.background': '--wa-color-surface-raised',
  'editorWidget.border': '--wa-color-surface-border',
  'editorIndentGuide.background1': '--wa-color-surface-border',
  // The LINE background is the broad wash over a whole changed line, so it uses the
  // *normal* fill. The TEXT background is the character-level emphasis layered on top of
  // that wash, so it uses the stronger *loud* fill — using the same token for both
  // would make the inline word-diff emphasis invisible. (The *quiet* fill was tried and
  // measured too faint to read; see the TRANSLUCENT_ALPHA comment below.)
  'diffEditor.insertedLineBackground': '--wa-color-success-fill-normal',
  'diffEditor.removedLineBackground': '--wa-color-danger-fill-normal',
  'diffEditor.insertedTextBackground': '--wa-color-success-fill-loud',
  'diffEditor.removedTextBackground': '--wa-color-danger-fill-loud',
} as const;

/**
 * Every Monaco colour ID this module fills in. Deriving this from
 * {@link EDITOR_COLOR_TOKENS} (rather than typing `FALLBACK_COLORS` against a bare
 * `Record<string, string>`) turns a colour ID that is missing from one of the fallback
 * blocks into a `npm run typecheck` failure instead of a runtime `undefined` reaching
 * Monaco's `Color.fromHex`, which throws and takes the whole editor down with it.
 */
export type EditorColorId = keyof typeof EDITOR_COLOR_TOKENS;

/** The distinct tokens to resolve. Feed to `resolveWaColors`. */
export const EDITOR_TOKENS: readonly string[] = [
  ...new Set(Object.values(EDITOR_COLOR_TOKENS)),
];

/**
 * Diff backgrounds sit *behind* the code, so they must stay translucent — VS Code's own
 * guidance is that these colours "must not be opaque so as not to hide underlying
 * decorations" such as the selection, the current-line highlight, and bracket-match
 * highlighting. Solid colour is therefore not an option; only the token and the alpha
 * can move.
 *
 * A first pass used the *quiet* fill at 20% alpha (`33`). Measured in a real browser
 * across all six theme × appearance combinations, that composited to a max channel
 * delta of only 3–9 from the editor background — invisible. The *normal* and *loud*
 * fills at 40% alpha (`66`) measured 16–102, a readable wash with a visibly stronger
 * character-level emphasis on top. Monaco accepts `#RRGGBBAA`.
 */
const TRANSLUCENT: ReadonlySet<EditorColorId> = new Set([
  'diffEditor.insertedLineBackground',
  'diffEditor.removedLineBackground',
  'diffEditor.insertedTextBackground',
  'diffEditor.removedTextBackground',
]);
const TRANSLUCENT_ALPHA = '66';

/**
 * Applies {@link TRANSLUCENT_ALPHA} to a colour that needs it, **replacing** any alpha
 * the colour already carries rather than appending to it. `resolveWaColors` can now
 * return an already-translucent `#rrggbbaa` (see `wa-color.ts`) as well as an opaque
 * `#rrggbb`; blindly appending would turn either into a 10-character string, which
 * Monaco cannot parse. Slicing to the first 7 characters (`#rrggbb`) before appending
 * is a no-op on an already-6-digit fallback and strips a pre-existing alpha on a
 * resolved value, so both the fallback path and the resolved path run through this one
 * function — the {@link TRANSLUCENT_ALPHA} constant is applied in exactly one place.
 */
function applyAlpha(colorId: EditorColorId, hex: string): string {
  return TRANSLUCENT.has(colorId) ? `${hex.slice(0, 7)}${TRANSLUCENT_ALPHA}` : hex;
}

/**
 * The palette from before #742, kept as a safety net.
 *
 * Stored as plain, opaque `#rrggbb` — never pre-mixed with {@link TRANSLUCENT_ALPHA} —
 * so {@link applyAlpha} is the single place that constant is used; changing it cannot
 * leave a fallback behind.
 *
 * Typed against {@link EditorColorId} rather than a bare `Record<string, string>`: a
 * colour ID missing from one of these blocks is now a `npm run typecheck` failure. Left
 * untyped, the same gap would surface at runtime as `colors[colorId] = undefined`, and
 * Monaco's `Color.fromHex(undefined)` throws a `TypeError` out of `defineTheme` —
 * worse than the un-themed fallback this table exists to provide.
 */
const FALLBACK_COLORS: Record<'light' | 'dark', Record<EditorColorId, string>> = {
  dark: {
    'editor.background': '#0f1729',
    'editorGutter.background': '#0f1729',
    'editor.foreground': '#e2e8f0',
    'editor.lineHighlightBackground': '#1a2332',
    'editorLineNumber.foreground': '#4a5f7f',
    'editorLineNumber.activeForeground': '#7a8fb8',
    'editor.selectionBackground': '#2a3f5f',
    'editor.inactiveSelectionBackground': '#1f2d42',
    'editorCursor.foreground': '#7a8fb8',
    'editorWidget.background': '#1a2332',
    'editorWidget.border': '#2a3f5f',
    'editorIndentGuide.background1': '#2a3f5f',
    'diffEditor.insertedLineBackground': '#3fb950',
    'diffEditor.removedLineBackground': '#f85149',
    'diffEditor.insertedTextBackground': '#3fb950',
    'diffEditor.removedTextBackground': '#f85149',
  },
  light: {
    'editor.background': '#ffffff',
    'editorGutter.background': '#ffffff',
    'editor.foreground': '#1a202c',
    'editor.lineHighlightBackground': '#f7fafc',
    'editorLineNumber.foreground': '#a0aec0',
    'editorLineNumber.activeForeground': '#4a5568',
    'editor.selectionBackground': '#e2e8f0',
    'editor.inactiveSelectionBackground': '#edf2f7',
    'editorCursor.foreground': '#4a5568',
    'editorWidget.background': '#ffffff',
    'editorWidget.border': '#e2e8f0',
    'editorIndentGuide.background1': '#e2e8f0',
    'diffEditor.insertedLineBackground': '#2ea043',
    'diffEditor.removedLineBackground': '#cf222e',
    'diffEditor.insertedTextBackground': '#2ea043',
    'diffEditor.removedTextBackground': '#cf222e',
  },
};

/**
 * Builds the Monaco theme for the active appearance from already-resolved tokens.
 *
 * @param appearance which base theme to inherit from
 * @param resolved   token → `#rrggbb`/`#rrggbbaa`, as returned by `resolveWaColors`.
 *                   Missing keys fall back to {@link FALLBACK_COLORS}.
 */
export function buildEditorTheme(
  appearance: 'light' | 'dark',
  resolved: Record<string, string>
): monaco.editor.IStandaloneThemeData {
  const fallback = FALLBACK_COLORS[appearance];
  const colors: Record<string, string> = {};

  for (const [colorId, token] of Object.entries(EDITOR_COLOR_TOKENS) as [
    EditorColorId,
    string,
  ][]) {
    const hex = resolved[token] ?? fallback[colorId];
    colors[colorId] = applyAlpha(colorId, hex);
  }

  return {
    base: appearance === 'dark' ? 'vs-dark' : 'vs',
    inherit: true,
    rules: [],
    colors,
  };
}
