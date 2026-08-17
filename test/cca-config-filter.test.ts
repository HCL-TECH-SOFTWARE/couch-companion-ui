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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getContext } from '../src/context';

import '../src/components/cca-header';
import '../src/plugins/config/cca-config';
import type { CcaConfig } from '../src/plugins/config/cca-config';

let mounted: HTMLElement[] = [];

async function mount(serverId = 'srv-1'): Promise<CcaConfig> {
  const header = document.createElement('cca-header');
  document.body.appendChild(header);
  mounted.push(header);

  const el = document.createElement('cca-config') as CcaConfig;
  el.serverId = serverId;
  document.body.appendChild(el);
  mounted.push(el);
  await el.updateComplete;
  await new Promise((r) => setTimeout(r, 0));
  await el.updateComplete;
  return el;
}

const table = (el: CcaConfig) =>
  el.shadowRoot!.querySelector('cca-data-table') as HTMLElement & {
    rows: Record<string, unknown>[];
    updateComplete: Promise<unknown>;
  };

const filterInput = (el: CcaConfig) =>
  el.shadowRoot!.querySelector('[data-filter]') as HTMLInputElement;

async function typeFilter(el: CcaConfig, value: string) {
  const input = filterInput(el);
  (input as any).value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await el.updateComplete;
}

const CONFIG = {
  chttpd: { port: '5984', bind_address: 'any' },
  cors: { origins: '*' },
  log: { level: 'info' }
};

describe('cca-config client-side filter (#827)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(getContext().serverMgmt, 'listServers').mockResolvedValue({
      servers: [{ id: 'srv-1', name: 'Alpha', url: 'http://a' }]
    } as never);
    vi.spyOn(getContext().config, 'getConfig').mockResolvedValue(structuredClone(CONFIG));
  });

  afterEach(() => {
    for (const el of mounted) el.remove();
    mounted = [];
  });

  it('filters rows by section name, recomputing the section-group flag', async () => {
    const el = await mount();
    expect(table(el).rows.length).toBe(4);

    await typeFilter(el, 'cors');
    expect(table(el).rows).toEqual([
      { section: 'cors', key: 'origins', value: '*', _first: true }
    ]);
  });

  it('filters rows by option key and by value, case-insensitively', async () => {
    const el = await mount();

    await typeFilter(el, 'PORT');
    expect(table(el).rows.map((r) => r.key)).toEqual(['port']);
    // the surviving row heads its (now single-row) section group
    expect(table(el).rows[0]._first).toBe(true);

    await typeFilter(el, 'info');
    expect(table(el).rows.map((r) => r.key)).toEqual(['level']);
  });

  it('clearing the filter restores every row', async () => {
    const el = await mount();
    await typeFilter(el, 'cors');
    expect(table(el).rows.length).toBe(1);

    filterInput(el).dispatchEvent(new CustomEvent('wa-clear', { bubbles: true }));
    await el.updateComplete;
    expect(table(el).rows.length).toBe(4);
  });

  it('shows a no-match empty message distinct from the unfiltered one', async () => {
    const el = await mount();
    expect(table(el).getAttribute('empty-message')).toBe('No configuration entries.');

    await typeFilter(el, 'zzz-no-such-entry');
    expect(table(el).rows.length).toBe(0);
    expect(table(el).getAttribute('empty-message')).toBe('No matching configuration entries.');
  });

  it('names the filter for assistive technology via the wa-input label', async () => {
    const el = await mount();
    expect(filterInput(el).getAttribute('label')).toBe('Filter configuration');
  });
});
