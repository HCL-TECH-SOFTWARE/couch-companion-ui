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
import { getRouter } from '../src/customEventRouter.js';
import '../src/components/cca-header';
import '../src/components/server-dashboard/cca-server-dashboard';
import { ALL_REQUEST_EVENTS, STORAGE_DATA, WELCOME_DATA } from '../src/components/server-dashboard/events';
import { SINGLE_SERVER_ID } from '../src/services/single-server.js';

let provider: HTMLElement;
let header: HTMLElement & { updateComplete: Promise<unknown>; pageTitle: string };
beforeEach(() => {
  provider = document.createElement('cca-router-provider');
  document.body.appendChild(provider);
  // Refresh and the page title now live in cca-header; mount one so the
  // dashboard's connectedCallback has a header to drive.
  header = document.createElement('cca-header') as typeof header;
  header.pageTitle = 'Servers';
  document.body.appendChild(header);
});
afterEach(() => {
  document.body.querySelectorAll('cca-server-dashboard').forEach((e) => e.remove());
  header.remove();
  provider.remove();
  vi.restoreAllMocks();
});

function mount(id: string): any {
  const el = document.createElement('cca-server-dashboard') as any;
  el.serverId = id;
  document.body.appendChild(el);
  return el;
}

/** Resolves the click handler the dashboard registered on the header for `icon`. */
async function headerAction(icon: string): Promise<(e: Event) => void> {
  await header.updateComplete;
  const action = header.shadowRoot!.querySelector(`cca-action[icon="${icon}"]`) as
    (Element & { action?: (e: Event) => void }) | null;
  if (!action?.action) throw new Error(`no header action for icon: ${icon}`);
  return action.action;
}

function headerTitle(): string {
  return header.shadowRoot!.querySelector('.title')?.textContent?.trim() ?? '';
}

describe('cca-server-dashboard', () => {
  it('passes its id to all five tiles as server-id', async () => {
    const el = mount('server:abc');
    await el.updateComplete;
    const ids = [
      'cca-dashboard-welcome',
      'cca-dashboard-storage',
      'cca-dashboard-replications',
      'cca-dashboard-tasks',
      'cca-dashboard-idp'
    ].map((tag) => el.shadowRoot!.querySelector(tag)?.getAttribute('server-id'));
    expect(ids).toEqual(Array(5).fill('server:abc'));
  });

  it('re-publishes every request event when the header Refresh action runs', async () => {
    const el = mount('server:abc');
    await el.updateComplete;
    const seen: string[] = [];
    const token = {};
    for (const name of ALL_REQUEST_EVENTS) {
      getRouter().subscribe(token, name, () => seen.push(name));
    }
    (await headerAction('rotate'))(new Event('click'));
    getRouter().unsubscribe(token);
    expect(seen.sort()).toEqual([...ALL_REQUEST_EVENTS].sort());
  });

  it('registers no back action — the dashboard is the home page', async () => {
    const el = mount(SINGLE_SERVER_ID);
    await el.updateComplete;
    await expect(headerAction('arrow-left')).rejects.toThrow(/no header action/);
  });

  // Every user lands here, and `_all_dbs` is admin-only by CouchDB's default
  // (spec D9): a non-admin must see the tile say so, not a broken page.
  it('degrades to the tile error text when the user is not a server admin', async () => {
    const el = mount(SINGLE_SERVER_ID);
    await el.updateComplete;
    const storage = el.shadowRoot.querySelector('cca-dashboard-storage') as any;

    getRouter().publish(STORAGE_DATA, {
      serverId: SINGLE_SERVER_ID,
      error: 'unauthorized: You are not a server admin.'
    });
    await storage.updateComplete;

    expect(storage.shadowRoot.textContent).toContain('You are not a server admin.');
    // One tile's permission error must not take the landing page down with it.
    const tiles = [...el.shadowRoot.querySelectorAll('.grid > *')].map((t: Element) =>
      t.tagName.toLowerCase()
    );
    expect(tiles).toEqual([
      'cca-dashboard-welcome',
      'cca-dashboard-software',
      'cca-dashboard-storage',
      'cca-dashboard-replications',
      'cca-dashboard-tasks',
      'cca-dashboard-idp'
    ]);
  });

  it("sets the header title to 'Server [name]' from a welcome:data event", async () => {
    const el = mount('server:abc');
    await el.updateComplete;
    getRouter().publish(WELCOME_DATA, { serverId: 'server:abc', name: 'Prod' });
    await el.updateComplete;
    await header.updateComplete;
    expect(headerTitle()).toBe('Server Prod');
  });
});
