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
 * The `[oidc]` ini section (#32): the `rsa:<kid>` key format that correlates one-for-one with
 * CouchDB's own `[jwt_keys]`, the issuer de-duplication that key format makes necessary, and
 * the `log` flag that keeps the activity log opt-in.
 *
 * Since #119 the stored shape is deliberately small — everything the identity provider's own
 * discovery document answers was dropped — so the parse tests here carry the load of proving
 * that entries written *before* that still read cleanly.
 */

import { describe, it, expect } from 'vitest';
import {
  JWT_KEYS_SECTION,
  LOG_KEY,
  OIDC_SECTION,
  dedupeByIssuer,
  groupByIssuer,
  kidFromKey,
  logEnabled,
  oidcKey,
  orphanKeyKids,
  parseEntry,
  parseSection,
  providersFrom,
  serializeEntry,
  type OidcEntry,
} from '../src/services/oidc-ini';
import type { NodeConfig } from '../src/plugins/config/types';

const entry = (overrides: Partial<OidcEntry> = {}): OidcEntry => ({
  name: 'Corporate Entra ID',
  issuer: 'https://login.example.com/v2.0',
  client_id: 'd3ad-beef',
  well_known_url: 'https://login.example.com/v2.0/.well-known/openid-configuration',
  roles_claim: 'roles',
  idp_only: false,
  alg: 'RS256',
  last_refreshed: null,
  created_at: '2026-08-01T00:00:00.000Z',
  ...overrides,
});

/**
 * An entry as written before #119 — the discovery document copied into the ini value. Real
 * deployments are full of these, and there is no migration step, so they have to keep reading.
 */
const FAT_ENTRY_JSON = JSON.stringify({
  name: 'Corporate Entra ID',
  issuer: 'https://login.example.com/v2.0',
  client_id: 'd3ad-beef',
  well_known_url: 'https://login.example.com/v2.0/.well-known/openid-configuration',
  scopes: ['openid', 'profile', 'email'],
  roles_claim: 'roles',
  end_session_endpoint: 'https://login.example.com/v2.0/logout',
  authorization_endpoint: 'https://login.example.com/v2.0/authorize',
  token_endpoint: 'https://login.example.com/v2.0/token',
  jwks_uri: 'https://login.example.com/v2.0/discovery/keys',
  supported_algorithms: ['RS256', 'RS384'],
  alg: 'RS256',
  urls: ['https://couch.example.com'],
  last_refreshed: null,
  created_at: '2026-08-01T00:00:00.000Z',
});

describe('key parsing (rsa:<kid>, matching [jwt_keys] one-for-one)', () => {
  it('oidcKey / kidFromKey round-trip a kid, including one containing a colon', () => {
    for (const kid of ['abc123', 'urn:example:key-1', 'DWSyRo4S6hueZQcPm-upI88JA0qJ_DUjLiBP2J-GSAw']) {
      expect(kidFromKey(oidcKey(kid))).toBe(kid);
    }
  });

  it('oidcKey always prefixes with rsa:', () => {
    expect(oidcKey('abc123')).toBe('rsa:abc123');
  });

  it('kidFromKey rejects the log key and any non-rsa key', () => {
    expect(kidFromKey(LOG_KEY)).toBeNull();
    expect(kidFromKey('hmac:abc123')).toBeNull();
    expect(kidFromKey('something-an-operator-typed')).toBeNull();
  });

  it('kidFromKey rejects a bare "rsa:" with no kid', () => {
    expect(kidFromKey('rsa:')).toBeNull();
  });

  it('OIDC_SECTION and JWT_KEYS_SECTION are lowercase, matching every CouchDB built-in', () => {
    expect(OIDC_SECTION).toBe('oidc');
    expect(JWT_KEYS_SECTION).toBe('jwt_keys');
  });
});

describe('parseEntry', () => {
  it('parses a complete entry', () => {
    const parsed = parseEntry(serializeEntry(entry()));
    expect(parsed).toEqual(entry());
  });

  it('rejects invalid JSON', () => {
    expect(parseEntry('not json')).toBeNull();
  });

  it('rejects a JSON value that is not an object', () => {
    expect(parseEntry('42')).toBeNull();
    expect(parseEntry('"a string"')).toBeNull();
    expect(parseEntry('null')).toBeNull();
  });

  it('rejects an entry naming no issuer — it cannot be grouped or offered as a login button', () => {
    expect(parseEntry(JSON.stringify({ name: 'no issuer here' }))).toBeNull();
  });

  /**
   * The direct descendant of the pre-#283 CouchDB docs that serialized fields as `null`: a
   * hand-written `[oidc]` entry may omit or null out anything but the issuer, and reading it
   * must not crash the screen that renders it.
   */
  it('defaults every absent optional field instead of crashing', () => {
    const parsed = parseEntry(
      JSON.stringify({ issuer: 'https://minimal.example.com', client_id: null }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.name).toBe('https://minimal.example.com'); // falls back to issuer
    expect(parsed?.client_id).toBeNull();
    expect(parsed?.well_known_url).toBe('');
    expect(parsed?.roles_claim).toBe('roles');
    expect(parsed?.idp_only).toBe(false);
    expect(parsed?.alg).toBe('RS256');
    expect(parsed?.last_refreshed).toBeNull();
    expect(parsed?.created_at).toBe('');
  });

  it('reads idp_only only from a real boolean true', () => {
    expect(parseEntry(JSON.stringify({ issuer: 'https://i', idp_only: true }))?.idp_only).toBe(true);
    expect(parseEntry(JSON.stringify({ issuer: 'https://i', idp_only: false }))?.idp_only).toBe(
      false,
    );
  });

  /**
   * Hiding the password form on the strength of the *string* `"false"`, or of a `1` an
   * operator typed meaning yes, would lock people out of a CouchDB on a typo. Only `true`
   * counts; everything else is off.
   */
  it('defaults idp_only to false when absent or not a boolean', () => {
    for (const idp_only of [undefined, null, 'true', 'false', 1, 0, [], {}]) {
      const parsed = parseEntry(JSON.stringify({ issuer: 'https://i', idp_only }));
      expect(parsed?.idp_only).toBe(false);
    }
  });

  /**
   * Backwards compatibility (#119). An already-registered provider carries the whole discovery
   * document in its ini value; it must parse as an ordinary slim entry, keeping what is still
   * stored and silently dropping what is not — no migration, no broken login screen.
   */
  it('reads an entry still carrying the pre-#119 fat fields, ignoring what is no longer stored', () => {
    const parsed = parseEntry(FAT_ENTRY_JSON);

    expect(parsed).toEqual(entry());
    for (const gone of [
      'scopes',
      'urls',
      'jwks_uri',
      'supported_algorithms',
      'authorization_endpoint',
      'token_endpoint',
      'end_session_endpoint',
    ]) {
      expect(parsed).not.toHaveProperty(gone);
    }
  });
});

describe('serializeEntry', () => {
  it('escapes newlines the way CouchDB config requires (apache/couchdb#5091)', () => {
    const withNewline = entry({ name: 'Line one\nLine two' });
    const raw = serializeEntry(withNewline);
    expect(raw).not.toContain('\n');
    expect(raw).toContain('\\n');
  });

  it('round-trips the slim shape through parseEntry', () => {
    const original = entry({ idp_only: true, alg: 'RS384', last_refreshed: '2026-08-02T00:00:00Z' });
    expect(parseEntry(serializeEntry(original))).toEqual(original);
  });

  it('writes only the slim field set — nothing the discovery document already answers', () => {
    expect(Object.keys(JSON.parse(serializeEntry(entry()))).sort()).toEqual([
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
  });
});

describe('parseSection', () => {
  it('reads every rsa:<kid> entry and ignores log and unparsable values', () => {
    const found = parseSection({
      [oidcKey('kid-1')]: serializeEntry(entry()),
      [LOG_KEY]: 'true',
      [oidcKey('kid-broken')]: 'not json',
      'hand-typed-key': 'whatever',
    });
    expect(found.map((f) => f.kid)).toEqual(['kid-1']);
  });

  it('is empty for an absent section', () => {
    expect(parseSection(undefined)).toEqual([]);
  });
});

describe('groupByIssuer / providersFrom (issuer de-duplication, #32)', () => {
  it('groups two kids of the same issuer into one provider with two keys', () => {
    const shared = entry();
    const found = [
      { kid: 'kid-1', entry: { ...shared, alg: 'RS256' } },
      { kid: 'kid-2', entry: { ...shared, alg: 'RS384' } },
    ];
    const providers = groupByIssuer(found);

    expect(providers).toHaveLength(1);
    expect(providers[0].issuer).toBe(shared.issuer);
    expect(providers[0].keys.map((k) => k.kid)).toEqual(['kid-1', 'kid-2']);
    // First entry wins for the shared metadata.
    expect(providers[0].entry.alg).toBe('RS256');
  });

  it('keeps two different issuers as two providers', () => {
    const providers = groupByIssuer([
      { kid: 'kid-1', entry: entry({ issuer: 'https://a' }) },
      { kid: 'kid-2', entry: entry({ issuer: 'https://b' }) },
    ]);
    expect(providers.map((p) => p.issuer).sort()).toEqual(['https://a', 'https://b']);
  });

  it('providersFrom reads straight out of a NodeConfig dump', () => {
    const config: NodeConfig = {
      [OIDC_SECTION]: {
        [oidcKey('kid-1')]: serializeEntry(entry({ alg: 'RS256' })),
        [oidcKey('kid-2')]: serializeEntry(entry({ alg: 'RS384' })),
      },
    };
    const providers = providersFrom(config);
    expect(providers).toHaveLength(1);
    expect(providers[0].keys).toHaveLength(2);
  });
});

describe('dedupeByIssuer', () => {
  it('keeps the first of two items sharing an issuer', () => {
    const a = { issuer: 'https://i', tag: 'first' };
    const b = { issuer: 'https://i', tag: 'second' };
    expect(dedupeByIssuer([a, b])).toEqual([a]);
  });

  it('keeps items with distinct issuers', () => {
    const a = { issuer: 'https://a' };
    const b = { issuer: 'https://b' };
    expect(dedupeByIssuer([a, b])).toEqual([a, b]);
  });
});

describe('logEnabled (default off, #32)', () => {
  it('is off for an absent key', () => {
    expect(logEnabled(undefined)).toBe(false);
    expect(logEnabled(null)).toBe(false);
  });

  it('is off for anything that is not an affirmative value', () => {
    for (const v of ['false', '0', 'no', 'off', '', 'nonsense']) {
      expect(logEnabled(v)).toBe(false);
    }
  });

  it('is on for true/1/yes/on, case-insensitively and trimmed', () => {
    for (const v of ['true', 'TRUE', ' true ', '1', 'yes', 'on']) {
      expect(logEnabled(v)).toBe(true);
    }
  });
});

describe('orphanKeyKids', () => {
  it('reports a [jwt_keys] entry with no [oidc] twin', () => {
    const config: NodeConfig = {
      [OIDC_SECTION]: { [oidcKey('claimed')]: serializeEntry(entry()) },
      [JWT_KEYS_SECTION]: {
        [oidcKey('claimed')]: '-----BEGIN PUBLIC KEY-----',
        [oidcKey('orphan')]: '-----BEGIN PUBLIC KEY-----',
      },
    };
    expect(orphanKeyKids(config)).toEqual(['orphan']);
  });

  it('is empty when every installed key has an [oidc] twin', () => {
    const config: NodeConfig = {
      [OIDC_SECTION]: { [oidcKey('k')]: serializeEntry(entry()) },
      [JWT_KEYS_SECTION]: { [oidcKey('k')]: '-----BEGIN PUBLIC KEY-----' },
    };
    expect(orphanKeyKids(config)).toEqual([]);
  });

  it('is empty when [jwt_keys] is absent entirely', () => {
    expect(orphanKeyKids({})).toEqual([]);
  });
});
