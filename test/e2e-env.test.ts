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
 * The E2E harness's env plumbing (#11).
 *
 * Lives outside `test/e2e/` on purpose so it runs in the ordinary `npm test` gate — the suite
 * it describes does not (see `vitest.config.ts`'s `exclude`). Nothing here does any I/O; it
 * tests the synchronous decision that keeps a credential-absent run a visible SKIP rather than
 * a confusing failure.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { authMode, missingVar, hasCredentials, sanitizeCouchUrl } from './e2e/helpers/env';

const KEYS = [
  'CCA_E2E_GIT_TOKEN',
  'CCA_E2E_GIT_REPO',
  'CCA_E2E_GIT_BASE_URL',
  'CCA_E2E_COUCH_URL',
  'CCA_E2E_AUTH_MODE',
  'CCA_E2E_ADMIN_USER',
  'CCA_E2E_ADMIN_PASSWORD',
] as const;

let saved: Record<string, string | undefined>;

/** The four variables that make a run "configured" in the default jwt mode. */
function setRequired() {
  process.env.CCA_E2E_GIT_TOKEN = 'tok';
  process.env.CCA_E2E_GIT_REPO = 'https://github.example.com/o/r';
  process.env.CCA_E2E_GIT_BASE_URL = '';   // empty is legal: means github.com
  process.env.CCA_E2E_COUCH_URL = 'http://localhost:5984';
}

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('authMode', () => {
  it('defaults to jwt, so existing devcontainer runs are unchanged', () => {
    expect(authMode()).toBe('jwt');
  });

  it('accepts basic, case- and whitespace-insensitively', () => {
    process.env.CCA_E2E_AUTH_MODE = '  BASIC ';
    expect(authMode()).toBe('basic');
  });

  it('rejects an unrecognised mode rather than silently falling back to jwt', () => {
    // Falling back would send a Keycloak-shaped run at a server that has no IdP, and the
    // failure would look like a CouchDB problem rather than a typo.
    process.env.CCA_E2E_AUTH_MODE = 'bearer';
    expect(() => authMode()).toThrow(/CCA_E2E_AUTH_MODE/);
  });
});

describe('the skip gate', () => {
  it('names the first missing required variable', () => {
    expect(missingVar()).toBe('CCA_E2E_GIT_TOKEN');
    expect(hasCredentials()).toBe(false);
  });

  it('treats an empty CCA_E2E_GIT_BASE_URL as present — it means github.com', () => {
    setRequired();
    expect(missingVar()).toBeNull();
    expect(hasCredentials()).toBe(true);
  });

  /**
   * In basic mode these are CouchDB credentials, not Keycloak ones, so the devcontainer
   * defaults (`hariseldon`/`password`) do NOT apply — using them would fail against any real
   * server with "Name or password is incorrect". Requiring them explicitly turns that into a
   * visible skip.
   */
  it('additionally requires an admin user in basic mode', () => {
    setRequired();
    process.env.CCA_E2E_AUTH_MODE = 'basic';

    expect(missingVar()).toBe('CCA_E2E_ADMIN_USER');
  });

  it('additionally requires an admin password in basic mode', () => {
    setRequired();
    process.env.CCA_E2E_AUTH_MODE = 'basic';
    process.env.CCA_E2E_ADMIN_USER = 'admin';

    expect(missingVar()).toBe('CCA_E2E_ADMIN_PASSWORD');
  });

  it('is satisfied in basic mode once both are set', () => {
    setRequired();
    process.env.CCA_E2E_AUTH_MODE = 'basic';
    process.env.CCA_E2E_ADMIN_USER = 'admin';
    process.env.CCA_E2E_ADMIN_PASSWORD = 'password';

    expect(missingVar()).toBeNull();
  });

  it('does NOT require them in jwt mode — the devcontainer defaults apply there', () => {
    setRequired();

    expect(missingVar()).toBeNull();
  });
});

describe('sanitizeCouchUrl', () => {
  it('strips userinfo, which Node fetch refuses to construct a request from', () => {
    expect(sanitizeCouchUrl('http://admin:password@localhost:5984')).toBe('http://localhost:5984');
  });

  it('leaves a clean URL alone, minus any trailing slash', () => {
    expect(sanitizeCouchUrl('http://localhost:5984/')).toBe('http://localhost:5984');
  });
});
