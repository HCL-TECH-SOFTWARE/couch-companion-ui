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
import '../src/components/server-dashboard/cca-dashboard-tasks';
import { TASKS_REQUEST, TASKS_DATA } from '../src/components/server-dashboard/events';

let provider: HTMLElement;
beforeEach(() => {
  provider = document.createElement('cca-router-provider');
  document.body.appendChild(provider);
});
afterEach(() => {
  document.body.querySelectorAll('cca-dashboard-tasks').forEach((e) => e.remove());
  provider.remove();
});

function mount(serverId: string): any {
  const el = document.createElement('cca-dashboard-tasks') as any;
  el.serverId = serverId;
  document.body.appendChild(el);
  return el;
}

describe('cca-dashboard-tasks', () => {
  it('publishes a tasks:request when serverId is set', async () => {
    const seen: any[] = [];
    const token = {};
    getRouter().subscribe(token, TASKS_REQUEST, (_t, ev) => seen.push((ev as CustomEvent).detail));
    const el = mount('server:abc');
    await el.updateComplete;
    getRouter().unsubscribe(token);
    expect(seen).toEqual([{ serverId: 'server:abc' }]);
  });

  it('lists task types and counts on data', async () => {
    const el = mount('server:abc');
    await el.updateComplete;
    getRouter().publish(TASKS_DATA, {
      serverId: 'server:abc',
      byType: { replication: 2, indexer: 1 }
    });
    await el.updateComplete;
    const text = el.shadowRoot.textContent;
    expect(text).toContain('replication');
    expect(text).toContain('indexer');
    // the count renders via wa-format-number (own shadow DOM) — assert its value.
    expect(el.shadowRoot.querySelector('wa-format-number[value="2"]')).toBeTruthy();
  });

  it('shows an empty state when there are no tasks', async () => {
    const el = mount('server:abc');
    await el.updateComplete;
    getRouter().publish(TASKS_DATA, { serverId: 'server:abc', byType: {} });
    await el.updateComplete;
    expect(el.shadowRoot!.textContent).toContain('No active tasks');
  });

  it('links the heading to the active-tasks page for this server', async () => {
    const el = mount('srv1');
    await el.updateComplete;
    const link = el.shadowRoot.querySelector('h3 a');
    expect(link?.getAttribute('href')).toBe('#/active-tasks/srv1');
    expect(link?.textContent?.trim()).toBe('Active Tasks');
  });
});
