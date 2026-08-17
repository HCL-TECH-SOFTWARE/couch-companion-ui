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
import { DbMgmtService } from '../src/services/db-mgmt-service';
import { UsersService } from '../src/services/users-service';

describe('UsersService', () => {
  let apiClient: ApiClient;
  let db: DbMgmtService;
  let service: UsersService;
  let requestSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    apiClient = new ApiClient('http://test');
    db = new DbMgmtService(apiClient);
    service = new UsersService(db);
    requestSpy = vi
      .spyOn(apiClient, 'request')
      .mockResolvedValue({ ok: true, id: 'org.couchdb.user:alice', rev: '3-abc' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('deleteUser', () => {
    it('sends DELETE with the encoded docId and rev query param (native CouchDB path, no server_id)', async () => {
      await service.deleteUser('srv1', 'org.couchdb.user:alice', '3-abc');

      expect(requestSpy).toHaveBeenCalledOnce();
      const [method, path] = (requestSpy.mock.calls[0] as [string, string]);
      expect(method).toBe('DELETE');
      // docId colon must be percent-encoded
      expect(path).toContain('org.couchdb.user%3Aalice');
      // rev query param must be present
      expect(path).toContain('rev=3-abc');
      // single-server product: no server_id on the native CouchDB path
      expect(path).not.toContain('server_id');
    });
  });

  describe('listUsers', () => {
    const user = (n: number) => ({ _id: `org.couchdb.user:u${n}`, name: `u${n}`, type: 'user', roles: [] });
    const fullPage = (start: number) =>
      Array.from({ length: 1000 }, (_, i) => user(start + i));

    it('follows bookmarks until a short page and aggregates all user docs', async () => {
      const listDocs = vi
        .spyOn(db, 'listDocuments')
        .mockResolvedValueOnce({ documents: fullPage(0), bookmark: 'bm1' })
        .mockResolvedValueOnce({ documents: fullPage(1000), bookmark: 'bm2' })
        .mockResolvedValueOnce({ documents: [user(2000)], bookmark: 'bm3' });

      const users = await service.listUsers('srv1');

      expect(users).toHaveLength(2001);
      expect(listDocs).toHaveBeenCalledTimes(3);
      expect(listDocs.mock.calls[0][2]).toMatchObject({ scope: 'full', limit: 1000 });
      expect(listDocs.mock.calls[0][2]).not.toHaveProperty('bookmark');
      expect(listDocs.mock.calls[1][2]).toMatchObject({ bookmark: 'bm1' });
      expect(listDocs.mock.calls[2][2]).toMatchObject({ bookmark: 'bm2' });
    });

    it('makes a single call when the first page is short', async () => {
      const listDocs = vi
        .spyOn(db, 'listDocuments')
        .mockResolvedValue({ documents: [user(1)], bookmark: 'bm1' });

      const users = await service.listUsers('srv1');

      expect(users).toHaveLength(1);
      expect(listDocs).toHaveBeenCalledTimes(1);
    });

    it('stops when the server echoes the same bookmark on a full page (no infinite loop)', async () => {
      const listDocs = vi
        .spyOn(db, 'listDocuments')
        .mockResolvedValueOnce({ documents: fullPage(0), bookmark: 'same' })
        .mockResolvedValue({ documents: fullPage(1000), bookmark: 'same' });

      const users = await service.listUsers('srv1');

      expect(listDocs).toHaveBeenCalledTimes(2);
      expect(users).toHaveLength(2000);
    });

    it('stops when a full page carries no bookmark', async () => {
      const listDocs = vi
        .spyOn(db, 'listDocuments')
        .mockResolvedValue({ documents: fullPage(0) });

      const users = await service.listUsers('srv1');

      expect(listDocs).toHaveBeenCalledTimes(1);
      expect(users).toHaveLength(1000);
    });

    it('filters non-user docs from every page', async () => {
      vi.spyOn(db, 'listDocuments')
        .mockResolvedValueOnce({
          documents: [...fullPage(0).slice(0, 999), { _id: '_design/auth', type: 'ddoc' }],
          bookmark: 'bm1',
        })
        .mockResolvedValueOnce({ documents: [user(1), { _id: 'org.couchdb.user:x' }], bookmark: 'bm2' });

      const users = await service.listUsers('srv1');

      // 999 users from page 1 + 1 from page 2; the ddoc and the type-less doc are dropped
      expect(users).toHaveLength(1000);
      expect(users.every((u) => (u as unknown as { type: string }).type === 'user')).toBe(true);
    });
  });
});
