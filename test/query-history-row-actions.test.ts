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
import { CcaQueryHistory } from '../src/plugins/db-mgmt/query_history';
import '../src/plugins/db-mgmt/query_history';
import type { SavedQuerySnapshot } from '../src/plugins/db-mgmt/types';

let mounted: HTMLElement[] = [];

async function mount(): Promise<CcaQueryHistory> {
  const el = document.createElement('cca-query-history') as CcaQueryHistory;
  el.dbName = 'testdb';
  el.serverId = 'srv-1';
  const entry: SavedQuerySnapshot = {
    id: 'q1',
    db_name: 'testdb',
    selected_server_id: 'srv-1',
    selectorJson: '{"_id":{"$gt":null}}',
    fields: [],
    sortItems: [],
    scope: 'raw',
    savedAt: new Date().toISOString(),
  };
  (el as unknown as { history: SavedQuerySnapshot[] }).history = [entry];
  document.body.appendChild(el);
  mounted.push(el);
  await el.updateComplete;
  // Open the history dropdown (a private @state) so its row actions render.
  (el as unknown as { _showHistory: boolean })._showHistory = true;
  await el.updateComplete;
  return el;
}

afterEach(() => {
  for (const el of mounted) el.remove();
  mounted = [];
});

describe('cca-query-history row actions (#112)', () => {
  it('gives both Rename and Delete the shared outlined/row-action-button treatment', async () => {
    const el = await mount();
    const buttons = [
      ...el.shadowRoot!.querySelectorAll('.history-item-actions wa-button'),
    ] as HTMLElement[];

    expect(buttons.length).toBe(2);
    for (const btn of buttons) {
      expect(btn.getAttribute('appearance')).toBe('outlined');
      expect(btn.classList.contains('row-action-button')).toBe(true);
    }
  });

  it('does not touch the standalone "Saved Queries" toggle button', async () => {
    const el = await mount();
    const toggle = [...el.shadowRoot!.querySelectorAll('wa-button')].find(
      (b) => !b.closest('.history-item-actions'),
    )!;

    expect(toggle.classList.contains('row-action-button')).toBe(false);
  });

  it('repeats ".history-item:hover" in the button-hover rule so it outranks the row-hover rule', () => {
    // Same specificity trap #110 shipped once: dropping the ".history-item:hover" prefix
    // would make this selector LESS specific than the row-hover rule above it, and lose
    // the cascade every time the button is actually hovered (hovering it also satisfies
    // ".history-item:hover" on its own ancestor).
    const styles = CcaQueryHistory.styles;
    const list = Array.isArray(styles) ? styles : [styles];
    const css = list.map((s) => (s as { cssText: string }).cssText).join('\n');
    expect(css).toMatch(
      /\.history-item:hover\s+\.row-action-button::part\(base\):hover\s*\{[^}]*background-color:\s*var\(--wa-color-fill-loud/,
    );
  });
});
