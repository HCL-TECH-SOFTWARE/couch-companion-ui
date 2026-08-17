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

import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import '../src/components/cca-data-table';

const here = dirname(fileURLToPath(import.meta.url));

async function mountTable(columns: unknown[], rows: unknown[]): Promise<any> {
  const el = document.createElement('cca-data-table') as any;
  el.columns = columns;
  el.rows = rows;
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

afterEach(() => {
  document.body.querySelectorAll('cca-data-table').forEach((e) => e.remove());
});

describe('cca-data-table aria-sort (#829)', () => {
  const rows = [{ name: 'a', url: 'u' }];

  it('stamps aria-sort on the column that declares it and omits it elsewhere', async () => {
    const el = await mountTable(
      [
        { label: 'Name', key: 'name', ariaSort: 'ascending' },
        { label: 'URL', key: 'url' }
      ],
      rows
    );
    const ths = el.shadowRoot!.querySelectorAll('th');
    expect(ths[0].getAttribute('aria-sort')).toBe('ascending');
    expect(ths[1].hasAttribute('aria-sort')).toBe(false);
  });

  it('reflects a descending value', async () => {
    const el = await mountTable([{ label: 'Name', key: 'name', ariaSort: 'descending' }], rows);
    expect(el.shadowRoot!.querySelector('th')!.getAttribute('aria-sort')).toBe('descending');
  });
});

describe('cca-data-table row-action-button hover treatment (#106)', () => {
  // Can't drive a real :hover in happy-dom, and a column's render() output composes
  // into THIS shadow root rather than the caller's own (see cca-data-table.ts's
  // _cell()/render()), so the CSS enabling this has to live in this component's own
  // styles rather than a caller's — this asserts that rule actually shipped, not just
  // that a caller wired the opt-in class/appearance.
  function cssText(): string {
    // cca-data-table's own styles are a constructed CSSStyleSheet (replaceSync), so
    // there's no CSSResult .cssText to read back, and happy-dom's CSSOM parser drops
    // ::part() rules silently rather than exposing them via cssRules — reading the
    // source file directly sidesteps both.
    return readFileSync(join(here, '..', 'src', 'components', 'cca-data-table.ts'), 'utf8');
  }

  it('nudges a row-action-button toward filled-outlined when the row is hovered', () => {
    expect(cssText()).toMatch(/tr:hover\s+\.row-action-button::part\(base\)\s*\{[^}]*background-color:\s*var\(--wa-color-fill-normal/);
  });

  it('goes further to accent when the button itself is hovered, at higher specificity than the row-hover rule', () => {
    // The "tr:hover" prefix must be repeated here, not dropped: hovering the button also
    // satisfies "tr:hover" on its own ancestor row, so both this rule and the row-hover
    // rule above match every time a button is hovered. Without the repeated prefix, this
    // selector has one fewer type selector (no "tr") than the row-hover rule, loses the
    // specificity comparison, and the button-hover state never actually renders — which
    // is exactly what shipped and was reported broken.
    expect(cssText()).toMatch(/tr:hover\s+\.row-action-button::part\(base\):hover\s*\{[^}]*background-color:\s*var\(--wa-color-fill-loud/);
  });
});
