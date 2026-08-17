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
 * `IdpService` against CouchDB, with no backend (phase 6, T3/T4), storage moved to the
 * `[oidc]` node-config section (#32).
 *
 * This file is the proof the migration happened. Every assertion here used to name a
 * `/api/idp…` path served by the parent product's Rust crates — endpoints that do not exist
 * in a backend-less deployment, which made the old suite green against an API that could
 * never answer. It was then rewritten again when provider metadata moved out of the
 * `couchcompanion` document store entirely and into `_node/_local/_config`'s `[oidc]`
 * section, correlated with `[jwt_keys]` by a shared `rsa:<kid>` key (#32).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IdpService, IdpConflictError } from '../src/services/idp-service';
import { ConfigService } from '../src/services/config-service';
import { ApiError } from '../src/services/api-error';
import { oidcKey } from '../src/services/oidc-ini';
import { resetNativeIdpProbe } from '../src/services/native-idp';
import type { ApiClient } from '../src/services/api-client';
import type { CouchCompanionStore } from '../src/services/git/couchcompanion-store';
import type { IdpConfig } from '../src/plugins/idp/types';
import { jsonResponse } from './helpers/response';

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

/** A second signing key for the same issuer — the "two kids, one provider" case (#32). */
const RSA_JWK_2 = { ...RSA_JWK, kid: 'second-kid-rotated-in' };

const DISCOVERY_DOC = {
  issuer: 'http://localhost:8080/realms/couch',
  jwks_uri: JWKS_URI,
  authorization_endpoint: 'http://localhost:8080/realms/couch/protocol/openid-connect/auth',
  token_endpoint: 'http://localhost:8080/realms/couch/protocol/openid-connect/token',
  id_token_signing_alg_values_supported: ['RS256'],
};

/** An in-memory `couchcompanion`, so the activity-log flow runs for real when enabled. */
function fakeStore() {
  const docs = new Map<string, Record<string, unknown>>();
  const store = {
    async list<T>(prefix: string): Promise<T[]> {
      return [...docs.entries()]
        .filter(([id]) => id.startsWith(prefix))
        .map(([, doc]) => doc as T);
    },
    async get<T>(id: string): Promise<T | null> {
      return (docs.get(id) as T) ?? null;
    },
    async put(id: string, body: Record<string, unknown>) {
      docs.set(id, { ...body, _id: id, _rev: '1-x' });
      return { id, rev: '1-x' };
    },
    async remove(id: string) {
      docs.delete(id);
    },
    async ensureDatabase() {},
  } as unknown as CouchCompanionStore;
  return { docs, store };
}

/**
 * A stateful stand-in for CouchDB's node-config endpoints, backing a real {@link ConfigService}
 * — `[oidc]` and `[jwt_keys]` really round-trip through it the way they do against a live
 * server, rather than a mock that always answers the same canned value. Every other path
 * (the `idp` stopgap database, `/_node/_local/_restart`) resolves emptily; those are asserted
 * on directly via `api.request.mock.calls`.
 *
 * `requestPreAuth` always rejects — no native `/_idp` endpoint — matching every CouchDB this
 * app runs against today (#32's native-endpoint path is covered separately in
 * `native-idp.test.ts`).
 */
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
      if (method === 'DELETE') {
        delete sections[section]?.[key];
        return '';
      }
    }

    return {};
  });

  const api = {
    request,
    requestPreAuth: vi.fn().mockRejectedValue(new ApiError(401, 'unauthorized')),
  } as unknown as ApiClient & { request: ReturnType<typeof vi.fn> };

  return { api, sections };
}

/** Serves the discovery document and JWKS the way the devcontainer Keycloak does. */
function idpNetwork(overrides: { jwks?: unknown; discovery?: unknown } = {}) {
  return vi.fn().mockImplementation(async (url: string) =>
    jsonResponse(
      url === JWKS_URI
        ? (overrides.jwks ?? { keys: [RSA_JWK] })
        : (overrides.discovery ?? DISCOVERY_DOC),
    ),
  );
}

/** Discovery reachable, JWKS not — the exact CORS asymmetry D15's paste fallback exists for. */
function jwksUnreachable() {
  return vi.fn().mockImplementation(async (url: string) => {
    if (url === JWKS_URI) throw new TypeError('Failed to fetch');
    return jsonResponse(DISCOVERY_DOC);
  });
}

const createRequest = {
  name: 'Dev Keycloak',
  well_known_url: WELL_KNOWN,
  client_id: 'couch-companion-ui',
  roles_claim: 'roles',
  idp_only: false,
};

/** Builds a service wired to real `ConfigService` + `CouchCompanionStore` fakes. */
function service(api: ReturnType<typeof fakeApi>['api'], store: CouchCompanionStore) {
  return new IdpService(api, store, new ConfigService(api));
}

beforeEach(() => {
  // Plain assignment, never vi.spyOn — a spy leaves a call-through wrapper that per-test
  // reassignment does not displace, and these tests then hit the real devcontainer Keycloak.
  globalThis.fetch = vi.fn().mockRejectedValue(new Error('unexpected network call in test'));
  // The native `/_idp` probe caches its answer at module scope for the whole page load; reset
  // it per test or an earlier test's fake api would leak its cached answer into this one.
  resetNativeIdpProbe();
});

describe('createIdp', () => {
  it('runs OIDC discovery in the browser and stores what it found', async () => {
    globalThis.fetch = idpNetwork();
    const { api, sections } = fakeApi();
    const svc = service(api, fakeStore().store);

    const created = await svc.createIdp(createRequest);

    // The issuer is discovery's, not the operator's — the well-known document is what names it.
    expect(created.issuer).toBe(DISCOVERY_DOC.issuer);
    expect(sections.oidc?.[oidcKey(RSA_JWK.kid)]).toBeDefined();
    expect(sections.jwt_keys?.[oidcKey(RSA_JWK.kid)]).toBeDefined();
  });

  /**
   * #119: discovery is still fetched — that is where the issuer and the JWKS come from — but
   * what it says about *itself* is not copied into `[oidc]`. A stored `authorization_endpoint`
   * is a copy that goes stale the day the provider moves it, with nothing to notice.
   */
  it('stores only the slim field set, none of the discovery document it just read', async () => {
    globalThis.fetch = idpNetwork();
    const { api, sections } = fakeApi();
    const svc = service(api, fakeStore().store);

    await svc.createIdp({ ...createRequest, idp_only: true });

    const stored = JSON.parse(sections.oidc![oidcKey(RSA_JWK.kid)]);
    expect(Object.keys(stored).sort()).toEqual([
      'alg',
      'client_id',
      'created_at',
      'idp_only',
      'issuer',
      'last_refreshed',
      'name',
      'roles_claim',
      'well_known_url',
    ]);
    expect(stored.idp_only).toBe(true);
    expect(stored.well_known_url).toBe(WELL_KNOWN);
  });

  it('converts the fetched JWKS to the PEM CouchDB config wants', async () => {
    globalThis.fetch = idpNetwork();
    const svc = service(fakeApi().api, fakeStore().store);

    const created = await svc.createIdp(createRequest);

    expect(created.jwks_keys).toHaveLength(1);
    expect(created.jwks_keys[0].kid).toBe(RSA_JWK.kid);
    expect(created.jwks_keys[0].value).toContain('-----BEGIN PUBLIC KEY-----');
  });

  it('ignores encryption keys — only signing keys can verify a JWT', async () => {
    globalThis.fetch = idpNetwork({
      jwks: { keys: [RSA_JWK, { ...RSA_JWK, kid: 'enc-key', use: 'enc' }] },
    });
    const svc = service(fakeApi().api, fakeStore().store);

    const created = await svc.createIdp(createRequest);

    expect(created.jwks_keys.map((k) => k.kid)).toEqual([RSA_JWK.kid]);
  });

  it('writes one [oidc]/[jwt_keys] entry per signing key, all naming the same issuer', async () => {
    globalThis.fetch = idpNetwork({ jwks: { keys: [RSA_JWK, RSA_JWK_2] } });
    const { api, sections } = fakeApi();
    const svc = service(api, fakeStore().store);

    const created = await svc.createIdp(createRequest);

    expect(created.jwks_keys.map((k) => k.kid).sort()).toEqual(
      [RSA_JWK.kid, RSA_JWK_2.kid].sort(),
    );
    expect(Object.keys(sections.oidc ?? {}).sort()).toEqual(
      [oidcKey(RSA_JWK.kid), oidcKey(RSA_JWK_2.kid)].sort(),
    );
    for (const kid of [RSA_JWK.kid, RSA_JWK_2.kid]) {
      expect(JSON.parse(sections.oidc[oidcKey(kid)]).issuer).toBe(DISCOVERY_DOC.issuer);
    }
  });

  it('refuses a second registration of an issuer already configured', async () => {
    globalThis.fetch = idpNetwork();
    const svc = service(fakeApi().api, fakeStore().store);
    await svc.createIdp(createRequest);

    await expect(svc.createIdp(createRequest)).rejects.toThrow(IdpConflictError);
  });

  it('does not touch couchcompanion when [oidc] log is off (default)', async () => {
    globalThis.fetch = idpNetwork();
    const { store, docs } = fakeStore();
    const svc = service(fakeApi().api, store);

    await svc.createIdp(createRequest);

    expect([...docs.keys()]).toEqual([]);
  });

  it('records an activity log entry once [oidc] log is enabled', async () => {
    globalThis.fetch = idpNetwork();
    const { api, sections } = fakeApi();
    sections.oidc = { log: 'true' };
    const { store, docs } = fakeStore();
    const svc = service(api, store);

    await svc.createIdp(createRequest);

    expect([...docs.keys()].some((id) => id.startsWith('idplog:'))).toBe(true);
  });

  it('accepts a pasted JWKS instead of fetching one (D15)', async () => {
    globalThis.fetch = jwksUnreachable();
    const svc = service(fakeApi().api, fakeStore().store);

    const created = await svc.createIdp({ ...createRequest, jwks: { keys: [RSA_JWK] } });

    expect(created.jwks_keys[0].kid).toBe(RSA_JWK.kid);
  });

  it('surfaces an unreachable JWKS rather than storing an unusable IdP', async () => {
    globalThis.fetch = jwksUnreachable();
    const svc = service(fakeApi().api, fakeStore().store);

    await expect(svc.createIdp(createRequest)).rejects.toThrow();
  });
});

describe('listIdps / getIdp', () => {
  it('lists what createIdp just wrote, keyed by issuer, from the node config', async () => {
    globalThis.fetch = idpNetwork();
    const svc = service(fakeApi().api, fakeStore().store);
    const created = await svc.createIdp(createRequest);

    const all = await svc.listIdps();

    expect(all.map((i) => i._id)).toEqual([created._id]);
    expect(created._id).toBe(DISCOVERY_DOC.issuer);
  });

  it('groups two signing keys of the same issuer into one provider (#32)', async () => {
    globalThis.fetch = idpNetwork({ jwks: { keys: [RSA_JWK, RSA_JWK_2] } });
    const svc = service(fakeApi().api, fakeStore().store);
    await svc.createIdp(createRequest);

    const all = await svc.listIdps();

    expect(all).toHaveLength(1);
    expect(all[0].jwks_keys.map((k) => k.kid).sort()).toEqual(
      [RSA_JWK.kid, RSA_JWK_2.kid].sort(),
    );
  });

  it('defaults every absent field of a hand-written [oidc] entry instead of crashing', async () => {
    const { api, sections } = fakeApi();
    sections.oidc = {
      [oidcKey('legacykid')]: JSON.stringify({
        name: 'legacy',
        issuer: 'https://legacy.example.com',
        client_id: null,
      }),
    };
    const svc = service(api, fakeStore().store);

    const idp = await svc.getIdp('https://legacy.example.com');

    expect(idp.roles_claim).toBe('roles');
    expect(idp.idp_only).toBe(false);
    expect(idp.well_known_url).toBe('');
    // No [jwt_keys] twin was ever written for this hand-authored entry.
    expect(idp.jwks_keys).toEqual([{ kid: 'legacykid', kty: 'RSA', alg: 'RS256', value: '', installed: false }]);
  });

  /**
   * Already-registered providers carry the whole discovery document in their ini value (#119
   * shipped no migration). Reading one must produce an ordinary provider, not a broken screen.
   */
  it('reads a provider stored in the pre-#119 fat shape', async () => {
    const { api, sections } = fakeApi();
    sections.oidc = {
      [oidcKey('fatkid')]: JSON.stringify({
        name: 'Registered before #119',
        issuer: 'https://fat.example.com',
        client_id: 'c',
        well_known_url: 'https://fat.example.com/.well-known/openid-configuration',
        scopes: ['openid'],
        roles_claim: 'groups',
        authorization_endpoint: 'https://fat.example.com/authorize',
        token_endpoint: 'https://fat.example.com/token',
        end_session_endpoint: 'https://fat.example.com/logout',
        jwks_uri: 'https://fat.example.com/keys',
        supported_algorithms: ['RS256'],
        alg: 'RS256',
        urls: ['https://couch.example.com'],
        last_refreshed: '2026-01-01T00:00:00.000Z',
        created_at: '2026-01-01T00:00:00.000Z',
      }),
    };
    const svc = service(api, fakeStore().store);

    const idp = await svc.getIdp('https://fat.example.com');

    expect(idp.name).toBe('Registered before #119');
    expect(idp.roles_claim).toBe('groups');
    expect(idp.idp_only).toBe(false);
    expect(idp.jwks_keys).toHaveLength(1);
    expect(idp).not.toHaveProperty('urls');
    expect(idp).not.toHaveProperty('scopes');
    expect(idp).not.toHaveProperty('oidc_config');
  });

  it('throws for an id that is not there', async () => {
    const svc = service(fakeApi().api, fakeStore().store);

    await expect(svc.getIdp('https://nowhere.example.com')).rejects.toThrow();
  });
});

describe('applyIdp', () => {
  async function applied() {
    globalThis.fetch = idpNetwork();
    const { api, sections } = fakeApi();
    const svc = service(api, fakeStore().store);
    const created = await svc.createIdp(createRequest);
    const result = await svc.applyIdp(created._id);
    return { api, sections, result, created };
  }

  const configPuts = (api: ApiClient & { request: ReturnType<typeof vi.fn> }) =>
    api.request.mock.calls.filter(
      (c: unknown[]) => c[0] === 'PUT' && String(c[1]).includes('_config'),
    );

  it('installs each signing key under jwt_keys/rsa:<kid>', async () => {
    const { api } = await applied();

    const keyPut = configPuts(api).find((c: unknown[]) => String(c[1]).includes('jwt_keys'));
    expect(String(keyPut?.[1])).toContain(encodeURIComponent(`rsa:${RSA_JWK.kid}`));
  });

  /**
   * apache/couchdb#5091: the `_config` PUT rejects literal newline bytes and wants the PEM's
   * line breaks as the two-character escape. `scripts/seed-dev.sh` already depends on this.
   */
  it('escapes the PEM newlines the way CouchDB config requires', async () => {
    const { api } = await applied();

    const keyPut = configPuts(api).find((c: unknown[]) => String(c[1]).includes('jwt_keys'));
    expect(String(keyPut?.[2])).not.toContain('\n');
    expect(String(keyPut?.[2])).toContain('\\n');
  });

  it('sets the roles claim so CouchDB maps JWT roles', async () => {
    const { api } = await applied();

    const paths = configPuts(api).map((c: unknown[]) => String(c[1]));
    expect(paths.some((p: string) => p.includes('roles_claim_name'))).toBe(true);
  });

  it('adds the jwt handler to the authentication chain', async () => {
    const { api } = await applied();

    const handlerPut = configPuts(api).find((c: unknown[]) =>
      String(c[1]).includes('authentication_handlers'),
    );
    expect(String(handlerPut?.[2])).toContain('jwt_authentication_handler');
  });

  /** D15/P6-6: an apply that configures CouchDB but leaves discovery stale would make the
   *  login button vanish for the next user. */
  it('publishes the public idp/config discovery document', async () => {
    const { api } = await applied();

    const discoveryPut = api.request.mock.calls.find(
      (c: unknown[]) => c[0] === 'PUT' && String(c[1]).includes('/idp/config'),
    );
    expect(discoveryPut).toBeDefined();
    const body = discoveryPut![2] as { idps: Array<{ client_id: string; well_known_url: string }> };
    expect(body.idps[0].client_id).toBe('couch-companion-ui');
    expect(body.idps[0].well_known_url).toBe(WELL_KNOWN);
  });

  /**
   * #119: §5 still *allows* the endpoint and scope overrides, but writing them back would only
   * republish what `well_known_url` already answers. What login genuinely cannot derive —
   * which client id to use, which claim carries the roles, whether to hide the password form —
   * is exactly what stays.
   */
  it('publishes only the slim §5 field set', async () => {
    const { api } = await applied();

    const discoveryPut = api.request.mock.calls.find(
      (c: unknown[]) => c[0] === 'PUT' && String(c[1]).includes('/idp/config'),
    );
    const body = discoveryPut![2] as { idps: Record<string, unknown>[] };
    expect(Object.keys(body.idps[0]).sort()).toEqual([
      'client_id',
      'idp_only',
      'issuer',
      'name',
      'roles_claim',
      'well_known_url',
    ]);
  });

  it('publishes idp_only so the login screen can hide the password form', async () => {
    globalThis.fetch = idpNetwork();
    const { api } = fakeApi();
    const svc = service(api, fakeStore().store);
    const created = await svc.createIdp({ ...createRequest, idp_only: true });
    await svc.applyIdp(created._id);

    const discoveryPut = api.request.mock.calls.find(
      (c: unknown[]) => c[0] === 'PUT' && String(c[1]).includes('/idp/config'),
    );
    const body = discoveryPut![2] as { idps: Array<{ idp_only: boolean }> };
    expect(body.idps[0].idp_only).toBe(true);
  });

  it('reports the single server it applied to', async () => {
    const { result } = await applied();

    expect(result.applied_to).toHaveLength(1);
    expect(result.errors).toEqual([]);
  });

  it('reports a missing [jwt_keys] twin as an error instead of silently applying', async () => {
    globalThis.fetch = idpNetwork();
    const { api, sections } = fakeApi();
    const svc = service(api, fakeStore().store);
    const created = await svc.createIdp(createRequest);
    delete sections.jwt_keys[oidcKey(RSA_JWK.kid)];

    const result = await svc.applyIdp(created._id);

    expect(result.errors[0]).toContain(`rsa:${RSA_JWK.kid}`);
    expect(result.applied_to).toEqual([]);
  });

  /** P6-7: /_restart bounces the server; it must never be a silent side effect of Apply. */
  it('does not restart the node', async () => {
    const { api } = await applied();

    expect(
      api.request.mock.calls.some((c: unknown[]) => String(c[1]).includes('_restart')),
    ).toBe(false);
  });
});

describe('restartNode', () => {
  it('POSTs /_node/_local/_restart', async () => {
    globalThis.fetch = idpNetwork();
    const { api } = fakeApi();
    const svc = service(api, fakeStore().store);
    const created = await svc.createIdp(createRequest);

    await svc.restartNode(created._id);

    expect(api.request).toHaveBeenCalledWith('POST', '/_node/_local/_restart');
  });
});

describe('deleteIdp', () => {
  it('removes the [oidc] entries but leaves [jwt_keys] alone, and the leftover is visible', async () => {
    globalThis.fetch = idpNetwork();
    const { api, sections } = fakeApi();
    const svc = service(api, fakeStore().store);
    const created = await svc.createIdp(createRequest);

    const result = await svc.deleteIdp(created._id);

    expect(result?.idp_id).toBe(created._id);
    expect(await svc.listIdps()).toEqual([]);
    expect(sections.jwt_keys[oidcKey(RSA_JWK.kid)]).toBeDefined();
    expect(await svc.listOrphanKeys()).toEqual([RSA_JWK.kid]);
  });
});

describe('listOrphanKeys', () => {
  it('is empty for a healthy install with no leftovers', async () => {
    globalThis.fetch = idpNetwork();
    const svc = service(fakeApi().api, fakeStore().store);
    await svc.createIdp(createRequest);

    expect(await svc.listOrphanKeys()).toEqual([]);
  });
});

describe('getLogs', () => {
  function logDoc(id: string, timestamp: string, event: string, idpId: string | null) {
    return [
      id,
      {
        _id: id,
        timestamp,
        level: 'info',
        event,
        idp_id: idpId,
        idp_name: null,
        message: event,
        details: null,
      },
    ] as const;
  }

  it('returns entries newest first', async () => {
    const { store, docs } = fakeStore();
    docs.set(...logDoc('idplog:2026-08-01T00:00:00.000Z~a', '2026-08-01T00:00:00.000Z', 'older', null));
    docs.set(...logDoc('idplog:2026-08-06T00:00:00.000Z~b', '2026-08-06T00:00:00.000Z', 'newer', null));
    const svc = service(fakeApi().api, store);

    const logs = await svc.getLogs();

    expect(logs.map((l) => l.event)).toEqual(['newer', 'older']);
  });

  it('filters by IdP when asked', async () => {
    const { store, docs } = fakeStore();
    docs.set(...logDoc('idplog:2026-08-01T00:00:00.000Z~a', '2026-08-01T00:00:00.000Z', 'apply', 'https://one.example.com'));
    docs.set(...logDoc('idplog:2026-08-02T00:00:00.000Z~b', '2026-08-02T00:00:00.000Z', 'apply', 'https://two.example.com'));
    const svc = service(fakeApi().api, store);

    const logs = await svc.getLogs('https://two.example.com');

    expect(logs.map((l) => l.idp_id)).toEqual(['https://two.example.com']);
  });
});

describe('isLogEnabled', () => {
  it('is off by default, with nothing written', async () => {
    const svc = service(fakeApi().api, fakeStore().store);

    expect(await svc.isLogEnabled()).toBe(false);
  });

  it('turns on with [oidc] log = true', async () => {
    const { api, sections } = fakeApi();
    sections.oidc = { log: 'true' };
    const svc = service(api, fakeStore().store);

    expect(await svc.isLogEnabled()).toBe(true);
  });
});

describe('no /api/idp anywhere', () => {
  it('never calls a parent-backend path', async () => {
    globalThis.fetch = idpNetwork();
    const { api } = fakeApi();
    const svc = service(api, fakeStore().store);

    const created = await svc.createIdp(createRequest);
    await svc.listIdps();
    await svc.getIdp(created._id);
    await svc.updateIdp(created._id, { client_id: 'x', roles_claim: 'roles', idp_only: false });
    await svc.applyIdp(created._id);
    await svc.getLogs();

    const paths = api.request.mock.calls.map((c: unknown[]) => String(c[1]));
    expect(paths.filter((p: string) => p.includes('/api/idp'))).toEqual([]);
  });
});

describe('IdpConfig shape (D6)', () => {
  it('still returns every field the detail screen renders', async () => {
    globalThis.fetch = idpNetwork();
    const svc = service(fakeApi().api, fakeStore().store);

    const created: IdpConfig = await svc.createIdp(createRequest);

    for (const field of [
      '_id',
      'name',
      'issuer',
      'well_known_url',
      'client_id',
      'roles_claim',
      'idp_only',
      'jwks_keys',
      'last_refreshed',
      'created_at',
    ]) {
      expect(created).toHaveProperty(field);
    }
  });

  /** #104/#119: the detail screen stopped rendering these, so nothing should still build them. */
  it('no longer carries the multi-server or discovery-copy fields', async () => {
    globalThis.fetch = idpNetwork();
    const svc = service(fakeApi().api, fakeStore().store);

    const created: IdpConfig = await svc.createIdp(createRequest);

    for (const gone of ['urls', 'scopes', 'oidc_config']) {
      expect(created).not.toHaveProperty(gone);
    }
  });
});
