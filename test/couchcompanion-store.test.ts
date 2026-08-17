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
import type { MockInstance } from 'vitest';
import { ApiClient } from '../src/services/api-client.js';
import { ApiError } from '../src/services/api-error.js';
import { dbPath, docPath } from '../src/services/db-mgmt-service.js';
import {
  CouchCompanionStore, COMPANION_DB, ID_PREFIX, syncStateId, conflictId,
} from '../src/services/git/couchcompanion-store.js';
import { jsonResponse } from './helpers/response.js';

describe('document ids', () => {
  it('drops the server segment (spec section 8) and strips the _design/ prefix', () => {
    expect(syncStateId('sales', '_design/reports')).toBe('sync:sales~ddoc:reports');
    expect(syncStateId('sales', 'reports')).toBe('sync:sales~ddoc:reports');
  });

  it('makes conflict ids deterministic so re-detection updates instead of duplicating', () => {
    expect(conflictId('sales', '_design/reports')).toBe('conflict:sales~ddoc:reports');
    expect(conflictId('sales', '_design/reports')).toBe(conflictId('sales', '_design/reports'));
  });
});

describe('CouchCompanionStore', () => {
  let store: CouchCompanionStore;
  let apiClient: ApiClient;
  let requestSpy: MockInstance;

  beforeEach(() => {
    apiClient = new ApiClient('http://test');
    store = new CouchCompanionStore(apiClient);
    requestSpy = vi.spyOn(apiClient, 'request');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates the database on first write and not before (D13)', async () => {
    requestSpy
      // get(id): the doc doesn't exist yet either way — the database itself is missing.
      .mockRejectedValueOnce(new ApiError(404, 'Database does not exist.'))
      // write attempt 1: fails because the database is missing.
      .mockRejectedValueOnce(new ApiError(404, 'Database does not exist.'))
      // ensureDatabase(): succeeds.
      .mockResolvedValueOnce(undefined)
      // write attempt 2 (retry): succeeds.
      .mockResolvedValueOnce({ id: 'gitaccount:1', rev: '1-a' });

    await store.put('gitaccount:1', { doc_type: 'gitaccount' });

    expect(requestSpy).toHaveBeenCalledWith('PUT', dbPath(COMPANION_DB));
    const writeCalls = requestSpy.mock.calls.filter(
      ([method, path]) => method === 'PUT' && path === docPath(COMPANION_DB, 'gitaccount:1'),
    );
    expect(writeCalls).toHaveLength(2); // failed, then retried after ensureDatabase()
  });

  it('does not touch the database when a write succeeds', async () => {
    requestSpy.mockResolvedValue({ id: 'gitaccount:1', rev: '1-a' });

    await store.put('gitaccount:1', {});

    expect(requestSpy).not.toHaveBeenCalledWith('PUT', dbPath(COMPANION_DB));
  });

  it('scans one id prefix exactly, with the ￰ sentinel as the end key', async () => {
    requestSpy.mockResolvedValueOnce({ rows: [] });

    await store.list(ID_PREFIX.account);

    expect(requestSpy).toHaveBeenCalledTimes(1);
    const [method, path] = requestSpy.mock.calls[0] as [string, string];
    expect(method).toBe('GET');
    expect(path).toContain(`${dbPath(COMPANION_DB)}/_all_docs?`);
    expect(path).toContain('include_docs=true');
    expect(path).toContain(`startkey=${encodeURIComponent(JSON.stringify('gitaccount:'))}`);
    expect(path).toContain(`endkey=${encodeURIComponent(JSON.stringify('gitaccount:￰'))}`);
  });

  it('resolves a missing database to an empty list, not an error', async () => {
    requestSpy.mockRejectedValue(new ApiError(404, 'Database does not exist.'));

    expect(await store.list(ID_PREFIX.repo)).toEqual([]);
  });

  it('reports a non-admin 403 rather than swallowing it as "nothing here"', async () => {
    requestSpy.mockRejectedValue(new ApiError(403, 'You are not a server admin.'));

    await expect(store.list(ID_PREFIX.repo)).rejects.toThrow(/admin/i);
  });

  it('resolves a missing document to null', async () => {
    requestSpy.mockRejectedValue(new ApiError(404, 'missing'));

    expect(await store.get('gitaccount:nope')).toBeNull();
  });

  /**
   * Issue #6 item 11. The self-heal used to require the word "database" in the error *message*,
   * which `ApiClient` builds from the response body (`reason`/`error`), falling back to
   * `statusText`. A reverse proxy that strips error bodies therefore yielded a bare `"Not Found"`
   * and the D13 lazy-create never fired — the first write on a fresh server failed permanently.
   *
   * Driven through a real `fetch` rather than a hand-made `ApiError`, so the message under test is
   * the one `ApiClient` actually produces for a bodiless 404, not one this test invented.
   */
  it('creates the database when a bodiless 404 answers the write (a body-stripping proxy must not defeat D13)', async () => {
    const calls: string[] = [];
    let dbExists = false;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${url}`);
      if (method === 'PUT' && url === `http://test${dbPath(COMPANION_DB)}`) {
        dbExists = true;
        return jsonResponse({ ok: true }, 201);
      }
      // Everything the proxy answers before the database exists: 404, no body at all.
      if (!dbExists) return new Response(null, { status: 404, statusText: 'Not Found' });
      if (method === 'PUT') return jsonResponse({ ok: true, id: 'gitaccount:1', rev: '1-a' }, 201);
      return new Response(null, { status: 404, statusText: 'Not Found' });
    }) as unknown as typeof fetch;

    await store.put('gitaccount:1', { doc_type: 'git_account' });

    expect(calls).toContain(`PUT http://test${dbPath(COMPANION_DB)}`);
    const writes = calls.filter((c) => c === `PUT http://test${docPath(COMPANION_DB, 'gitaccount:1')}`);
    expect(writes).toHaveLength(2); // failed, then retried after ensureDatabase()
  });

  it('carries _rev forward on update so a second write is not a conflict', async () => {
    requestSpy
      .mockResolvedValueOnce({ _id: 'gitaccount:1', _rev: '3-c', label: 'old' }) // get()
      .mockResolvedValueOnce({ id: 'gitaccount:1', rev: '4-d' }); // write()

    await store.put('gitaccount:1', { label: 'new' });

    const [method, path, body] = requestSpy.mock.calls[1] as [string, string, Record<string, unknown>];
    expect(method).toBe('PUT');
    expect(path).toBe(docPath(COMPANION_DB, 'gitaccount:1'));
    expect(body).toEqual(expect.objectContaining({ _rev: '3-c', label: 'new' }));
  });

  it('reads the current _rev before deleting a single document by id', async () => {
    requestSpy
      .mockResolvedValueOnce({ _id: 'sync:sales~ddoc:reports', _rev: '4-d' }) // get()
      .mockResolvedValueOnce({ ok: true }); // DELETE

    await store.remove('sync:sales~ddoc:reports');

    const [method, path] = requestSpy.mock.calls[1] as [string, string];
    expect(method).toBe('DELETE');
    expect(path).toContain('rev=4-d');
  });

  /**
   * Issue #6 item 12. Every sweep (`detachTarget`, `deleteRepo`, `unlinkRepo`, `deleteRepoDocs`)
   * removed documents one at a time through {@link CouchCompanionStore.remove}, which re-reads each
   * document purely for its `_rev` — two round trips per document, even though `list()` had just
   * returned every one of them *with* its `_rev`.
   */
  describe('removeAll', () => {
    it('deletes documents that already carry a _rev in one _bulk_docs, re-reading nothing', async () => {
      requestSpy.mockResolvedValueOnce([
        { ok: true, id: 'sync:sales~ddoc:reports', rev: '3-c' },
        { ok: true, id: 'conflict:sales~ddoc:reports', rev: '2-b' },
      ]);

      await store.removeAll([
        { _id: 'sync:sales~ddoc:reports', _rev: '2-b' },
        { _id: 'conflict:sales~ddoc:reports', _rev: '1-a' },
      ]);

      expect(requestSpy).toHaveBeenCalledTimes(1);
      const [method, path, body] = requestSpy.mock.calls[0] as [string, string, Record<string, unknown>];
      expect(method).toBe('POST');
      expect(path).toBe(`${dbPath(COMPANION_DB)}/_bulk_docs`);
      expect(body).toEqual({
        docs: [
          { _id: 'sync:sales~ddoc:reports', _rev: '2-b', _deleted: true },
          { _id: 'conflict:sales~ddoc:reports', _rev: '1-a', _deleted: true },
        ],
      });
    });

    it('resolves the revisions of id-only entries in a single _all_docs lookup, not one GET each', async () => {
      requestSpy
        .mockResolvedValueOnce({
          rows: [
            { id: 'sync:sales~ddoc:reports', key: 'sync:sales~ddoc:reports', value: { rev: '7-g' } },
            { id: 'sync:sales~ddoc:views', key: 'sync:sales~ddoc:views', value: { rev: '9-i' } },
          ],
        })
        .mockResolvedValueOnce([{ ok: true, id: 'sync:sales~ddoc:reports' }, { ok: true, id: 'sync:sales~ddoc:views' }]);

      await store.removeAll(['sync:sales~ddoc:reports', 'sync:sales~ddoc:views']);

      expect(requestSpy).toHaveBeenCalledTimes(2);
      const [lookupMethod, lookupPath, lookupBody] = requestSpy.mock.calls[0] as [string, string, unknown];
      expect(lookupMethod).toBe('POST');
      expect(lookupPath).toBe(`${dbPath(COMPANION_DB)}/_all_docs`);
      expect(lookupBody).toEqual({ keys: ['sync:sales~ddoc:reports', 'sync:sales~ddoc:views'] });
      const [, , deleteBody] = requestSpy.mock.calls[1] as [string, string, { docs: unknown[] }];
      expect(deleteBody.docs).toEqual([
        { _id: 'sync:sales~ddoc:reports', _rev: '7-g', _deleted: true },
        { _id: 'sync:sales~ddoc:views', _rev: '9-i', _deleted: true },
      ]);
    });

    it('skips an id that no longer exists instead of failing the whole sweep', async () => {
      requestSpy
        .mockResolvedValueOnce({
          rows: [
            { key: 'sync:sales~ddoc:gone', error: 'not_found' },
            { id: 'sync:sales~ddoc:reports', key: 'sync:sales~ddoc:reports', value: { rev: '7-g' } },
          ],
        })
        .mockResolvedValueOnce([{ ok: true, id: 'sync:sales~ddoc:reports' }]);

      await store.removeAll(['sync:sales~ddoc:gone', 'sync:sales~ddoc:reports']);

      const [, , deleteBody] = requestSpy.mock.calls[1] as [string, string, { docs: unknown[] }];
      expect(deleteBody.docs).toEqual([{ _id: 'sync:sales~ddoc:reports', _rev: '7-g', _deleted: true }]);
    });

    it('makes no request at all when there is nothing to delete', async () => {
      requestSpy.mockResolvedValueOnce({ rows: [{ key: 'sync:x', error: 'not_found' }] });

      await store.removeAll([]);
      await store.removeAll([{ _id: 'sync:x' }]); // unresolvable: no _rev, and _all_docs finds nothing

      expect(requestSpy).toHaveBeenCalledTimes(1); // the lookup only; never an empty _bulk_docs
      expect(requestSpy.mock.calls[0][1]).toBe(`${dbPath(COMPANION_DB)}/_all_docs`);
    });

    it('resolves a missing database to a no-op, exactly like remove() does', async () => {
      requestSpy.mockRejectedValueOnce(new ApiError(404, 'Database does not exist.'));
      await expect(store.removeAll(['sync:sales~ddoc:reports'])).resolves.toBeUndefined();
    });

    it('names the documents _bulk_docs refused rather than reporting a clean sweep', async () => {
      requestSpy.mockResolvedValueOnce([
        { ok: true, id: 'sync:sales~ddoc:reports' },
        { id: 'sync:sales~ddoc:views', error: 'conflict', reason: 'Document update conflict.' },
      ]);

      await expect(
        store.removeAll([
          { _id: 'sync:sales~ddoc:reports', _rev: '1-a' },
          { _id: 'sync:sales~ddoc:views', _rev: '1-a' },
        ]),
      ).rejects.toThrow(/sync:sales~ddoc:views/);
    });
  });
});
