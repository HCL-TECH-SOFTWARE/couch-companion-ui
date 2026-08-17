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

import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchJson, OidcHttpError } from '../src/services/oidc-http';
import { jsonResponse } from './helpers/response';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

/** A browser reports a CORS rejection as a bare TypeError with no status to inspect. */
function corsRejection() {
  return vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
}

function respondsWith(body: unknown, init: { status?: number } = {}) {
  return vi.fn().mockImplementation(async () => jsonResponse(body, init.status ?? 200));
}

describe('fetchJson', () => {
  it('returns the parsed body on success', async () => {
    globalThis.fetch = respondsWith({ issuer: 'https://idp.example/realms/couch' });

    await expect(fetchJson('https://idp.example/.well-known/openid-configuration')).resolves.toEqual(
      { issuer: 'https://idp.example/realms/couch' },
    );
  });

  it('classifies a network-level rejection as cors-blocked', async () => {
    globalThis.fetch = corsRejection();

    // The distinction is load-bearing: `cors-blocked` is the ONLY condition that should offer
    // the operator the paste-JWKS fallback (D15). A 404 means the URL is wrong, and pasting
    // a JWKS would paper over a typo.
    await expect(fetchJson('https://idp.example/certs')).rejects.toMatchObject({
      kind: 'cors-blocked',
    });
  });

  it('classifies a 404 as not-found, not cors-blocked', async () => {
    globalThis.fetch = respondsWith({ error: 'nope' }, { status: 404 });

    await expect(fetchJson('https://idp.example/certs')).rejects.toMatchObject({
      kind: 'not-found',
    });
  });

  it('classifies other non-2xx responses as http-error carrying the status', async () => {
    globalThis.fetch = respondsWith('boom', { status: 500 });

    await expect(fetchJson('https://idp.example/certs')).rejects.toMatchObject({
      kind: 'http-error',
      status: 500,
    });
  });

  it('classifies an unparseable 200 body as malformed', async () => {
    globalThis.fetch = respondsWith('<html>not json</html>');

    await expect(fetchJson('https://idp.example/certs')).rejects.toMatchObject({
      kind: 'malformed',
    });
  });

  it('reports the URL it failed on so the paste fallback can name it', async () => {
    globalThis.fetch = corsRejection();

    await expect(fetchJson('https://idp.example/certs')).rejects.toMatchObject({
      url: 'https://idp.example/certs',
    });
  });

  it('throws OidcHttpError instances, so callers can instanceof them', async () => {
    globalThis.fetch = corsRejection();

    await expect(fetchJson('https://idp.example/certs')).rejects.toBeInstanceOf(OidcHttpError);
  });

  it('never sends credentials — the IdP is a foreign origin with its own session', async () => {
    const spy = respondsWith({ ok: true });
    globalThis.fetch = spy;

    await fetchJson('https://idp.example/certs');

    expect(spy.mock.calls[0][1]).toMatchObject({ credentials: 'omit' });
  });

  it('aborts rather than hanging when the IdP never answers', async () => {
    globalThis.fetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    });

    await expect(fetchJson('https://idp.example/certs', 10)).rejects.toBeInstanceOf(OidcHttpError);
  });
});
