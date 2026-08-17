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
 * The JWT half of `AuthService` (spec D8/§5). The cookie half lives in `auth-service.test.ts`;
 * this file only covers what a Bearer session does differently, plus the places the two must
 * not interfere.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuthService } from '../src/services/auth-service';
import type { ApiClient } from '../src/services/api-client';
import type { Deployment } from '../src/services/deployment-mode';

const USER_KEY = 'cca_user';
const TOKEN_KEY = 'cca_token';
const sameOrigin: Deployment = { mode: 'same-origin', baseUrl: 'http://couch.local' };

const fakeApi = () =>
  ({ request: vi.fn(), setBaseUrl: vi.fn(), setToken: vi.fn() }) as unknown as ApiClient & {
    request: ReturnType<typeof vi.fn>;
    setBaseUrl: ReturnType<typeof vi.fn>;
    setToken: ReturnType<typeof vi.fn>;
  };

/** A JWT is three base64url segments; only the payload is ever read, and never verified here
 *  — CouchDB is the verifier. */
function jwt(payload: Record<string, unknown>): string {
  const seg = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${seg({ alg: 'RS256', typ: 'JWT' })}.${seg(payload)}.signature`;
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});

describe('loginWithToken', () => {
  it('attaches the token to the api client before probing the session', async () => {
    const api = fakeApi();
    api.request.mockResolvedValue({ userCtx: { name: 'uuid-1', roles: ['_admin'] } });
    const svc = new AuthService(api, () => sameOrigin);

    await svc.loginWithToken(jwt({ preferred_username: 'hariseldon' }));

    expect(api.setToken).toHaveBeenCalledWith(expect.stringContaining('.'));
    expect(api.request).toHaveBeenCalledWith('GET', '/_session');
  });

  it('takes roles from CouchDB, which is the only authority on them', async () => {
    const api = fakeApi();
    api.request.mockResolvedValue({ userCtx: { name: 'uuid-1', roles: ['_admin', 'ops'] } });
    const svc = new AuthService(api, () => sameOrigin);

    await svc.loginWithToken(jwt({ preferred_username: 'hariseldon', roles: ['lies'] }));

    expect(svc.state.roles).toEqual(['_admin', 'ops']);
    expect(svc.isAdmin).toBe(true);
  });

  /**
   * P6-4. CouchDB's jwt_authentication_handler sets userCtx.name to the `sub` claim — a
   * Keycloak UUID. Showing that as "signed in as" is a defect, not a quirk to preserve.
   */
  it('prefers preferred_username over the sub UUID CouchDB reports', async () => {
    const api = fakeApi();
    api.request.mockResolvedValue({
      userCtx: { name: 'f81d4fae-7dec-11d0-a765-00a0c91e6bf6', roles: [] },
    });
    const svc = new AuthService(api, () => sameOrigin);

    await svc.loginWithToken(jwt({ sub: 'f81d4fae-7dec-11d0-a765-00a0c91e6bf6', preferred_username: 'hariseldon' }));

    expect(svc.state.username).toBe('hariseldon');
  });

  it('falls back through name and email before accepting the UUID', async () => {
    const api = fakeApi();
    api.request.mockResolvedValue({ userCtx: { name: 'uuid-1', roles: [] } });

    const withName = new AuthService(api, () => sameOrigin);
    await withName.loginWithToken(jwt({ name: 'Hari Seldon' }));
    expect(withName.state.username).toBe('Hari Seldon');

    sessionStorage.clear();
    const withEmail = new AuthService(api, () => sameOrigin);
    await withEmail.loginWithToken(jwt({ email: 'hari@trantor.gov' }));
    expect(withEmail.state.username).toBe('hari@trantor.gov');

    sessionStorage.clear();
    const bare = new AuthService(api, () => sameOrigin);
    await bare.loginWithToken(jwt({ sub: 'uuid-1' }));
    expect(bare.state.username).toBe('uuid-1');
  });

  it('survives a token whose payload is not decodable', async () => {
    const api = fakeApi();
    api.request.mockResolvedValue({ userCtx: { name: 'uuid-1', roles: [] } });
    const svc = new AuthService(api, () => sameOrigin);

    await svc.loginWithToken('not.a.jwt');

    expect(svc.state.username).toBe('uuid-1');
  });

  it('notifies subscribers so the shell swaps in', async () => {
    const api = fakeApi();
    api.request.mockResolvedValue({ userCtx: { name: 'uuid-1', roles: [] } });
    const svc = new AuthService(api, () => sameOrigin);
    const seen: boolean[] = [];
    svc.subscribe((s) => seen.push(s.authenticated));

    await svc.loginWithToken(jwt({ preferred_username: 'hariseldon' }));

    expect(seen).toEqual([true]);
  });

  it('rejects a token CouchDB will not accept, leaving the user logged out', async () => {
    const api = fakeApi();
    api.request.mockResolvedValue({ userCtx: { name: null, roles: [] } });
    const svc = new AuthService(api, () => sameOrigin);

    await expect(svc.loginWithToken(jwt({ preferred_username: 'hariseldon' }))).rejects.toThrow();

    expect(svc.state.authenticated).toBe(false);
    expect(api.setToken).toHaveBeenLastCalledWith(null);
  });
});

describe('restore with a stored JWT', () => {
  it('re-attaches the token before probing, or the probe 401s', async () => {
    const api = fakeApi();
    sessionStorage.setItem(TOKEN_KEY, jwt({ preferred_username: 'hariseldon' }));
    sessionStorage.setItem(
      USER_KEY,
      JSON.stringify({ name: 'hariseldon', roles: ['_admin'], companionServer: 'http://couch.local', kind: 'jwt' }),
    );
    api.request.mockResolvedValue({ userCtx: { name: 'uuid-1', roles: ['_admin'] } });
    const svc = new AuthService(api, () => sameOrigin);

    await svc.restore();

    const setTokenCallIndex = api.setToken.mock.invocationCallOrder[0];
    const requestCallIndex = api.request.mock.invocationCallOrder[0];
    expect(setTokenCallIndex).toBeLessThan(requestCallIndex);
    expect(svc.state.authenticated).toBe(true);
  });

  it('clears both the token and the user when the session is gone', async () => {
    const api = fakeApi();
    sessionStorage.setItem(TOKEN_KEY, jwt({ preferred_username: 'hariseldon' }));
    sessionStorage.setItem(
      USER_KEY,
      JSON.stringify({ name: 'hariseldon', roles: [], companionServer: 'http://couch.local', kind: 'jwt' }),
    );
    api.request.mockRejectedValue(new Error('401'));
    const svc = new AuthService(api, () => sameOrigin);

    await svc.restore();

    expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(svc.state.authenticated).toBe(false);
  });

  it('leaves a cookie session alone — no token is attached', async () => {
    const api = fakeApi();
    sessionStorage.setItem(
      USER_KEY,
      JSON.stringify({ name: 'kai', roles: [], companionServer: 'http://couch.local' }),
    );
    api.request.mockResolvedValue({ userCtx: { name: 'kai', roles: [] } });
    const svc = new AuthService(api, () => sameOrigin);

    await svc.restore();

    expect(api.setToken).not.toHaveBeenCalled();
  });
});

describe('logout of a JWT session', () => {
  it('clears the token and does not DELETE /_session', async () => {
    const api = fakeApi();
    api.request.mockResolvedValue({ userCtx: { name: 'uuid-1', roles: [] } });
    const svc = new AuthService(api, () => sameOrigin);
    await svc.loginWithToken(jwt({ preferred_username: 'hariseldon' }));
    api.request.mockClear();

    svc.logout();

    // A Bearer session has no server-side cookie to delete, and the DELETE would 401 noisily.
    expect(api.request).not.toHaveBeenCalledWith('DELETE', '/_session');
    expect(api.setToken).toHaveBeenLastCalledWith(null);
    expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(svc.state.authenticated).toBe(false);
  });

  it('still DELETEs /_session for a cookie session', async () => {
    const api = fakeApi();
    api.request.mockResolvedValue({ ok: true, name: 'kai', roles: [] });
    const svc = new AuthService(api, () => sameOrigin);
    await svc.login('ignored', 'kai', 'pw');
    api.request.mockClear();
    api.request.mockResolvedValue({ ok: true });

    svc.logout();

    expect(api.request).toHaveBeenCalledWith('DELETE', '/_session');
  });
});

/**
 * #24. The record naming the identity provider this browser could sign out of is session state,
 * so it must die with the session — every way a session can end, not just the polite one.
 *
 * A survivor is not cosmetic: the logout dialog renders its "Full logout from IdP" checkbox
 * from that record's presence, so a leftover offers the *next* user of this browser a round
 * trip to a provider their session never came from.
 */
describe('the IdP logout record', () => {
  const RP_LOGOUT_KEY = 'cca_oidc_logout';
  const RP = {
    end_session_endpoint: 'http://localhost:8080/realms/couch/protocol/openid-connect/logout',
    client_id: 'couch-companion-ui',
  };

  it('is forgotten when the user logs out', async () => {
    const api = fakeApi();
    api.request.mockResolvedValue({ userCtx: { name: 'uuid-1', roles: [] } });
    const svc = new AuthService(api, () => sameOrigin);
    await svc.loginWithToken(jwt({ preferred_username: 'hariseldon' }));
    sessionStorage.setItem(RP_LOGOUT_KEY, JSON.stringify(RP));

    svc.logout();

    expect(sessionStorage.getItem(RP_LOGOUT_KEY)).toBeNull();
  });

  /** A cookie session never had one, but it must not inherit the last session's either. */
  it('is forgotten when a cookie session logs out', async () => {
    const api = fakeApi();
    api.request.mockResolvedValue({ ok: true, name: 'kai', roles: [] });
    const svc = new AuthService(api, () => sameOrigin);
    await svc.login('ignored', 'kai', 'pw');
    sessionStorage.setItem(RP_LOGOUT_KEY, JSON.stringify(RP));

    svc.logout();

    expect(sessionStorage.getItem(RP_LOGOUT_KEY)).toBeNull();
  });

  /** The token was rejected, so there is no session — and nothing to sign out of. */
  it('is forgotten when CouchDB rejects the token', async () => {
    const api = fakeApi();
    api.request.mockResolvedValue({ userCtx: { name: null } });
    const svc = new AuthService(api, () => sameOrigin);
    sessionStorage.setItem(RP_LOGOUT_KEY, JSON.stringify(RP));

    await expect(svc.loginWithToken(jwt({ preferred_username: 'hariseldon' }))).rejects.toThrow();

    expect(sessionStorage.getItem(RP_LOGOUT_KEY)).toBeNull();
  });

  /** The expiry path: ApiClient's centralized 401 logout arrives here too. */
  it('is forgotten when a restore finds the session gone', async () => {
    const api = fakeApi();
    api.request.mockResolvedValue({ userCtx: { name: 'uuid-1', roles: [] } });
    const svc = new AuthService(api, () => sameOrigin);
    await svc.loginWithToken(jwt({ preferred_username: 'hariseldon' }));
    sessionStorage.setItem(RP_LOGOUT_KEY, JSON.stringify(RP));
    api.request.mockRejectedValue(new Error('401'));

    await svc.restore();

    expect(sessionStorage.getItem(RP_LOGOUT_KEY)).toBeNull();
  });
});
