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
 * `detectNativeIdp` (#32): the boot-time probe for CouchDB's future `/_idp` endpoint, and the
 * short-circuit it drives — when present, this app must never create, secure, or write the
 * `idp` stopgap database.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { detectNativeIdp, resetNativeIdpProbe, NATIVE_IDP_PATH } from '../src/services/native-idp';
import { IdpService } from '../src/services/idp-service';
import { ConfigService } from '../src/services/config-service';
import { ApiError } from '../src/services/api-error';
import type { ApiClient } from '../src/services/api-client';
import type { CouchCompanionStore } from '../src/services/git/couchcompanion-store';
import { jsonResponse } from './helpers/response';

function apiWith(requestPreAuth: ReturnType<typeof vi.fn>) {
  return { requestPreAuth, request: vi.fn() } as unknown as ApiClient & {
    request: ReturnType<typeof vi.fn>;
    requestPreAuth: ReturnType<typeof vi.fn>;
  };
}

beforeEach(() => {
  resetNativeIdpProbe();
});

describe('detectNativeIdp', () => {
  it('is true when /_idp answers with an idps array', async () => {
    const api = apiWith(vi.fn().mockResolvedValue({ idps: [] }));

    expect(await detectNativeIdp(api)).toBe(true);
    expect(api.requestPreAuth).toHaveBeenCalledWith(NATIVE_IDP_PATH);
  });

  it('is false when the request fails — the ordinary case today, CouchDB answers 401', async () => {
    const api = apiWith(vi.fn().mockRejectedValue(new ApiError(401, 'unauthorized')));

    expect(await detectNativeIdp(api)).toBe(false);
  });

  it('is false when something answers 2xx but with no idps array — a proxy error page must not read as native', async () => {
    const api = apiWith(vi.fn().mockResolvedValue({ error: 'not_found' }));

    expect(await detectNativeIdp(api)).toBe(false);
  });

  it('reads through requestPreAuth, never request — the probe runs with no session at boot', async () => {
    const api = apiWith(vi.fn().mockResolvedValue({ idps: [] }));

    await detectNativeIdp(api);

    expect(api.request).not.toHaveBeenCalled();
  });

  it('probes once per page load and caches the answer', async () => {
    const requestPreAuth = vi.fn().mockResolvedValue({ idps: [] });
    const api = apiWith(requestPreAuth);

    await detectNativeIdp(api);
    await detectNativeIdp(api);
    await detectNativeIdp(api);

    expect(requestPreAuth).toHaveBeenCalledTimes(1);
  });

  it('resetNativeIdpProbe forces a fresh probe', async () => {
    const first = apiWith(vi.fn().mockResolvedValue({ idps: [] }));
    const second = apiWith(vi.fn().mockRejectedValue(new ApiError(401, 'unauthorized')));

    expect(await detectNativeIdp(first)).toBe(true);
    resetNativeIdpProbe();
    expect(await detectNativeIdp(second)).toBe(false);
    expect(second.requestPreAuth).toHaveBeenCalledTimes(1);
  });
});

describe('the /_idp-present short-circuit (#32)', () => {
  const WELL_KNOWN = 'http://localhost:8080/realms/couch/.well-known/openid-configuration';
  const JWKS_URI = 'http://localhost:8080/realms/couch/protocol/openid-connect/certs';
  const RSA_JWK = {
    kid: 'DWSyRo4S6hueZQcPm-upI88JA0qJ_DUjLiBP2J-GSAw',
    kty: 'RSA',
    alg: 'RS256',
    use: 'sig',
    n:
      '5xOdf6K7wgxq-Nkow8ChHB1xnt5ak9UdBbNcpSocs1IpFGclWaysyfB5qHd50veuDDkBozNdApid8Y--GDt4' +
      'ET_g5o_S7wWt3RBbW-ejfMjQyunUzA_mfXkL6V2G3dIGmQUMwTbfVL_kmdX7q1-WdlOfQNybB-hO3qkeroPD' +
      'wo70S6iPVeBVi199W2i2TbT0hgUkITxGLkkKdeHS9hMtMKRI1hOB6u-R_4eOLG2Ad5RZQwG6FqKb1BirNi5V' +
      'XqvR3TIhyHaxpqSYe3iKlLesxjNJX1AQSmKvGM0b2x1CcalreYlXTB5WhUFCEqwe9xRlpWxy0P-OBO4F3h1R' +
      'WVlgkQ',
    e: 'AQAB',
  };
  const DISCOVERY_DOC = {
    issuer: 'http://localhost:8080/realms/couch',
    jwks_uri: JWKS_URI,
    authorization_endpoint: 'http://localhost:8080/realms/couch/protocol/openid-connect/auth',
    token_endpoint: 'http://localhost:8080/realms/couch/protocol/openid-connect/token',
    id_token_signing_alg_values_supported: ['RS256'],
  };

  function fakeStore() {
    const docs = new Map<string, Record<string, unknown>>();
    return {
      async list<T>(prefix: string): Promise<T[]> {
        return [...docs.entries()].filter(([id]) => id.startsWith(prefix)).map(([, d]) => d as T);
      },
      async get() {
        return null;
      },
      async put(id: string, body: Record<string, unknown>) {
        docs.set(id, body);
        return { id, rev: '1-x' };
      },
      async remove() {},
      async ensureDatabase() {},
    } as unknown as CouchCompanionStore;
  }

  /** Node-config-backed api, plus a native /_idp that answers present. */
  function fakeApi() {
    const sections: Record<string, Record<string, string>> = {};
    const request = vi.fn(async (method: string, path: string, body?: unknown) => {
      if (method === 'GET' && path === '/_node/_local/_config') return structuredClone(sections);
      const keyed = /^\/_node\/_local\/_config\/([^/]+)\/([^/]+)$/.exec(path);
      if (keyed) {
        const section = decodeURIComponent(keyed[1]);
        const key = decodeURIComponent(keyed[2]);
        if (method === 'GET') {
          const value = sections[section]?.[key];
          if (value === undefined) throw new ApiError(404, 'not_found');
          return value;
        }
        if (method === 'PUT') {
          const previous = sections[section]?.[key] ?? '';
          sections[section] = { ...(sections[section] ?? {}), [key]: body as string };
          return previous;
        }
      }
      return {};
    });
    return {
      request,
      requestPreAuth: vi.fn().mockResolvedValue({ idps: [] }),
    } as unknown as ApiClient & { request: ReturnType<typeof vi.fn> };
  }

  beforeEach(() => {
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) =>
      jsonResponse(url === JWKS_URI ? { keys: [RSA_JWK] } : DISCOVERY_DOC),
    );
  });

  it('applyIdp never touches the idp database once /_idp answers present', async () => {
    const api = fakeApi();
    const svc = new IdpService(api, fakeStore(), new ConfigService(api));
    const created = await svc.createIdp({
      name: 'Dev Keycloak',
      well_known_url: WELL_KNOWN,
      client_id: 'couch-companion-ui',
      roles_claim: 'roles',
      idp_only: false,
    });

    const result = await svc.applyIdp(created._id);

    expect(result.errors).toEqual([]);
    const idpDbCalls = api.request.mock.calls.filter((c: unknown[]) => String(c[1]).startsWith('/idp'));
    expect(idpDbCalls).toEqual([]);
  });

  it('still writes [jwt_keys]/[oidc] config either way — only the stopgap database is skipped', async () => {
    const api = fakeApi();
    const svc = new IdpService(api, fakeStore(), new ConfigService(api));
    const created = await svc.createIdp({
      name: 'Dev Keycloak',
      well_known_url: WELL_KNOWN,
      client_id: 'couch-companion-ui',
      roles_claim: 'roles',
      idp_only: false,
    });

    await svc.applyIdp(created._id);

    const configPuts = api.request.mock.calls.filter(
      (c: unknown[]) => c[0] === 'PUT' && String(c[1]).includes('_config'),
    );
    expect(configPuts.length).toBeGreaterThan(0);
  });
});
