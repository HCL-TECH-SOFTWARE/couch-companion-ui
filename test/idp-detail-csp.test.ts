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
 * Narrowing `connect-src` when an identity provider is deleted (#149).
 *
 * The subtraction is the part worth pinning. Adding an origin is a switch the operator throws;
 * removing one happens on their behalf, so it has to be provably conservative — it may take back
 * only what the deleted provider contributed and nothing any remaining provider still needs. Two
 * Keycloak realms on one host is the ordinary case that would otherwise lock the survivor out,
 * silently, which is the same class of bug as never widening the policy in the first place.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getContext } from '../src/context';
import '../src/plugins/idp/idp-detail';
import type { CcaIdpDetail } from '../src/plugins/idp/idp-detail';
import type { IdpConfig } from '../src/plugins/idp/types';

const idp = (name: string, origins: string[]): IdpConfig => ({
  _id: `https://${name}.example.com/realms/${name}`,
  name,
  issuer: `https://${name}.example.com/realms/${name}`,
  well_known_url: `https://${name}.example.com/realms/${name}/.well-known/openid-configuration`,
  client_id: null,
  roles_claim: 'roles',
  idp_only: false,
  jwks_keys: [],
  csp_origins: origins,
  last_refreshed: null,
  created_at: '2026-08-15T00:00:00.000Z',
});

const POLICY =
  "default-src 'self'; connect-src 'self' https://gone.example https://shared.example";

let mounted: HTMLElement[] = [];

async function mount(): Promise<CcaIdpDetail> {
  const el = document.createElement('cca-idp-detail') as CcaIdpDetail;
  document.body.appendChild(el);
  mounted.push(el);
  await el.updateComplete;
  return el;
}

describe('cca-idp-detail — releasing CSP origins on delete (#149)', () => {
  beforeEach(() => {
    getContext().deployment = { mode: 'same-origin', baseUrl: 'http://localhost:5984' };
    vi.spyOn(getContext().csp, 'readUtilsPolicy').mockResolvedValue(POLICY);
  });

  afterEach(() => {
    for (const el of mounted) el.remove();
    mounted = [];
    vi.restoreAllMocks();
  });

  it('removes only the origins no remaining provider needs', async () => {
    vi.spyOn(getContext().idp, 'listIdps').mockResolvedValue([
      idp('kept', ['https://shared.example']),
    ]);
    const write = vi.spyOn(getContext().csp, 'writeUtilsPolicy').mockResolvedValue();

    const el = await mount();
    await el.releaseCspOrigins(idp('gone', ['https://gone.example', 'https://shared.example']));

    expect(write).toHaveBeenCalledTimes(1);
    const header = write.mock.calls[0][1];
    expect(header).not.toContain('https://gone.example');
    // The survivor's origin stays, and so does everything the policy already said.
    expect(header).toContain('https://shared.example');
    expect(header).toContain("default-src 'self'");
  });

  it('writes nothing at all when every origin is still in use', async () => {
    vi.spyOn(getContext().idp, 'listIdps').mockResolvedValue([
      idp('kept', ['https://gone.example', 'https://shared.example']),
    ]);
    const write = vi.spyOn(getContext().csp, 'writeUtilsPolicy').mockResolvedValue();

    const el = await mount();
    await el.releaseCspOrigins(idp('gone', ['https://gone.example', 'https://shared.example']));

    expect(write).not.toHaveBeenCalled();
  });

  /*
   * An origin the policy never listed is not ours to take out: rewriting the header to remove
   * something that was never there is a config write with no effect, and the reason it is absent
   * may be a wildcard or a host pattern the operator wrote deliberately.
   */
  it('writes nothing when the policy does not list the origin anyway', async () => {
    vi.spyOn(getContext().idp, 'listIdps').mockResolvedValue([]);
    const write = vi.spyOn(getContext().csp, 'writeUtilsPolicy').mockResolvedValue();

    const el = await mount();
    await el.releaseCspOrigins(idp('gone', ['https://never-listed.example']));

    expect(write).not.toHaveBeenCalled();
  });

  /* SPA mode: the policy belongs to whoever serves the page, so CouchDB's config key is not it. */
  it('leaves the policy alone in SPA mode', async () => {
    getContext().deployment = { mode: 'spa', baseUrl: '' };
    vi.spyOn(getContext().idp, 'listIdps').mockResolvedValue([]);
    const write = vi.spyOn(getContext().csp, 'writeUtilsPolicy').mockResolvedValue();

    const el = await mount();
    await el.releaseCspOrigins(idp('gone', ['https://gone.example']));

    expect(write).not.toHaveBeenCalled();
  });
});
