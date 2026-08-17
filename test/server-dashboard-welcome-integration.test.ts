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

// End-to-end through everything the browser would run, minus the network and the paint: the real
// ApiClient, the real ServerMgmtService, the real ServerDashboardService, the real event router
// and the real <cca-dashboard-welcome>. Only `fetch` is stubbed — and it answers with the exact
// shapes CouchDB's `GET /` and `GET /_session` return, so a change to the response shape fails
// here instead of only in a browser nobody reruns.
//
// The unit tests either side of this cover the service and the tile in isolation, with hand-fed
// payloads. What they cannot catch is a mismatch *between* the layers — a field the service reads
// as `git_sha` and the tile expects as `gitSha`, say. That seam is what this test exists to pin.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getRouter } from '../src/customEventRouter.js';
import { ApiClient } from '../src/services/api-client.js';
import { ServerMgmtService } from '../src/services/server-mgmt-service.js';
import { ServerDashboardService } from '../src/services/server-dashboard-service.js';
import { SINGLE_SERVER_ID } from '../src/services/single-server.js';
import '../src/components/server-dashboard/cca-dashboard-welcome';
import '../src/components/server-dashboard/cca-dashboard-software';

// Verbatim shape of CouchDB's GET / on a reachable node.
const WELCOME_REACHABLE = {
  couchdb: 'Welcome',
  version: '3.3.3',
  uuid: '8a1b0c2d3e4f5a6b7c8d9e0f1a2b3c4d',
  git_sha: '40bce0dc5',
  features: ['access-ready', 'partitioned', 'pluggable-storage-engines', 'reshard', 'scheduler'],
  vendor: { name: 'The Apache Software Foundation' }
};
const SESSION_OK = { ok: true, userCtx: { name: 'admin', roles: ['_admin'] } };
const UPSTREAM_UNREACHABLE = {
  type: 'about:blank',
  title: 'Upstream Unreachable',
  status: 502,
  detail: 'Failed to reach CouchDB'
};

/** Routes by URL, the way the mock does, so the two in-flight requests cannot be confused. */
function stubFetch(routes: Record<string, { body: unknown; status: number }>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    const match = Object.keys(routes).find((path) => url.endsWith(path));
    if (!match) throw new Error(`unstubbed request: ${url}`);
    const { body, status } = routes[match];
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: String(status),
      headers: { get: () => 'application/json' },
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body))
    } as unknown as Response;
  });
}

let provider: HTMLElement;
let svc: ServerDashboardService;

beforeEach(() => {
  // Reset the router singleton *before* the provider mounts. The provider hands the tile whichever
  // router existed when it was created, so swapping the singleton afterwards would leave the tile
  // publishing on one router while the service listens on another, and the tile would spin forever.
  getRouter(true);
  provider = document.createElement('cca-router-provider');
  document.body.appendChild(provider);
});

afterEach(() => {
  svc?.stop();
  document.body.querySelectorAll('cca-dashboard-welcome, cca-dashboard-software').forEach((e) => e.remove());
  provider.remove();
  vi.restoreAllMocks();
});

/** Wires the real stack and mounts the real tile, exactly as `context.ts` does at runtime. */
async function mount(serverId: string, tag = 'cca-dashboard-welcome') {
  const router = getRouter();
  const serverMgmt = new ServerMgmtService(new ApiClient(''));
  svc = new ServerDashboardService(serverMgmt, {} as never, {} as never, router);
  svc.start();

  const el = document.createElement(tag) as HTMLElement & {
    serverId: string;
    updateComplete: Promise<unknown>;
  };
  el.serverId = serverId;
  document.body.appendChild(el);
  await el.updateComplete;

  // Two fetches, an allSettled and a publish stand between mount and paint; a fixed number of
  // ticks is a guess that passes locally and flakes on a loaded CI box. Poll for the field list
  // the tile only renders once its data has actually landed.
  await vi.waitFor(() => {
    if (!el.shadowRoot?.querySelector('.fields')) {
      throw new Error('tile still rendering its spinner');
    }
  });
  await el.updateComplete;
  return el;
}

describe('welcome tile, wired end to end', () => {
  it('renders the live GET / of a reachable server', async () => {
    stubFetch({
      '/': { body: WELCOME_REACHABLE, status: 200 },
      '/_session': { body: SESSION_OK, status: 200 }
    });

    const el = await mount(SINGLE_SERVER_ID);
    const text = el.shadowRoot!.textContent ?? '';

    // From the synthesized record (GET /_session + reachability).
    expect(text).toContain('admin');
    expect(text).toContain('Reachable');
    // From the live welcome document — the whole point of #587. These reach the DOM only if the
    // snake_case wire fields survived the service's mapping into the tile's camelCase payload.
    expect(text).toContain('8a1b0c2d3e4f5a6b7c8d9e0f1a2b3c4d'); // uuid
    // #41: these three moved to <cca-dashboard-software>. The seam under test is the
    // service's snake_case -> camelCase mapping, which is tile-agnostic, so assert them
    // on the tile that renders them rather than dropping the coverage.
    const sw = await mount(SINGLE_SERVER_ID, 'cca-dashboard-software');
    const swText = sw.shadowRoot!.textContent ?? '';
    expect(swText).toContain('40bce0dc5'); // git_sha -> gitSha -> "Build"
    expect(swText).toContain('The Apache Software Foundation'); // vendor.name -> vendor
    expect(swText).toContain('scheduler'); // features[]
    expect(swText).toContain('reshard');
  });

  it('keeps the tile alive when the server is down and GET / 502s', async () => {
    stubFetch({
      '/': { body: UPSTREAM_UNREACHABLE, status: 502 },
      '/_session': { body: UPSTREAM_UNREACHABLE, status: 502 }
    });

    const el = await mount(SINGLE_SERVER_ID);
    const text = el.shadowRoot!.textContent ?? '';

    // The record still renders — this is the degrade, not a dead tile.
    expect(text).toContain('Unreachable');
    expect(el.shadowRoot!.querySelector('.fields')).not.toBeNull();
    // The live failure is stated rather than left as a silent row of em dashes.
    expect(text.toLowerCase()).toContain('could not read');
    // And no live values leaked in from anywhere.
    expect(text).not.toContain('40bce0dc5');
  });
});
