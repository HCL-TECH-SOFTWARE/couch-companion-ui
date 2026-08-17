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
import '../src/components/server-dashboard/cca-dashboard-software';
import { WELCOME_REQUEST, WELCOME_DATA } from '../src/components/server-dashboard/events';

let provider: HTMLElement;

beforeEach(() => {
  provider = document.createElement('cca-router-provider');
  document.body.appendChild(provider);
});

afterEach(() => {
  document.body.querySelectorAll('cca-dashboard-software').forEach((e) => e.remove());
  provider.remove();
});

function mountSoftware(serverId: string): HTMLElement & { updateComplete: Promise<unknown> } {
  const el = document.createElement('cca-dashboard-software') as HTMLElement & {
    serverId: string;
    updateComplete: Promise<unknown>;
  };
  el.serverId = serverId;
  document.body.appendChild(el);
  return el;
}

describe('cca-dashboard-software', () => {
  // It shares WELCOME_REQUEST/WELCOME_DATA with the Server tile on purpose: the service
  // coalesces in-flight welcome fetches per serverId, so a second subscriber is free.
  it('publishes a welcome:request once its serverId is set', async () => {
    const seen: unknown[] = [];
    const token = {};
    getRouter().subscribe(token, WELCOME_REQUEST, (_t, ev) => seen.push((ev as CustomEvent).detail));
    const el = mountSoftware('server:abc');
    await el.updateComplete;
    getRouter().unsubscribe(token);
    expect(seen).toEqual([{ serverId: 'server:abc' }]);
  });

  it('renders version, vendor, build and features on a matching welcome:data event', async () => {
    const el = mountSoftware('server:abc');
    await el.updateComplete;
    getRouter().publish(WELCOME_DATA, {
      serverId: 'server:abc',
      version: '3.3.3',
      gitSha: '40bce0dc5',
      vendor: 'The Apache Software Foundation',
      features: ['scheduler', 'partitioned']
    });
    await el.updateComplete;
    const text = el.shadowRoot!.textContent ?? '';
    for (const label of ['Version', 'Vendor', 'Build', 'Features']) {
      expect(text).toContain(label);
    }
    expect(text).toContain('CouchDB 3.3.3');
    expect(text).toContain('40bce0dc5');
    expect(text).toContain('The Apache Software Foundation');
    expect(text).toContain('scheduler');
    expect(text).toContain('partitioned');
  });

  // The fields that stayed behind on the Server tile must not reappear here.
  it('does not render the instance fields that stayed on the Server tile', async () => {
    const el = mountSoftware('server:abc');
    await el.updateComplete;
    getRouter().publish(WELCOME_DATA, {
      serverId: 'server:abc',
      name: 'Prod',
      url: 'http://couch:5984',
      username: 'admin',
      uuid: 'deadbeef',
      vendor: 'ASF'
    });
    await el.updateComplete;
    const text = el.shadowRoot!.textContent ?? '';
    for (const label of ['URL', 'Username', 'UUID', 'Last checked']) {
      expect(text).not.toContain(label);
    }
    expect(text).not.toContain('deadbeef');
  });

  it('ignores a welcome:data event for a different server', async () => {
    const el = mountSoftware('server:abc');
    await el.updateComplete;
    getRouter().publish(WELCOME_DATA, { serverId: 'server:other', vendor: 'Someone Else' });
    await el.updateComplete;
    expect(el.shadowRoot!.textContent ?? '').not.toContain('Someone Else');
  });

  // Three states that must not collapse: never asked, asked and got none, asked and got some.
  it('distinguishes "no features" from "features unknown"', async () => {
    const el = mountSoftware('server:abc');
    await el.updateComplete;
    getRouter().publish(WELCOME_DATA, { serverId: 'server:abc', features: [] });
    await el.updateComplete;
    expect(el.shadowRoot!.textContent).toContain('none');

    const el2 = mountSoftware('server:xyz');
    await el2.updateComplete;
    getRouter().publish(WELCOME_DATA, { serverId: 'server:xyz', vendor: 'ASF' });
    await el2.updateComplete;
    expect(el2.shadowRoot!.textContent).not.toContain('none');
  });

  it('surfaces the error from a failed welcome record', async () => {
    const el = mountSoftware('server:abc');
    await el.updateComplete;
    getRouter().publish(WELCOME_DATA, { serverId: 'server:abc', error: 'nope' });
    await el.updateComplete;
    expect(el.shadowRoot!.textContent).toContain('nope');
  });
});
