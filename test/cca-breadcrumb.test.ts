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
import { fixture, html } from '@open-wc/testing';
import { getContext } from '../src/context';
import { SINGLE_SERVER_ID } from '../src/services/single-server';
import type { CcaBreadcrumb } from '../src/components/cca-breadcrumb';
// cca-breadcrumb.ts doesn't register these itself (the app does once, globally, via
// src/webawesome.ts). Registered here anyway so a resurrected dropdown would be a real
// component, not an inert unknown element the "no switcher" assertions could miss.
import '@awesome.me/webawesome/dist/components/dropdown/dropdown.js';
import '@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '../src/components/cca-breadcrumb';

async function mountAt(path: string): Promise<CcaBreadcrumb> {
  getContext().router.navigate(path);
  getContext().router.resolve();
  const el = (await fixture(html`<cca-breadcrumb></cca-breadcrumb>`)) as CcaBreadcrumb;
  await new Promise((r) => setTimeout(r, 0));
  await el.updateComplete;
  return el;
}

describe('cca-breadcrumb trail', () => {
  beforeEach(() => {
    vi.spyOn(getContext().serverMgmt, 'listServers').mockResolvedValue({ servers: [], nextBookmark: '' });
    getContext().router.addRoute({ path: '/databases/:serverId/:dbName/documents', component: 'cca-doc-browser' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('builds a crumb per route segment with cumulative hash hrefs', async () => {
    getContext().router.navigate('/databases/srv1/mydb/documents');
    await new Promise(r => setTimeout(r, 0));
    const el = await fixture(html`<cca-breadcrumb></cca-breadcrumb>`);
    const hrefs = [...el.shadowRoot!.querySelectorAll('wa-breadcrumb-item')].map((i) => i.getAttribute('href'));
    expect(hrefs).toContain('#/');
    expect(hrefs).toContain('#/databases/srv1/mydb/documents');
  });

  it('labels the $all server segment "All servers"', async () => {
    const el = await mountAt('/databases/$all/mydb/documents');
    const crumb = el.shadowRoot!.querySelector('wa-breadcrumb-item[data-server-crumb]');
    expect(crumb?.textContent?.trim()).toBe('All servers');
  });

  // #31: this deployment manages exactly one CouchDB, so there is nothing to
  // switch to. The :serverId segment survives (deep links must keep working)
  // but the crumb that rendered it is inert context text now.
  describe('no server switcher (#31)', () => {
    it('renders no dropdown anywhere in the trail', async () => {
      const el = await mountAt(`/databases/${SINGLE_SERVER_ID}/mydb/documents`);
      expect(el.shadowRoot!.querySelector('wa-dropdown')).toBeNull();
      expect(el.shadowRoot!.querySelector('wa-dropdown-item')).toBeNull();
      expect(el.shadowRoot!.querySelector('[slot="trigger"]')).toBeNull();
    });

    it('renders the server segment as plain, unlinked text', async () => {
      const el = await mountAt(`/databases/${SINGLE_SERVER_ID}/mydb/documents`);
      const crumb = el.shadowRoot!.querySelector('wa-breadcrumb-item[data-server-crumb]')!;
      expect(crumb.textContent?.trim()).toBe(SINGLE_SERVER_ID);
      expect(crumb.hasAttribute('href')).toBe(false);
      expect(crumb.querySelector('wa-button')).toBeNull();
    });

    it('never loads the server registry just to draw a crumb', async () => {
      const list = vi.spyOn(getContext().serverMgmt, 'listServers');
      await mountAt(`/databases/${SINGLE_SERVER_ID}/mydb/documents`);
      expect(list).not.toHaveBeenCalled();
    });

    it('keeps the non-server crumbs linked and in order', async () => {
      const el = await mountAt(`/databases/${SINGLE_SERVER_ID}/mydb/documents`);
      const labels = [...el.shadowRoot!.querySelectorAll('wa-breadcrumb-item')].map((i) =>
        i.textContent?.trim()
      );
      expect(labels).toEqual(['Home', 'Databases', SINGLE_SERVER_ID, 'mydb', 'Documents']);
      const last = el.shadowRoot!.querySelector('wa-breadcrumb-item:last-of-type');
      expect(last?.getAttribute('href')).toBe(`#/databases/${SINGLE_SERVER_ID}/mydb/documents`);
    });
  });
});
