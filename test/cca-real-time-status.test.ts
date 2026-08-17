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
import type { StatusUpdate } from '../src/services/reachability-status-service';
import { getRouter } from '../src/customEventRouter';

const h = vi.hoisted(() => ({
  calls: [] as { id: string; initialReachable: boolean }[],
  emit: null as ((u: StatusUpdate) => void) | null,
  unsubscribe: vi.fn(),
}));

vi.mock('../src/context', () => ({
  getContext: () => ({
    reachabilityStatus: {
      subscribe: (
        id: string,
        cb: (u: StatusUpdate) => void,
        initialReachable = false,
      ) => {
        h.calls.push({ id, initialReachable });
        h.emit = cb;
        return h.unsubscribe;
      },
    },
  }),
}));

import '../src/components/cca-real-time-status';
import type { CcaRealTimeStatus } from '../src/components/cca-real-time-status';

const UPDATE: StatusUpdate = {
  id: 'server:a',
  reachable: true,
  couch_version: '3.3.3',
  checked_at: '2026-07-10T00:00:00Z',
};

async function mount(id = 'server:a', reachable = false): Promise<CcaRealTimeStatus> {
  const el = document.createElement('cca-real-time-status') as CcaRealTimeStatus;
  el.id = id;
  el.reachable = reachable;
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

const dot = (el: CcaRealTimeStatus) => el.shadowRoot!.querySelector('.dot')!.className;

beforeEach(() => {
  h.calls = [];
  h.emit = null;
  h.unsubscribe = vi.fn();
});

afterEach(() => {
  document.body.replaceChildren();
});

describe('cca-real-time-status', () => {
  it('subscribes exactly once on mount, seeded with its reachable prop', async () => {
    await mount('server:a', true);
    expect(h.calls).toEqual([{ id: 'server:a', initialReachable: true }]);
  });

  it('does not subscribe without an id', async () => {
    await mount('');
    expect(h.calls).toEqual([]);
  });

  it('unsubscribes on unmount', async () => {
    const el = await mount();
    el.remove();
    expect(h.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('resubscribes with the new id when id changes', async () => {
    const el = await mount('server:a');
    el.id = 'server:b';
    await el.updateComplete;

    expect(h.unsubscribe).toHaveBeenCalledTimes(1);
    expect(h.calls.map((c) => c.id)).toEqual(['server:a', 'server:b']);
  });

  it('does not resubscribe when an unrelated property changes', async () => {
    const el = await mount('server:a');
    el.showLabel = true;
    await el.updateComplete;
    expect(h.calls).toHaveLength(1);
  });

  it('renders unknown, then up or down as updates arrive', async () => {
    const el = await mount();
    expect(dot(el)).toContain('unknown');

    h.emit!(UPDATE);
    await el.updateComplete;
    expect(dot(el)).toContain('up');

    h.emit!({ ...UPDATE, reachable: false });
    await el.updateComplete;
    expect(dot(el)).toContain('down');
  });

  it('shows a label only when show-label is set', async () => {
    const el = await mount();
    expect(el.shadowRoot!.querySelector('.label')).toBeNull();

    el.showLabel = true;
    await el.updateComplete;
    expect(el.shadowRoot!.querySelector('.label')!.textContent).toContain('checking');
  });

  it('re-emits each update as a cca-status-update CustomEvent', async () => {
    const el = await mount();
    const seen: StatusUpdate[] = [];
    el.addEventListener('cca-status-update', (e) =>
      seen.push((e as CustomEvent<StatusUpdate>).detail),
    );

    h.emit!(UPDATE);
    expect(seen).toEqual([UPDATE]);
  });

  it('the update event crosses a shadow boundary (composed)', async () => {
    // Put the component inside a host's shadow root; listen on document,
    // which is OUTSIDE that boundary. Only a composed event reaches it.
    const host = document.createElement('div');
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const el = document.createElement('cca-real-time-status') as CcaRealTimeStatus;
    el.id = 'server:a';
    shadow.appendChild(el);
    await el.updateComplete;

    const seen: StatusUpdate[] = [];
    document.addEventListener('cca-status-update', (e) =>
      seen.push((e as CustomEvent<StatusUpdate>).detail),
    );

    // fire an update through the mocked subscribe callback for THIS element
    h.emit!(UPDATE);
    expect(seen).toEqual([UPDATE]);
  });

  it('publishes status:update to the router', async () => {
    getRouter(true); // fresh router
    const provider = document.createElement('cca-router-provider');
    document.body.appendChild(provider);
    const el = document.createElement('cca-real-time-status') as CcaRealTimeStatus;
    el.id = 'server:a';
    provider.appendChild(el);
    await el.updateComplete;

    const received: unknown[] = [];
    const token = {};
    getRouter().subscribe(token, 'status:update', (_t, event) => {
      received.push((event as CustomEvent).detail);
    });

    h.emit!(UPDATE);
    getRouter().unsubscribe(token);

    expect(received).toEqual([{ update: UPDATE }]);
  });
});
