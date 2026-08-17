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
import { ApiClient } from '../src/services/api-client';
import { ApiError } from '../src/services/api-error';
import { jsonResponse } from './helpers/response';

/**
 * Deliberately a duck type, not `test/helpers/response.ts` (#17).
 *
 * This file is the one place that tests `ApiClient`'s *response handling* rather than using
 * it, so it needs shapes a real `Response` cannot express — `headers.get()` always null, and
 * (below) mocks that omit `text()` entirely to cover the
 * `// Test mocks may provide json() but not text()/headers` branch in `api-client.ts`.
 * Everywhere else in the suite should use the shared real-`Response` helpers.
 */
function mockFetch(body: unknown, status = 200, ok = true) {
  const bodyText = body !== undefined ? JSON.stringify(body) : '';
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: { get: (_name: string) => null },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(bodyText),
  } as unknown as Response);
}

describe('ApiClient', () => {
  let client: ApiClient;

  beforeEach(() => {
    client = new ApiClient('http://test');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('headers', () => {
    it('sends no headers at all on an unauthenticated bodyless GET (#36)', async () => {
      const spy = mockFetch({ status: 'ok' });
      await client.request('GET', '/db');

      const [, init] = spy.mock.calls[0];
      expect(init?.headers).toEqual({});
      expect(init?.credentials).toBe('include');
    });

    it('includes Authorization header after setToken', async () => {
      client.setToken('my-token');
      const spy = mockFetch({ status: 'ok' });
      await client.request('POST', '/db', { hello: 'world' });

      const [, init] = spy.mock.calls[0];
      expect(init?.headers).toEqual({
        'Content-Type': 'application/json',
        Authorization: 'Bearer my-token',
      });
      expect(init?.credentials).toBe('include');
    });

    it('removes Authorization header after setToken(null)', async () => {
      client.setToken('my-token');
      client.setToken(null);
      const spy = mockFetch({ status: 'ok' });
      await client.request('POST', '/db', { hello: 'world' });

      const [, init] = spy.mock.calls[0];
      expect(init?.headers).toEqual({ 'Content-Type': 'application/json' });
      expect(init?.credentials).toBe('include');
    });
  });

  /**
   * #36. `Content-Type` on a bodyless request is not free: it takes the request out of the
   * CORS-simple set, so in SPA mode (app and CouchDB on different origins, spec D5) the browser
   * must send `OPTIONS` before every single read. A GET has no body, so the header describes
   * nothing — it is pure latency in the deployment mode that already has the most of it, plus a
   * header every operator's `[cors] headers` allowlist has to know about.
   *
   * Same-origin `/_utils` never preflights, which is why this stayed invisible.
   *
   * The rule is "a body decides", not "a verb decides": every ctype-validating CouchDB endpoint
   * we call (`POST /_dbs_info`, `POST /{db}`, `_bulk_docs`, `_find`, `_index`, `_session`) sends
   * a body, and the two bodyless writes we make — `POST /_node/_local/_restart` and `PUT /{db}`
   * — have handlers that never call `validate_ctype` (verified against chttpd_node.erl /
   * chttpd_db.erl).
   */
  describe('Content-Type only rides on requests that have a body (#36)', () => {
    const contentTypeOf = (init: RequestInit | undefined) =>
      (init?.headers as Record<string, string> | undefined)?.['Content-Type'];
    const authOf = (init: RequestInit | undefined) =>
      (init?.headers as Record<string, string> | undefined)?.['Authorization'];

    it.each(['GET', 'DELETE'])('sends no Content-Type on a bodyless %s', async (method) => {
      const spy = mockFetch({ ok: true });
      await client.request(method, '/db/doc');

      expect(contentTypeOf(spy.mock.calls[0][1])).toBeUndefined();
    });

    it.each(['POST', 'PUT'])('sends Content-Type on %s with a body', async (method) => {
      const spy = mockFetch({ ok: true });
      await client.request(method, '/db/doc', { hello: 'world' });

      expect(contentTypeOf(spy.mock.calls[0][1])).toBe('application/json');
      expect(spy.mock.calls[0][1]?.body).toBe(JSON.stringify({ hello: 'world' }));
    });

    it('keeps Authorization on every verb, body or no body', async () => {
      client.setToken('my-token');
      const spy = mockFetch({ ok: true });

      await client.request('GET', '/db/doc');
      await client.request('DELETE', '/db/doc?rev=1-x');
      await client.request('POST', '/db', { hello: 'world' });
      await client.request('PUT', '/db/doc', { hello: 'world' });
      await client.requestPreAuth('/_idp');

      expect(spy).toHaveBeenCalledTimes(5);
      for (const [, init] of spy.mock.calls) {
        expect(authOf(init)).toBe('Bearer my-token');
      }
    });

    it('sends no Content-Type from requestPreAuth — the login-screen probe is a bodyless GET', async () => {
      const spy = mockFetch({ idp: [] });
      await client.requestPreAuth('/_idp');

      const [, init] = spy.mock.calls[0];
      expect(init?.method).toBe('GET');
      expect(contentTypeOf(init)).toBeUndefined();
      expect(init?.credentials).toBe('include');
    });
  });

  /**
   * #11. CouchDB offers three authentication handlers — `jwt`, `cookie`, `default` (Basic) —
   * and `ApiClient` could express only the first two, the second of which is browser-only
   * (`credentials: "include"` is inert under Node's fetch: verified, a follow-up request after
   * a successful `POST /_session` still 401s). So a Node consumer could reach only a CouchDB
   * with `[jwt_keys]` configured — which is why the E2E harness hard-required Keycloak.
   */
  describe('credentials (#11)', () => {
    it('sends Basic auth for a basic credential', async () => {
      client.setCredential({ kind: 'basic', username: 'admin', password: 'password' });
      const spy = mockFetch({ status: 'ok' });
      await client.request('GET', '/db');

      const [, init] = spy.mock.calls[0];
      expect((init?.headers as Record<string, string>).Authorization).toBe(
        `Basic ${btoa('admin:password')}`,
      );
    });

    it('sends Bearer for a bearer credential', async () => {
      client.setCredential({ kind: 'bearer', token: 'jwt-here' });
      const spy = mockFetch({ status: 'ok' });
      await client.request('GET', '/db');

      const [, init] = spy.mock.calls[0];
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer jwt-here');
    });

    it('sends no Authorization header for a null credential — the browser cookie path', async () => {
      client.setCredential({ kind: 'bearer', token: 'x' });
      client.setCredential(null);
      const spy = mockFetch({ status: 'ok' });
      await client.request('POST', '/db', { hello: 'world' });

      const [, init] = spy.mock.calls[0];
      expect(init?.headers).toEqual({ 'Content-Type': 'application/json' });
    });

    it('replaces rather than merges — switching credential kinds sends exactly one scheme', async () => {
      client.setCredential({ kind: 'basic', username: 'admin', password: 'password' });
      client.setCredential({ kind: 'bearer', token: 'jwt-here' });
      const spy = mockFetch({ status: 'ok' });
      await client.request('GET', '/db');

      const [, init] = spy.mock.calls[0];
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer jwt-here');
    });

    /**
     * A password is not guaranteed ASCII, and bare `btoa` throws on anything above U+00FF.
     * RFC 7617 says to encode the user-pass as UTF-8 before base64.
     */
    it('encodes a non-ASCII password as UTF-8, which bare btoa cannot', async () => {
      const password = 'sesam-öffne-dich-日本';
      expect(() => btoa(`admin:${password}`)).toThrow();

      client.setCredential({ kind: 'basic', username: 'admin', password });
      const spy = mockFetch({ status: 'ok' });
      await client.request('GET', '/db');

      const sent = (spy.mock.calls[0][1]?.headers as Record<string, string>).Authorization;
      const decoded = new TextDecoder().decode(
        Uint8Array.from(atob(sent.slice('Basic '.length)), (c) => c.charCodeAt(0)),
      );
      expect(decoded).toBe(`admin:${password}`);
    });

    it('handles a colon in the password — only the first separates user from pass', async () => {
      client.setCredential({ kind: 'basic', username: 'admin', password: 'a:b:c' });
      const spy = mockFetch({ status: 'ok' });
      await client.request('GET', '/db');

      const sent = (spy.mock.calls[0][1]?.headers as Record<string, string>).Authorization;
      expect(atob(sent.slice('Basic '.length))).toBe('admin:a:b:c');
    });

    it('setToken stays a thin wrapper, so no existing caller changes', async () => {
      client.setToken('my-token');
      const spy = mockFetch({ status: 'ok' });
      await client.request('GET', '/db');

      expect((spy.mock.calls[0][1]?.headers as Record<string, string>).Authorization).toBe(
        'Bearer my-token',
      );
    });

    it('applies the credential to the /_session probe too, not just ordinary requests', async () => {
      // The 401 disambiguation re-reads /_session with a bare fetch; a Basic session must be
      // able to prove it is still alive, or every 401 would log a Basic user out.
      const onUnauthorized = vi.fn();
      const guarded = new ApiClient('http://test', onUnauthorized);
      guarded.setCredential({ kind: 'basic', username: 'admin', password: 'password' });

      const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        const auth = new Headers(init?.headers).get('Authorization');
        if (String(_url).endsWith('/_session')) {
          expect(auth).toBe(`Basic ${btoa('admin:password')}`);
          return jsonResponse({ ok: true, userCtx: { name: 'admin', roles: ['_admin'] } });
        }
        return jsonResponse({ error: 'unauthorized', reason: 'You are not a server admin.' }, 401);
      });

      await expect(guarded.request('GET', '/_all_dbs')).rejects.toThrow(ApiError);
      expect(onUnauthorized).not.toHaveBeenCalled();   // session alive, so no logout
      expect(spy).toHaveBeenCalledTimes(2);
    });
  });

  describe('CouchDB error mapping', () => {
    it('uses reason, then error, then statusText for the message', async () => {
      const mk = (body: unknown, statusText = '') =>
        ({ ok: false, status: 400, statusText, json: () => Promise.resolve(body) }) as unknown as Response;
      const client = new ApiClient('');
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mk({ error: 'bad_request', reason: 'Invalid rev format' })));
      await expect(client.request('GET', '/db')).rejects.toMatchObject({
        status: 400, message: 'Invalid rev format', body: { error: 'bad_request', reason: 'Invalid rev format' },
      });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mk({ error: 'bad_request' })));
      await expect(client.request('GET', '/db')).rejects.toMatchObject({ message: 'bad_request' });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mk({}, 'Bad Request')));
      await expect(client.request('GET', '/db')).rejects.toMatchObject({ message: 'Bad Request' });
    });

    it('invokes onUnauthorized on 401 except for /_session', async () => {
      const on401 = vi.fn();
      const resp401 = { ok: false, status: 401, statusText: '', json: () => Promise.resolve({ error: 'unauthorized', reason: 'nope' }) } as unknown as Response;
      const client = new ApiClient('', on401);
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp401));
      await expect(client.request('GET', '/db')).rejects.toBeInstanceOf(ApiError);
      expect(on401).toHaveBeenCalledTimes(1);
      await expect(client.request('POST', '/_session', { name: 'x', password: 'y' })).rejects.toBeInstanceOf(ApiError);
      expect(on401).toHaveBeenCalledTimes(1); // unchanged — carve-out
    });
  });

  describe('session-expiry probe (D9): a 401 outside /_session confirms the session is dead before logging out', () => {
    /** Routes fetch by URL suffix so a test can give /_session a different answer than the real request. */
    function mockFetchByPath(answers: Record<string, unknown>) {
      const fetchMock = vi.fn((url: string) => {
        const hit = Object.entries(answers).find(([suffix]) => String(url).endsWith(suffix));
        if (!hit) throw new Error(`unexpected fetch: ${url}`);
        return Promise.resolve(hit[1] as Response);
      });
      vi.stubGlobal('fetch', fetchMock);
      return fetchMock;
    }

    const notAdmin401 = {
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      headers: { get: () => null },
      json: () => Promise.resolve({ error: 'unauthorized', reason: 'You are not a server admin.' }),
    } as unknown as Response;

    const sessionAlive = (name: string | null) =>
      ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: () => Promise.resolve({ ok: true, userCtx: { name, roles: name ? ['_admin'] : [] } }),
      }) as unknown as Response;

    it('(a) leaves an authenticated non-admin logged in: callback not invoked, ApiError still thrown', async () => {
      const onUnauthorized = vi.fn();
      const client = new ApiClient('http://test', onUnauthorized);
      mockFetchByPath({ '/_session': sessionAlive('demo'), '/_all_dbs': notAdmin401 });

      await expect(client.request('GET', '/_all_dbs')).rejects.toMatchObject({
        status: 401,
        message: 'You are not a server admin.',
      });
      expect(onUnauthorized).not.toHaveBeenCalled();
    });

    it('(b) logs out once the probe confirms the session is really dead', async () => {
      const onUnauthorized = vi.fn();
      const client = new ApiClient('http://test', onUnauthorized);
      mockFetchByPath({ '/_session': sessionAlive(null), '/_all_dbs': notAdmin401 });

      await expect(client.request('GET', '/_all_dbs')).rejects.toBeInstanceOf(ApiError);
      expect(onUnauthorized).toHaveBeenCalledTimes(1);
    });

    it('(c) logs out when the probe itself 401s', async () => {
      const onUnauthorized = vi.fn();
      const client = new ApiClient('http://test', onUnauthorized);
      mockFetchByPath({ '/_session': notAdmin401, '/_all_dbs': notAdmin401 });

      await expect(client.request('GET', '/_all_dbs')).rejects.toBeInstanceOf(ApiError);
      expect(onUnauthorized).toHaveBeenCalledTimes(1);
    });

    it('(d) shares one in-flight probe across concurrent 401s', async () => {
      const onUnauthorized = vi.fn();
      const client = new ApiClient('http://test', onUnauthorized);
      let sessionCalls = 0;
      let resolveSession!: (r: Response) => void;
      const sessionPromise = new Promise<Response>((resolve) => {
        resolveSession = resolve;
      });

      const fetchMock = vi.fn((url: string) => {
        if (String(url).endsWith('/_session')) {
          sessionCalls++;
          return sessionPromise;
        }
        return Promise.resolve(notAdmin401);
      });
      vi.stubGlobal('fetch', fetchMock);

      const p1 = client.request('GET', '/_all_dbs').catch((e) => e);
      const p2 = client.request('GET', '/_active_tasks').catch((e) => e);

      // Give both 401 branches room to reach the probe check before it resolves.
      for (let i = 0; i < 6; i++) await Promise.resolve();
      resolveSession(sessionAlive(null));
      await Promise.all([p1, p2]);

      expect(sessionCalls).toBe(1);
      expect(onUnauthorized).toHaveBeenCalledTimes(1);
    });
  });

  describe('credentials and base URL', () => {
    it("sends credentials: 'include' and honours setBaseUrl", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, headers: new Headers(), text: () => Promise.resolve('{}') } as unknown as Response);
      vi.stubGlobal('fetch', fetchMock);
      const client = new ApiClient('');
      client.setBaseUrl('http://couch.example:5984/');
      await client.request('GET', '/_all_dbs');
      expect(fetchMock).toHaveBeenCalledWith('http://couch.example:5984/_all_dbs',
        expect.objectContaining({ credentials: 'include', method: 'GET' }));
    });
  });

  describe('probeUp', () => {
    it('returns true for a CouchDB-shaped /_up', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ status: 'ok' }) } as unknown as Response));
      await expect(new ApiClient('').probeUp('http://x')).resolves.toBe(true);
    });
    it('returns false on non-couch JSON or a network error', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ hello: 'world' }) } as unknown as Response));
      await expect(new ApiClient('').probeUp('http://x')).resolves.toBe(false);
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('net')));
      await expect(new ApiClient('').probeUp('http://x')).resolves.toBe(false);
    });

    /**
     * #13. `chttpd/require_valid_user = true` makes CouchDB answer **401** to an anonymous
     * `GET /_up` — verified live against 3.5.2. Treating that as "not CouchDB" made the app,
     * served from that very server's `/_utils`, drop into SPA mode and ask the user to type in
     * a URL for the server they were already looking at.
     *
     * A 401 carrying CouchDB's `{error: "unauthorized"}` body is stronger evidence of CouchDB
     * than a bare 200 from an arbitrary host: something answered, and it guards its endpoints.
     */
    it('treats a CouchDB-shaped 401 as CouchDB — require_valid_user is not "not CouchDB"', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
        jsonResponse({ error: 'unauthorized', reason: 'Authentication required.' }, 401),
      ));
      await expect(new ApiClient('').probeUp('http://x')).resolves.toBe(true);
    });

    it('does not treat a foreign 401 as CouchDB', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
        jsonResponse({ message: 'Unauthorized' }, 401),   // e.g. a reverse proxy or an SSO wall
      ));
      await expect(new ApiClient('').probeUp('http://x')).resolves.toBe(false);
    });

    it('does not treat a non-JSON 401 as CouchDB', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
        new Response('<html>401 Unauthorized</html>', { status: 401 }),
      ));
      await expect(new ApiClient('').probeUp('http://x')).resolves.toBe(false);
    });

    it('still returns false for 404 and 500 — genuinely not CouchDB', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error: 'not_found' }, 404)));
      await expect(new ApiClient('').probeUp('http://x')).resolves.toBe(false);
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error: 'unauthorized' }, 500)));
      await expect(new ApiClient('').probeUp('http://x')).resolves.toBe(false);
    });

    it('still returns false when the response is not ok and has no body at all', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 } as unknown as Response));
      await expect(new ApiClient('').probeUp('http://x')).resolves.toBe(false);
    });
  });

  // request() delegates to requestWithHeaders() and drops the headers (#683). These pin the
  // empty-response handling, which used to live in request()'s own body.
  describe('request', () => {
    it('returns the parsed JSON body', async () => {
      mockFetch({ id: 'srv1' });

      await expect(client.request('GET', '/api/test')).resolves.toEqual({ id: 'srv1' });
    });

    it('returns undefined on 204 No Content', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        status: 204,
        headers: { get: () => null },
        text: () => Promise.resolve(''),
      } as unknown as Response);

      await expect(client.request('DELETE', '/api/test/123')).resolves.toBeUndefined();
    });

    it('returns undefined when content-length is 0', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: (name: string) => (name === 'content-length' ? '0' : null) },
        text: () => Promise.resolve(''),
      } as unknown as Response);

      await expect(client.request('GET', '/api/test')).resolves.toBeUndefined();
    });

    /**
     * Pins the `// Test mocks may provide json() but not text()/headers` fallback in
     * `requestWithHeaders`. That branch exists ONLY for duck-typed mocks, so nothing else in
     * the suite can reach it — which is exactly how it would rot unnoticed. Deliberately a
     * partial mock (no `text`, no real `headers`): a real `Response` cannot express this, and
     * expressing it is the point (#17).
     */
    it('falls back to json() for a mock that provides no text()', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ id: 'from-json' }),
      } as unknown as Response);

      await expect(client.request('GET', '/api/test')).resolves.toEqual({ id: 'from-json' });
    });

    it('returns undefined for a mock providing neither text() nor json()', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
      } as unknown as Response);

      await expect(client.request('GET', '/api/test')).resolves.toBeUndefined();
    });

    it('returns undefined when the body is empty despite a 200', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: () => Promise.resolve(''),
      } as unknown as Response);

      await expect(client.request('POST', '/api/test')).resolves.toBeUndefined();
    });

    it('throws ApiError and triggers onUnauthorized on 401', async () => {
      const onUnauthorized = vi.fn();
      const guarded = new ApiClient('http://test', onUnauthorized);
      mockFetch({ detail: 'expired' }, 401, false);

      await expect(guarded.request('GET', '/api/protected')).rejects.toThrow(ApiError);
      expect(onUnauthorized).toHaveBeenCalledOnce();
    });
  });

  describe('requestWithHeaders', () => {
    it('returns data and headers on successful response', async () => {
      const responseData = { id: 123, name: 'Test' };
      const headerValue = 'test-header-value';

      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        headers: {
          get: (name: string) => (name === 'x-custom-header' ? headerValue : null),
        },
        text: () => Promise.resolve(JSON.stringify(responseData)),
      } as unknown as Response);

      const result = await client.requestWithHeaders('GET', '/api/test');

      expect(result.data).toEqual(responseData);
      expect(result.headers.get('x-custom-header')).toBe(headerValue);
    });

    it('handles 204 No Content with headers', async () => {
      const headerValue = 'content-header';

      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        status: 204,
        headers: {
          get: (name: string) => (name === 'x-location' ? headerValue : '0'),
        },
        text: () => Promise.resolve(''),
      } as unknown as Response);

      const result = await client.requestWithHeaders('DELETE', '/api/test/123');

      expect(result.data).toBeUndefined();
      expect(result.headers.get('x-location')).toBe(headerValue);
    });

    it('returns undefined data when response is empty', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: () => Promise.resolve(''),
      } as unknown as Response);

      const result = await client.requestWithHeaders('POST', '/api/test');

      expect(result.data).toBeUndefined();
      expect(result.headers).not.toBeNull();
    });

    it('triggers onUnauthorized on 401 in requestWithHeaders', async () => {
      const logoutHandler = vi.fn();
      client.onUnauthorized = logoutHandler;

      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        headers: { get: () => null },
        json: () => Promise.resolve({ detail: 'Session expired' }),
      } as unknown as Response);

      await expect(client.requestWithHeaders('GET', '/api/protected')).rejects.toThrow(ApiError);
      expect(logoutHandler).toHaveBeenCalledTimes(1);
    });

    it('throws ApiError on error response in requestWithHeaders', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Error',
        headers: { get: () => null },
        json: () => Promise.resolve({ detail: 'Server error' }),
      } as unknown as Response);

      await expect(client.requestWithHeaders('POST', '/api/test')).rejects.toThrow(ApiError);
    });
  });
});
