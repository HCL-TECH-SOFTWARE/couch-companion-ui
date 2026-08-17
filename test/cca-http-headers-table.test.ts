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
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CcaHttpHeadersTable } from '../src/components/cca-http-headers-table';
import '../src/components/cca-http-headers-table';
import type { HttpHeaderRow } from '../src/components/cca-http-headers-table';

/**
 * Dark-mode token hygiene (#635).
 *
 * The component drives every color from a `--wa-color-*` token with no
 * hardcoded fallback. A fallback is a light-mode color, so any reference to a
 * token WebAwesome does not actually define silently renders that light color
 * in `wa-dark` (this is exactly how `--wa-color-surface-quiet` — which does not
 * exist — pinned the auth helper to near-white in dark mode). These guards fail
 * CI if either regression is reintroduced.
 */

const here = dirname(fileURLToPath(import.meta.url));
const WA_STYLES_DIR = join(
  here,
  '..',
  'node_modules',
  '@awesome.me',
  'webawesome',
  'dist',
  'styles',
);

function cssFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...cssFilesUnder(full));
    else if (entry.name.endsWith('.css')) out.push(full);
  }
  return out;
}

/** Every `--wa-color-*` custom property WebAwesome actually declares. */
function declaredWaColorTokens(): Set<string> {
  const declared = new Set<string>();
  for (const file of cssFilesUnder(WA_STYLES_DIR)) {
    const css = readFileSync(file, 'utf8');
    for (const match of css.matchAll(/(--wa-color-[a-z0-9-]+)\s*:/g)) {
      declared.add(match[1]);
    }
  }
  return declared;
}

function componentCssText(): string {
  const styles = CcaHttpHeadersTable.styles;
  const list = Array.isArray(styles) ? styles : [styles];
  return list.map((s) => (s as { cssText: string }).cssText).join('\n');
}

const CSS = componentCssText();
const DECLARED = declaredWaColorTokens();

describe('cca-http-headers-table dark-mode token hygiene', () => {
  it('locates the WebAwesome token declarations (guards against a bad path)', () => {
    expect(DECLARED.size).toBeGreaterThan(50);
  });

  it('references at least one --wa-color-* token (guards against a vacuous pass)', () => {
    const referenced = [...CSS.matchAll(/--wa-color-[a-z0-9-]+/g)];
    expect(referenced.length).toBeGreaterThan(0);
  });

  it('references only --wa-color-* tokens that WebAwesome defines', () => {
    const referenced = new Set(
      [...CSS.matchAll(/--wa-color-[a-z0-9-]+/g)].map((m) => m[0]),
    );
    const undefinedTokens = [...referenced].filter((t) => !DECLARED.has(t));
    expect(undefinedTokens).toEqual([]);
  });

  it('uses no hardcoded color fallbacks — colors come from tokens only', () => {
    const withFallback = [
      ...CSS.matchAll(/var\(\s*--wa-color-[a-z0-9-]+\s*,[^)]*\)/g),
    ].map((m) => m[0]);
    expect(withFallback).toEqual([]);
  });
});

/**
 * grid-only mode (#635).
 *
 * When embedded in `cca-repl-auth-panel`, the parent already owns auth-mode
 * selection and only wants the editable key/value grid. Without `grid-only`,
 * the component re-derives its own mode from the seeded headers; empty headers
 * derive to "none", which hides the `<table>` entirely — so the grid never
 * shows in the dialog's Custom-headers mode.
 */
async function mountTable(opts: {
  gridOnly?: boolean;
  headers?: HttpHeaderRow[];
}): Promise<CcaHttpHeadersTable> {
  const el = document.createElement(
    'cca-http-headers-table',
  ) as CcaHttpHeadersTable;
  if (opts.gridOnly) el.setAttribute('grid-only', '');
  if (opts.headers) el.headers = opts.headers;
  document.body.appendChild(el);
  await el.updateComplete;
  // firstUpdated() sets reactive state, scheduling a second render.
  await el.updateComplete;
  return el;
}

function shadow(el: CcaHttpHeadersTable): ShadowRoot {
  if (!el.shadowRoot) throw new Error('expected shadowRoot');
  return el.shadowRoot;
}

describe('cca-http-headers-table grid-only mode', () => {
  it('renders the editable grid even with an empty seeded row', async () => {
    const el = await mountTable({
      gridOnly: true,
      headers: [{ enabled: true, key: '', value: '' }],
    });
    const root = shadow(el);
    expect(root.querySelector('table')).not.toBeNull();
    // the redundant inner auth-mode selector is hidden
    expect(root.querySelector('.mode-row')).toBeNull();
  });

  it('drops the card/header chrome (no duplicate title, no Hide toggle)', async () => {
    const el = await mountTable({
      gridOnly: true,
      headers: [{ enabled: true, key: '', value: '' }],
    });
    const root = shadow(el);
    expect(root.querySelector('.section')).toBeNull();
    expect(root.querySelector('.section-header')).toBeNull();
    expect(root.querySelector('.summary')).toBeNull();
  });

  it('renders the row remove control as a trash icon', async () => {
    const el = await mountTable({
      gridOnly: true,
      headers: [{ enabled: true, key: 'Accept', value: 'application/json' }],
    });
    const removeBtn = shadow(el).querySelector('.remove-btn');
    expect(removeBtn).not.toBeNull();
    expect(removeBtn?.textContent?.trim()).toBe('');
    expect(
      shadow(el).querySelector('.remove-btn wa-icon[name="trash-can"]'),
    ).not.toBeNull();
  });

  it('renders the grid for pre-populated custom headers', async () => {
    const el = await mountTable({
      gridOnly: true,
      headers: [
        { enabled: true, key: 'Accept', value: 'application/json' },
        { enabled: true, key: 'X-Foo', value: 'bar' },
      ],
    });
    const rows = shadow(el).querySelectorAll('tbody tr');
    expect(rows.length).toBe(2);
  });

  it('without grid-only, empty headers still derive to "none" and hide the grid', async () => {
    const el = await mountTable({
      headers: [{ enabled: true, key: '', value: '' }],
    });
    const root = shadow(el);
    expect(root.querySelector('table')).toBeNull();
    expect(root.querySelector('.mode-row')).not.toBeNull();
  });
});
