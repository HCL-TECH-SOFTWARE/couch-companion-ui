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
import '../src/components/server-dashboard/cca-dashboard-welcome';
import { WELCOME_REQUEST, WELCOME_DATA } from '../src/components/server-dashboard/events';

let provider: HTMLElement;

beforeEach(() => {
  provider = document.createElement('cca-router-provider');
  document.body.appendChild(provider);
});

afterEach(() => {
  document.body.querySelectorAll('cca-dashboard-welcome').forEach((e) => e.remove());
  provider.remove();
});

function mountWelcome(serverId: string): HTMLElement & { updateComplete: Promise<unknown> } {
  const el = document.createElement('cca-dashboard-welcome') as any;
  el.serverId = serverId;
  document.body.appendChild(el);
  return el;
}

describe('cca-dashboard-welcome', () => {
  it('publishes a welcome:request once its serverId is set', async () => {
    const seen: any[] = [];
    const token = {};
    getRouter().subscribe(token, WELCOME_REQUEST, (_t, ev) => seen.push((ev as CustomEvent).detail));
    const el = mountWelcome('server:abc');
    await el.updateComplete;
    getRouter().unsubscribe(token);
    expect(seen).toEqual([{ serverId: 'server:abc' }]);
  });

  it('renders labelled fields on a matching welcome:data event', async () => {
    const el = mountWelcome('server:abc');
    await el.updateComplete;
    getRouter().publish(WELCOME_DATA, {
      serverId: 'server:abc',
      name: 'Prod',
      url: 'http://couch:5984',
      username: 'admin',
      version: '3.3.3',
      reachable: true,
      lastChecked: '2026-01-02T03:04:05Z'
    });
    await el.updateComplete;
    const text = el.shadowRoot!.textContent ?? '';
    // values

    expect(text).toContain('http://couch:5984');
    expect(text).toContain('admin');

    expect(text).toContain('Reachable');
    // labels
    for (const label of ['URL', 'Username', 'Status', 'Last checked']) {
      expect(text).toContain(label);
    }
  });

  it('ignores data for a different serverId', async () => {
    const el = mountWelcome('server:abc');
    await el.updateComplete;
    getRouter().publish(WELCOME_DATA, { serverId: 'server:other', name: 'Nope' });
    await el.updateComplete;
    expect(el.shadowRoot!.textContent).not.toContain('Nope');
  });

  it('shows an error state when the payload carries an error', async () => {
    const el = mountWelcome('server:abc');
    await el.updateComplete;
    getRouter().publish(WELCOME_DATA, { serverId: 'server:abc', error: 'boom' });
    await el.updateComplete;
    expect(el.shadowRoot!.textContent).toContain('boom');
  });

  it('renders the live welcome fields from GET /', async () => {
    const el = mountWelcome('server:abc');
    await el.updateComplete;
    getRouter().publish(WELCOME_DATA, {
      serverId: 'server:abc',
      name: 'Prod',
      version: '3.3.3',
      reachable: true,
      couchdb: 'Welcome',
      uuid: 'abc123',
      gitSha: '40bce0dc5',
      vendor: 'The Apache Software Foundation',
      features: ['scheduler', 'partitioned']
    });
    await el.updateComplete;
    const text = el.shadowRoot!.textContent ?? '';
    expect(text).toContain('abc123');
    expect(text).toContain('UUID');
    // #41: vendor, build and features moved to <cca-dashboard-software>. Assert they are
    // gone, so a future re-merge of the two tiles cannot pass this suite unnoticed.
    for (const gone of ['Name', 'Version', 'Vendor', 'Build', 'Features', '40bce0dc5', 'The Apache Software Foundation', 'scheduler']) {
      expect(text).not.toContain(gone);
    }
  });

  // The point of decision #2 in #587: an unreachable server loses its live details but keeps its
  // tile. Collapsing the whole tile to an error would throw away the stored record, which is
  // exactly the information you want when a server is down.
  it('keeps the stored fields and warns when only the live fetch failed', async () => {
    const el = mountWelcome('server:abc');
    await el.updateComplete;
    getRouter().publish(WELCOME_DATA, {
      serverId: 'server:abc',
      name: 'Edge',
      url: 'http://edge:5984',
      reachable: false,
      lastChecked: '2026-01-02T03:04:05Z',
      liveError: 'Bad Gateway'
    });
    await el.updateComplete;
    const text = el.shadowRoot!.textContent ?? '';
    // The record still renders — carried by the URL now that the name is gone (#41).
    expect(text).toContain('http://edge:5984');
    expect(text).toContain('Unreachable');
    // …and the live failure is surfaced rather than silently blank.
    expect(text).toContain('Bad Gateway');
    // Not the hard-error state: the tile still has its field list.
    expect(el.shadowRoot!.querySelector('.fields')).not.toBeNull();
  });

  // #796: the tile tints its own card by reachability so a grid of tiles reads
  // at a glance. Quiet fill tokens keep text readable; the Status badge remains
  // the semantic carrier — the tint is reinforcement only.
  describe('reachability tint', () => {
    it('tints the card success when reachable', async () => {
      const el = mountWelcome('server:abc');
      await el.updateComplete;
      getRouter().publish(WELCOME_DATA, { serverId: 'server:abc', name: 'Prod', reachable: true });
      await el.updateComplete;
      const card = el.shadowRoot!.querySelector('wa-card')!;
      expect(card.classList.contains('reachable')).toBe(true);
      expect(card.classList.contains('unreachable')).toBe(false);
    });

    it('tints the card danger when unreachable', async () => {
      const el = mountWelcome('server:abc');
      await el.updateComplete;
      getRouter().publish(WELCOME_DATA, { serverId: 'server:abc', name: 'Edge', reachable: false });
      await el.updateComplete;
      const card = el.shadowRoot!.querySelector('wa-card')!;
      expect(card.classList.contains('unreachable')).toBe(true);
      expect(card.classList.contains('reachable')).toBe(false);
    });

    it('stays neutral while loading and on record error', async () => {
      const el = mountWelcome('server:abc');
      await el.updateComplete;
      let card = el.shadowRoot!.querySelector('wa-card')!;
      expect(card.classList.contains('reachable')).toBe(false);
      expect(card.classList.contains('unreachable')).toBe(false);

      getRouter().publish(WELCOME_DATA, { serverId: 'server:abc', error: 'boom' });
      await el.updateComplete;
      card = el.shadowRoot!.querySelector('wa-card')!;
      expect(card.classList.contains('reachable')).toBe(false);
      expect(card.classList.contains('unreachable')).toBe(false);
    });
  });
});
