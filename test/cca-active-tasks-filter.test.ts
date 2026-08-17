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
import { WaTabShowEvent } from '@awesome.me/webawesome/dist/events/tab-show.js';
import { getContext } from '../src/context';
import type { ActiveTask } from '../src/plugins/server-mgmt/types';

import '../src/components/cca-header';
import '../src/plugins/server-mgmt/active-tasks';
import { POLL_INTERVAL_MS, type CcaActiveTasks } from '../src/plugins/server-mgmt/active-tasks';

let mounted: HTMLElement[] = [];

/** Drains the microtask queue the async load chain runs on. Never touches timers. */
async function settle(el: CcaActiveTasks) {
  for (let i = 0; i < 10; i++) {
    await el.updateComplete;
    await Promise.resolve();
  }
  await el.updateComplete;
}

async function mount(serverId = 'srv-1'): Promise<CcaActiveTasks> {
  const header = document.createElement('cca-header');
  document.body.appendChild(header);
  mounted.push(header);

  const el = document.createElement('cca-active-tasks') as CcaActiveTasks;
  el.serverId = serverId;
  document.body.appendChild(el);
  mounted.push(el);
  await settle(el);
  return el;
}

type Table = HTMLElement & { rows: Record<string, unknown>[] };
const table = (el: CcaActiveTasks) => el.shadowRoot!.querySelector('cca-data-table') as Table | null;
const rows = (el: CcaActiveTasks) => table(el)?.rows ?? [];

const filterInput = (el: CcaActiveTasks) =>
  el.shadowRoot!.querySelector('[data-filter]') as HTMLInputElement;

async function typeFilter(el: CcaActiveTasks, value: string) {
  const input = filterInput(el);
  (input as any).value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await el.updateComplete;
}

function selectTab(el: CcaActiveTasks, panel: string) {
  const group = el.shadowRoot!.querySelector('wa-tab-group');
  if (!group) throw new Error('no wa-tab-group rendered');
  const panels = [...el.shadowRoot!.querySelectorAll('wa-tab')].map((t) => t.getAttribute('panel'));
  expect(panels).toContain(panel);
  group.dispatchEvent(new WaTabShowEvent({ name: panel }));
}

const REPLICATION: ActiveTask = {
  node: 'couchdb@alpha',
  pid: '<0.686.0>',
  type: 'replication',
  started_on: 1783933280,
  updated_on: 1783940992,
  source: 'http://alpha:5984/dance/',
  target: 'http://bravo:5984/dance/',
  continuous: true,
  doc_id: null
};

const INDEXER: ActiveTask = {
  node: 'couchdb@alpha',
  pid: '<0.700.0>',
  type: 'indexer',
  started_on: 1783933280,
  updated_on: 1783940992,
  database: 'shards/00000000-1fffffff/shopping.1783933280',
  design_document: '_design/products',
  progress: 40
};

describe('cca-active-tasks client-side filter (#827)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(getContext().serverMgmt, 'getActiveTasks').mockResolvedValue([
      structuredClone(REPLICATION),
      structuredClone(INDEXER)
    ]);
  });

  afterEach(() => {
    vi.useRealTimers();
    for (const el of mounted) el.remove();
    mounted = [];
  });

  it('filters rows by source/target and by database, case-insensitively', async () => {
    const el = await mount();
    expect(rows(el).length).toBe(2);

    await typeFilter(el, 'DANCE');
    expect(rows(el).map((r) => r.type)).toEqual(['replication']);

    await typeFilter(el, 'shopping');
    expect(rows(el).map((r) => r.type)).toEqual(['indexer']);

    await typeFilter(el, '_design/products');
    expect(rows(el).map((r) => r.type)).toEqual(['indexer']);
  });

  it('composes with the type tabs', async () => {
    const el = await mount();
    selectTab(el, 'replication');
    await el.updateComplete;
    expect(rows(el).length).toBe(1);

    // a filter matching only the indexer yields nothing inside the replication tab
    await typeFilter(el, 'shopping');
    expect(rows(el).length).toBe(0);

    await typeFilter(el, 'dance');
    expect(rows(el).map((r) => r.type)).toEqual(['replication']);
  });

  it('clearing the filter restores every row', async () => {
    const el = await mount();
    await typeFilter(el, 'dance');
    expect(rows(el).length).toBe(1);

    filterInput(el).dispatchEvent(new CustomEvent('wa-clear', { bubbles: true }));
    await el.updateComplete;
    expect(rows(el).length).toBe(2);
  });

  it('survives a poll refresh', async () => {
    vi.useFakeTimers();
    const el = await mount();
    await typeFilter(el, 'dance');
    expect(rows(el).map((r) => r.type)).toEqual(['replication']);

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    await settle(el);

    expect((filterInput(el) as any).value ?? filterInput(el).getAttribute('value')).toBe('dance');
    expect(rows(el).map((r) => r.type)).toEqual(['replication']);
  });

  it('shows a no-match empty message distinct from the unfiltered one', async () => {
    const el = await mount();
    expect(table(el)!.getAttribute('empty-message')).toBe('No active tasks.');

    await typeFilter(el, 'zzz-no-such-task');
    expect(rows(el).length).toBe(0);
    expect(table(el)!.getAttribute('empty-message')).toBe('No matching tasks.');
  });

  it('names the filter for assistive technology via the wa-input label', async () => {
    const el = await mount();
    expect(filterInput(el).getAttribute('label')).toBe('Filter tasks');
  });
});
