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
import type { Server } from '../src/plugins/server-mgmt/types';
import type { UserDoc } from '../src/plugins/users/types';
import '../src/components/cca-header';
// cca-users-list.ts itself no longer self-imports these — production gets them from
// webawesome.ts's barrel, loaded once at app boot. This isolated test run needs its own.
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/dialog/dialog.js';
import '@awesome.me/webawesome/dist/components/input/input.js';
import '../src/plugins/users/cca-users-list';
import type { CcaUsersList } from '../src/plugins/users/cca-users-list';

let mounted: HTMLElement[] = [];

async function mount(serverId: string): Promise<CcaUsersList> {
  // Mount a header so clearHeaderActions/addHeaderActions don't emit log warnings
  const header = document.createElement('cca-header');
  document.body.appendChild(header);
  mounted.push(header);

  const el = document.createElement('cca-users-list') as CcaUsersList;
  el.serverId = serverId;
  document.body.appendChild(el);
  mounted.push(el);

  await el.updateComplete;
  await new Promise((r) => setTimeout(r, 0));
  await el.updateComplete;
  return el;
}

describe('cca-users-list', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(getContext().serverMgmt, 'listServers').mockResolvedValue({
      servers: [{ id: 'srv1', name: 'Server One' } as Server],
      nextBookmark: '',
    });
  });

  afterEach(() => {
    for (const el of mounted) {
      el.remove();
    }
    mounted = [];
  });

  it('renders one row per user with username and roles', async () => {
    vi.spyOn(getContext().users, 'listUsers').mockResolvedValue([
      { _id: 'org.couchdb.user:alice', name: 'alice', type: 'user', roles: ['reader'] },
    ] as UserDoc[]);
    const el = await mount('srv1');
    const table = el.shadowRoot!.querySelector('cca-data-table') as any;
    expect(table.rows.length).toBe(1);
    expect(table.rows[0].name).toBe('alice');
  });

  it('clicking a row navigates to the detail route', async () => {
    vi.spyOn(getContext().users, 'listUsers').mockResolvedValue([
      { _id: 'org.couchdb.user:alice', name: 'alice', type: 'user', roles: [] },
    ] as UserDoc[]);
    const nav = vi.spyOn(getContext().router, 'navigate').mockImplementation(() => {});
    const el = await mount('srv1');
    const table = el.shadowRoot!.querySelector('cca-data-table')!;
    table.dispatchEvent(
      new CustomEvent('cca-row-click', {
        detail: { _id: 'org.couchdb.user:alice', name: 'alice' },
        bubbles: true,
        composed: true,
      }),
    );
    expect(nav).toHaveBeenCalledWith('/users/srv1/org.couchdb.user%3Aalice');
  });

  it('confirming delete calls deleteUser with rev then reloads', async () => {
    const list = vi
      .spyOn(getContext().users, 'listUsers')
      .mockResolvedValue([
        { _id: 'org.couchdb.user:alice', name: 'alice', type: 'user', roles: [], _rev: '3-abc' },
      ] as UserDoc[]);
    const del = vi.spyOn(getContext().users, 'deleteUser').mockResolvedValue({});
    const el = await mount('srv1');
    await el.confirmDelete('org.couchdb.user:alice');
    expect(del).toHaveBeenCalledWith('srv1', 'org.couchdb.user:alice', '3-abc');
    expect(list).toHaveBeenCalledTimes(2); // initial load + reload after delete
  });

  it('gives both row actions the shared outlined/row-action-button treatment (#112)', async () => {
    vi.spyOn(getContext().users, 'listUsers').mockResolvedValue([
      { _id: 'org.couchdb.user:alice', name: 'alice', type: 'user', roles: [] },
    ] as UserDoc[]);
    const el = await mount('srv1');
    const table = el.shadowRoot!.querySelector('cca-data-table') as any;
    await table.updateComplete;
    const buttons = [...table.shadowRoot!.querySelectorAll('wa-button')] as HTMLElement[];

    expect(buttons.length).toBe(2);
    for (const btn of buttons) {
      expect(btn.getAttribute('appearance')).toBe('outlined');
      expect(btn.classList.contains('row-action-button')).toBe(true);
    }
  });

  function mockTwoServers() {
    vi.spyOn(getContext().serverMgmt, 'listServers').mockResolvedValue({
      servers: [
        { id: 'srv1', name: 'Server One' } as Server,
        { id: 'srv2', name: 'Server Two' } as Server,
      ],
      nextBookmark: '',
    });
  }

  it('shows the empty state instead of a modal when no server is resolvable and several exist', async () => {
    mockTwoServers();
    const el = await mount('$all');
    expect(el.shadowRoot!.querySelector('wa-dialog[data-pick-server]')).toBeNull();
    expect(el.shadowRoot!.querySelector('cca-server-select')).toBeNull();
    const table = el.shadowRoot!.querySelector('cca-data-table');
    expect(table!.getAttribute('empty-message')).toBe('No CouchDB server available.');
  });

  it('adopts the single server locally on a legacy $all deep link (#31)', async () => {
    // beforeEach mocks a single server (srv1).
    const list = vi.spyOn(getContext().users, 'listUsers').mockResolvedValue([
      { _id: 'org.couchdb.user:alice', name: 'alice', type: 'user', roles: [] },
    ] as UserDoc[]);
    const el = await mount('$all');
    expect(el.shadowRoot!.querySelector('wa-dialog[data-pick-server]')).toBeNull();
    expect(list).toHaveBeenCalledWith('srv1');
  });

  it('filters rows client-side by username without refetching', async () => {
    const spy = vi.spyOn(getContext().users, 'listUsers').mockResolvedValue([
      { _id: 'org.couchdb.user:alice', name: 'alice', type: 'user', roles: ['reader'] },
      { _id: 'org.couchdb.user:bob', name: 'bob', type: 'user', roles: ['writer'] },
    ] as UserDoc[]);
    const el = await mount('srv1');
    spy.mockClear();

    const input = el.shadowRoot!.querySelector('wa-input') as HTMLInputElement;
    (input as any).value = 'ali';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await el.updateComplete;

    const table = el.shadowRoot!.querySelector('cca-data-table') as any;
    expect(table.rows.map((u: UserDoc) => u.name)).toEqual(['alice']);
    expect(spy).not.toHaveBeenCalled();
  });

  it('matches roles too, case-insensitively', async () => {
    vi.spyOn(getContext().users, 'listUsers').mockResolvedValue([
      { _id: 'org.couchdb.user:alice', name: 'alice', type: 'user', roles: ['Auditor'] },
      { _id: 'org.couchdb.user:bob', name: 'bob', type: 'user', roles: ['writer'] },
    ] as UserDoc[]);
    const el = await mount('srv1');

    const input = el.shadowRoot!.querySelector('wa-input') as HTMLInputElement;
    (input as any).value = 'audit';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await el.updateComplete;

    const table = el.shadowRoot!.querySelector('cca-data-table') as any;
    expect(table.rows.map((u: UserDoc) => u.name)).toEqual(['alice']);
  });

  it('clearing the search restores the full list', async () => {
    vi.spyOn(getContext().users, 'listUsers').mockResolvedValue([
      { _id: 'org.couchdb.user:alice', name: 'alice', type: 'user', roles: [] },
      { _id: 'org.couchdb.user:bob', name: 'bob', type: 'user', roles: [] },
    ] as UserDoc[]);
    const el = await mount('srv1');

    const input = el.shadowRoot!.querySelector('wa-input') as HTMLInputElement;
    (input as any).value = 'ali';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await el.updateComplete;
    (input as any).value = '';
    input.dispatchEvent(new CustomEvent('wa-clear', { bubbles: true }));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await el.updateComplete;

    const table = el.shadowRoot!.querySelector('cca-data-table') as any;
    expect(table.rows.length).toBe(2);
  });
});
