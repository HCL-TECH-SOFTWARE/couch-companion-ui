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
import { ApiClient } from '../src/services/api-client';
import { ApiError } from '../src/services/api-error';
import { DbMgmtService, docPath, isDatabaseAdmin } from '../src/services/db-mgmt-service';
import { SINGLE_SERVER_ID } from '../src/services/single-server';
import type { DatabaseAccess, DatabaseRoles } from '../src/plugins/db-mgmt/types';

describe('DbMgmtService', () => {
  let service: DbMgmtService;
  let apiClient: ApiClient;
  let requestSpy: MockInstance;

  beforeEach(() => {
    apiClient = new ApiClient('http://test');
    service = new DbMgmtService(apiClient);
    requestSpy = vi.spyOn(apiClient, 'request');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('listDatabases', () => {
    const dbsInfoFor = (keys: string[]) => {
      const info: Record<string, { db_name: string; doc_count: number; sizes: { file: number }; props?: { partitioned?: boolean } }> = {
        alpha: { db_name: 'alpha', doc_count: 3, sizes: { file: 100 }, props: {} },
        beta: { db_name: 'beta', doc_count: 0, sizes: { file: 50 }, props: { partitioned: true } }
      };
      return keys.map((key) => ({ key, info: info[key] }));
    };

    beforeEach(() => {
      requestSpy.mockImplementation(async (_method: string, path: string, body?: unknown) => {
        if (path === '/_all_dbs') return ['alpha', 'beta'];
        if (path === '/_dbs_info') return dbsInfoFor((body as { keys: string[] }).keys);
        throw new Error(`unexpected ${path}`);
      });
    });

    it('maps _all_dbs + _dbs_info into one-server DatabaseOverviews', async () => {
      const dbs = await service.listDatabases();
      expect(requestSpy).toHaveBeenCalledWith('GET', '/_all_dbs');
      expect(requestSpy).toHaveBeenCalledWith('POST', '/_dbs_info', { keys: ['alpha', 'beta'] });
      expect(dbs[0]).toEqual({
        db_name: 'alpha',
        servers: [
          { server_id: SINGLE_SERVER_ID, server_name: expect.any(String), doc_count: 3, size_bytes: 100, partitioned: false }
        ]
      });
      expect(dbs[1].servers[0].partitioned).toBe(true);
    });

    it('filters by name and sorts by doc_count desc', async () => {
      await expect(service.listDatabases({ filter_name: 'db_name', filter_value: 'alp' })).resolves.toHaveLength(1);
      const sorted = await service.listDatabases({ sort_by: 'doc_count', sort_order: 'desc' });
      expect(sorted.map((d) => d.db_name)).toEqual(['alpha', 'beta']);
    });

    it('chunks _dbs_info at 100 keys', async () => {
      const many = Array.from({ length: 250 }, (_, i) => `db${String(i).padStart(3, '0')}`);
      requestSpy.mockImplementation(async (_method: string, path: string, body?: unknown) => {
        if (path === '/_all_dbs') return many;
        if (path === '/_dbs_info') {
          const keys = (body as { keys: string[] }).keys;
          expect(keys.length).toBeLessThanOrEqual(100);
          return keys.map((k) => ({ key: k, info: { db_name: k, doc_count: 1, sizes: { file: 1 } } }));
        }
        throw new Error(`unexpected ${path}`);
      });

      const dbs = await service.listDatabases();
      expect(dbs).toHaveLength(250);
      expect(requestSpy.mock.calls.filter(([, p]: [string, string]) => p === '/_dbs_info').length).toBe(3);
    });

    it('skips databases whose _dbs_info entry carries an error', async () => {
      requestSpy.mockImplementation(async (_method: string, path: string) => {
        if (path === '/_all_dbs') return ['alpha', 'gone'];
        if (path === '/_dbs_info') {
          return [
            { key: 'alpha', info: { db_name: 'alpha', doc_count: 1, sizes: { file: 2 } } },
            { key: 'gone', error: 'not_found' }
          ];
        }
        throw new Error(`unexpected ${path}`);
      });

      const dbs = await service.listDatabases();
      expect(dbs.map((d) => d.db_name)).toEqual(['alpha']);
    });
  });

  describe('createDatabase', () => {
    beforeEach(() => {
      requestSpy.mockResolvedValue({ ok: true });
    });

    it('PUTs the database and returns its overview', async () => {
      const result = await service.createDatabase({
        db_name: 'fresh',
        setup_replication: false,
        servers: [{ server_id: SINGLE_SERVER_ID }]
      });
      expect(requestSpy).toHaveBeenCalledWith('PUT', '/fresh');
      expect(result.db_name).toBe('fresh');
      expect(result.servers[0].server_id).toBe(SINGLE_SERVER_ID);
      expect(result.servers[0].doc_count).toBe(0);
    });

    it('passes the partitioned flag as a query parameter', async () => {
      await service.createDatabase({
        db_name: 'parts',
        setup_replication: false,
        servers: [{ server_id: SINGLE_SERVER_ID, partitioned: true }]
      });
      expect(requestSpy).toHaveBeenCalledWith('PUT', '/parts?partitioned=true');
    });

    it('applies an initial _security document when access is supplied', async () => {
      await service.createDatabase({
        db_name: 'locked',
        setup_replication: false,
        servers: [
          {
            server_id: SINGLE_SERVER_ID,
            access: { member: { name: ['kai'], roles: ['dev'] }, admin: { name: [], roles: ['ops'] } }
          }
        ]
      });
      expect(requestSpy).toHaveBeenCalledWith('PUT', '/locked/_security', {
        admins: { names: [], roles: ['ops'] },
        members: { names: ['kai'], roles: ['dev'] }
      });
    });

    it('encodes the database name', async () => {
      await service.createDatabase({
        db_name: 'a b',
        setup_replication: false,
        servers: [{ server_id: SINGLE_SERVER_ID }]
      });
      expect(requestSpy).toHaveBeenCalledWith('PUT', '/a%20b');
    });

    it('ignores replication pairs (single-server product)', async () => {
      await service.createDatabase({
        db_name: 'solo',
        setup_replication: true,
        servers: [{ server_id: SINGLE_SERVER_ID }],
        replication_pairs: [{ source_id: 'a', target_id: 'b' }]
      });
      const replicatorCalls = requestSpy.mock.calls.filter(([, p]: [string, string]) => String(p).includes('_replicator'));
      expect(replicatorCalls).toHaveLength(0);
    });
  });

  describe('deleteDatabase', () => {
    it('DELETEs the encoded database', async () => {
      requestSpy.mockResolvedValue(undefined);
      await service.deleteDatabase('a b', SINGLE_SERVER_ID);
      expect(requestSpy).toHaveBeenCalledWith('DELETE', '/a%20b');
    });
  });

  describe('getDatabaseInfo', () => {
    it('GETs /{db} and returns the parsed db-info body', async () => {
      const info = {
        db_name: 'shared',
        doc_count: 7,
        doc_del_count: 0,
        instance_start_time: '0',
        sizes: { active: 1, external: 2, file: 3 }
      };
      requestSpy.mockResolvedValue(info);
      await expect(service.getDatabaseInfo(SINGLE_SERVER_ID, 'shared')).resolves.toEqual(info);
      expect(requestSpy).toHaveBeenCalledWith('GET', '/shared');
    });

    it('lets a 403 propagate with its status intact — a member-less database is not a missing one', async () => {
      requestSpy.mockRejectedValue(new ApiError(403, 'You are not allowed to access this db.'));
      await expect(service.getDatabaseInfo(SINGLE_SERVER_ID, 'secret')).rejects.toMatchObject({
        name: 'ApiError',
        status: 403
      });
    });

    it('lets a 404 propagate with its status intact', async () => {
      requestSpy.mockRejectedValue(new ApiError(404, 'Database does not exist.'));
      await expect(service.getDatabaseInfo(SINGLE_SERVER_ID, 'nope')).rejects.toMatchObject({
        name: 'ApiError',
        status: 404
      });
    });

    it('encodes a database name containing a slash so it cannot inject a path segment', async () => {
      requestSpy.mockResolvedValue({ db_name: 'a/b', doc_count: 0 });
      await service.getDatabaseInfo(SINGLE_SERVER_ID, 'a/b');
      expect(requestSpy).toHaveBeenCalledWith('GET', '/a%2Fb');
    });

    it('encodes a database name containing a space', async () => {
      requestSpy.mockResolvedValue({ db_name: 'a b', doc_count: 0 });
      await service.getDatabaseInfo(SINGLE_SERVER_ID, 'a b');
      expect(requestSpy).toHaveBeenCalledWith('GET', '/a%20b');
    });
  });

  describe('listDocuments', () => {
    const rowsFor = (ids: string[], withDocs: boolean) =>
      ids.map((id) => ({ id, key: id, value: { rev: `1-${id}` }, ...(withDocs ? { doc: { _id: id, _rev: `1-${id}`, n: id.length } } : {}) }));

    it('fetches limit+1 with include_docs and returns exactly `limit` documents plus a bookmark', async () => {
      requestSpy.mockResolvedValue({ total_rows: 42, offset: 0, rows: rowsFor(['a', 'b', 'c'], true) });
      const resp = await service.listDocuments(SINGLE_SERVER_ID, 'db', { limit: 2 });
      const [, path] = requestSpy.mock.calls[0] as [string, string];
      expect(path).toContain('/db/_all_docs?');
      expect(path).toContain('limit=3');
      expect(path).toContain('include_docs=true');
      expect(resp.documents).toHaveLength(2);
      expect(resp.total_count).toBe(42);
      expect(resp.bookmark).toBeTruthy();
      expect(JSON.parse(atob(resp.bookmark!))).toEqual({ startkey: 'c' });
    });

    it('omits the bookmark on the last page', async () => {
      requestSpy.mockResolvedValue({ total_rows: 2, rows: rowsFor(['a', 'b'], true) });
      const resp = await service.listDocuments(SINGLE_SERVER_ID, 'db', { limit: 5 });
      expect(resp.documents).toHaveLength(2);
      expect(resp.bookmark).toBeUndefined();
    });

    it('omits the bookmark when the remaining count is exactly `limit` (no lookahead row) — a caller must not infer hasMore from row count alone', async () => {
      requestSpy.mockResolvedValue({ total_rows: 2, rows: rowsFor(['a', 'b'], true) });
      const resp = await service.listDocuments(SINGLE_SERVER_ID, 'db', { limit: 2 });
      expect(resp.documents).toHaveLength(2);
      expect(resp.bookmark).toBeUndefined();
    });

    it('replays a bookmark as a JSON-encoded startkey', async () => {
      requestSpy.mockResolvedValue({ total_rows: 9, rows: rowsFor(['c', 'd'], true) });
      await service.listDocuments(SINGLE_SERVER_ID, 'db', { limit: 2, bookmark: btoa(JSON.stringify({ startkey: 'c' })) });
      const [, path] = requestSpy.mock.calls[0] as [string, string];
      expect(path).toContain(`startkey=${encodeURIComponent('"c"')}`);
    });

    it('ignores a corrupted bookmark instead of throwing', async () => {
      requestSpy.mockResolvedValue({ total_rows: 1, rows: rowsFor(['a'], true) });
      await expect(service.listDocuments(SINGLE_SERVER_ID, 'db', { limit: 2, bookmark: 'not-base64!!' })).resolves.toBeTruthy();
      expect(requestSpy.mock.calls[0][1]).not.toContain('startkey');
    });

    it('scope raw returns id+rev only and does not request docs', async () => {
      requestSpy.mockResolvedValue({ total_rows: 1, rows: rowsFor(['a'], false) });
      const resp = await service.listDocuments(SINGLE_SERVER_ID, 'db', { limit: 10, scope: 'raw' });
      expect(requestSpy.mock.calls[0][1]).not.toContain('include_docs=true');
      expect(resp.documents).toEqual([{ _id: 'a', _rev: '1-a' }]);
    });

    it('falls back to id+rev when include_docs yields no doc (deleted row)', async () => {
      requestSpy.mockResolvedValue({ total_rows: 1, rows: [{ id: 'gone', key: 'gone', value: { rev: '2-x', deleted: true } }] });
      const resp = await service.listDocuments(SINGLE_SERVER_ID, 'db', { limit: 10 });
      expect(resp.documents).toEqual([{ _id: 'gone', _rev: '2-x' }]);
    });

    // #80 — the skip box offsets from the start of the database, so it belongs on the
    // first request only. A page token is a startkey taken from an already-offset page.
    it('sends skip on a bookmark-less first page', async () => {
      requestSpy.mockResolvedValue({ total_rows: 9, rows: rowsFor(['c'], true) });
      await service.listDocuments(SINGLE_SERVER_ID, 'db', { limit: 2, skip: 40 });
      expect(requestSpy.mock.calls[0][1]).toContain('skip=40');
    });

    it('omits skip entirely when it is zero', async () => {
      requestSpy.mockResolvedValue({ total_rows: 9, rows: rowsFor(['a'], true) });
      await service.listDocuments(SINGLE_SERVER_ID, 'db', { limit: 2, skip: 0 });
      expect(requestSpy.mock.calls[0][1]).not.toContain('skip=');
    });

    it('drops skip while replaying a page token, so paging does not re-skip once per page', async () => {
      requestSpy.mockResolvedValue({ total_rows: 9, rows: rowsFor(['c', 'd'], true) });
      await service.listDocuments(SINGLE_SERVER_ID, 'db', {
        limit: 2,
        skip: 40,
        bookmark: btoa(JSON.stringify({ startkey: 'c' }))
      });
      const [, path] = requestSpy.mock.calls[0] as [string, string];
      expect(path).toContain(`startkey=${encodeURIComponent('"c"')}`);
      expect(path).not.toContain('skip=');
    });
  });

  describe('getDoc', () => {
    it('GETs the encoded document', async () => {
      requestSpy.mockResolvedValue({ _id: 'x', _rev: '1-a' });
      await service.getDoc(SINGLE_SERVER_ID, 'my db', 'a b');
      expect(requestSpy).toHaveBeenCalledWith('GET', '/my%20db/a%20b');
    });

    it('keeps the _design/ prefix unencoded', async () => {
      requestSpy.mockResolvedValue({});
      await service.getDoc(SINGLE_SERVER_ID, 'db', '_design/views');
      expect(requestSpy).toHaveBeenCalledWith('GET', '/db/_design/views');
    });

    it("encodes a user id's colon", async () => {
      requestSpy.mockResolvedValue({});
      await service.getDoc(SINGLE_SERVER_ID, '_users', 'org.couchdb.user:alice');
      expect(requestSpy).toHaveBeenCalledWith('GET', '/_users/org.couchdb.user%3Aalice');
    });
  });

  describe('saveDocument', () => {
    it('PUTs when an id is given and returns {id, rev}', async () => {
      requestSpy.mockResolvedValue({ ok: true, id: 'doc1', rev: '2-b' });
      await expect(
        service.saveDocument(SINGLE_SERVER_ID, 'db', { id: 'doc1', body: { _id: 'doc1', _rev: '1-a', v: 2 } })
      ).resolves.toEqual({ id: 'doc1', rev: '2-b' });
      expect(requestSpy).toHaveBeenCalledWith('PUT', '/db/doc1', { _id: 'doc1', _rev: '1-a', v: 2 });
    });

    it('POSTs when no id is given (server-generated id)', async () => {
      requestSpy.mockResolvedValue({ ok: true, id: 'gen', rev: '1-z' });
      await expect(
        service.saveDocument(SINGLE_SERVER_ID, 'db', { id: null, body: { v: 1 } })
      ).resolves.toEqual({ id: 'gen', rev: '1-z' });
      expect(requestSpy).toHaveBeenCalledWith('POST', '/db', { v: 1 });
    });
  });

  describe('deleteDoc', () => {
    it('DELETEs with the rev when supplied', async () => {
      requestSpy.mockResolvedValue({ ok: true, id: 'd', rev: '3-c' });
      await service.deleteDoc(SINGLE_SERVER_ID, 'db', 'd', '2-b');
      expect(requestSpy).toHaveBeenCalledWith('DELETE', '/db/d?rev=2-b');
    });

    it('DELETEs without a rev when omitted', async () => {
      requestSpy.mockResolvedValue({});
      await service.deleteDoc(SINGLE_SERVER_ID, 'db', 'd');
      expect(requestSpy).toHaveBeenCalledWith('DELETE', '/db/d');
    });
  });

  describe('queryDocuments', () => {
    it('unwraps a double-wrapped selector and always sends a limit', async () => {
      requestSpy.mockResolvedValue({ docs: [{ _id: 'a' }], bookmark: 'bm1' });
      const resp = await service.queryDocuments(SINGLE_SERVER_ID, 'db', {
        selector: { selector: { type: 'user' } } as never,
        limit: 10
      });
      expect(requestSpy).toHaveBeenCalledWith('POST', '/db/_find', expect.objectContaining({
        selector: { type: 'user' },
        limit: 10
      }));
      expect(resp.documents).toEqual([{ _id: 'a' }]);
      expect(resp.bookmark).toBe('bm1');
      expect(resp.total_count).toBeUndefined();
    });

    it('accepts a flat selector unchanged', async () => {
      requestSpy.mockResolvedValue({ docs: [] });
      await service.queryDocuments(SINGLE_SERVER_ID, 'db', { selector: { _id: { $gt: null } }, limit: 5 });
      expect(requestSpy).toHaveBeenCalledWith('POST', '/db/_find', expect.objectContaining({
        selector: { _id: { $gt: null } }
      }));
    });

    it('defaults the limit when the caller omits it (CouchDB would silently cap at 25)', async () => {
      requestSpy.mockResolvedValue({ docs: [] });
      await service.queryDocuments(SINGLE_SERVER_ID, 'db', { selector: {} });
      const body = requestSpy.mock.calls[0][2] as { limit?: number };
      expect(typeof body.limit).toBe('number');
      expect(body.limit).toBeGreaterThan(25);
    });

    it('forwards sort, fields and bookmark, and never sends scope', async () => {
      requestSpy.mockResolvedValue({ docs: [], bookmark: 'bm2' });
      await service.queryDocuments(SINGLE_SERVER_ID, 'db', {
        selector: { a: 1 }, sort: [{ a: 'asc' }] as never, fields: ['a', 'b'], limit: 3, bookmark: 'prev', scope: 'full'
      } as never);
      const body = requestSpy.mock.calls[0][2] as Record<string, unknown>;
      expect(body).toMatchObject({ sort: [{ a: 'asc' }], fields: ['a', 'b'], limit: 3, bookmark: 'prev' });
      expect(body).not.toHaveProperty('scope');
    });

    it('scope raw projects to _id and _rev via fields', async () => {
      requestSpy.mockResolvedValue({ docs: [{ _id: 'a', _rev: '1-a' }] });
      await service.queryDocuments(SINGLE_SERVER_ID, 'db', { selector: {}, limit: 2, scope: 'raw' } as never);
      const body = requestSpy.mock.calls[0][2] as { fields?: string[] };
      expect(body.fields).toEqual(['_id', '_rev']);
    });

    it('encodes the database name', async () => {
      requestSpy.mockResolvedValue({ docs: [] });
      await service.queryDocuments(SINGLE_SERVER_ID, 'my db', { selector: {}, limit: 1 });
      expect(requestSpy.mock.calls[0][1]).toBe('/my%20db/_find');
    });

    // #80 — same rule as listDocuments: `_find` applies skip *after* the bookmark's
    // position, so sending both would skip that many documents again on every page.
    it('forwards skip on a bookmark-less request', async () => {
      requestSpy.mockResolvedValue({ docs: [] });
      await service.queryDocuments(SINGLE_SERVER_ID, 'db', { selector: {}, limit: 5, skip: 25 });
      expect(requestSpy.mock.calls[0][2]).toMatchObject({ skip: 25 });
    });

    it('omits skip when it is zero or unset', async () => {
      requestSpy.mockResolvedValue({ docs: [] });
      await service.queryDocuments(SINGLE_SERVER_ID, 'db', { selector: {}, limit: 5, skip: 0 });
      expect(requestSpy.mock.calls[0][2]).not.toHaveProperty('skip');
      await service.queryDocuments(SINGLE_SERVER_ID, 'db', { selector: {}, limit: 5 });
      expect(requestSpy.mock.calls[1][2]).not.toHaveProperty('skip');
    });

    it('drops skip while replaying a bookmark', async () => {
      requestSpy.mockResolvedValue({ docs: [] });
      await service.queryDocuments(SINGLE_SERVER_ID, 'db', { selector: {}, limit: 5, skip: 25, bookmark: 'bm' });
      const body = requestSpy.mock.calls[0][2] as Record<string, unknown>;
      expect(body).toMatchObject({ bookmark: 'bm' });
      expect(body).not.toHaveProperty('skip');
    });
  });

  describe('explainQuery', () => {
    it('POSTs the flat Mango body to _explain and returns the raw response', async () => {
      requestSpy.mockResolvedValue({ dbname: 'db', index: { type: 'json', name: 'idx' }, selector: { a: 1 }, opts: {}, limit: 25, skip: 0, fields: 'all_fields' });
      const resp = await service.explainQuery(SINGLE_SERVER_ID, 'db', { selector: { a: 1 }, limit: 25 } as never);
      expect(requestSpy).toHaveBeenCalledWith('POST', '/db/_explain', expect.objectContaining({ selector: { a: 1 } }));
      expect(resp.index?.name).toBe('idx');
    });

    it('normalizes a double-wrapped selector here too', async () => {
      requestSpy.mockResolvedValue({});
      await service.explainQuery(SINGLE_SERVER_ID, 'db', { selector: { selector: { a: 1 } } } as never);
      expect(requestSpy.mock.calls[0][2]).toMatchObject({ selector: { a: 1 } });
    });
  });

  describe('listIndexes', () => {
    it('maps _index into {indexes, total_count} and applies skip/limit client-side', async () => {
      const indexes = Array.from({ length: 5 }, (_, i) => ({
        ddoc: `_design/d${i}`,
        name: `idx${i}`,
        type: 'json',
        def: { fields: [{ [`f${i}`]: 'asc' }] }
      }));
      requestSpy.mockResolvedValue({ total_rows: 5, indexes });

      const all = await service.listIndexes(SINGLE_SERVER_ID, 'db');
      expect(requestSpy).toHaveBeenCalledWith('GET', '/db/_index');
      expect(all.total_count).toBe(5);
      expect(all.indexes).toHaveLength(5);

      const page = await service.listIndexes(SINGLE_SERVER_ID, 'db', { skip: 1, limit: 2 });
      expect(page.indexes.map((i) => i.name)).toEqual(['idx1', 'idx2']);
      expect(page.total_count).toBe(5);
    });

    it('falls back to indexes.length when total_rows is missing', async () => {
      requestSpy.mockResolvedValue({ indexes: [{ ddoc: '_design/a', name: 'a', def: {} }] });
      const result = await service.listIndexes(SINGLE_SERVER_ID, 'db');
      expect(result.total_count).toBe(1);
    });

    it('encodes the database name', async () => {
      requestSpy.mockResolvedValue({ total_rows: 0, indexes: [] });
      await service.listIndexes(SINGLE_SERVER_ID, 'db/special');
      expect(requestSpy).toHaveBeenCalledWith('GET', '/db%2Fspecial/_index');
    });
  });

  describe('createIndex', () => {
    it('POSTs a Mango index definition and reports the result', async () => {
      requestSpy.mockResolvedValue({ result: 'created', id: '_design/abc', name: 'by_type' });
      const resp = await service.createIndex(SINGLE_SERVER_ID, 'db', {
        name: 'by_type',
        type: 'json',
        fields: ['type', 'created_at']
      });
      expect(requestSpy).toHaveBeenCalledWith('POST', '/db/_index', {
        index: { fields: ['type', 'created_at'] },
        name: 'by_type',
        type: 'json'
      });
      expect(resp).toMatchObject({ id: '_design/abc', name: 'by_type', result: 'created' });
      expect(resp.fields).toEqual(['type', 'created_at']);
    });

    it('parses partial_filter_selector from its string form and forwards ddoc', async () => {
      requestSpy.mockResolvedValue({ result: 'created', id: '_design/x', name: 'n' });
      await service.createIndex(SINGLE_SERVER_ID, 'db', {
        name: 'n',
        fields: ['a'],
        ddoc: 'myddoc',
        partial_filter_selector: '{"status":"active"}'
      });
      expect(requestSpy).toHaveBeenCalledWith('POST', '/db/_index', {
        index: { fields: ['a'], partial_filter_selector: { status: 'active' } },
        name: 'n',
        ddoc: 'myddoc'
      });
    });

    it('rejects an unparseable partial_filter_selector with a clear message', async () => {
      await expect(
        service.createIndex(SINGLE_SERVER_ID, 'db', { name: 'n', fields: ['a'], partial_filter_selector: '{oops' })
      ).rejects.toThrow(/partial filter selector/i);
      expect(requestSpy).not.toHaveBeenCalled();
    });

    it('defaults type to json when the caller omits it', async () => {
      requestSpy.mockResolvedValue({ result: 'created', id: '_design/y', name: 'n' });
      const resp = await service.createIndex(SINGLE_SERVER_ID, 'db', { name: 'n', fields: ['a'] });
      expect(resp.type).toBe('json');
    });
  });

  describe('deleteIndexes', () => {
    it('DELETEs each index by design doc and name', async () => {
      requestSpy.mockResolvedValue({ ok: true });
      await service.deleteIndexes(SINGLE_SERVER_ID, 'db', { documents: [{ id: '_design/a', rev: 'idx1' }] });
      expect(requestSpy).toHaveBeenCalledWith('DELETE', '/db/_index/_design/a/json/idx1');
    });

    it('fires a DELETE per index when multiple are selected', async () => {
      requestSpy.mockResolvedValue({ ok: true });
      await service.deleteIndexes(SINGLE_SERVER_ID, 'db', {
        documents: [
          { id: '_design/a', rev: 'idx1' },
          { id: '_design/b', rev: 'idx2' }
        ]
      });
      expect(requestSpy).toHaveBeenCalledTimes(2);
      expect(requestSpy).toHaveBeenNthCalledWith(1, 'DELETE', '/db/_index/_design/a/json/idx1');
      expect(requestSpy).toHaveBeenNthCalledWith(2, 'DELETE', '/db/_index/_design/b/json/idx2');
    });
  });

  describe('deleteDocuments', () => {
    it('_bulk_docs with _deleted markers, counting successes and errors', async () => {
      requestSpy.mockResolvedValue([
        { ok: true, id: 'a', rev: '2-a' },
        { id: 'b', error: 'conflict', reason: 'Document update conflict.' }
      ]);
      const resp = await service.deleteDocuments(SINGLE_SERVER_ID, 'db', {
        documents: [{ id: 'a', rev: '1-a' }, { id: 'b', rev: '1-b' }]
      });
      expect(requestSpy).toHaveBeenCalledWith('POST', '/db/_bulk_docs', {
        docs: [{ _id: 'a', _rev: '1-a', _deleted: true }, { _id: 'b', _rev: '1-b', _deleted: true }]
      });
      expect(resp.deleted).toBe(1);
      expect(resp.errors).toHaveLength(1);
      expect(resp.errors[0]).toMatchObject({ title: 'conflict' });
    });
  });

  describe('listDatabaseAccess / updateDatabaseAccess', () => {
    it('maps _security into {member, admin} with singular name arrays', async () => {
      requestSpy.mockResolvedValue({
        admins: { names: ['root'], roles: ['ops'] },
        members: { names: ['kai'], roles: ['dev'] }
      });
      await expect(service.listDatabaseAccess(SINGLE_SERVER_ID, 'db')).resolves.toEqual({
        admin: { name: ['root'], roles: ['ops'] },
        member: { name: ['kai'], roles: ['dev'] }
      });
      expect(requestSpy).toHaveBeenCalledWith('GET', '/db/_security');
    });

    it('defaults missing halves to empty arrays', async () => {
      requestSpy.mockResolvedValue({});
      await expect(service.listDatabaseAccess(SINGLE_SERVER_ID, 'db')).resolves.toEqual({
        admin: { name: [], roles: [] },
        member: { name: [], roles: [] }
      });
    });

    it('PUTs the CouchDB-shaped security document back', async () => {
      requestSpy.mockResolvedValue({ ok: true });
      await service.updateDatabaseAccess(SINGLE_SERVER_ID, 'db', {
        member: { name: ['kai'], roles: [] },
        admin: { name: [], roles: ['ops'] }
      });
      expect(requestSpy).toHaveBeenCalledWith('PUT', '/db/_security', {
        admins: { names: [], roles: ['ops'] },
        members: { names: ['kai'], roles: [] }
      });
    });
  });

  describe('isDatabaseAdmin', () => {
    const access = (admin: Partial<DatabaseAccess['admin']> = {}): DatabaseAccess => ({
      admin: { name: [], roles: [], ...admin },
      member: { name: [], roles: [] }
    });

    it('is true when the username is listed in admins.names', () => {
      expect(isDatabaseAdmin(access({ name: ['dbadmin'] }), 'dbadmin', [])).toBe(true);
    });

    it('is true when any of the roles is listed in admins.roles', () => {
      expect(isDatabaseAdmin(access({ roles: ['animals-admins'] }), 'alice', ['animals-admins', 'other'])).toBe(true);
    });

    it('is false for a plain member — being in members, not admins, is not enough', () => {
      expect(isDatabaseAdmin(access({ name: ['someone-else'] }), 'plain-member', [])).toBe(false);
    });

    it('is false for a completely empty admins section — "public" writes do not cover design docs', () => {
      expect(isDatabaseAdmin(access(), 'anyone', ['any-role'])).toBe(false);
    });

    it('is false for a null username with no matching role', () => {
      expect(isDatabaseAdmin(access({ name: ['someone'] }), null, [])).toBe(false);
    });
  });

  describe('listDatabaseRoles', () => {
    it("unions roles from every database's _security", async () => {
      requestSpy.mockImplementation((_m: string, path: string) => {
        if (path === '/_all_dbs') return Promise.resolve(['a', 'b']);
        if (path === '/a/_security') return Promise.resolve({ members: { roles: ['dev'] }, admins: { roles: ['ops'] } });
        if (path === '/b/_security') return Promise.resolve({ members: { roles: ['dev', 'qa'] }, admins: { roles: [] } });
        return Promise.reject(new Error(`unexpected ${path}`));
      });
      const resp: DatabaseRoles = await service.listDatabaseRoles(SINGLE_SERVER_ID);
      expect([...resp.roles].sort()).toEqual(['dev', 'ops', 'qa']);
    });

    it('skips databases whose _security cannot be read', async () => {
      requestSpy.mockImplementation((_m: string, path: string) => {
        if (path === '/_all_dbs') return Promise.resolve(['ok', 'denied']);
        if (path === '/ok/_security') return Promise.resolve({ members: { roles: ['dev'] } });
        return Promise.reject(new ApiError(403, 'forbidden'));
      });
      await expect(service.listDatabaseRoles(SINGLE_SERVER_ID)).resolves.toEqual({ roles: ['dev'] });
    });

    it('bounds concurrency at 8 in-flight _security reads', async () => {
      const names = Array.from({ length: 20 }, (_, i) => `db${i}`);
      let inFlight = 0;
      let maxInFlight = 0;
      requestSpy.mockImplementation(async (_m: string, path: string) => {
        if (path === '/_all_dbs') return names;
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        inFlight--;
        return { members: { roles: [] }, admins: { roles: [] } };
      });
      await service.listDatabaseRoles(SINGLE_SERVER_ID);
      expect(maxInFlight).toBeLessThanOrEqual(8);
      expect(maxInFlight).toBeGreaterThan(1);
    });
  });
});

describe('docPath', () => {
  it('encodes a plain document id', () => {
    expect(docPath('db', 'a b')).toBe('/db/a%20b');
  });

  it('preserves the literal _design/ prefix for design documents', () => {
    expect(docPath('db', '_design/views')).toBe('/db/_design/views');
  });

  it('encodes a colon in a user id', () => {
    expect(docPath('db', 'org.couchdb.user:alice')).toBe('/db/org.couchdb.user%3Aalice');
  });

  it('does not restore a slash in a non-design id (guards the regex against over-matching)', () => {
    expect(docPath('db', 'a/b')).toBe('/db/a%2Fb');
  });
});
