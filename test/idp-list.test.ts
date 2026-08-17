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
import { getContext } from '../src/context';
import '../src/plugins/idp/idp-list';
import type { CcaIdpList } from '../src/plugins/idp/idp-list';

// A hand-written [oidc] entry (#32): an operator (or a config restored from another server)
// can add one without ever running discovery, so it may omit every optional field — and here
// it also still carries the pre-#119 fat fields a real already-registered provider has, which
// the list must ignore rather than choke on. The [jwt_keys] twin is deliberately unwritten.
const NODE_CONFIG = {
  oidc: {
    'rsa:legacykid': JSON.stringify({
      name: 'idp-keycloak',
      issuer: 'http://idp:8090/realms/empire',
      well_known_url: 'http://idp:8090/realms/empire/.well-known/openid-configuration',
      client_id: null,
      roles_claim: 'realm_access.roles',
      urls: null,
      scopes: null,
      supported_algorithms: ['RS256'],
      jwks_uri: 'http://idp:8090/realms/empire/protocol/openid-connect/certs',
    }),
  },
  // No [jwt_keys] twin — CouchDB was never told about this key, so the badge must say so
  // rather than assume the key is installed.
  jwt_keys: {},
};

let mounted: HTMLElement[] = [];

describe('cca-idp-list', () => {
  beforeEach(() => {
    // Both `listIdps` and `listOrphanKeys` read the whole node config (#32), so one mocked
    // GET response serves both calls.
    vi.spyOn(getContext().api, 'request').mockResolvedValue(structuredClone(NODE_CONFIG));
  });

  afterEach(() => {
    for (const el of mounted) el.remove();
    mounted = [];
    vi.restoreAllMocks();
  });

  it('renders a hand-written [oidc] entry carrying null and pre-#119 fields', async () => {
    const el = document.createElement('cca-idp-list') as CcaIdpList;
    document.body.appendChild(el);
    mounted.push(el);

    await vi.waitFor(() => {
      const table = el.shadowRoot?.querySelector('cca-data-table');
      expect(table?.shadowRoot?.textContent).toContain('idp-keycloak');
    });

    const table = el.shadowRoot!.querySelector('cca-data-table')!;
    // One [oidc] entry, no [jwt_keys] twin: "0 of 1 installed", not a crash on a null array.
    expect(table.shadowRoot!.textContent).toContain('0 of 1 installed');
  });

  /** #104: there is one server, so a per-IdP server count was a column of the same number. */
  it('no longer offers a Servers column', async () => {
    const el = document.createElement('cca-idp-list') as CcaIdpList;
    document.body.appendChild(el);
    mounted.push(el);

    await vi.waitFor(() => {
      const table = el.shadowRoot?.querySelector('cca-data-table');
      expect(table?.shadowRoot?.textContent).toContain('idp-keycloak');
    });

    const headers = Array.from(
      el.shadowRoot!.querySelector('cca-data-table')!.shadowRoot!.querySelectorAll('th'),
    ).map((th) => th.textContent?.trim());
    expect(headers).not.toContain('Servers');
    expect(headers).toContain('Issuer');
  });
});
