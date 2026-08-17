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

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getRouter } from '../src/customEventRouter.js';
import '../src/components/server-dashboard/cca-dashboard-idp';
import { IDP_REQUEST, IDP_DATA } from '../src/components/server-dashboard/events';

let provider: HTMLElement;
beforeEach(() => {
  provider = document.createElement('cca-router-provider');
  document.body.appendChild(provider);
});
afterEach(() => {
  document.body.querySelectorAll('cca-dashboard-idp').forEach((e) => e.remove());
  provider.remove();
});

function mount(serverId: string): any {
  const el = document.createElement('cca-dashboard-idp') as any;
  el.serverId = serverId;
  document.body.appendChild(el);
  return el;
}

describe('cca-dashboard-idp', () => {
  it('publishes an idp:request when serverId is set', async () => {
    const seen: any[] = [];
    const token = {};
    getRouter().subscribe(token, IDP_REQUEST, (_t, ev) => seen.push((ev as CustomEvent).detail));
    const el = mount('server:abc');
    await el.updateComplete;
    getRouter().unsubscribe(token);
    expect(seen).toEqual([{ serverId: 'server:abc' }]);
  });

  it('lists configured IdPs on data', async () => {
    const el = mount('server:abc');
    await el.updateComplete;
    getRouter().publish(IDP_DATA, {
      serverId: 'server:abc',
      idps: [{ id: 'okta-1', name: 'Okta', issuer: 'https://okta' }]
    });
    await el.updateComplete;
    expect(el.shadowRoot!.textContent).toContain('Okta');
  });

  it('links the heading to the global IdP list', async () => {
    const el = mount('srv1');
    await el.updateComplete;
    const link = el.shadowRoot.querySelector('h3 a');
    expect(link?.getAttribute('href')).toBe('#/idp');
    expect(link?.textContent?.trim()).toBe('Identity Providers');
  });

  it('links each IdP name to its detail page', async () => {
    const el = mount('srv1');
    await el.updateComplete;
    getRouter().publish(IDP_DATA, {
      serverId: 'srv1',
      idps: [{ id: 'okta-1', name: 'Okta', issuer: 'https://okta' }]
    });
    await el.updateComplete;
    const link = el.shadowRoot.querySelector('a[href="#/idp/okta-1"]');
    expect(link?.textContent?.trim()).toBe('Okta');
  });

  it('shows an empty state with no IdPs', async () => {
    const el = mount('server:abc');
    await el.updateComplete;
    getRouter().publish(IDP_DATA, { serverId: 'server:abc', idps: [] });
    await el.updateComplete;
    expect(el.shadowRoot!.textContent).toContain('No identity providers');
  });
});
