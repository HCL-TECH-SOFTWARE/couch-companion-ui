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
import { ApiError } from '../src/services/api-error';
import type { ActiveTask, Server } from '../src/plugins/server-mgmt/types';

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

type Table = HTMLElement & {
  rows: Record<string, unknown>[];
  columns: { label: string }[];
};

const table = (el: CcaActiveTasks) => el.shadowRoot!.querySelector('cca-data-table') as Table | null;
const rows = (el: CcaActiveTasks) => table(el)?.rows ?? [];
const labels = (el: CcaActiveTasks) => (table(el)?.columns ?? []).map((c) => c.label);
const tabs = (el: CcaActiveTasks) =>
  [...el.shadowRoot!.querySelectorAll('wa-tab')].map((t) => t.textContent!.trim());

/**
 * Selects a type tab the way a real click does.
 *
 * `wa-tab-group` binds its click handler to a `<div>` inside its *own shadow root*, and
 * happy-dom does not run shadow-tree listeners for a click on a slotted light-DOM child
 * (verified: the click reaches the host, `wa-tab-show` is never emitted). So a
 * `waTab.click()` here would assert nothing.
 *
 * Instead we dispatch `WaTabShowEvent` — imported from Web Awesome, not hand-rolled. It is
 * the very class `wa-tab-group.setActiveTab()` constructs and dispatches on itself
 * (`new WaTabShowEvent({ name: activeTab.panel })`, bubbling and composed), so the payload
 * and the event name cannot drift from the real component without this import breaking.
 */
function selectTab(el: CcaActiveTasks, panel: string) {
  const group = el.shadowRoot!.querySelector('wa-tab-group');
  if (!group) throw new Error('no wa-tab-group rendered');
  // The tab must actually exist — otherwise the test proves nothing about the UI.
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
  docs_read: 3,
  docs_written: 3,
  doc_write_failures: 0,
  // Nullable in the schema — must render, not crash.
  changes_pending: null,
  doc_id: null,
  user: null
};

const INDEXER: ActiveTask = {
  node: 'couchdb@alpha',
  pid: '<0.700.0>',
  type: 'indexer',
  started_on: 1783933280,
  updated_on: 1783940992,
  database: 'dance',
  design_document: '_design/steps',
  progress: 42,
  changes_done: 10,
  total_changes: 24
};

const SERVERS = [
  { id: 'srv-1', name: 'Alpha' },
  { id: 'srv-2', name: 'Bravo' }
] as unknown as Server[];

function mockServers(servers: Server[] = SERVERS) {
  return vi
    .spyOn(getContext().serverMgmt, 'listServers')
    .mockResolvedValue({ servers, nextBookmark: '' });
}

/** Per-server active-tasks stub: a rejected value throws for that server only. */
function mockTasks(byServer: Record<string, ActiveTask[] | Error>) {
  return vi.spyOn(getContext().serverMgmt, 'getActiveTasks').mockImplementation((id: string) => {
    const v = byServer[id];
    if (v instanceof Error) return Promise.reject(v);
    return Promise.resolve(v ?? []);
  });
}

describe('cca-active-tasks', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockServers();
  });

  afterEach(() => {
    for (const el of mounted) el.remove();
    mounted = [];
    vi.useRealTimers();
  });

  describe('single server', () => {
    it('renders one row per task for the routed server', async () => {
      const get = mockTasks({ 'srv-1': [REPLICATION, INDEXER] });
      const el = await mount('srv-1');

      expect(get).toHaveBeenCalledWith('srv-1');
      expect(rows(el)).toHaveLength(2);
      // Scoped to one server, so the Server column is pointless and must be absent.
      expect(labels(el)).not.toContain('Server');
      expect(labels(el)).toEqual(['Type', 'Node', 'Database', 'Started', 'Updated']);
    });

    it('renders started_on as a relative time from Unix seconds', async () => {
      mockTasks({ 'srv-1': [INDEXER] });
      const el = await mount('srv-1');

      const time = table(el)!.shadowRoot!.querySelector('wa-relative-time');
      // 1783933280 s -> ms. A ms-vs-s mix-up would put this in the year 58k.
      expect(time?.getAttribute('date')).toBe(new Date(1783933280 * 1000).toISOString());
    });
  });

  describe('$all', () => {
    it('fans out over every server and adds the Server column', async () => {
      const get = mockTasks({ 'srv-1': [REPLICATION], 'srv-2': [INDEXER] });
      const el = await mount('$all');

      expect(get).toHaveBeenCalledWith('srv-1');
      expect(get).toHaveBeenCalledWith('srv-2');
      expect(rows(el)).toHaveLength(2);
      expect(labels(el)[0]).toBe('Server');
      expect(rows(el).map((r) => r._serverName)).toEqual(['Alpha', 'Bravo']);
    });

    it('an unreachable server does not blank the table', async () => {
      mockTasks({ 'srv-1': [REPLICATION], 'srv-2': new ApiError(502, 'connection refused') });
      const el = await mount('$all');

      // The healthy server's rows survive...
      expect(rows(el)).toHaveLength(1);
      expect(rows(el)[0]._serverId).toBe('srv-1');
      // ...the failure is a non-fatal inline warning, naming the server...
      const warning = el.shadowRoot!.querySelector('[data-warning]');
      expect(warning).not.toBeNull();
      expect(warning!.textContent).toContain('Bravo');
      expect(warning!.textContent).toContain('connection refused');
      // ...and the page is NOT in an error state.
      expect(el.shadowRoot!.querySelector('[data-error]')).toBeNull();
    });

    it('follows the bookmark so servers past the first page are included', async () => {
      const list = vi
        .spyOn(getContext().serverMgmt, 'listServers')
        .mockResolvedValueOnce({ servers: [SERVERS[0]], nextBookmark: 'page-2' })
        .mockResolvedValueOnce({ servers: [SERVERS[1]], nextBookmark: '' });
      const get = mockTasks({ 'srv-1': [REPLICATION], 'srv-2': [INDEXER] });
      const el = await mount('$all');

      expect(list).toHaveBeenCalledTimes(2);
      expect(list).toHaveBeenLastCalledWith({ limit: 100, bookmark: 'page-2' });
      expect(get).toHaveBeenCalledWith('srv-2');
      expect(rows(el)).toHaveLength(2);
    });

    it('surfaces an error when the server list itself fails', async () => {
      mockServers();
      vi.spyOn(getContext().serverMgmt, 'listServers').mockRejectedValue(new ApiError(500, 'boom'));
      const el = await mount('$all');

      expect(el.shadowRoot!.querySelector('[data-error]')).not.toBeNull();
    });
  });

  describe('type tabs', () => {
    it('derives one tab per task type present in the data, plus All', async () => {
      mockTasks({ 'srv-1': [REPLICATION], 'srv-2': [INDEXER] });
      const el = await mount('$all');

      expect(tabs(el)).toEqual(['All', 'indexer', 'replication']);
    });

    it('gives an unknown future task type its own tab rather than dropping it', async () => {
      const future: ActiveTask = { ...INDEXER, type: 'quantum_compaction' };
      mockTasks({ 'srv-1': [REPLICATION, future] });
      const el = await mount('srv-1');

      expect(tabs(el)).toContain('quantum_compaction');
      expect(rows(el)).toHaveLength(2);
    });

    it('selecting a type tab filters the rows and switches the columns', async () => {
      mockTasks({ 'srv-1': [REPLICATION, INDEXER] });
      const el = await mount('srv-1');
      expect(rows(el)).toHaveLength(2);

      selectTab(el, 'replication');
      await settle(el);

      expect(rows(el)).toHaveLength(1);
      expect(rows(el)[0].type).toBe('replication');
      expect(labels(el)).toEqual([
        'Source',
        'Target',
        'Continuous',
        'Docs read',
        'Docs written',
        'Write failures',
        'Pending',
        'Started'
      ]);
    });

    it('gives the indexer and compaction types the progress columns', async () => {
      const compaction: ActiveTask = { ...INDEXER, type: 'database_compaction' };
      mockTasks({ 'srv-1': [INDEXER, compaction, REPLICATION] });
      const el = await mount('srv-1');

      const progressColumns = [
        'Database',
        'Design doc',
        'Progress',
        'Changes done',
        'Total changes',
        'Started'
      ];

      selectTab(el, 'indexer');
      await settle(el);
      expect(labels(el)).toEqual(progressColumns);
      expect(rows(el)).toHaveLength(1);

      // The compaction types share the indexer's column set, not the replication one.
      selectTab(el, 'database_compaction');
      await settle(el);
      expect(labels(el)).toEqual(progressColumns);
      expect(rows(el)).toHaveLength(1);
    });

    it('falls back to All when the selected type disappears from the data', async () => {
      mockTasks({ 'srv-1': [REPLICATION, INDEXER] });
      const el = await mount('srv-1');

      selectTab(el, 'replication');
      await settle(el);
      expect(rows(el)).toHaveLength(1);

      // The replication finished between polls.
      mockTasks({ 'srv-1': [INDEXER] });
      await el.refresh();
      await settle(el);

      expect(rows(el)).toHaveLength(1);
      expect(rows(el)[0].type).toBe('indexer');
      expect(labels(el)).toContain('Type');
    });
  });

  describe('polling', () => {
    it('re-fetches every 60s while mounted', async () => {
      vi.useFakeTimers();
      const get = mockTasks({ 'srv-1': [INDEXER] });
      const el = await mount('srv-1');
      expect(get).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      await settle(el);
      expect(get).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      await settle(el);
      expect(get).toHaveBeenCalledTimes(3);
    });

    it('clears the interval on disconnect', async () => {
      vi.useFakeTimers();
      const get = mockTasks({ 'srv-1': [INDEXER] });
      const el = await mount('srv-1');

      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      expect(get).toHaveBeenCalledTimes(2);

      el.remove();
      // A leaked interval would keep polling a detached element forever.
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 5);
      expect(get).toHaveBeenCalledTimes(2);
    });

    it('a failed poll keeps the last good rows instead of blanking the table', async () => {
      vi.useFakeTimers();
      mockTasks({ 'srv-1': [REPLICATION, INDEXER] });
      const el = await mount('srv-1');
      expect(rows(el)).toHaveLength(2);

      mockTasks({ 'srv-1': new ApiError(503, 'gateway down') });
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      await settle(el);

      expect(rows(el)).toHaveLength(2);
      expect(el.shadowRoot!.querySelector('[data-error]')).toBeNull();
    });
  });

  describe('initial load failure', () => {
    it('renders an error state', async () => {
      mockTasks({ 'srv-1': new ApiError(500, 'internal error') });
      const el = await mount('srv-1');

      const err = el.shadowRoot!.querySelector('[data-error]');
      expect(err).not.toBeNull();
      expect(err!.textContent).toContain('internal error');
      expect(table(el)).toBeNull();
    });

    // #688: ApiError.message is '' for an HTTP/2 response (no statusText). A truthiness
    // check on the message made a *failed* load render as an empty table.
    it('renders an error state even when the error message is the empty string', async () => {
      mockTasks({ 'srv-1': new ApiError(500, '') });
      const el = await mount('srv-1');

      expect(el.shadowRoot!.querySelector('[data-error]')).not.toBeNull();
      expect(table(el)).toBeNull();
      expect(el.shadowRoot!.textContent).toContain('Failed to load active tasks');
    });

    it('a successful refresh clears the error and shows the rows', async () => {
      mockTasks({ 'srv-1': new ApiError(500, '') });
      const el = await mount('srv-1');
      expect(el.shadowRoot!.querySelector('[data-error]')).not.toBeNull();

      mockTasks({ 'srv-1': [INDEXER] });
      await el.refresh();
      await settle(el);

      expect(el.shadowRoot!.querySelector('[data-error]')).toBeNull();
      expect(rows(el)).toHaveLength(1);
    });
  });

  describe('header actions', () => {
    it('registers a refresh action that re-fetches', async () => {
      const get = mockTasks({ 'srv-1': [INDEXER] });
      const el = await mount('srv-1');

      const header = document.querySelector('cca-header') as HTMLElement & {
        shadowRoot: ShadowRoot;
        updateComplete: Promise<unknown>;
      };
      await header.updateComplete;
      const action = header.shadowRoot.querySelector('cca-action[icon="arrows-rotate"]') as
        | (Element & { action?: (e: Event) => void })
        | null;
      expect(action?.action).toBeTruthy();

      action!.action!(new Event('click'));
      await settle(el);
      expect(get).toHaveBeenCalledTimes(2);
    });

    it("titles the page 'Active Tasks', not the owning plugin's name", async () => {
      mockTasks({ 'srv-1': [INDEXER] });
      const el = await mount('srv-1');

      const header = document.querySelector('cca-header') as HTMLElement & {
        shadowRoot: ShadowRoot;
        updateComplete: Promise<unknown>;
      };
      await header.updateComplete;
      const title = header.shadowRoot.querySelector('.title')?.textContent?.trim();
      // plugin-loader labels every plugin route with the plugin name, so without an
      // explicit setHeaderTitle this page renders as "server-mgmt".
      expect(title).toBe('Active Tasks');
      expect(title).not.toBe('server-mgmt');

      // and it must not leak the override onto the next page
      el.remove();
      await header.updateComplete;
      expect(header.shadowRoot.querySelector('.title')?.textContent?.trim()).not.toBe(
        'Active Tasks'
      );
    });
  });

  describe('route changes', () => {
    it('reloads when the :serverId route segment switches', async () => {
      const get = mockTasks({ 'srv-1': [INDEXER], 'srv-2': [REPLICATION] });
      const el = await mount('srv-1');
      expect(get).toHaveBeenCalledTimes(1);

      el.serverId = 'srv-2';
      await settle(el);

      expect(get).toHaveBeenLastCalledWith('srv-2');
      expect(rows(el)).toHaveLength(1);
      expect(rows(el)[0].type).toBe('replication');
    });
  });
});
