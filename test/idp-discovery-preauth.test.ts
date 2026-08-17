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

/**
 * Discovery runs on the login screen, before anyone has authenticated. It must therefore not
 * engage `ApiClient`'s centralized 401 handling.
 *
 * Verified live against CouchDB 3.5.2: `GET /_idp` answers **401**, not 404 — every reserved
 * `_`-prefixed top-level path does. That 401 would otherwise make `ApiClient` probe
 * `/_session` and log "Session confirmed expired" on every single login page view, for a user
 * who was never signed in.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiClient } from '../src/services/api-client';
import { discoverIdps } from '../src/services/idp-discovery';
import { couchError, jsonResponse } from './helpers/response';

const IDP_CONFIG = {
  idps: [
    {
      name: 'Dev Keycloak',
      issuer: 'http://localhost:8080/realms/couch',
      client_id: 'couch-companion-ui',
      well_known_url: 'http://localhost:8080/realms/couch/.well-known/openid-configuration',
      roles_claim: 'roles',
      idp_only: false,
    },
  ],
};

const SESSION = {
  ok: true,
  userCtx: { name: null, roles: [] },
  info: { authentication_handlers: ['jwt', 'cookie', 'default'] },
};

/**
 * CouchDB's real answers: `_idp` is reserved and 401s; `idp/config` is world-readable.
 *
 * Real `Response` objects, not duck types (#16/#17). The first version of this fixture
 * supplied only `text()`; `ApiClient` reads the error body with `resp.json()`, so it threw
 * before the 401 branch and three of these tests passed without exercising anything.
 */
function couchdb() {
  return vi.fn().mockImplementation(async (url: string) => {
    if (url.endsWith('/_idp')) {
      return couchError(401, 'unauthorized', 'Authentication required.');
    }
    if (url.endsWith('/idp/config')) return jsonResponse(IDP_CONFIG);
    if (url.endsWith('/_session')) return jsonResponse(SESSION);
    return couchError(404, 'not_found', 'missing');
  });
}

beforeEach(() => {
  globalThis.fetch = vi.fn().mockRejectedValue(new Error('unexpected network call in test'));
});

describe('discovery before login', () => {
  it('finds the IdP despite the reserved-path 401 on /_idp', async () => {
    globalThis.fetch = couchdb();
    const api = new ApiClient('http://couch.local');

    const found = await discoverIdps(api);

    expect(found.source).toBe('idp/config');
    expect(found.idps[0].name).toBe('Dev Keycloak');
    expect(found.jwtHandlerEnabled).toBe(true);
  });

  it('never triggers the centralized logout', async () => {
    globalThis.fetch = couchdb();
    const onUnauthorized = vi.fn();
    const api = new ApiClient('http://couch.local', onUnauthorized);

    await discoverIdps(api);

    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('does not issue an extra /_session probe for the 401', async () => {
    const spy = couchdb();
    globalThis.fetch = spy;
    const api = new ApiClient('http://couch.local', vi.fn());

    await discoverIdps(api);

    // Exactly one /_session request: discovery's own read of authentication_handlers.
    const sessionCalls = spy.mock.calls.filter((c) => String(c[0]).endsWith('/_session'));
    expect(sessionCalls).toHaveLength(1);
  });

  it('still reports nothing found when every step fails', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async () =>
      couchError(401, 'unauthorized', 'Authentication required.'),
    );
    const onUnauthorized = vi.fn();
    const api = new ApiClient('http://couch.local', onUnauthorized);

    const found = await discoverIdps(api);

    expect(found).toEqual({ idps: [], source: 'none', jwtHandlerEnabled: false });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});
