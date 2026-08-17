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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getContext } from '../src/context';
import type { DatabaseOverview } from '../src/plugins/db-mgmt/types';
import type { GitRepo } from '../src/plugins/design-mgmt/types';
import { ApiError } from '../src/services/api-error';
import { describeDbAccessError } from '../src/services/db-enumeration';
import { SINGLE_SERVER_ID } from '../src/services/single-server';
import '../src/plugins/db-mgmt/db-list';
import '../src/components/cca-toast';
import type { CcaToast } from '../src/components/cca-toast';

const DBS: DatabaseOverview[] = [
  { db_name: 'orders', servers: [{ server_id: 'srv1', server_name: 'Alpha', doc_count: 3 }] } as DatabaseOverview,
  { db_name: 'invoices', servers: [{ server_id: 'srv1', server_name: 'Alpha', doc_count: 1 }] } as DatabaseOverview,
];

const MIXED_DBS: DatabaseOverview[] = [
  {
    db_name: 'orders',
    servers: [
      { server_id: 'srv1', server_name: 'Alpha', doc_count: 3 },
      { server_id: 'srv2', server_name: 'Bravo', doc_count: 2 },
    ]
  } as DatabaseOverview,
  {
    db_name: 'invoices',
    servers: [{ server_id: 'srv2', server_name: 'Bravo', doc_count: 1 }],
  } as DatabaseOverview,
  {
    db_name: 'audit',
    servers: [{ server_id: 'srv3', server_name: 'Charlie', doc_count: 5 }],
  } as DatabaseOverview,
];

async function mount(serverId = '$all'): Promise<any> {
  const el = document.createElement('cca-db-list') as any;
  el.serverId = serverId;
  document.body.appendChild(el);
  await el.updateComplete;
  await new Promise((r) => setTimeout(r, 0));
  await el.updateComplete;
  return el;
}

/**
 * The search box. Deliberately the first `wa-input` in db-list's OWN shadow root — the
 * open-by-name field added for #5 lives inside `<cca-db-picker>`'s shadow root, which this
 * query cannot reach, so it stays unambiguous.
 */
function searchInput(el: any): HTMLInputElement {
  return el.shadowRoot!.querySelector('wa-input') as HTMLInputElement;
}

function type(el: any, value: string) {
  const input = searchInput(el);
  (input as any).value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/** The data table, painted — its cells and headers live in its own shadow root. */
async function table(el: any): Promise<any> {
  const t = el.shadowRoot!.querySelector('cca-data-table') as any;
  await t.updateComplete;
  return t;
}

/** Header labels in order, with the sort indicator the active header carries stripped off. */
async function headerLabels(el: any): Promise<string[]> {
  const t = await table(el);
  return [...t.shadowRoot!.querySelectorAll('th')].map((th) =>
    (th as HTMLElement).textContent!.replace(/[↑↓]/g, '').trim()
  );
}

/**
 * Repositories are read once per mount for the Version Control column (#34). The default is the
 * ordinary "administrator, nothing registered yet" answer — the column is there, every cell is
 * empty — so no test in this file has to know about version control unless it is about it. The
 * column's own describe block below overrides this per scenario.
 *
 * Mocked rather than left alone deliberately: an unmocked call reaches `test/setup.ts`'s
 * fetch guard, which is a failure the column would then degrade over — every assertion here
 * would be resting on a broken request rather than on a stated state.
 */
beforeEach(() => {
  vi.spyOn(getContext().dbMgmt, 'listDatabases').mockResolvedValue(DBS);
  vi.spyOn(getContext().designMgmt, 'listRepos').mockResolvedValue({
    repos: [],
    truncated: false,
  });
});

afterEach(() => {
  vi.useRealTimers();
  document.body.querySelectorAll('cca-db-list').forEach((e) => e.remove());
  vi.restoreAllMocks();
});

describe('cca-db-list server-side search', () => {
  it('filters rows by selected server while leaving each row’s server data intact', async () => {
    const spy = getContext().dbMgmt.listDatabases as ReturnType<typeof vi.fn>;
    spy.mockResolvedValue(MIXED_DBS);

    const el = await mount('srv2');
    const table = el.shadowRoot!.querySelector('cca-data-table') as any;

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        sort_by: 'db_name',
        sort_order: 'asc',
      }),
    );
    expect(spy).toHaveBeenCalledWith(
      expect.not.objectContaining({
        filter_name: 'server_id',
      }),
    );
    expect((table.rows as DatabaseOverview[]).map((r) => r.db_name)).toEqual(['orders', 'invoices']);
    expect((table.rows as DatabaseOverview[])[0].servers.map((s) => s.server_id)).toEqual(['srv1', 'srv2']);
  });

  it('does not send server_id filter when mounted on $all', async () => {
    await mount('$all');
    const spy = getContext().dbMgmt.listDatabases as ReturnType<typeof vi.fn>;
    expect(spy).toHaveBeenCalledWith(
      expect.not.objectContaining({
        filter_name: 'server_id',
      }),
    );
  });

  it('reloads and re-filters rows when serverId changes after mount', async () => {
    const el = await mount('$all');
    const spy = getContext().dbMgmt.listDatabases as ReturnType<typeof vi.fn>;
    spy.mockClear();
    spy.mockResolvedValue(MIXED_DBS);

    el.serverId = 'srv2';
    await el.updateComplete;
    await new Promise((r) => setTimeout(r, 0));
    await el.updateComplete;
    const table = el.shadowRoot!.querySelector('cca-data-table') as any;

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toEqual(expect.objectContaining({
      sort_by: 'db_name',
      sort_order: 'asc',
    }));
    expect(spy.mock.calls[0][0]).toEqual(expect.not.objectContaining({
      filter_name: 'server_id',
    }));
    expect((table.rows as DatabaseOverview[]).map((r) => r.db_name)).toEqual(['orders', 'invoices']);
    expect((table.rows as DatabaseOverview[])[0].servers.map((s) => s.server_id)).toEqual(['srv1', 'srv2']);
  });

  it('shows all rows when mounted on $all', async () => {
    const spy = getContext().dbMgmt.listDatabases as ReturnType<typeof vi.fn>;
    spy.mockResolvedValue(MIXED_DBS);
    const el = await mount('$all');
    const table = el.shadowRoot!.querySelector('cca-data-table') as any;
    expect((table.rows as DatabaseOverview[]).map((r) => r.db_name)).toEqual([
      'orders',
      'invoices',
      'audit',
    ]);
    expect(spy).toHaveBeenCalledWith(expect.not.objectContaining({
      filter_name: 'server_id',
      filter_value: 'srv2',
    }));
  });

  it('coalesces rapid keystrokes into one reload carrying filter_name/filter_value', async () => {
    const el = await mount();
    const spy = getContext().dbMgmt.listDatabases as ReturnType<typeof vi.fn>;
    spy.mockClear();
    vi.useFakeTimers();

    for (const v of ['o', 'or', 'ord']) type(el, v);

    expect(spy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(250);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toMatchObject({ filter_name: 'db_name', filter_value: 'ord' });
  });

  it('renders exactly what the service returns — no client-side filtering pass', async () => {
    const el = await mount();
    const spy = getContext().dbMgmt.listDatabases as ReturnType<typeof vi.fn>;
    spy.mockClear();
    // Deliberately return rows that do NOT contain the query: a surviving
    // client-side pass would hide them; the server-side contract shows them.
    spy.mockResolvedValue(DBS);
    vi.useFakeTimers();

    type(el, 'zzz');
    await vi.advanceTimersByTimeAsync(250);
    await el.updateComplete;

    const table = el.shadowRoot!.querySelector('cca-data-table') as any;
    expect(table.rows).toEqual(DBS);
  });

  it('clearing the search reloads immediately without filter params and cancels the pending reload', async () => {
    const el = await mount();
    const spy = getContext().dbMgmt.listDatabases as ReturnType<typeof vi.fn>;
    spy.mockClear();
    vi.useFakeTimers();

    type(el, 'x');
    // WA's clear button dispatches wa-clear, then a composed input for the
    // same (now empty) value — replicate the full shipped event sequence.
    const input = searchInput(el);
    (input as any).value = '';
    input.dispatchEvent(new CustomEvent('wa-clear', { bubbles: true }));
    input.dispatchEvent(new Event('input', { bubbles: true }));

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).not.toHaveProperty('filter_name');
    expect(spy.mock.calls[0][0]).not.toHaveProperty('filter_value');
    vi.advanceTimersByTime(1000);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('sort-header click reloads immediately, carrying the active filter, and cancels the pending reload', async () => {
    const el = await mount();
    const spy = getContext().dbMgmt.listDatabases as ReturnType<typeof vi.fn>;
    spy.mockClear();
    vi.useFakeTimers();

    type(el, 'ord');
    const table = el.shadowRoot!.querySelector('cca-data-table') as any;
    await table.updateComplete;
    // Sortable headers render spans; spans[0] is Database (already active asc → flips to desc).
    const header = table.shadowRoot!.querySelectorAll('th span')[0] as HTMLElement;
    header.click();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toMatchObject({
      sort_by: 'db_name',
      sort_order: 'desc',
      filter_name: 'db_name',
      filter_value: 'ord',
    });
    vi.advanceTimersByTime(1000);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('drops a stale response that resolves after a newer reload', async () => {
    const el = await mount();
    const spy = getContext().dbMgmt.listDatabases as ReturnType<typeof vi.fn>;
    spy.mockClear();
    let resolveStale!: (v: unknown) => void;
    let resolveCurrent!: (v: unknown) => void;
    spy
      .mockImplementationOnce(() => new Promise((r) => { resolveStale = r; }))
      .mockImplementationOnce(() => new Promise((r) => { resolveCurrent = r; }));
    vi.useFakeTimers();

    type(el, 'a');
    vi.advanceTimersByTime(250); // reload 1 (will become stale) in flight
    const input = searchInput(el);
    (input as any).value = '';
    input.dispatchEvent(new CustomEvent('wa-clear', { bubbles: true })); // reload 2 (current)
    expect(spy).toHaveBeenCalledTimes(2);

    const stale = [{ db_name: 'stale', servers: [] }];
    resolveStale(stale);
    await vi.advanceTimersByTimeAsync(0);
    expect(el.loading).toBe(true);
    expect(el.databases).not.toEqual(stale);

    resolveCurrent(DBS);
    await vi.advanceTimersByTimeAsync(0);
    expect(el.databases).toEqual(DBS);
    expect(el.loading).toBe(false);
  });

  it('does not fire a scheduled reload after the element is removed', async () => {
    const el = await mount();
    const spy = getContext().dbMgmt.listDatabases as ReturnType<typeof vi.fn>;
    spy.mockClear();
    vi.useFakeTimers();

    type(el, 'x');
    el.remove();
    vi.advanceTimersByTime(1000);
    expect(spy).not.toHaveBeenCalled();
  });
});

/**
 * The Servers column said the same thing on every row — there is exactly one server (spec D3) —
 * while its badge duplicated the Doc Count and Size columns beside it. Removing it also removes
 * the only sort key that sorted nothing (#44).
 */
describe('cca-db-list columns without the server column (#44)', () => {
  it('renders no Servers column', async () => {
    const el = await mount();
    expect(await headerLabels(el)).not.toContain('Servers');
  });

  // Version Control joined the list in #34, between the database's own figures and its actions.
  it('keeps the remaining columns, in order', async () => {
    const el = await mount();
    expect(await headerLabels(el)).toEqual([
      'Database',
      'Doc Count',
      'Size',
      'Version Control',
      'Actions',
    ]);
  });

  it('renders no server badge in any row', async () => {
    (getContext().dbMgmt.listDatabases as ReturnType<typeof vi.fn>).mockResolvedValue(MIXED_DBS);
    const el = await mount('$all');
    const t = await table(el);
    expect(t.shadowRoot!.querySelectorAll('wa-badge').length).toBe(0);
    // The server names themselves are gone from the painted table, not merely un-badged.
    expect(t.shadowRoot!.textContent).not.toContain('Alpha');
    expect(t.shadowRoot!.textContent).not.toContain('Bravo');
  });

  it('never asks the service to sort by server_name, whichever header is clicked', async () => {
    const el = await mount();
    const spy = getContext().dbMgmt.listDatabases as ReturnType<typeof vi.fn>;
    const t = await table(el);
    const headers = [...t.shadowRoot!.querySelectorAll('th span')] as HTMLElement[];
    // Three sortable headers remain; Actions has no header renderer of its own.
    expect(headers.length).toBe(3);

    spy.mockClear();
    for (const h of headers) h.click();

    expect(spy).toHaveBeenCalledTimes(3);
    for (const [params] of spy.mock.calls) {
      expect(['db_name', 'doc_count', 'size_bytes']).toContain(params.sort_by);
    }
  });
});

/**
 * Design documents are per-database, so the row is where they are reachable from. The target is
 * the registered `/design-docs/:serverId` route plus the `?database=` filter `cca-design-list`
 * reads on arrival — the same pair repo-overview's target pills navigate with (#44).
 */
describe('cca-db-list design-documents action (#44)', () => {
  const designButtons = async (el: any): Promise<HTMLElement[]> =>
    [...(await table(el)).shadowRoot!.querySelectorAll('[data-design-docs]')] as HTMLElement[];

  it('offers the action once per row, beside the other row actions', async () => {
    const el = await mount();
    const buttons = await designButtons(el);
    expect(buttons.length).toBe(DBS.length);
    expect(buttons[0].getAttribute('title')).toBe('Design Documents');
    // Same treatment as its neighbours: an icon button inside the Actions cell.
    expect(buttons[0].querySelector('wa-icon')?.getAttribute('name')).toBe('pen-nib');
    const cell = buttons[0].closest('td')!;
    expect(cell.querySelectorAll('wa-button').length).toBe(5);
  });

  it('navigates to the design-doc list filtered to that row’s database', async () => {
    const nav = vi.spyOn(getContext().router, 'navigate').mockImplementation(() => {});
    const el = await mount('$all');

    (await designButtons(el))[0].click();

    expect(nav).toHaveBeenCalledWith('/design-docs/srv1?database=orders');
  });

  it('percent-encodes a database name that needs it', async () => {
    (getContext().dbMgmt.listDatabases as ReturnType<typeof vi.fn>).mockResolvedValue([
      { db_name: 'my db/x', servers: [{ server_id: 'srv1', server_name: 'Alpha', doc_count: 0 }] },
    ] as DatabaseOverview[]);
    const nav = vi.spyOn(getContext().router, 'navigate').mockImplementation(() => {});
    const el = await mount('$all');

    (await designButtons(el))[0].click();

    expect(nav).toHaveBeenCalledWith('/design-docs/srv1?database=my%20db%2Fx');
  });

  /**
   * `$all` is not addressable here: design-list ignores `?database=` unless `:serverId` names a
   * real server, so a row without one must still resolve to the single server, not to `$all`.
   */
  it('addresses the single server when the row carries none', async () => {
    (getContext().dbMgmt.listDatabases as ReturnType<typeof vi.fn>).mockResolvedValue([
      { db_name: 'lonely', servers: [] },
    ] as DatabaseOverview[]);
    const nav = vi.spyOn(getContext().router, 'navigate').mockImplementation(() => {});
    const el = await mount('$all');

    (await designButtons(el))[0].click();

    expect(nav).toHaveBeenCalledWith(`/design-docs/${SINGLE_SERVER_ID}?database=lonely`);
  });

  it('does not also trigger the row click that browses documents', async () => {
    const nav = vi.spyOn(getContext().router, 'navigate').mockImplementation(() => {});
    const el = await mount('$all');

    (await designButtons(el))[0].click();

    expect(nav).toHaveBeenCalledTimes(1);
  });
});

describe('cca-db-list manage-indexes action (#106)', () => {
  const indexButtons = async (el: any): Promise<HTMLElement[]> =>
    [...(await table(el)).shadowRoot!.querySelectorAll('[data-manage-indexes]')] as HTMLElement[];

  it('sits between Design Documents and Permissions', async () => {
    const el = await mount();
    const cell = (await indexButtons(el))[0].closest('td')!;
    const titles = [...cell.querySelectorAll('wa-button')].map((b) => b.getAttribute('title'));

    expect(titles).toEqual(['Design Documents', 'Manage Indexes', 'Permissions', 'Replication', 'Delete Database']);
  });

  it('offers the action once per row', async () => {
    const el = await mount();
    const buttons = await indexButtons(el);

    expect(buttons.length).toBe(DBS.length);
    expect(buttons[0].querySelector('wa-icon')?.getAttribute('name')).toBe('list-check');
  });

  it('navigates to that row’s index-manage screen', async () => {
    const nav = vi.spyOn(getContext().router, 'navigate').mockImplementation(() => {});
    const el = await mount('$all');

    (await indexButtons(el))[0].click();

    expect(nav).toHaveBeenCalledWith('/databases/srv1/orders/indexes');
  });

  it('addresses the single server when the row carries none', async () => {
    (getContext().dbMgmt.listDatabases as ReturnType<typeof vi.fn>).mockResolvedValue([
      { db_name: 'lonely', servers: [] },
    ] as DatabaseOverview[]);
    const nav = vi.spyOn(getContext().router, 'navigate').mockImplementation(() => {});
    const el = await mount('$all');

    (await indexButtons(el))[0].click();

    expect(nav).toHaveBeenCalledWith(`/databases/${SINGLE_SERVER_ID}/lonely/indexes`);
  });

  it('does not also trigger the row click that browses documents', async () => {
    const nav = vi.spyOn(getContext().router, 'navigate').mockImplementation(() => {});
    const el = await mount('$all');

    (await indexButtons(el))[0].click();

    expect(nav).toHaveBeenCalledTimes(1);
  });
});

describe('cca-db-list action-button appearance (#106)', () => {
  it('gives every row action an outlined base appearance and the opt-in hover-treatment class', async () => {
    const el = await mount();
    const cell = (await table(el)).shadowRoot!.querySelector('[data-design-docs]')!.closest('td')!;

    for (const button of cell.querySelectorAll('wa-button')) {
      expect(button.getAttribute('appearance')).toBe('outlined');
      expect(button.classList.contains('row-action-button')).toBe(true);
    }
  });

  it('keeps the delete action’s danger variant alongside the new outlined appearance', async () => {
    const el = await mount();
    const cell = (await table(el)).shadowRoot!.querySelector('[data-design-docs]')!.closest('td')!;
    const deleteButton = [...cell.querySelectorAll('wa-button')].find(
      (b) => b.getAttribute('title') === 'Delete Database',
    )!;

    expect(deleteButton.getAttribute('variant')).toBe('danger');
    expect(deleteButton.getAttribute('appearance')).toBe('outlined');
  });
});

/**
 * #34 — the database-first half of "which databases are under version control". `/version-control`
 * already answers this repository-first; standing on a database you could not tell at all.
 */
describe('cca-db-list version-control column (#34)', () => {
  const TRACKED: GitRepo[] = [
    {
      _id: 'gitrepo:designs',
      name: 'couchdb-designs',
      url: 'https://github.com/example/couchdb-designs.git',
      provider: 'github',
      account_id: 'gitaccount:work',
      sync_status: 'idle',
      sync_targets: [{ server_id: 'srv1', db_name: 'orders', branch: 'trunk', path: '/ddocs' }],
    },
  ];

  const withRepos = (repos: GitRepo[]) =>
    (getContext().designMgmt.listRepos as ReturnType<typeof vi.fn>).mockResolvedValue({
      repos,
      truncated: false,
    });

  /** Every row's version-control cell, in row order — `null` where the cell is empty. */
  async function cells(el: any): Promise<(HTMLElement | null)[]> {
    const t = await table(el);
    const columns = (t.columns as { label: string }[]).map((c) => c.label);
    const index = columns.indexOf('Version Control');
    if (index === -1) return [];
    return [...t.shadowRoot!.querySelectorAll('tbody tr')].map(
      (row) => row.children[index].querySelector('[data-version-control]') as HTMLElement | null,
    );
  }

  const textOf = (cell: HTMLElement | null, part: 'repo' | 'branch'): string | null =>
    cell?.querySelector(`[data-version-control-${part}]`)?.textContent?.trim() ?? null;

  it('names the repository and branch of a database that is tracked', async () => {
    withRepos(TRACKED);
    const el = await mount();

    const [orders] = await cells(el);
    expect(textOf(orders, 'repo')).toBe('couchdb-designs');
    expect(textOf(orders, 'branch')).toBe('trunk');
  });

  // Not the word "None" on every untracked row: there is nothing to report, and saying so on
  // every row is noise on the way to the rows that have something to say.
  it('leaves the cell empty for a database no repository tracks', async () => {
    withRepos(TRACKED);
    const el = await mount();

    const [, invoices] = await cells(el);
    expect(invoices).toBeNull();
    const t = await table(el);
    const index = (t.columns as { label: string }[]).map((c) => c.label).indexOf('Version Control');
    expect(t.shadowRoot!.querySelectorAll('tbody tr')[1].children[index].textContent!.trim()).toBe('');
  });

  it('matches on the server as well as the name, never on the name alone', async () => {
    withRepos([{ ...TRACKED[0], sync_targets: [{ server_id: 'srv-other', db_name: 'orders', branch: 'trunk', path: '/' }] }]);
    const el = await mount();

    expect(await cells(el)).toEqual([null, null]);
  });

  it('sends the reader to the repository-first view', async () => {
    const nav = vi.spyOn(getContext().router, 'navigate').mockImplementation(() => {});
    withRepos(TRACKED);
    const el = await mount();

    const [orders] = await cells(el);
    // `#/` because this app routes on the location hash — a bare path would be a link that only
    // works when the click handler runs, i.e. never for middle-click or "copy link address".
    expect(orders!.getAttribute('href')).toBe('#/version-control');
    orders!.click();

    expect(nav).toHaveBeenCalledWith('/version-control');
    // The row click that browses documents must not fire as well.
    expect(nav).toHaveBeenCalledTimes(1);
  });

  it('reads the repositories once for the whole table, not once per row', async () => {
    const spy = getContext().designMgmt.listRepos as ReturnType<typeof vi.fn>;
    withRepos(TRACKED);
    (getContext().dbMgmt.listDatabases as ReturnType<typeof vi.fn>).mockResolvedValue(MIXED_DBS);

    const el = await mount();

    expect((await table(el)).rows.length).toBe(MIXED_DBS.length);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  // Searching or sorting re-reads the databases; it cannot change which repository tracks one.
  it('does not re-read the repositories when the database list reloads', async () => {
    const spy = getContext().designMgmt.listRepos as ReturnType<typeof vi.fn>;
    withRepos(TRACKED);
    const el = await mount();
    spy.mockClear();

    type(el, 'ord');
    await new Promise((r) => setTimeout(r, 400));
    await el.updateComplete;

    expect(getContext().dbMgmt.listDatabases).toHaveBeenCalledTimes(2);
    expect(spy).not.toHaveBeenCalled();
  });

  /**
   * D9's sharp edge. `couchcompanion` is admin-only under CouchDB's own default security, so a
   * non-admin's read of it is refused — measured live against 3.5.2: `GET
   * /couchcompanion/_all_docs` answers 403 `forbidden` to an authenticated non-admin (while
   * `GET /_all_dbs` answers 401 `unauthorized`). Both are refusals of the *repositories*, not of
   * the database list, and neither may cost the reader their working screen.
   *
   * Nothing is pre-gated on `isAdmin` — `auth.isAdmin` is deliberately left alone in these tests,
   * which is exactly why they would fail if a pre-gate were ever added in its place.
   */
  describe('when the repositories are refused', () => {
    let toastEl: CcaToast;

    beforeEach(async () => {
      toastEl = document.createElement('cca-toast') as CcaToast;
      document.body.appendChild(toastEl);
      await toastEl.updateComplete;
    });

    afterEach(() => toastEl.remove());

    for (const [status, label] of [
      [403, 'forbidden'],
      [401, 'unauthorized'],
    ] as const) {
      it(`renders no column at all on ${status} ${label}, and still lists the databases`, async () => {
        (getContext().designMgmt.listRepos as ReturnType<typeof vi.fn>).mockRejectedValue(
          new ApiError(status, 'You are not allowed to access this db.'),
        );

        const el = await mount();

        expect(await headerLabels(el)).not.toContain('Version Control');
        expect((await table(el)).rows.map((r: DatabaseOverview) => r.db_name)).toEqual([
          'orders',
          'invoices',
        ]);
      });

      it(`surfaces no error on ${status} ${label}`, async () => {
        (getContext().designMgmt.listRepos as ReturnType<typeof vi.fn>).mockRejectedValue(
          new ApiError(status, 'You are not allowed to access this db.'),
        );

        const el = await mount();

        expect(toastEl.shadowRoot!.querySelector('.toast.error')).toBeNull();
        expect(el.shadowRoot!.querySelector('[data-enumeration-denied]')).toBeNull();
        expect((await table(el)).shadowRoot!.textContent).not.toMatch(/not allowed|forbidden/i);
      });
    }

    // A genuine fault is still not this screen's to report — the databases are what it is for —
    // but it must not be mistaken for "nothing is tracked" either, so the column goes too.
    it('renders no column when the read fails outright', async () => {
      (getContext().designMgmt.listRepos as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('network down'),
      );

      const el = await mount();

      expect(await headerLabels(el)).not.toContain('Version Control');
      expect(toastEl.shadowRoot!.querySelector('.toast.error')).toBeNull();
    });
  });

  // An administrator with nothing registered is the opposite state from a refused read: the
  // column belongs there, empty, because "not under version control" is a thing we now know.
  it('keeps the column, empty, when every database is untracked', async () => {
    withRepos([]);
    const el = await mount();

    expect(await headerLabels(el)).toContain('Version Control');
    expect(await cells(el)).toEqual([null, null]);
  });
});

describe('cca-db-list load-failure error state', () => {
  let toastEl: CcaToast;

  beforeEach(async () => {
    toastEl = document.createElement('cca-toast') as CcaToast;
    document.body.appendChild(toastEl);
    await toastEl.updateComplete;
  });

  afterEach(() => {
    toastEl.remove();
  });

  it('surfaces a toast when listDatabases rejects, instead of silently rendering "No databases found."', async () => {
    const spy = getContext().dbMgmt.listDatabases as ReturnType<typeof vi.fn>;
    spy.mockRejectedValueOnce(new Error('network down'));

    await mount();

    const text = toastEl.shadowRoot!.querySelector('.toast.error')?.textContent ?? '';
    expect(text).toContain('network down');
  });

  /**
   * A non-admin's `GET /_all_dbs` is refused by CouchDB's own default security (401), which is
   * not a fault: the databases are there and the per-database screens answer 200 for a member.
   * The list screen has to say so and offer a way in by name, rather than claim "No databases
   * found." over an empty table. Statuses measured live against CouchDB 3.5.2 (see
   * test/db-enumeration.test.ts).
   */
  describe('enumeration denied (#5)', () => {
    const allDbsUnauthorized = () =>
      new ApiError(401, 'You are not a server admin.', {
        error: 'unauthorized',
        reason: 'You are not a server admin.'
      });

    const dbForbidden = () =>
      new ApiError(403, 'You are not allowed to access this db.', {
        error: 'forbidden',
        reason: 'You are not allowed to access this db.'
      });

    const dbNotFound = () =>
      new ApiError(404, 'Database does not exist.', {
        error: 'not_found',
        reason: 'Database does not exist.'
      });

    /** Mounts with `_all_dbs` refused for every reload, not just the first. */
    async function mountDenied(serverId = '$all'): Promise<any> {
      (getContext().dbMgmt.listDatabases as ReturnType<typeof vi.fn>).mockRejectedValue(
        allDbsUnauthorized()
      );
      return mount(serverId);
    }

    const picker = (el: any): any => el.shadowRoot!.querySelector('cca-db-picker');
    const openError = (el: any): string =>
      el.shadowRoot!.querySelector('[data-open-error]')?.textContent?.trim() ?? '';

    /** Types a name into the open-by-name field the way the picker's own API exposes it. */
    async function openByName(el: any, name: string): Promise<void> {
      picker(el).value = name;
      (el.shadowRoot!.querySelector('[data-open-db]') as HTMLElement).click();
      await new Promise((r) => setTimeout(r, 0));
      await el.updateComplete;
    }

    it('explains the refusal and offers open-by-name instead of "No databases found."', async () => {
      const el = await mountDenied();

      const callout = el.shadowRoot!.querySelector('[data-enumeration-denied]');
      expect(callout).not.toBeNull();
      expect(callout!.textContent).toContain(describeDbAccessError(allDbsUnauthorized()));
      expect(picker(el)).not.toBeNull();
      // The table — and with it the false "No databases found." — must be gone.
      expect(el.shadowRoot!.querySelector('cca-data-table')).toBeNull();
    });

    it('does not fire the "Failed to load databases" toast for a refusal', async () => {
      await mountDenied();

      expect(toastEl.shadowRoot!.querySelector('.toast.error')).toBeNull();
    });

    it('probes the typed name and navigates to its documents when CouchDB allows it', async () => {
      const el = await mountDenied('srv1');
      const info = vi
        .spyOn(getContext().dbMgmt, 'getDatabaseInfo')
        .mockResolvedValue({ db_name: 'orders' } as any);
      const navigate = vi.spyOn(getContext().router, 'navigate');

      await openByName(el, 'orders');

      expect(info).toHaveBeenCalledWith('srv1', 'orders');
      expect(navigate).toHaveBeenCalledWith('/databases/srv1/orders/documents');
    });

    it('opens on Enter in the field, without reaching for the button', async () => {
      const el = await mountDenied('srv1');
      vi.spyOn(getContext().dbMgmt, 'getDatabaseInfo').mockResolvedValue({} as any);
      const navigate = vi.spyOn(getContext().router, 'navigate');

      const p = picker(el);
      p.value = 'orders';
      // Composed, as a real keypress inside the picker's nested shadow roots is.
      p.shadowRoot!.querySelector('wa-input')!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true })
      );
      await new Promise((r) => setTimeout(r, 0));
      await el.updateComplete;

      expect(navigate).toHaveBeenCalledWith('/databases/srv1/orders/documents');
    });

    it('addresses the single server when the list is mounted on $all', async () => {
      const el = await mountDenied('$all');
      vi.spyOn(getContext().dbMgmt, 'getDatabaseInfo').mockResolvedValue({} as any);
      const navigate = vi.spyOn(getContext().router, 'navigate');

      await openByName(el, 'orders');

      expect(navigate).toHaveBeenCalledWith(
        `/databases/${SINGLE_SERVER_ID}/orders/documents`
      );
    });

    it('percent-encodes a database name that needs it', async () => {
      const el = await mountDenied('srv1');
      vi.spyOn(getContext().dbMgmt, 'getDatabaseInfo').mockResolvedValue({} as any);
      const navigate = vi.spyOn(getContext().router, 'navigate');

      await openByName(el, 'my db/x');

      expect(navigate).toHaveBeenCalledWith('/databases/srv1/my%20db%2Fx/documents');
    });

    it('shows the "no such database" copy and stays put when the probe 404s', async () => {
      const el = await mountDenied('srv1');
      vi.spyOn(getContext().dbMgmt, 'getDatabaseInfo').mockRejectedValue(dbNotFound());
      const navigate = vi.spyOn(getContext().router, 'navigate');

      await openByName(el, 'ordrs');

      expect(openError(el)).toBe(describeDbAccessError(dbNotFound(), 'ordrs'));
      expect(navigate).not.toHaveBeenCalled();
    });

    // #66: the probe is `GET /{db}`, so a 401 from it refuses that database — telling the user
    // the *listing* is administrator-only says nothing about the name they just typed, and this
    // screen is already showing them the listing refusal above the field.
    it('shows the per-database copy, not the listing copy, when the probe 401s', async () => {
      const el = await mountDenied('srv1');
      vi.spyOn(getContext().dbMgmt, 'getDatabaseInfo').mockRejectedValue(
        new ApiError(401, 'You are not authorized to access this db.')
      );
      const navigate = vi.spyOn(getContext().router, 'navigate');

      await openByName(el, 'secrets');

      expect(openError(el)).toBe(
        describeDbAccessError(
          new ApiError(401, 'You are not authorized to access this db.'),
          'secrets',
          'database'
        )
      );
      expect(openError(el)).not.toMatch(/listing the databases/i);
      expect(navigate).not.toHaveBeenCalled();
    });

    it('shows the "not a member" copy and stays put when the probe 403s', async () => {
      const el = await mountDenied('srv1');
      vi.spyOn(getContext().dbMgmt, 'getDatabaseInfo').mockRejectedValue(dbForbidden());
      const navigate = vi.spyOn(getContext().router, 'navigate');

      await openByName(el, 'secrets');

      expect(openError(el)).toBe(describeDbAccessError(dbForbidden(), 'secrets'));
      expect(navigate).not.toHaveBeenCalled();
    });

    it('clears the refusal when a later load succeeds', async () => {
      const el = await mountDenied('$all');
      expect(el.shadowRoot!.querySelector('[data-enumeration-denied]')).not.toBeNull();

      const spy = getContext().dbMgmt.listDatabases as ReturnType<typeof vi.fn>;
      spy.mockResolvedValue(DBS);

      el.serverId = 'srv1';
      await el.updateComplete;
      await new Promise((r) => setTimeout(r, 0));
      await el.updateComplete;

      expect(el.shadowRoot!.querySelector('[data-enumeration-denied]')).toBeNull();
      expect(el.shadowRoot!.querySelector('cca-data-table')).not.toBeNull();
    });
  });
});
