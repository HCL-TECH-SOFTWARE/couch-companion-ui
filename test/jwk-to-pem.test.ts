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

import { describe, it, expect } from 'vitest';
import {
  jwkToSpkiPem,
  escapeForCouchConfig,
  signingKeys,
  type RsaJwk,
} from '../src/services/jwk-to-pem';

/**
 * The real RS256 signing key from the devcontainer Keycloak realm (`couch`), and the PEM
 * `scripts/jwks-to-pem.mjs` produces from it via `node:crypto`. That script is what
 * `seed-dev.sh` feeds into CouchDB's `[jwt_keys]` today, so matching its output byte-for-byte
 * is the whole contract: a PEM this converter produces must be one CouchDB already accepts.
 */
const KEYCLOAK_RS256: RsaJwk = {
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

const EXPECTED_PEM = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA5xOdf6K7wgxq+Nkow8Ch
HB1xnt5ak9UdBbNcpSocs1IpFGclWaysyfB5qHd50veuDDkBozNdApid8Y++GDt4
ET/g5o/S7wWt3RBbW+ejfMjQyunUzA/mfXkL6V2G3dIGmQUMwTbfVL/kmdX7q1+W
dlOfQNybB+hO3qkeroPDwo70S6iPVeBVi199W2i2TbT0hgUkITxGLkkKdeHS9hMt
MKRI1hOB6u+R/4eOLG2Ad5RZQwG6FqKb1BirNi5VXqvR3TIhyHaxpqSYe3iKlLes
xjNJX1AQSmKvGM0b2x1CcalreYlXTB5WhUFCEqwe9xRlpWxy0P+OBO4F3h1RWVlg
kQIDAQAB
-----END PUBLIC KEY-----
`;

describe('jwkToSpkiPem', () => {
  it('reproduces the PEM node:crypto produces for the devcontainer Keycloak key', async () => {
    expect(await jwkToSpkiPem(KEYCLOAK_RS256)).toBe(EXPECTED_PEM);
  });

  it('wraps the base64 body at 64 characters', async () => {
    const body = (await jwkToSpkiPem(KEYCLOAK_RS256)).split('\n').slice(1, -2);
    expect(body[0].length).toBe(64);
    expect(body.every((line) => line.length <= 64)).toBe(true);
  });

  it('imports an RS512 key under its own digest', async () => {
    // A hardcoded SHA-256 would make importKey reject the declared alg on some engines;
    // the SPKI bytes are digest-independent, so this asserts it completes at all.
    await expect(jwkToSpkiPem({ ...KEYCLOAK_RS256, alg: 'RS512' })).resolves.toContain(
      'BEGIN PUBLIC KEY',
    );
  });

  it('rejects a non-RSA key rather than emitting a bad PEM', async () => {
    await expect(jwkToSpkiPem({ ...KEYCLOAK_RS256, kty: 'EC' })).rejects.toThrow(/RSA/);
  });
});

describe('signingKeys', () => {
  it('keeps RSA keys marked for signing', () => {
    expect(signingKeys([KEYCLOAK_RS256])).toEqual([KEYCLOAK_RS256]);
  });

  it('keeps RSA keys with no use declared', () => {
    const noUse: RsaJwk = { ...KEYCLOAK_RS256, use: undefined };
    expect(signingKeys([noUse])).toEqual([noUse]);
  });

  it('drops encryption keys', () => {
    expect(signingKeys([{ ...KEYCLOAK_RS256, use: 'enc' }])).toEqual([]);
  });

  it('drops non-RSA keys', () => {
    expect(signingKeys([{ ...KEYCLOAK_RS256, kty: 'EC' }])).toEqual([]);
  });
});

describe('escapeForCouchConfig', () => {
  /**
   * CouchDB's `_config` PUT rejects values containing literal newline bytes
   * (apache/couchdb#5091) — it wants the PEM's line breaks stored as the literal
   * two-character escape. See `scripts/jwks-to-pem.mjs:6-13`.
   */
  it('replaces newline bytes with a literal backslash-n', () => {
    expect(escapeForCouchConfig('a\nb\n')).toBe('a\\nb\\n');
  });

  it('leaves a value with no newlines untouched', () => {
    expect(escapeForCouchConfig('roles')).toBe('roles');
  });

  it('leaves no literal newline byte anywhere in a converted PEM', () => {
    expect(escapeForCouchConfig(EXPECTED_PEM)).not.toContain('\n');
  });
});
