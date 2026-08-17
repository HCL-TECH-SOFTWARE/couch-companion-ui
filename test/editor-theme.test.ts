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

import { describe, it, expect } from 'vitest';

import { collectDeclaredTokens } from '../eslint-rules/no-undefined-wa-token.js';
import {
  EDITOR_COLOR_TOKENS,
  EDITOR_THEME_ID,
  EDITOR_TOKENS,
  buildEditorTheme,
} from '../src/services/editor-theme';

/** Resolves every token to the same colour, so assertions can spot substitutions. */
const allResolved = (hex: string): Record<string, string> =>
  Object.fromEntries(EDITOR_TOKENS.map((token) => [token, hex]));

describe('EDITOR_COLOR_TOKENS', () => {
  // The `cca/no-undefined-wa-token` lint rule only scans CSS text — tagged `css`
  // templates and inline style strings. These tokens live in a TypeScript map, so the
  // rule never sees them and a typo would resolve to an inherited colour and merely
  // look *slightly* wrong. This test is the guard: check them against the same
  // declared-token set the lint rule uses.
  it('references only tokens Web Awesome actually declares', () => {
    const declared = collectDeclaredTokens();

    expect(declared.size).toBeGreaterThan(300);
    for (const token of EDITOR_TOKENS) {
      expect(declared.has(token), `${token} is not declared by Web Awesome`).toBe(true);
    }
  });

  it('lists each token once, covering every mapped colour', () => {
    expect(EDITOR_TOKENS).toHaveLength(new Set(EDITOR_TOKENS).size);
    expect(new Set(EDITOR_TOKENS)).toEqual(new Set(Object.values(EDITOR_COLOR_TOKENS)));
  });
});

describe('buildEditorTheme', () => {
  it('uses a Monaco-legal theme id', () => {
    expect(EDITOR_THEME_ID).toMatch(/^[a-z0-9-]+$/i);
  });

  it('flips base with appearance', () => {
    expect(buildEditorTheme('dark', {}).base).toBe('vs-dark');
    expect(buildEditorTheme('light', {}).base).toBe('vs');
  });

  it('inherits the base theme so syntax colours stay stock', () => {
    const theme = buildEditorTheme('light', {});

    expect(theme.inherit).toBe(true);
    expect(theme.rules).toEqual([]);
  });

  it('maps resolved hex onto the Monaco colour IDs', () => {
    const theme = buildEditorTheme('dark', allResolved('#123456'));

    expect(theme.colors['editor.background']).toBe('#123456');
    expect(theme.colors['editorLineNumber.foreground']).toBe('#123456');
  });

  it('makes the diff backgrounds translucent', () => {
    const theme = buildEditorTheme('dark', allResolved('#123456'));

    expect(theme.colors['diffEditor.insertedLineBackground']).toBe('#12345666');
    expect(theme.colors['diffEditor.removedLineBackground']).toBe('#12345666');
    expect(theme.colors['diffEditor.insertedTextBackground']).toBe('#12345666');
    expect(theme.colors['diffEditor.removedTextBackground']).toBe('#12345666');
  });

  it('falls back to the legacy palette for an unresolved token', () => {
    // Every token resolves except the one behind `editor.background`.
    const resolved = allResolved('#123456');
    delete resolved[EDITOR_COLOR_TOKENS['editor.background']];

    const dark = buildEditorTheme('dark', resolved);
    const light = buildEditorTheme('light', resolved);

    expect(dark.colors['editor.background']).toBe('#0f1729');
    expect(light.colors['editor.background']).toBe('#ffffff');
    // The tokens that *did* resolve are untouched.
    expect(dark.colors['editorWidget.background']).toBe('#123456');
  });

  it('falls back wholesale when nothing resolves', () => {
    // This is the no-canvas path: the editor must look exactly as it did before #742,
    // never like a Monaco parse failure (which paints it bright red).
    const theme = buildEditorTheme('dark', {});

    expect(theme.colors['editor.background']).toBe('#0f1729');
    expect(theme.colors['editorLineNumber.foreground']).toBe('#4a5f7f');
  });

  it('emits only Monaco-parseable hex, in both appearances', () => {
    for (const appearance of ['light', 'dark'] as const) {
      const theme = buildEditorTheme(appearance, {});

      for (const [id, value] of Object.entries(theme.colors)) {
        expect(value, `${appearance} ${id} must be #rrggbb or #rrggbbaa`).toMatch(
          /^#[0-9a-f]{6}([0-9a-f]{2})?$/i,
        );
      }
    }
  });

  it('replaces rather than appends alpha when the resolved token is already translucent', () => {
    // `resolveWaColors` can hand back a token that already carries its own alpha
    // (e.g. a token defined with partial transparency). Appending `TRANSLUCENT_ALPHA`
    // to that would produce a 10-character string Monaco cannot parse.
    const resolved = allResolved('#12345680');

    const theme = buildEditorTheme('dark', resolved);

    expect(theme.colors['diffEditor.insertedLineBackground']).toBe('#12345666');
    expect(theme.colors['diffEditor.insertedLineBackground']).toHaveLength(9);
  });
});
