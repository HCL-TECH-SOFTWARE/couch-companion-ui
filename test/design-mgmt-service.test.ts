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
import {
  DesignMgmtService,
  type RegisterRepoBody,
  type TestViewRequest,
  type TestViewResult
} from '../src/services/design-mgmt-service.js';
import type { TrackedDesignDoc, GitRepo, DesignConflict } from '../src/plugins/design-mgmt/types.js';
import { ApiError } from '../src/services/api-error.js';
import { CouchCompanionStore, ID_PREFIX } from '../src/services/git/couchcompanion-store.js';
import { GitCredentialStore, type CouchTokenIo } from '../src/services/git/git-credential-store.js';
import { GitHttpError } from '../src/services/git/git-http.js';
import { GitHubProvider } from '../src/services/git/github-provider.js';
import { SINGLE_SERVER_ID } from '../src/services/single-server.js';
import { Logger, Level } from '../src/services/log-service.js';
import { installFakeIndexedDb, type FakeIndexedDb } from './helpers/fake-indexeddb.js';

/**
 * A `CouchTokenIo` that never actually persists anything. None of this file's scenarios exercise
 * the real couchdb-backed round trip (they either use credential mode `'none'`, which never calls
 * this port, or stub `store.get`/`store.put` directly) — the real adapter is a small, unexported
 * function in `context.ts`, kept private to that wiring per the task's decision #2.
 */
const fakeCouchTokenIo = (): CouchTokenIo => ({
  readToken: async () => null,
  writeToken: async () => {}
});

/**
 * Every document id a sweep asked the store to delete, however it was batched — `remove(id)` for
 * the one-off deletes that genuinely hold nothing but an id, `removeAll([...])` for the bulk
 * sweeps (issue #6 item 12). The assertions that matter here are "which documents were swept and
 * which survived", which is a property of the ids, not of how they were packed into requests.
 */
function sweptIds(...spies: MockInstance[]): string[] {
  return spies.flatMap((spy) =>
    spy.mock.calls.flatMap(([arg]) =>
      Array.isArray(arg)
        ? arg.map((doc) => (typeof doc === 'string' ? doc : (doc as { _id: string })._id))
        : [arg as string]
    )
  );
}

describe('DesignMgmtService', () => {
  let service: DesignMgmtService;
  let api: ApiClient;
  let store: CouchCompanionStore;
  let credentials: GitCredentialStore;
  let request: MockInstance;

  beforeEach(() => {
    api = new ApiClient('http://test');
    store = new CouchCompanionStore(api);
    credentials = new GitCredentialStore(fakeCouchTokenIo());
    service = new DesignMgmtService(api, store, credentials);
    request = vi.spyOn(api, 'request');
    // Shared defaults so a test that isn't specifically about the git-registry lookup or the
    // token-verification step doesn't have to know either happens: registerRepo/deleteRepo/etc.
    // always range-scan the store for existing docs before doing anything else, and
    // postGitAccounts always calls whoami(). Individual tests override either with their own
    // vi.spyOn(...).mockResolvedValue(...) when the scenario needs specific data.
    vi.spyOn(store, 'list').mockResolvedValue([]);
    vi.spyOn(store, 'get').mockResolvedValue(null);
    vi.spyOn(GitHubProvider.prototype, 'whoami').mockResolvedValue({ login: 'octocat', name: 'Octo Cat' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------------------------
  // Shared fixtures for the sync-flow describes below (getRepoDocs, deleteRepoDocs, syncToRepo,
  // syncToCouch). One repository, one account, one database — every sync test resolves the same
  // (repoId, dbName) pair; what differs between tests is the git/sync-state each stubs on top.
  // ---------------------------------------------------------------------------------------------
  const SYNC_REPO_ID = 'gitrepo:1';
  const SYNC_ACCOUNT_ID = 'gitaccount:1';
  const SYNC_DB = 'sales';
  const SYNC_REPO: GitRepo = {
    _id: SYNC_REPO_ID,
    url: 'https://github.com/acme/widgets',
    account_id: SYNC_ACCOUNT_ID,
    provider: 'github',
    sync_targets: [{ server_id: SINGLE_SERVER_ID, db_name: SYNC_DB, branch: 'main', path: '' }]
  };
  const SYNC_ACCOUNT = {
    _id: SYNC_ACCOUNT_ID,
    provider: 'github',
    label: 'work',
    base_url: null,
    credential_mode: 'none' as const
  };

  /**
   * Answers `store.get` with the repo/account pair every sync-flow test needs, plus whatever a
   * test layers on top (typically a `sync:` or `conflict:` document) via `overrides` — keyed by
   * document id, exactly what {@link CouchCompanionStore.get} would return for it.
   */
  function stubRepoAndAccount(overrides: Record<string, unknown> = {}): void {
    vi.spyOn(store, 'get').mockImplementation(async (id: string) => {
      if (id === SYNC_REPO_ID) return SYNC_REPO as never;
      if (id === SYNC_ACCOUNT_ID) return SYNC_ACCOUNT as never;
      if (id in overrides) return overrides[id] as never;
      return null;
    });
  }

  describe('listDesignDocs', () => {
    // Fix round 1, minor 7 (coordinator's own): include_docs=true fetched a body nothing read —
    // id/rev from the bare _design_docs listing is everything TrackedDesignDoc needs.
    it('lists design docs from _design_docs, without fetching bodies nothing reads', async () => {
      request.mockResolvedValue({
        total_rows: 1,
        offset: 0,
        rows: [{ id: '_design/reports', key: '_design/reports', value: { rev: '2-b' } }]
      });
      const docs = await service.listDesignDocs(SINGLE_SERVER_ID, 'sales');
      expect(request).toHaveBeenCalledWith('GET', '/sales/_design_docs');
      expect(docs[0]).toMatchObject({
        server_id: SINGLE_SERVER_ID,
        db_name: 'sales',
        ddoc_id: '_design/reports',
        rev: '2-b'
      });
    });

    it('percent-encodes a database name that needs it', async () => {
      request.mockResolvedValue({ rows: [] });
      await service.listDesignDocs(SINGLE_SERVER_ID, 'my db+1');
      expect(request).toHaveBeenCalledWith('GET', '/my%20db%2B1/_design_docs');
    });

    it('returns an empty array when no design docs exist', async () => {
      request.mockResolvedValue({ rows: [] });
      const result = await service.listDesignDocs('server1', 'db');
      expect(result).toEqual([]);
    });

    it('merges the stored sync state onto each tracked doc', async () => {
      request.mockResolvedValue({
        rows: [{ id: '_design/reports', value: { rev: '5-e' } }]
      });
      vi.spyOn(store, 'list').mockResolvedValue([
        {
          _id: 'sync:sales~ddoc:reports',
          database: 'sales',
          ddoc_id: '_design/reports',
          git_repo_id: 'gitrepo:1',
          git_sha: 'abc',
          ddoc_rev: '4-d',
          last_sync: '2026-08-01T00:00:00Z',
          updated_at: '2026-08-01T00:00:01Z'
        }
      ]);
      const [doc] = await service.listDesignDocs(SINGLE_SERVER_ID, 'sales');
      expect(doc).toMatchObject({
        rev: '5-e',
        ddoc_rev: '4-d',
        git_repo_id: 'gitrepo:1',
        last_git_sha: 'abc',
        updated_at: '2026-08-01T00:00:01Z'
      });
    });

    it('leaves the git fields null for a doc that was never synced', async () => {
      request.mockResolvedValue({ rows: [{ id: '_design/fresh', value: { rev: '1-a' } }] });
      vi.spyOn(store, 'list').mockResolvedValue([]);
      const [doc] = await service.listDesignDocs(SINGLE_SERVER_ID, 'sales');
      expect(doc).toMatchObject({ git_repo_id: null, last_git_sha: null, last_sync: null, updated_at: null });
    });

    it('ignores sync state recorded against a different database', async () => {
      request.mockResolvedValue({
        rows: [{ id: '_design/reports', value: { rev: '1-a' } }]
      });
      vi.spyOn(store, 'list').mockResolvedValue([
        { _id: 'sync:hr~ddoc:reports', database: 'hr', ddoc_id: '_design/reports', git_repo_id: 'gitrepo:9' }
      ]);
      const [doc] = await service.listDesignDocs(SINGLE_SERVER_ID, 'sales');
      expect(doc.git_repo_id).toBeNull();
    });

    // Fix round 1, IMPORTANT 3: couchcompanion is admin-only, so a 403 from the sync-state lookup
    // must not take the whole (readable-by-anyone) design-doc list down with it.
    it('survives a 403 from couchcompanion, with the git columns null', async () => {
      request.mockResolvedValue({ rows: [{ id: '_design/reports', value: { rev: '1-a' } }] });
      vi.spyOn(store, 'list').mockRejectedValue(new ApiError(403, 'You are not a server admin.'));
      const [doc] = await service.listDesignDocs(SINGLE_SERVER_ID, 'sales');
      expect(doc).toMatchObject({
        ddoc_id: '_design/reports',
        rev: '1-a',
        git_repo_id: null,
        last_git_sha: null,
        last_sync: null,
        updated_at: null
      });
    });

    // Fix round 2 (coordinator's small item): the 403 catch above must not fail silently — it's
    // meant to be diagnosable, not just quietly degraded.
    describe('when the sync-state lookup fails', () => {
      let warnSpy: ReturnType<typeof vi.fn>;
      let savedWarnTarget: (typeof Logger.logTarget)[typeof Level.WARN];

      beforeEach(() => {
        savedWarnTarget = Logger.logTarget[Level.WARN];
        warnSpy = vi.fn();
        Logger.logTarget[Level.WARN] = warnSpy;
      });

      afterEach(() => {
        Logger.logTarget[Level.WARN] = savedWarnTarget;
      });

      it('logs why the git columns went null, without a token or a document body', async () => {
        request.mockResolvedValue({ rows: [{ id: '_design/reports', value: { rev: '1-a' } }] });
        vi.spyOn(store, 'list').mockRejectedValue(new ApiError(403, 'You are not a server admin.'));
        await service.listDesignDocs(SINGLE_SERVER_ID, 'sales');
        expect(warnSpy).toHaveBeenCalledTimes(1);
        const [message, context] = warnSpy.mock.calls[0];
        expect(message).toMatch(/sync state/i);
        expect(context).toMatchObject({ db: 'sales', status: 403 });
        expect(JSON.stringify(context)).not.toMatch(/ghp_|token/i);
      });
    });
  });

  describe('getDesignDoc', () => {
    it('keeps the _design/ segment unencoded when reading one design doc', async () => {
      request.mockResolvedValue({ _id: '_design/reports' });
      await service.getDesignDoc(SINGLE_SERVER_ID, 'sales', '_design/reports');
      expect(request).toHaveBeenCalledWith('GET', '/sales/_design/reports');
    });

    it('accepts a bare ddoc name and normalizes it', async () => {
      request.mockResolvedValue({ _id: '_design/reports' });
      await service.getDesignDoc(SINGLE_SERVER_ID, 'sales', 'reports');
      expect(request).toHaveBeenCalledWith('GET', '/sales/_design/reports');
    });
  });

  describe('saveDesignDoc', () => {
    it('PUTs a design doc to its own path', async () => {
      request.mockResolvedValue({ ok: true, id: '_design/reports', rev: '3-c' });
      const saved = await service.saveDesignDoc(SINGLE_SERVER_ID, 'sales', '_design/reports', {
        _rev: '2-b',
        views: {}
      });
      expect(request).toHaveBeenCalledWith('PUT', '/sales/_design/reports', { _rev: '2-b', views: {} });
      expect(saved).toEqual({ ok: true, id: '_design/reports', rev: '3-c' });
    });

    it('accepts a bare ddoc name and normalizes it', async () => {
      request.mockResolvedValue({ ok: true, id: '_design/reports', rev: '1-a' });
      await service.saveDesignDoc(SINGLE_SERVER_ID, 'sales', 'reports', { views: {} });
      expect(request).toHaveBeenCalledWith('PUT', '/sales/_design/reports', { views: {} });
    });

    it('surfaces the 403 a non-admin gets when saving, without rewording it', async () => {
      request.mockRejectedValue(new ApiError(403, 'You are not a db or server admin.'));
      await expect(service.saveDesignDoc(SINGLE_SERVER_ID, 'sales', '_design/reports', {})).rejects.toThrow(
        'You are not a db or server admin.'
      );
    });
  });

  describe('testView', () => {
    // Task 7: CouchDB 3 answers `_temp_view` with `410 gone`, and the retired backend never
    // actually ran the function either — testView now executes the real map function in-browser
    // (via runViewIsolated/runMapReduce) and makes no network call at all. `request` staying
    // uncalled in every scenario below is as load-bearing as the returned rows/error.

    it('tests a map function against sample documents', async () => {
      // TestViewRequest.sample_docs carries whole documents, not their ids.
      const testReq: TestViewRequest = {
        map_function: 'function(doc) { emit(doc.type, 1); }',
        sample_docs: [
          { _id: 'doc1', type: 'user' },
          { _id: 'doc2', type: 'post' }
        ]
      };

      const result = await service.testView(testReq);

      expect(request).not.toHaveBeenCalled();
      // TestViewResult.rows are { key, value, id } objects, per the spec.
      expect(result).toEqual<TestViewResult>({
        rows: [
          { key: 'post', value: 1, id: 'doc2' },
          { key: 'user', value: 1, id: 'doc1' }
        ],
        error: undefined
      });
      expect(result.rows?.find((r) => r.key === 'user')?.id).toBe('doc1');
    });

    it('carries an optional reduce_function and reduces the real map output', async () => {
      const testReq: TestViewRequest = {
        map_function: 'function(doc) { emit(doc.type, 1); }',
        sample_docs: [
          { _id: 'doc1', type: 'user' },
          { _id: 'doc2', type: 'user' }
        ],
        reduce_function: '_count'
      };

      const result = await service.testView(testReq);

      expect(request).not.toHaveBeenCalled();
      expect(result).toEqual<TestViewResult>({ rows: [{ key: 'user', value: 2, id: '' }], error: undefined });
    });

    it('returns error when map function has a syntax error', async () => {
      const testReq: TestViewRequest = {
        map_function: 'function(doc) { invalid syntax }'
      };

      const result = await service.testView(testReq);

      expect(request).not.toHaveBeenCalled();
      expect(result.rows).toEqual([]);
      expect(result.error).toMatch(/unexpected/i);
    });
  });

  describe('getRepo', () => {
    it('returns the repo whose sync_targets include this server/database pair', async () => {
      const repo: GitRepo = {
        _id: 'repo1',
        url: 'https://github.com/example/repo',
        sync_targets: [{ server_id: SINGLE_SERVER_ID, db_name: 'my_db', branch: 'main', path: '' }]
      };
      vi.spyOn(store, 'list').mockResolvedValue([repo]);

      const result = await service.getRepo(SINGLE_SERVER_ID, 'my_db');

      expect(result).toEqual({ repo });
    });

    it('returns null repo when none registered', async () => {
      vi.spyOn(store, 'list').mockResolvedValue([]);
      const result = await service.getRepo(SINGLE_SERVER_ID, 'db');
      expect(result.repo).toBeNull();
    });

    it('ignores a repo whose targets are all for a different database', async () => {
      vi.spyOn(store, 'list').mockResolvedValue([
        {
          _id: 'repo1',
          url: 'https://github.com/example/repo',
          sync_targets: [{ server_id: SINGLE_SERVER_ID, db_name: 'other_db', branch: 'main', path: '' }]
        }
      ]);
      const result = await service.getRepo(SINGLE_SERVER_ID, 'my_db');
      expect(result.repo).toBeNull();
    });
  });

  describe('listRepos', () => {
    const repos: GitRepo[] = [
      {
        _id: 'repo:one',
        name: 'designs',
        url: 'https://github.com/acme/designs',
        sync_targets: [{ server_id: SINGLE_SERVER_ID, db_name: 'db1', branch: 'main', path: '' }]
      },
      {
        _id: 'repo:two',
        name: 'edge-views',
        url: 'https://github.com/acme/edge-views',
        sync_targets: [{ server_id: SINGLE_SERVER_ID, db_name: 'db2', branch: 'release', path: '' }]
      }
    ];

    it('lists every repository across the fleet', async () => {
      vi.spyOn(store, 'list').mockResolvedValue(repos);
      const result = await service.listRepos();
      expect(result.repos).toHaveLength(2);
      expect(result.truncated).toBe(false);
    });

    it('returns an empty list when no repositories are registered', async () => {
      vi.spyOn(store, 'list').mockResolvedValue([]);
      const result = await service.listRepos();
      expect(result.repos).toEqual([]);
    });

    it('filters case-insensitively on name or url', async () => {
      vi.spyOn(store, 'list').mockResolvedValue(repos);
      const result = await service.listRepos('EDGE');
      expect(result.repos).toEqual([repos[1]]);
    });

    it('trims the filter value before matching', async () => {
      vi.spyOn(store, 'list').mockResolvedValue(repos);
      const result = await service.listRepos('  designs  ');
      expect(result.repos).toEqual([repos[0]]);
    });

    it('treats a blank (whitespace-only) filter as absent', async () => {
      vi.spyOn(store, 'list').mockResolvedValue(repos);
      const result = await service.listRepos('   ');
      expect(result.repos).toHaveLength(2);
    });

    it('never reports truncated — there is no server-side cap any more', async () => {
      vi.spyOn(store, 'list').mockResolvedValue(repos);
      expect((await service.listRepos()).truncated).toBe(false);
    });
  });

  describe('registerRepo', () => {
    it('registers a repo with the target the caller supplied', async () => {
      const put = vi.spyOn(store, 'put').mockResolvedValue({ id: 'gitrepo:1', rev: '1-a' });
      await service.registerRepo(SINGLE_SERVER_ID, 'sales', {
        url: 'https://github.com/acme/widgets',
        branch: 'main',
        path: 'ddocs',
        account_id: 'gitaccount:1'
      });
      expect(put.mock.calls[0][1]).toMatchObject({
        doc_type: 'git_repo',
        sync_targets: [{ server_id: SINGLE_SERVER_ID, db_name: 'sales', branch: 'main', path: 'ddocs' }]
      });
    });

    it('defaults branch to main and path to empty when the caller omits them', async () => {
      vi.spyOn(store, 'list').mockResolvedValue([]);
      const put = vi.spyOn(store, 'put').mockResolvedValue({ id: 'gitrepo:1', rev: '1-a' });
      const body: RegisterRepoBody = { url: 'https://github.com/acme/widgets' };
      await service.registerRepo(SINGLE_SERVER_ID, 'sales', body);
      expect(put.mock.calls[0][1]).toMatchObject({
        sync_targets: [{ server_id: SINGLE_SERVER_ID, db_name: 'sales', branch: 'main', path: '' }]
      });
    });

    it('adds a second database to an existing repo rather than creating a duplicate', async () => {
      vi.spyOn(store, 'list').mockResolvedValue([
        {
          _id: 'gitrepo:1',
          url: 'https://github.com/acme/widgets',
          sync_targets: [{ server_id: SINGLE_SERVER_ID, db_name: 'sales', branch: 'main', path: '' }]
        }
      ]);
      const put = vi.spyOn(store, 'put').mockResolvedValue({ id: 'gitrepo:1', rev: '2-b' });
      await service.registerRepo(SINGLE_SERVER_ID, 'hr', {
        url: 'https://github.com/acme/widgets',
        branch: 'main',
        path: ''
      });
      expect(put.mock.calls[0][0]).toBe('gitrepo:1');
      expect((put.mock.calls[0][1] as { sync_targets: unknown[] }).sync_targets).toHaveLength(2);
    });

    it('returns the saved repo with its assigned id and rev', async () => {
      vi.spyOn(store, 'list').mockResolvedValue([]);
      vi.spyOn(store, 'put').mockResolvedValue({ id: 'gitrepo:1', rev: '1-a' });
      const result = await service.registerRepo(SINGLE_SERVER_ID, 'sales', {
        url: 'https://github.com/acme/widgets',
        branch: 'main',
        path: ''
      });
      expect(result._id).toBe('gitrepo:1');
      expect(result._rev).toBe('1-a');
      expect(result.url).toBe('https://github.com/acme/widgets');
    });

    it("stamps the repo with its account's provider — design-list's manage-repo drawer gates on it", async () => {
      vi.spyOn(store, 'get').mockResolvedValue({ _id: 'gitaccount:1', provider: 'github', label: 'work' });
      vi.spyOn(store, 'list').mockResolvedValue([]);
      const put = vi.spyOn(store, 'put').mockResolvedValue({ id: 'gitrepo:1', rev: '1-a' });
      const result = await service.registerRepo(SINGLE_SERVER_ID, 'sales', {
        url: 'https://github.com/acme/widgets',
        branch: 'main',
        path: '',
        account_id: 'gitaccount:1'
      });
      expect(put.mock.calls[0][1]).toMatchObject({ provider: 'github' });
      expect(result.provider).toBe('github');
    });

    it('preserves the existing provider when appending a target without an account_id', async () => {
      vi.spyOn(store, 'list').mockResolvedValue([
        {
          _id: 'gitrepo:1',
          url: 'https://github.com/acme/widgets',
          provider: 'github',
          sync_targets: [{ server_id: SINGLE_SERVER_ID, db_name: 'sales', branch: 'main', path: '' }]
        }
      ]);
      const put = vi.spyOn(store, 'put').mockResolvedValue({ id: 'gitrepo:1', rev: '2-b' });
      await service.registerRepo(SINGLE_SERVER_ID, 'hr', {
        url: 'https://github.com/acme/widgets',
        branch: 'main',
        path: ''
      });
      expect(put.mock.calls[0][1]).toMatchObject({ provider: 'github' });
    });

    // Fix round 1, CRITICAL 1: "Manage Repository -> Update" re-calls registerRepo for a database
    // that is ALREADY a target, to change its branch/path. Appending instead of replacing left
    // the stale target in place (every reader uses .find()/[0]) while the toast claimed success.
    it('re-registering the same database replaces its target instead of adding a second one', async () => {
      vi.spyOn(store, 'list').mockResolvedValue([
        {
          _id: 'gitrepo:1',
          url: 'https://github.com/acme/widgets',
          sync_targets: [{ server_id: SINGLE_SERVER_ID, db_name: 'sales', branch: 'main', path: '' }]
        }
      ]);
      const put = vi.spyOn(store, 'put').mockResolvedValue({ id: 'gitrepo:1', rev: '2-b' });
      await service.registerRepo(SINGLE_SERVER_ID, 'sales', {
        url: 'https://github.com/acme/widgets',
        branch: 'release',
        path: 'new-root'
      });
      const body = put.mock.calls[0][1] as { sync_targets: unknown[] };
      expect(body.sync_targets).toHaveLength(1);
      expect(body.sync_targets[0]).toMatchObject({ db_name: 'sales', branch: 'release', path: 'new-root' });
    });

    // Fix round 1, IMPORTANT 2: raw string equality treated "…/widgets" and "…/widgets.git" (or a
    // trailing slash) as two different repositories.
    it('treats a URL that differs only by a trailing .git as the same repository', async () => {
      vi.spyOn(store, 'list').mockResolvedValue([
        {
          _id: 'gitrepo:1',
          url: 'https://github.com/acme/widgets',
          sync_targets: [{ server_id: SINGLE_SERVER_ID, db_name: 'sales', branch: 'main', path: '' }]
        }
      ]);
      const put = vi.spyOn(store, 'put').mockResolvedValue({ id: 'gitrepo:1', rev: '2-b' });
      await service.registerRepo(SINGLE_SERVER_ID, 'hr', {
        url: 'https://github.com/acme/widgets.git',
        branch: 'main',
        path: ''
      });
      expect(put.mock.calls[0][0]).toBe('gitrepo:1');
      expect((put.mock.calls[0][1] as { sync_targets: unknown[] }).sync_targets).toHaveLength(2);
    });

    // Fix round 1, IMPORTANT 2 (the reachable half): re-pointing an already-linked database at a
    // different repository used to leave the old repo document still claiming that target, so
    // which repo `getRepo` returned was decided by UUID sort order.
    it('drops the (serverId, dbName) target from another repository entirely when it was its only one', async () => {
      const remove = vi.spyOn(store, 'remove').mockResolvedValue(undefined);
      const put = vi.spyOn(store, 'put').mockResolvedValue({ id: 'gitrepo:new', rev: '1-a' });
      vi.spyOn(store, 'list').mockResolvedValue([
        {
          _id: 'gitrepo:old',
          url: 'https://github.com/acme/old',
          sync_targets: [{ server_id: SINGLE_SERVER_ID, db_name: 'sales', branch: 'main', path: '' }]
        }
      ]);
      await service.registerRepo(SINGLE_SERVER_ID, 'sales', {
        url: 'https://github.com/acme/new',
        branch: 'main',
        path: ''
      });
      expect(remove).toHaveBeenCalledWith('gitrepo:old');
      expect(put).toHaveBeenCalledTimes(1); // only the new repo's creation, not a rewrite of the old one
      expect(put.mock.calls[0][1]).toMatchObject({
        url: 'https://github.com/acme/new',
        sync_targets: [{ db_name: 'sales' }]
      });
    });

    it('only drops the matching target from another repo, keeping its other targets intact', async () => {
      const remove = vi.spyOn(store, 'remove');
      const put = vi.spyOn(store, 'put').mockResolvedValue({ id: 'gitrepo:new', rev: '1-a' });
      vi.spyOn(store, 'list').mockResolvedValue([
        {
          _id: 'gitrepo:old',
          url: 'https://github.com/acme/old',
          sync_targets: [
            { server_id: SINGLE_SERVER_ID, db_name: 'sales', branch: 'main', path: '' },
            { server_id: SINGLE_SERVER_ID, db_name: 'hr', branch: 'main', path: '' }
          ]
        }
      ]);
      await service.registerRepo(SINGLE_SERVER_ID, 'sales', {
        url: 'https://github.com/acme/new',
        branch: 'main',
        path: ''
      });
      expect(remove).not.toHaveBeenCalledWith('gitrepo:old');
      const oldRepoPut = put.mock.calls.find(([id]) => id === 'gitrepo:old');
      expect(oldRepoPut).toBeDefined();
      expect((oldRepoPut![1] as { sync_targets: { db_name: string }[] }).sync_targets).toEqual([
        { server_id: SINGLE_SERVER_ID, db_name: 'hr', branch: 'main', path: '' }
      ]);
    });

    // Fix round 2, NEW IMPORTANT 1: the cross-repo strip used to delete/rewrite the other repo
    // without sweeping the sync: docs it owned — orphaning a git_repo_id no sweep could ever
    // find again (both deleteRepo's and unlinkRepo's filter on the *new* repo's id).
    it("sweeps the other repo's sync: docs for the departing database when the strip deletes it", async () => {
      const remove = vi.spyOn(store, 'remove').mockResolvedValue(undefined);
      const removeAll = vi.spyOn(store, 'removeAll').mockResolvedValue(undefined);
      vi.spyOn(store, 'put').mockResolvedValue({ id: 'gitrepo:new', rev: '1-a' });
      vi.spyOn(store, 'list').mockImplementation(async (prefix: string) => {
        if (prefix === ID_PREFIX.repo) {
          return [
            {
              _id: 'gitrepo:old',
              url: 'https://github.com/acme/old',
              sync_targets: [{ server_id: SINGLE_SERVER_ID, db_name: 'sales', branch: 'main', path: '' }]
            }
          ] as unknown as GitRepo[];
        }
        if (prefix === ID_PREFIX.sync) {
          return [
            { _id: 'sync:sales~ddoc:reports', database: 'sales', ddoc_id: '_design/reports', git_repo_id: 'gitrepo:old' },
            // Same repo, different database — must survive the strip.
            { _id: 'sync:hr~ddoc:staff', database: 'hr', ddoc_id: '_design/staff', git_repo_id: 'gitrepo:old' }
          ] as unknown as GitRepo[];
        }
        return [];
      });
      await service.registerRepo(SINGLE_SERVER_ID, 'sales', {
        url: 'https://github.com/acme/new',
        branch: 'main',
        path: ''
      });
      const swept = sweptIds(removeAll, remove);
      expect(swept).toContain('sync:sales~ddoc:reports');
      expect(swept).not.toContain('sync:hr~ddoc:staff');
      expect(swept).toContain('gitrepo:old');
    });

    it("sweeps only the departing database's sync: docs when the strip is partial (repo keeps other targets)", async () => {
      const remove = vi.spyOn(store, 'remove').mockResolvedValue(undefined);
      const removeAll = vi.spyOn(store, 'removeAll').mockResolvedValue(undefined);
      vi.spyOn(store, 'put').mockResolvedValue({ id: 'gitrepo:new', rev: '1-a' });
      vi.spyOn(store, 'list').mockImplementation(async (prefix: string) => {
        if (prefix === ID_PREFIX.repo) {
          return [
            {
              _id: 'gitrepo:old',
              url: 'https://github.com/acme/old',
              sync_targets: [
                { server_id: SINGLE_SERVER_ID, db_name: 'sales', branch: 'main', path: '' },
                { server_id: SINGLE_SERVER_ID, db_name: 'hr', branch: 'main', path: '' }
              ]
            }
          ] as unknown as GitRepo[];
        }
        if (prefix === ID_PREFIX.sync) {
          return [
            { _id: 'sync:sales~ddoc:reports', database: 'sales', ddoc_id: '_design/reports', git_repo_id: 'gitrepo:old' },
            { _id: 'sync:hr~ddoc:staff', database: 'hr', ddoc_id: '_design/staff', git_repo_id: 'gitrepo:old' }
          ] as unknown as GitRepo[];
        }
        return [];
      });
      await service.registerRepo(SINGLE_SERVER_ID, 'sales', {
        url: 'https://github.com/acme/new',
        branch: 'main',
        path: ''
      });
      const swept = sweptIds(removeAll, remove);
      expect(swept).toContain('sync:sales~ddoc:reports');
      expect(swept).not.toContain('sync:hr~ddoc:staff');
      expect(swept).not.toContain('gitrepo:old'); // the repo itself survives, only rewritten
    });

    // Fix round 2, NEW IMPORTANT 2: the strip used to run before the new/merged registration was
    // durable, so a failed write could delete the old repo without ever creating its replacement.
    it('does not touch another repository at all if persisting the new/merged registration fails', async () => {
      const remove = vi.spyOn(store, 'remove');
      const removeAll = vi.spyOn(store, 'removeAll');
      vi.spyOn(store, 'put').mockRejectedValue(new Error('network blip'));
      vi.spyOn(store, 'list').mockResolvedValue([
        {
          _id: 'gitrepo:old',
          url: 'https://github.com/acme/old',
          sync_targets: [{ server_id: SINGLE_SERVER_ID, db_name: 'sales', branch: 'main', path: '' }]
        }
      ]);
      await expect(
        service.registerRepo(SINGLE_SERVER_ID, 'sales', {
          url: 'https://github.com/acme/new',
          branch: 'main',
          path: ''
        })
      ).rejects.toThrow('network blip');
      expect(remove).not.toHaveBeenCalled();
      expect(removeAll).not.toHaveBeenCalled();
    });

    // Fix round 2 (coordinator's small item): repoIdentity must lowercase owner/repo too, not
    // just host (parseRepoUrl only lowercases host, to keep GitHubProvider.slug()'s case intact).
    it('treats a URL that differs only by owner/repo case as the same repository', async () => {
      vi.spyOn(store, 'list').mockResolvedValue([
        {
          _id: 'gitrepo:1',
          url: 'https://github.com/Acme/Widgets',
          sync_targets: [{ server_id: SINGLE_SERVER_ID, db_name: 'sales', branch: 'main', path: '' }]
        }
      ]);
      const put = vi.spyOn(store, 'put').mockResolvedValue({ id: 'gitrepo:1', rev: '2-b' });
      await service.registerRepo(SINGLE_SERVER_ID, 'hr', {
        url: 'https://github.com/acme/widgets',
        branch: 'main',
        path: ''
      });
      expect(put.mock.calls[0][0]).toBe('gitrepo:1');
      expect((put.mock.calls[0][1] as { sync_targets: unknown[] }).sync_targets).toHaveLength(2);
    });
  });

  describe('deleteRepo', () => {
    it('removes the repository document', async () => {
      const remove = vi.spyOn(store, 'remove').mockResolvedValue(undefined);
      vi.spyOn(store, 'list').mockResolvedValue([]);
      await service.deleteRepo('repo1');
      expect(remove).toHaveBeenCalledWith('repo1');
    });

    it('also removes every sync: document that pointed at the deleted repo', async () => {
      const remove = vi.spyOn(store, 'remove').mockResolvedValue(undefined);
      const removeAll = vi.spyOn(store, 'removeAll').mockResolvedValue(undefined);
      vi.spyOn(store, 'list').mockResolvedValue([
        { _id: 'sync:sales~ddoc:reports', database: 'sales', ddoc_id: '_design/reports', git_repo_id: 'gitrepo:1' },
        { _id: 'sync:hr~ddoc:staff', database: 'hr', ddoc_id: '_design/staff', git_repo_id: 'gitrepo:2' }
      ]);
      await service.deleteRepo('gitrepo:1');
      const swept = sweptIds(removeAll, remove);
      expect(swept).toContain('sync:sales~ddoc:reports');
      expect(swept).not.toContain('sync:hr~ddoc:staff');
    });

    // Fix round 1, minor 6: a throw between the two removals used to be able to leave orphaned
    // sync: docs with a dangling git_repo_id and no repo left to re-derive them from.
    it('sweeps sync: documents before removing the repository itself', async () => {
      const remove = vi.spyOn(store, 'remove').mockResolvedValue(undefined);
      const removeAll = vi.spyOn(store, 'removeAll').mockResolvedValue(undefined);
      vi.spyOn(store, 'list').mockResolvedValue([
        { _id: 'sync:sales~ddoc:reports', database: 'sales', ddoc_id: '_design/reports', git_repo_id: 'gitrepo:1' }
      ]);
      await service.deleteRepo('gitrepo:1');
      // The sweep is one bulk call now, so ordering is between the two spies rather than within
      // one call list — invocationCallOrder is the chronological fact either way.
      expect(sweptIds(removeAll)).toContain('sync:sales~ddoc:reports');
      expect(remove.mock.calls.map(([id]) => id)).toEqual(['gitrepo:1']);
      expect(removeAll.mock.invocationCallOrder[0]).toBeLessThan(remove.mock.invocationCallOrder[0]);
    });

    // Issue #6 item 12: store.list() already returned each document WITH its _rev, and remove(id)
    // then threw that away and re-read it — two round trips per document, in every sweep.
    it('sweeps in one bulk delete, reusing the revisions the listing already returned', async () => {
      const removeAll = vi.spyOn(store, 'removeAll').mockResolvedValue(undefined);
      const remove = vi.spyOn(store, 'remove').mockResolvedValue(undefined);
      vi.spyOn(store, 'list').mockImplementation(async (prefix: string) => {
        if (prefix === ID_PREFIX.sync) {
          return [
            { _id: 'sync:sales~ddoc:reports', _rev: '3-c', database: 'sales', git_repo_id: 'gitrepo:1' }
          ] as never;
        }
        if (prefix === ID_PREFIX.conflict) {
          return [
            { _id: 'conflict:sales~ddoc:reports', _rev: '2-b', db_name: 'sales', git_repo_id: 'gitrepo:1' }
          ] as never;
        }
        return [] as never;
      });

      await service.deleteRepo('gitrepo:1');

      expect(removeAll).toHaveBeenCalledTimes(1);
      expect(removeAll.mock.calls[0][0]).toEqual([
        expect.objectContaining({ _id: 'sync:sales~ddoc:reports', _rev: '3-c' }),
        expect.objectContaining({ _id: 'conflict:sales~ddoc:reports', _rev: '2-b' })
      ]);
      // Only the repository document itself — the one id this call really does hold on its own.
      expect(remove.mock.calls.map(([id]) => id)).toEqual(['gitrepo:1']);
    });

    // Fix round 1, IMPORTANT: conflict: docs carry a git_repo_id (also added this round) but were
    // never swept — a deleted repository used to leave its unresolved conflicts behind forever,
    // pointing at an id nothing could look up again.
    it('also removes conflict: documents that pointed at the deleted repo', async () => {
      const remove = vi.spyOn(store, 'remove').mockResolvedValue(undefined);
      const removeAll = vi.spyOn(store, 'removeAll').mockResolvedValue(undefined);
      vi.spyOn(store, 'list').mockImplementation(async (prefix: string) => {
        if (prefix === ID_PREFIX.sync) return [];
        if (prefix === ID_PREFIX.conflict) {
          return [
            { _id: 'conflict:sales~ddoc:reports', db_name: 'sales', ddoc_id: '_design/reports', git_repo_id: 'gitrepo:1' },
            { _id: 'conflict:hr~ddoc:staff', db_name: 'hr', ddoc_id: '_design/staff', git_repo_id: 'gitrepo:2' }
          ] as unknown as DesignConflict[];
        }
        return [];
      });
      await service.deleteRepo('gitrepo:1');
      const swept = sweptIds(removeAll, remove);
      expect(swept).toContain('conflict:sales~ddoc:reports');
      expect(swept).not.toContain('conflict:hr~ddoc:staff');
    });
  });

  describe('unlinkRepo', () => {
    it('unlinkRepo removes one target and keeps the repo when others remain', async () => {
      vi.spyOn(store, 'get').mockResolvedValue({
        _id: 'gitrepo:1',
        sync_targets: [
          { server_id: SINGLE_SERVER_ID, db_name: 'sales', branch: 'main', path: '' },
          { server_id: SINGLE_SERVER_ID, db_name: 'hr', branch: 'main', path: '' }
        ]
      });
      vi.spyOn(store, 'put').mockResolvedValue({ id: 'gitrepo:1', rev: '2-b' });
      expect(await service.unlinkRepo('gitrepo:1', SINGLE_SERVER_ID, 'sales')).toMatchObject({
        action: 'target_removed',
        remaining_targets: 1
      });
    });

    it('unlinkRepo deletes the repo when the last target goes', async () => {
      vi.spyOn(store, 'get').mockResolvedValue({
        _id: 'gitrepo:1',
        sync_targets: [{ server_id: SINGLE_SERVER_ID, db_name: 'sales', branch: 'main', path: '' }]
      });
      const remove = vi.spyOn(store, 'remove').mockResolvedValue(undefined);
      expect(await service.unlinkRepo('gitrepo:1', SINGLE_SERVER_ID, 'sales')).toMatchObject({
        action: 'repo_deleted',
        remaining_targets: 0
      });
      expect(remove).toHaveBeenCalledWith('gitrepo:1');
    });

    it('throws when the repository does not exist', async () => {
      vi.spyOn(store, 'get').mockResolvedValue(null);
      await expect(service.unlinkRepo('missing', SINGLE_SERVER_ID, 'sales')).rejects.toThrow(ApiError);
    });

    // Fix round 1, IMPORTANT 4: sync: docs are keyed by (git_repo_id, database) with a single
    // server (D2/D3), the same filter deleteRepo already applies — just also scoped to one db.
    it('sweeps the sync: documents for the unlinked target and reports the real count', async () => {
      vi.spyOn(store, 'get').mockResolvedValue({
        _id: 'gitrepo:1',
        sync_targets: [
          { server_id: SINGLE_SERVER_ID, db_name: 'sales', branch: 'main', path: '' },
          { server_id: SINGLE_SERVER_ID, db_name: 'hr', branch: 'main', path: '' }
        ]
      });
      vi.spyOn(store, 'put').mockResolvedValue({ id: 'gitrepo:1', rev: '2-b' });
      const remove = vi.spyOn(store, 'remove').mockResolvedValue(undefined);
      const removeAll = vi.spyOn(store, 'removeAll').mockResolvedValue(undefined);
      vi.spyOn(store, 'list').mockResolvedValue([
        { _id: 'sync:sales~ddoc:reports', database: 'sales', ddoc_id: '_design/reports', git_repo_id: 'gitrepo:1' },
        { _id: 'sync:sales~ddoc:views', database: 'sales', ddoc_id: '_design/views', git_repo_id: 'gitrepo:1' },
        // Same repo, different database — must survive.
        { _id: 'sync:hr~ddoc:staff', database: 'hr', ddoc_id: '_design/staff', git_repo_id: 'gitrepo:1' },
        // Same database, different (already-unlinked) repo — must survive.
        { _id: 'sync:sales~ddoc:old', database: 'sales', ddoc_id: '_design/old', git_repo_id: 'gitrepo:2' }
      ]);

      const result = await service.unlinkRepo('gitrepo:1', SINGLE_SERVER_ID, 'sales');

      const swept = sweptIds(removeAll, remove);
      expect(swept).toContain('sync:sales~ddoc:reports');
      expect(swept).toContain('sync:sales~ddoc:views');
      expect(swept).not.toContain('sync:hr~ddoc:staff');
      expect(swept).not.toContain('sync:sales~ddoc:old');
      expect(result.deleted_sync_docs).toBe(2);
    });

    // Fix round 1, minor 5: unlinking a target this repo never had used to report success and,
    // whenever sync_targets happened to already be empty, delete the whole repository.
    it('does not delete the repo or claim a removal when the target was never linked', async () => {
      vi.spyOn(store, 'get').mockResolvedValue({
        _id: 'gitrepo:1',
        sync_targets: [{ server_id: SINGLE_SERVER_ID, db_name: 'hr', branch: 'main', path: '' }]
      });
      const remove = vi.spyOn(store, 'remove');
      const put = vi.spyOn(store, 'put');
      const result = await service.unlinkRepo('gitrepo:1', SINGLE_SERVER_ID, 'sales');
      expect(remove).not.toHaveBeenCalled();
      expect(put).not.toHaveBeenCalled();
      expect(result).toMatchObject({ remaining_targets: 1, deleted_sync_docs: 0 });
    });

    // Issue #6 item 1: detachTarget's no-op (`removed === false`) still came back as
    // 'target_removed', and repo-overview toasted "Target unlinked (N connections remain)" — a
    // cheerful confirmation of a removal that never happened. The union needs a third member so a
    // caller can tell "already not linked" from "just unlinked".
    it('reports that nothing was linked rather than claiming a target was removed', async () => {
      vi.spyOn(store, 'get').mockResolvedValue({
        _id: 'gitrepo:1',
        sync_targets: [{ server_id: SINGLE_SERVER_ID, db_name: 'hr', branch: 'main', path: '' }]
      });

      const result = await service.unlinkRepo('gitrepo:1', SINGLE_SERVER_ID, 'sales');

      expect(result.action).toBe('not_linked');
      expect(result).toMatchObject({ remaining_targets: 1, deleted_sync_docs: 0 });
    });

    it('does not delete a repo that already has no targets, just because unlinking found nothing to remove', async () => {
      vi.spyOn(store, 'get').mockResolvedValue({ _id: 'gitrepo:1', sync_targets: [] });
      const remove = vi.spyOn(store, 'remove');
      const result = await service.unlinkRepo('gitrepo:1', SINGLE_SERVER_ID, 'sales');
      expect(remove).not.toHaveBeenCalled();
      expect(result.remaining_targets).toBe(0);
    });

    // Fix round 1, IMPORTANT: same gap as deleteRepo's — unlinking a target used to leave its
    // conflict: documents behind, un-owned once the target no longer resolves to anything.
    it('sweeps conflict: documents for the unlinked target', async () => {
      vi.spyOn(store, 'get').mockResolvedValue({
        _id: 'gitrepo:1',
        sync_targets: [
          { server_id: SINGLE_SERVER_ID, db_name: 'sales', branch: 'main', path: '' },
          { server_id: SINGLE_SERVER_ID, db_name: 'hr', branch: 'main', path: '' }
        ]
      });
      vi.spyOn(store, 'put').mockResolvedValue({ id: 'gitrepo:1', rev: '2-b' });
      const remove = vi.spyOn(store, 'remove').mockResolvedValue(undefined);
      const removeAll = vi.spyOn(store, 'removeAll').mockResolvedValue(undefined);
      vi.spyOn(store, 'list').mockImplementation(async (prefix: string) => {
        if (prefix === ID_PREFIX.conflict) {
          return [
            { _id: 'conflict:sales~ddoc:reports', db_name: 'sales', ddoc_id: '_design/reports', git_repo_id: 'gitrepo:1' },
            // Same repo, different database — must survive.
            { _id: 'conflict:hr~ddoc:staff', db_name: 'hr', ddoc_id: '_design/staff', git_repo_id: 'gitrepo:1' }
          ] as unknown as DesignConflict[];
        }
        return [];
      });

      await service.unlinkRepo('gitrepo:1', SINGLE_SERVER_ID, 'sales');

      const swept = sweptIds(removeAll, remove);
      expect(swept).toContain('conflict:sales~ddoc:reports');
      expect(swept).not.toContain('conflict:hr~ddoc:staff');
    });
  });

  describe('getGitAccounts', () => {
    it('masks the token when reading accounts back', async () => {
      vi.spyOn(store, 'list').mockResolvedValue([
        {
          _id: 'gitaccount:1',
          provider: 'github',
          label: 'work',
          auth: { token: 'ghp_secret' },
          credential_mode: 'couchdb'
        }
      ]);
      const [account] = await service.getGitAccounts();
      expect(JSON.stringify(account)).not.toContain('ghp_secret');
    });

    it('returns an empty list when no accounts are registered', async () => {
      vi.spyOn(store, 'list').mockResolvedValue([]);
      expect(await service.getGitAccounts()).toEqual([]);
    });

    it('carries the visible fields through unmasked, credential_mode included', async () => {
      vi.spyOn(store, 'list').mockResolvedValue([
        {
          _id: 'gitaccount:1',
          provider: 'github',
          label: 'work',
          username: 'octocat',
          base_url: null,
          credential_mode: 'indexeddb'
        }
      ]);
      const [account] = await service.getGitAccounts();
      // credential_mode is WHERE the token lives, never the token — and without it no component
      // could tell which mode it was in, so the sync-time prompt told every user their account
      // "does not store its access token", false for both persisting modes.
      expect(account).toEqual({
        _id: 'gitaccount:1',
        provider: 'github',
        label: 'work',
        username: 'octocat',
        base_url: null,
        credential_mode: 'indexeddb'
      });
    });

    it("reports a document written before credential_mode existed as 'none'", async () => {
      vi.spyOn(store, 'list').mockResolvedValue([
        { _id: 'gitaccount:1', provider: 'github', label: 'legacy' }
      ]);
      const [account] = await service.getGitAccounts();
      expect(account.credential_mode).toBe('none');
    });
  });

  describe('postGitAccounts', () => {
    it('stores a connected account without ever writing the token into the doc body', async () => {
      const put = vi.spyOn(store, 'put').mockResolvedValue({ id: 'gitaccount:1', rev: '1-a' });
      await service.postGitAccounts({
        provider: 'github',
        label: 'work',
        base_url: null,
        token: 'ghp_secret',
        username: null
      });
      const [, body] = put.mock.calls[0];
      expect(JSON.stringify(body)).not.toContain('ghp_secret');
    });

    it("writes the token into the account doc only when the mode is 'couchdb'", async () => {
      const put = vi.spyOn(store, 'put').mockResolvedValue({ id: 'gitaccount:1', rev: '1-a' });
      await service.postGitAccounts({
        provider: 'github',
        label: 'work',
        base_url: null,
        token: 'ghp_secret',
        username: null,
        credential_mode: 'couchdb'
      } as never);
      expect(JSON.stringify(put.mock.calls[0][1])).toContain('ghp_secret');
    });

    it('verifies a github token with whoami before storing anything', async () => {
      const whoami = vi.spyOn(GitHubProvider.prototype, 'whoami').mockResolvedValue({ login: 'octocat', name: null });
      vi.spyOn(store, 'put').mockResolvedValue({ id: 'gitaccount:1', rev: '1-a' });
      await service.postGitAccounts({
        provider: 'github',
        label: 'work',
        base_url: null,
        token: 'ghp_secret',
        username: null
      });
      expect(whoami).toHaveBeenCalled();
    });

    it('surfaces an invalid token instead of storing the account', async () => {
      vi.spyOn(GitHubProvider.prototype, 'whoami').mockRejectedValue(new Error('Bad credentials'));
      const put = vi.spyOn(store, 'put');
      await expect(
        service.postGitAccounts({
          provider: 'github',
          label: 'work',
          base_url: null,
          token: 'ghp_bad',
          username: null
        })
      ).rejects.toThrow('Bad credentials');
      expect(put).not.toHaveBeenCalled();
    });

    it('returns the masked account with a generated id', async () => {
      vi.spyOn(store, 'put').mockResolvedValue({ id: 'gitaccount:1', rev: '1-a' });
      const account = await service.postGitAccounts({
        provider: 'github',
        label: 'work',
        base_url: null,
        token: 'ghp_secret',
        username: null
      });
      expect(account).toMatchObject({ provider: 'github', label: 'work' });
      expect(account._id).toMatch(/^gitaccount:/);
      expect(JSON.stringify(account)).not.toContain('ghp_secret');
    });
  });

  describe('getGitAccount', () => {
    it('fetches and masks a single account', async () => {
      vi.spyOn(store, 'get').mockResolvedValue({
        _id: 'gitaccount:1',
        provider: 'github',
        label: 'work',
        auth: { token: 'ghp_secret' },
        credential_mode: 'couchdb'
      });
      const account = await service.getGitAccount('gitaccount:1');
      expect(account).toMatchObject({ _id: 'gitaccount:1', provider: 'github', label: 'work' });
      expect(JSON.stringify(account)).not.toContain('ghp_secret');
    });

    it('throws when the account does not exist', async () => {
      vi.spyOn(store, 'get').mockResolvedValue(null);
      await expect(service.getGitAccount('gitaccount:missing')).rejects.toThrow(ApiError);
    });
  });

  describe('deleteGitAccount', () => {
    it('removes the document and forgets every stored copy of its token', async () => {
      const remove = vi.spyOn(store, 'remove').mockResolvedValue(undefined);
      const forget = vi.spyOn(credentials, 'forget').mockResolvedValue(undefined);
      await service.deleteGitAccount('gitaccount:1');
      expect(remove).toHaveBeenCalledWith('gitaccount:1');
      expect(forget).toHaveBeenCalledWith('gitaccount:1');
    });

    // Fix round 1, minor 9: forget() used to be skipped entirely if store.remove threw, stranding
    // the PAT in IndexedDB/the session cache with the account doc gone.
    it('still forgets the token even when removing the document fails', async () => {
      vi.spyOn(store, 'remove').mockRejectedValue(new Error('network blip'));
      const forget = vi.spyOn(credentials, 'forget').mockResolvedValue(undefined);
      await expect(service.deleteGitAccount('gitaccount:1')).rejects.toThrow('network blip');
      expect(forget).toHaveBeenCalledWith('gitaccount:1');
    });
  });

  // -----------------------------------------------------------------------------------------
  // Issue #9. The credential mode was chosen once at connect time and could never be changed —
  // and the hazard is not the field, it is the token underneath it. `GitCredentialStore.put()`
  // writes under the NEW mode and does not purge the old backing store, while `get()` consults
  // the session cache BEFORE the mode, so in the tab that made the change everything keeps
  // working and the abandoned copy is invisible. `forget()` is the only thing that clears all
  // three locations, so it has to run first — and, because it clears the session cache too, only
  // after the token is safely in a local.
  //
  // The whole operation lives in the service because it has to: `credentials` is private, is not
  // on AppContext, and `maskAccount` is an allow-list that guarantees no public method ever
  // returns a token. A component physically cannot move one.
  // -----------------------------------------------------------------------------------------
  describe('changeCredentialMode', () => {
    const ACCOUNT = 'gitaccount:edit';

    /** A complete `gitaccount:` document — every field `postGitAccounts` writes. */
    const accountDoc = (over: Record<string, unknown> = {}) => ({
      _id: ACCOUNT,
      _rev: '3-c',
      doc_type: 'git_account',
      provider: 'github',
      label: 'work',
      username: 'octocat',
      base_url: 'https://ghe.example.com',
      credential_mode: 'none',
      created_at: '2026-01-01T00:00:00.000Z',
      ...over
    });

    let idb: FakeIndexedDb;

    /**
     * Every token actually on "disk". happy-dom implements no `indexedDB`, so without the fake
     * every IndexedDB read and write short-circuits to `null` — meaning a `put()` that stranded a
     * token, or a `forget()` that never removed one, would leave this suite perfectly green. That
     * is precisely the leak #9 is about, so it has to be observable here.
     */
    const storedTokens = () => [...idb.data.values()].flatMap((s) => [...s.values()]);

    beforeEach(() => {
      idb = installFakeIndexedDb();
    });

    afterEach(() => {
      idb.uninstall();
    });

    /**
     * A service whose credential store starts with an **empty session cache**, and whose CouchDB
     * port is a spy over `token.value` — the same port `context.ts` wires to `auth.token` on the
     * account document. Anything a test finds afterwards therefore came out of a real backing
     * store, not out of the in-tab cache that makes this class of leak invisible.
     */
    function coldService(token: { value: string | null }) {
      const io = {
        readToken: vi.fn(async () => token.value),
        writeToken: vi.fn(async (_id: string, next: string | null) => {
          token.value = next;
        })
      } satisfies CouchTokenIo;
      const store2 = new GitCredentialStore(io);
      return { io, credentials: store2, service: new DesignMgmtService(api, store, store2) };
    }

    it('carries an indexeddb token over to couchdb and leaves no copy behind in the browser', async () => {
      // Seeded through a throwaway instance so the token is genuinely on "disk" and nowhere else.
      await new GitCredentialStore(fakeCouchTokenIo()).put(ACCOUNT, 'indexeddb', 'ghp_on_disk');
      expect(storedTokens()).toContain('ghp_on_disk');

      const couch = { value: null as string | null };
      const cold = coldService(couch);
      vi.spyOn(store, 'get').mockResolvedValue(accountDoc({ credential_mode: 'indexeddb' }));
      vi.spyOn(store, 'put').mockResolvedValue({ id: ACCOUNT, rev: '4-d' });

      const result = await cold.service.changeCredentialMode(ACCOUNT, 'couchdb');

      expect(result).toEqual({ status: 'changed', from: 'indexeddb', to: 'couchdb' });
      expect(couch.value).toBe('ghp_on_disk');
      // The assertion the issue is actually about: put() alone would have left this behind.
      expect(storedTokens()).not.toContain('ghp_on_disk');
    });

    it('reads a couchdb-mode token off the account document, not the session cache', async () => {
      const couch = { value: 'ghp_in_couchdb' as string | null };
      const cold = coldService(couch);
      vi.spyOn(store, 'get').mockResolvedValue(accountDoc({ credential_mode: 'couchdb' }));
      vi.spyOn(store, 'put').mockResolvedValue({ id: ACCOUNT, rev: '4-d' });

      const result = await cold.service.changeCredentialMode(ACCOUNT, 'indexeddb');

      expect(result).toEqual({ status: 'changed', from: 'couchdb', to: 'indexeddb' });
      // `get()` checks the session cache first and only then the mode, so a hit here is only
      // reachable when the cache was empty — which is exactly the illusion this bug hides behind.
      expect(cold.io.readToken).toHaveBeenCalledWith(ACCOUNT);
      expect(storedTokens()).toContain('ghp_in_couchdb');
      expect(couch.value).toBeNull();
    });

    it("moves a mode-'none' token that this tab still holds", async () => {
      vi.spyOn(store, 'get').mockResolvedValue(accountDoc({ credential_mode: 'none' }));
      vi.spyOn(store, 'put').mockResolvedValue({ id: ACCOUNT, rev: '4-d' });
      credentials.remember(ACCOUNT, 'ghp_session');

      const result = await service.changeCredentialMode(ACCOUNT, 'indexeddb');

      expect(result).toEqual({ status: 'changed', from: 'none', to: 'indexeddb' });
      expect(storedTokens()).toContain('ghp_session');
    });

    it("reports token_required, and changes nothing, when mode 'none' has no token in this tab", async () => {
      vi.spyOn(store, 'get').mockResolvedValue(accountDoc({ credential_mode: 'none' }));
      const docPut = vi.spyOn(store, 'put');
      const forget = vi.spyOn(credentials, 'forget');
      const credPut = vi.spyOn(credentials, 'put');

      expect(await service.changeCredentialMode(ACCOUNT, 'couchdb')).toEqual({ status: 'token_required' });

      // "Changes nothing" is the whole contract: no purge, no document write, no new copy.
      expect(forget).not.toHaveBeenCalled();
      expect(docPut).not.toHaveBeenCalled();
      expect(credPut).not.toHaveBeenCalled();
    });

    it('takes the token the caller supplies when there is nothing to move', async () => {
      vi.spyOn(store, 'get').mockResolvedValue(accountDoc({ credential_mode: 'none' }));
      vi.spyOn(store, 'put').mockResolvedValue({ id: ACCOUNT, rev: '4-d' });
      const credPut = vi.spyOn(credentials, 'put').mockResolvedValue(undefined);

      expect(await service.changeCredentialMode(ACCOUNT, 'couchdb', 'ghp_typed')).toEqual({
        status: 'changed',
        from: 'none',
        to: 'couchdb'
      });
      expect(credPut).toHaveBeenCalledWith(ACCOUNT, 'couchdb', 'ghp_typed');
    });

    it('prefers a freshly typed token over the stored one it could have moved', async () => {
      const couch = { value: 'ghp_stale' as string | null };
      const cold = coldService(couch);
      vi.spyOn(store, 'get').mockResolvedValue(accountDoc({ credential_mode: 'couchdb' }));
      vi.spyOn(store, 'put').mockResolvedValue({ id: ACCOUNT, rev: '4-d' });

      await cold.service.changeCredentialMode(ACCOUNT, 'indexeddb', 'ghp_rotated');

      expect(storedTokens()).toContain('ghp_rotated');
      expect(storedTokens()).not.toContain('ghp_stale');
    });

    it("purges every copy and stores nothing when switching to 'none'", async () => {
      await new GitCredentialStore(fakeCouchTokenIo()).put(ACCOUNT, 'indexeddb', 'ghp_on_disk');
      const couch = { value: null as string | null };
      const cold = coldService(couch);
      vi.spyOn(store, 'get').mockResolvedValue(accountDoc({ credential_mode: 'indexeddb' }));
      const docPut = vi.spyOn(store, 'put').mockResolvedValue({ id: ACCOUNT, rev: '4-d' });
      const credPut = vi.spyOn(cold.credentials, 'put');

      const result = await cold.service.changeCredentialMode(ACCOUNT, 'none');

      expect(result).toEqual({ status: 'changed', from: 'indexeddb', to: 'none' });
      // No token is needed to get here, and none may be written: forget() IS the operation.
      expect(credPut).not.toHaveBeenCalled();
      expect(storedTokens()).toHaveLength(0);
      expect(docPut.mock.calls[0][1]).toMatchObject({ credential_mode: 'none' });
    });

    it("never asks for a token to switch to 'none', even with nothing stored anywhere", async () => {
      vi.spyOn(store, 'get').mockResolvedValue(accountDoc({ credential_mode: 'indexeddb' }));
      vi.spyOn(store, 'put').mockResolvedValue({ id: ACCOUNT, rev: '4-d' });

      expect(await service.changeCredentialMode(ACCOUNT, 'none')).toEqual({
        status: 'changed',
        from: 'indexeddb',
        to: 'none'
      });
    });

    it('purges before it writes anything, so no live token is left under a mode nothing reads', async () => {
      vi.spyOn(store, 'get').mockResolvedValue(accountDoc({ credential_mode: 'none' }));
      credentials.remember(ACCOUNT, 'ghp_session');
      const forget = vi.spyOn(credentials, 'forget').mockResolvedValue(undefined);
      const docPut = vi.spyOn(store, 'put').mockResolvedValue({ id: ACCOUNT, rev: '4-d' });
      const credPut = vi.spyOn(credentials, 'put').mockResolvedValue(undefined);

      await service.changeCredentialMode(ACCOUNT, 'couchdb');

      // Ordering, not mere participation — "both were called" is satisfied by the broken order.
      expect(forget.mock.invocationCallOrder[0]).toBeLessThan(docPut.mock.invocationCallOrder[0]);
      expect(docPut.mock.invocationCallOrder[0]).toBeLessThan(credPut.mock.invocationCallOrder[0]);
    });

    it('leaves no token in the new store when the document write fails', async () => {
      const couch = { value: 'ghp_in_couchdb' as string | null };
      const cold = coldService(couch);
      vi.spyOn(store, 'get').mockResolvedValue(accountDoc({ credential_mode: 'couchdb' }));
      vi.spyOn(store, 'put').mockRejectedValue(new ApiError(409, 'conflict'));

      await expect(cold.service.changeCredentialMode(ACCOUNT, 'indexeddb')).rejects.toThrow(ApiError);

      // "No token anywhere" is the acceptable failure — the sync-time prompt recovers from it.
      // A token stranded under a mode the document does not name is not.
      expect(storedTokens()).toHaveLength(0);
      expect(await cold.credentials.get(ACCOUNT, 'indexeddb')).toBeNull();
    });

    it('writes the whole account document back, because store.put replaces rather than merges', async () => {
      vi.spyOn(store, 'get').mockResolvedValue(accountDoc({ credential_mode: 'none' }));
      const docPut = vi.spyOn(store, 'put').mockResolvedValue({ id: ACCOUNT, rev: '4-d' });
      credentials.remember(ACCOUNT, 'ghp_session');

      await service.changeCredentialMode(ACCOUNT, 'indexeddb');

      const [id, body] = docPut.mock.calls[0];
      expect(id).toBe(ACCOUNT);
      // Dropping `provider` here would break providerFor permanently — it throws for anything
      // that is not "github", and nothing would ever put the field back.
      expect(body).toMatchObject({
        doc_type: 'git_account',
        provider: 'github',
        label: 'work',
        username: 'octocat',
        base_url: 'https://ghe.example.com',
        created_at: '2026-01-01T00:00:00.000Z',
        credential_mode: 'indexeddb'
      });
    });

    it('does not write the purged couchdb token back into the document', async () => {
      // The document read before forget() still carries auth.token; writing it back would
      // resurrect the very copy forget() had just stripped.
      vi.spyOn(store, 'get').mockResolvedValue(
        accountDoc({ credential_mode: 'couchdb', auth: { token: 'ghp_in_couchdb' } })
      );
      const docPut = vi.spyOn(store, 'put').mockResolvedValue({ id: ACCOUNT, rev: '4-d' });

      await service.changeCredentialMode(ACCOUNT, 'indexeddb', 'ghp_typed');

      expect(docPut.mock.calls[0][1]).not.toHaveProperty('auth');
      expect(JSON.stringify(docPut.mock.calls[0][1])).not.toContain('ghp_in_couchdb');
      expect(JSON.stringify(docPut.mock.calls[0][1])).not.toContain('ghp_typed');
    });

    it('throws when the account does not exist', async () => {
      vi.spyOn(store, 'get').mockResolvedValue(null);
      await expect(service.changeCredentialMode('gitaccount:missing', 'indexeddb')).rejects.toThrow(ApiError);
    });
  });

  describe('renameGitAccount', () => {
    const ACCOUNT = 'gitaccount:edit';

    it('changes only the label and preserves every other field', async () => {
      vi.spyOn(store, 'get').mockResolvedValue({
        _id: ACCOUNT,
        _rev: '3-c',
        doc_type: 'git_account',
        provider: 'github',
        label: 'work',
        username: 'octocat',
        base_url: 'https://ghe.example.com',
        credential_mode: 'couchdb',
        created_at: '2026-01-01T00:00:00.000Z',
        auth: { token: 'ghp_in_couchdb' }
      });
      const docPut = vi.spyOn(store, 'put').mockResolvedValue({ id: ACCOUNT, rev: '4-d' });

      const account = await service.renameGitAccount(ACCOUNT, 'personal');

      expect(docPut.mock.calls[0][1]).toMatchObject({
        doc_type: 'git_account',
        provider: 'github',
        label: 'personal',
        username: 'octocat',
        base_url: 'https://ghe.example.com',
        credential_mode: 'couchdb',
        created_at: '2026-01-01T00:00:00.000Z',
        // A rename is not a credential operation: dropping `auth` would silently delete a
        // couchdb-mode account's token, and store.put replaces rather than merges.
        auth: { token: 'ghp_in_couchdb' }
      });
      expect(account).toEqual({
        _id: ACCOUNT,
        provider: 'github',
        label: 'personal',
        username: 'octocat',
        base_url: 'https://ghe.example.com',
        credential_mode: 'couchdb'
      });
      expect(JSON.stringify(account)).not.toContain('ghp_in_couchdb');
    });

    it('trims the label rather than storing a name made of spaces', async () => {
      vi.spyOn(store, 'get').mockResolvedValue({ _id: ACCOUNT, provider: 'github', label: 'work' });
      const docPut = vi.spyOn(store, 'put').mockResolvedValue({ id: ACCOUNT, rev: '4-d' });

      const account = await service.renameGitAccount(ACCOUNT, '  personal  ');

      expect(docPut.mock.calls[0][1]).toMatchObject({ label: 'personal' });
      expect(account.label).toBe('personal');
    });

    it('refuses an empty label instead of writing an unnameable account', async () => {
      vi.spyOn(store, 'get').mockResolvedValue({ _id: ACCOUNT, provider: 'github', label: 'work' });
      const docPut = vi.spyOn(store, 'put');

      await expect(service.renameGitAccount(ACCOUNT, '   ')).rejects.toThrow(ApiError);
      expect(docPut).not.toHaveBeenCalled();
    });

    it('throws when the account does not exist', async () => {
      vi.spyOn(store, 'get').mockResolvedValue(null);
      await expect(service.renameGitAccount('gitaccount:missing', 'personal')).rejects.toThrow(ApiError);
    });

    it('never touches the credential store', async () => {
      vi.spyOn(store, 'get').mockResolvedValue({ _id: ACCOUNT, provider: 'github', label: 'work' });
      vi.spyOn(store, 'put').mockResolvedValue({ id: ACCOUNT, rev: '4-d' });
      const forget = vi.spyOn(credentials, 'forget');
      const credPut = vi.spyOn(credentials, 'put');

      await service.renameGitAccount(ACCOUNT, 'personal');

      expect(forget).not.toHaveBeenCalled();
      expect(credPut).not.toHaveBeenCalled();
    });
  });

  describe('rememberAccountToken', () => {
    // Task 8's sync-time prompt for credential mode 'none': the entire persistence story is the
    // in-memory session cache — this must never touch the couchdb or indexeddb backing stores.
    it('warms the session cache so the next providerFor resolves it, without persisting anywhere', async () => {
      const put = vi.spyOn(credentials, 'put');
      service.rememberAccountToken('gitaccount:1', 'ghp_prompted');
      expect(await credentials.get('gitaccount:1', 'none')).toBe('ghp_prompted');
      expect(put).not.toHaveBeenCalled();
    });
  });

  // The rotated-PAT trap: isMissingTokenError treats any 401 as "needs a token" and the retry
  // recovered by remembering it for the session — correct for mode 'none', a permanent loop for
  // the persisting modes, because GitCredentialStore.get re-read the stale stored token on every
  // fresh tab and nothing but postGitAccounts ever wrote through put(). With no account-edit
  // screen anywhere in the app, that loop had no exit.
  describe('saveAccountToken', () => {
    it("keeps a mode-'none' account's token in the session cache only", async () => {
      vi.spyOn(store, 'get').mockResolvedValue({
        _id: 'gitaccount:1', provider: 'github', label: 'work', credential_mode: 'none'
      });
      const put = vi.spyOn(credentials, 'put');
      expect(await service.saveAccountToken('gitaccount:1', 'ghp_prompted')).toBe('none');
      expect(await credentials.get('gitaccount:1', 'none')).toBe('ghp_prompted');
      expect(put).not.toHaveBeenCalled();
    });

    it('writes through to the backing store for a persisting mode, replacing the rejected token', async () => {
      vi.spyOn(store, 'get').mockResolvedValue({
        _id: 'gitaccount:1', provider: 'github', label: 'work', credential_mode: 'indexeddb'
      });
      const put = vi.spyOn(credentials, 'put').mockResolvedValue(undefined);
      expect(await service.saveAccountToken('gitaccount:1', 'ghp_rotated')).toBe('indexeddb');
      expect(put).toHaveBeenCalledWith('gitaccount:1', 'indexeddb', 'ghp_rotated');
    });

    it("routes a couchdb-mode account's token to the couchcompanion copy", async () => {
      vi.spyOn(store, 'get').mockResolvedValue({
        _id: 'gitaccount:1', provider: 'github', label: 'work', credential_mode: 'couchdb'
      });
      const put = vi.spyOn(credentials, 'put').mockResolvedValue(undefined);
      await service.saveAccountToken('gitaccount:1', 'ghp_rotated');
      expect(put).toHaveBeenCalledWith('gitaccount:1', 'couchdb', 'ghp_rotated');
    });

    it('degrades to session-only rather than losing a just-typed token when the mode lookup fails', async () => {
      vi.spyOn(store, 'get').mockRejectedValue(new ApiError(403, 'forbidden'));
      expect(await service.saveAccountToken('gitaccount:1', 'ghp_prompted')).toBe('none');
      expect(await credentials.get('gitaccount:1', 'none')).toBe('ghp_prompted');
    });
  });

  describe('getGitAccountRepos', () => {
    it('asks for the token when the account stores none and none was remembered', async () => {
      vi.spyOn(store, 'get').mockResolvedValue({
        _id: 'gitaccount:1',
        provider: 'github',
        base_url: null,
        credential_mode: 'none'
      });
      await expect(service.getGitAccountRepos('gitaccount:1')).rejects.toThrow(/token/i);
    });

    it("lists the authenticated user's repositories through the provider", async () => {
      vi.spyOn(store, 'get').mockResolvedValue({
        _id: 'gitaccount:1',
        provider: 'github',
        base_url: null,
        credential_mode: 'none'
      });
      credentials.remember('gitaccount:1', 'ghp_secret');
      const repos = [
        {
          full_name: 'acme/widgets',
          clone_url: 'https://github.com/acme/widgets.git',
          default_branch: 'main',
          private: false
        }
      ];
      const listRepos = vi.spyOn(GitHubProvider.prototype, 'listRepos').mockResolvedValue(repos);
      expect(await service.getGitAccountRepos('gitaccount:1')).toEqual(repos);
      expect(listRepos).toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
    });
  });

  describe('getGitRepoBranches', () => {
    it('lists branches through the provider, not through CouchDB', async () => {
      const branches = vi.spyOn(GitHubProvider.prototype, 'listBranches').mockResolvedValue(['main', 'dev']);
      vi.spyOn(store, 'get').mockResolvedValue({
        _id: 'gitaccount:1',
        provider: 'github',
        base_url: null,
        credential_mode: 'none'
      });
      expect(await service.getGitRepoBranches('gitaccount:1', 'https://github.com/acme/widgets')).toEqual([
        'main',
        'dev'
      ]);
      expect(branches).toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
    });

    it('rejects an account for a provider that is not implemented yet', async () => {
      vi.spyOn(store, 'get').mockResolvedValue({ _id: 'gitaccount:1', provider: 'gitlab', base_url: null });
      await expect(
        service.getGitRepoBranches('gitaccount:1', 'https://gitlab.com/acme/widgets')
      ).rejects.toThrow(/gitlab/i);
    });

    it('throws when the account does not exist', async () => {
      vi.spyOn(store, 'get').mockResolvedValue(null);
      await expect(service.getGitRepoBranches('missing', 'https://github.com/acme/widgets')).rejects.toThrow(
        ApiError
      );
    });
  });

  describe('getRepoDocs', () => {
    beforeEach(() => {
      stubRepoAndAccount();
    });

    it('reads every design doc under the target path from the repo tree, ignoring non-design files', async () => {
      vi.spyOn(GitHubProvider.prototype, 'listTree').mockResolvedValue([
        { path: 'sales/_design/reports.json', sha: 'sha1' },
        { path: 'sales/_design/views.json', sha: 'sha2' },
        { path: 'sales/README.md', sha: 'sha3' }
      ]);
      vi.spyOn(GitHubProvider.prototype, 'getFile').mockImplementation(async (_url, _branch, path) =>
        JSON.stringify({ path })
      );

      const docs = await service.getRepoDocs(SYNC_REPO_ID, SYNC_DB);

      expect(docs).toHaveLength(2);
      expect(docs.map((d) => d.info.ddoc_id).sort()).toEqual(['_design/reports', '_design/views']);
      expect(docs.find((d) => d.info.ddoc_id === '_design/reports')).toMatchObject({
        info: { db_name: SYNC_DB, git_repo_id: SYNC_REPO_ID, git_sha: 'sha1' }
      });
    });

    it('returns an empty array when the repository has no design docs', async () => {
      vi.spyOn(GitHubProvider.prototype, 'listTree').mockResolvedValue([]);
      expect(await service.getRepoDocs(SYNC_REPO_ID, SYNC_DB)).toEqual([]);
    });

    // Each file is its own GitHub API call against a rate limit the caller does not control — a
    // repository with more than the cap must degrade to "the first 50, logged", never a silent
    // truncation that reads as "that's everything".
    it('caps the fan-out at 50 files and logs what was dropped', async () => {
      const entries = Array.from({ length: 55 }, (_, i) => ({ path: `sales/_design/doc${i}.json`, sha: `sha${i}` }));
      vi.spyOn(GitHubProvider.prototype, 'listTree').mockResolvedValue(entries);
      const getFile = vi.spyOn(GitHubProvider.prototype, 'getFile').mockResolvedValue('{}');

      const warnSpy = vi.fn();
      const savedWarnTarget = Logger.logTarget[Level.WARN];
      Logger.logTarget[Level.WARN] = warnSpy;
      try {
        const docs = await service.getRepoDocs(SYNC_REPO_ID, SYNC_DB);
        expect(docs).toHaveLength(50);
        expect(getFile).toHaveBeenCalledTimes(50);
        expect(warnSpy).toHaveBeenCalledTimes(1);
        const [message, context] = warnSpy.mock.calls[0];
        expect(message).toMatch(/50/);
        expect(context).toMatchObject({ db: SYNC_DB, total: 55, dropped: 5 });
        // Fix round 1: a caller reading a bare count still sees "the repo has 50 files" — the
        // actual dropped paths must be there too, so a truncation is diagnosable from the log.
        expect((context as { droppedPaths: string[] }).droppedPaths).toHaveLength(5);
        expect((context as { droppedPaths: string[] }).droppedPaths).toContain('sales/_design/doc54.json');
      } finally {
        Logger.logTarget[Level.WARN] = savedWarnTarget;
      }
    });

    // A log.warn nobody renders is not a disclosure — in the UI the cap WAS the silent truncation
    // this method's own comment says it must never be. The optional callback is what a caller
    // needs to put it on screen.
    it('reports the truncation to a caller that asks, with the dropped paths', async () => {
      const entries = Array.from({ length: 52 }, (_, i) => ({ path: `sales/_design/doc${i}.json`, sha: `sha${i}` }));
      vi.spyOn(GitHubProvider.prototype, 'listTree').mockResolvedValue(entries);
      vi.spyOn(GitHubProvider.prototype, 'getFile').mockResolvedValue('{}');

      const seen: unknown[] = [];
      await service.getRepoDocs(SYNC_REPO_ID, SYNC_DB, (info) => seen.push(info));

      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ shown: 50, total: 52 });
      expect((seen[0] as { droppedPaths: string[] }).droppedPaths).toEqual([
        'sales/_design/doc50.json',
        'sales/_design/doc51.json'
      ]);
    });

    /**
     * Issue #6 item 6: `onTruncated` fired *before* the per-file reads, so `shown` counted the
     * files this method was about to attempt, not the ones it got back. Every failure the
     * `Promise.allSettled` below drops made the number a lie — the callout could say "Showing 50
     * of 52" for a list that rendered 48 rows.
     */
    it('reports what actually came back, not what it set out to read', async () => {
      const entries = Array.from({ length: 52 }, (_, i) => ({ path: `sales/_design/doc${i}.json`, sha: `sha${i}` }));
      vi.spyOn(GitHubProvider.prototype, 'listTree').mockResolvedValue(entries);
      vi.spyOn(GitHubProvider.prototype, 'getFile').mockImplementation(async (_url, _branch, path) => {
        if (path === 'sales/_design/doc3.json') throw new Error('too large for the GitHub Contents API');
        if (path === 'sales/_design/doc7.json') throw new Error('rate limited');
        return '{}';
      });

      const seen: unknown[] = [];
      const docs = await service.getRepoDocs(SYNC_REPO_ID, SYNC_DB, (info) => seen.push(info));

      expect(docs).toHaveLength(48);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ shown: 48, total: 52 });
      // Everything the caller asked about but did not get: the two the cap dropped and the two
      // that could not be read — so "shown + not shown" adds up to what the repository holds.
      const info = seen[0] as { droppedPaths: string[]; unreadablePaths?: string[] };
      expect(info.droppedPaths).toEqual([
        'sales/_design/doc50.json',
        'sales/_design/doc51.json',
        'sales/_design/doc3.json',
        'sales/_design/doc7.json'
      ]);
      // ...and which of those failed to read rather than being capped, kept separately so a
      // caller can explain the two for what they are.
      expect(info.unreadablePaths).toEqual(['sales/_design/doc3.json', 'sales/_design/doc7.json']);
    });

    it('discloses files it could not read even when the cap was never reached', async () => {
      vi.spyOn(GitHubProvider.prototype, 'listTree').mockResolvedValue([
        { path: 'sales/_design/reports.json', sha: 'sha1' },
        { path: 'sales/_design/huge.json', sha: 'sha2' }
      ]);
      vi.spyOn(GitHubProvider.prototype, 'getFile').mockImplementation(async (_url, _branch, path) => {
        if (path.endsWith('huge.json')) throw new Error('too large for the GitHub Contents API');
        return '{}';
      });

      const onTruncated = vi.fn();
      await service.getRepoDocs(SYNC_REPO_ID, SYNC_DB, onTruncated);

      expect(onTruncated).toHaveBeenCalledTimes(1);
      expect(onTruncated.mock.calls[0][0]).toMatchObject({
        shown: 1,
        total: 2,
        droppedPaths: ['sales/_design/huge.json'],
        unreadablePaths: ['sales/_design/huge.json']
      });
    });

    it('does not report a truncation that did not happen', async () => {
      vi.spyOn(GitHubProvider.prototype, 'listTree').mockResolvedValue([
        { path: 'sales/_design/reports.json', sha: 'sha1' }
      ]);
      vi.spyOn(GitHubProvider.prototype, 'getFile').mockResolvedValue('{}');

      const onTruncated = vi.fn();
      await service.getRepoDocs(SYNC_REPO_ID, SYNC_DB, onTruncated);

      expect(onTruncated).not.toHaveBeenCalled();
    });

    // Fix round 1, IMPORTANT: with the target's (commonly empty, repo-root) path, listTree
    // returns the WHOLE repository tree, and a bare "matches _design/*.json" filter let another
    // database's files (and root-level ones) leak in as phantom rows for this database.
    it('does not return a design doc that belongs to a different database or the repo root', async () => {
      vi.spyOn(GitHubProvider.prototype, 'listTree').mockResolvedValue([
        { path: 'sales/_design/reports.json', sha: 'sha1' },
        { path: 'hr/_design/salaries.json', sha: 'sha2' },
        { path: '_design/rootlevel.json', sha: 'sha3' }
      ]);
      vi.spyOn(GitHubProvider.prototype, 'getFile').mockResolvedValue('{}');

      const docs = await service.getRepoDocs(SYNC_REPO_ID, SYNC_DB);

      expect(docs.map((d) => d.info.ddoc_id)).toEqual(['_design/reports']);
    });

    // Fix round 2, test gap the coordinator flagged: the case above only exercised an EMPTY
    // target.path (the repo-root case). A non-empty path is exactly the configuration where the
    // designDocRepoPath/ddocIdFromPath arithmetic can actually go wrong — a sibling database
    // under the same configured root, or a root-level file directly under that root (missing the
    // db segment entirely), must still be excluded.
    it('scopes correctly with a non-empty target path too', async () => {
      const repoWithPath: GitRepo = {
        ...SYNC_REPO,
        sync_targets: [{ server_id: SINGLE_SERVER_ID, db_name: SYNC_DB, branch: 'main', path: 'ddocs' }]
      };
      vi.spyOn(store, 'get').mockImplementation(async (id: string) => {
        if (id === SYNC_REPO_ID) return repoWithPath as never;
        if (id === SYNC_ACCOUNT_ID) return SYNC_ACCOUNT as never;
        return null;
      });
      vi.spyOn(GitHubProvider.prototype, 'listTree').mockResolvedValue([
        { path: 'ddocs/sales/_design/reports.json', sha: 'sha1' },
        { path: 'ddocs/hr/_design/salaries.json', sha: 'sha2' },
        { path: 'ddocs/_design/rootlevel.json', sha: 'sha3' }
      ]);
      vi.spyOn(GitHubProvider.prototype, 'getFile').mockResolvedValue('{}');

      const docs = await service.getRepoDocs(SYNC_REPO_ID, SYNC_DB);

      expect(docs.map((d) => d.info.ddoc_id)).toEqual(['_design/reports']);
    });

    // Fix round 1: getFile deliberately throws (not null) for a file too large for the Contents
    // API — correct for the write-safety-critical sync flows, but this read-only listing has no
    // such obligation and must degrade gracefully instead of failing every other document.
    it('drops a single file that fails to read instead of failing the whole list', async () => {
      vi.spyOn(GitHubProvider.prototype, 'listTree').mockResolvedValue([
        { path: 'sales/_design/reports.json', sha: 'sha1' },
        { path: 'sales/_design/huge.json', sha: 'sha2' }
      ]);
      vi.spyOn(GitHubProvider.prototype, 'getFile').mockImplementation(async (_url, _branch, path) => {
        if (path.endsWith('huge.json')) throw new Error('huge.json: too large for the GitHub Contents API');
        return '{}';
      });

      const warnSpy = vi.fn();
      const savedWarnTarget = Logger.logTarget[Level.WARN];
      Logger.logTarget[Level.WARN] = warnSpy;
      try {
        const docs = await service.getRepoDocs(SYNC_REPO_ID, SYNC_DB);
        expect(docs.map((d) => d.info.ddoc_id)).toEqual(['_design/reports']);
        expect(warnSpy).toHaveBeenCalledTimes(1);
        const [, context] = warnSpy.mock.calls[0];
        expect(context).toMatchObject({ path: 'sales/_design/huge.json' });
      } finally {
        Logger.logTarget[Level.WARN] = savedWarnTarget;
      }
    });
  });

  describe('deleteRepoDocs', () => {
    beforeEach(() => {
      stubRepoAndAccount();
    });

    it('deletes every requested path in one commit and drops their sync: state', async () => {
      const commit = vi
        .spyOn(GitHubProvider.prototype, 'commitFiles')
        .mockResolvedValue({ commit_sha: 'del1', file_shas: [] });
      const remove = vi.spyOn(store, 'remove').mockResolvedValue(undefined);
      const removeAll = vi.spyOn(store, 'removeAll').mockResolvedValue(undefined);

      const result = await service.deleteRepoDocs(SYNC_REPO_ID, SYNC_DB, ['reports', 'views']);

      expect(commit).toHaveBeenCalledTimes(1);
      const changes = commit.mock.calls[0][3] as { path: string; content: string | null }[];
      expect(changes).toEqual([
        { path: 'sales/_design/reports.json', content: null },
        { path: 'sales/_design/views.json', content: null }
      ]);
      expect(result).toEqual({
        reports: { deleted: true, commit_sha: 'del1' },
        views: { deleted: true, commit_sha: 'del1' }
      });
      const swept = sweptIds(removeAll, remove);
      expect(swept).toContain('sync:sales~ddoc:reports');
      expect(swept).toContain('sync:sales~ddoc:views');
    });

    it('does nothing for an empty list rather than creating an empty commit', async () => {
      const commit = vi.spyOn(GitHubProvider.prototype, 'commitFiles');
      const result = await service.deleteRepoDocs(SYNC_REPO_ID, SYNC_DB, []);
      expect(commit).not.toHaveBeenCalled();
      expect(result).toEqual({});
    });

    // Issue #6 item 2: detachTarget, deleteRepo and unlinkRepo all sweep conflict: alongside
    // sync:; this one swept only sync:, so deleting the conflicted file from the repository left
    // the conflict record behind — an unresolved conflict against a file that no longer exists,
    // which no later sweep for that (db, ddoc) pair would ever produce again.
    it('drops the conflict: record too — a file that no longer exists cannot still be conflicted', async () => {
      vi.spyOn(GitHubProvider.prototype, 'commitFiles').mockResolvedValue({ commit_sha: 'del1', file_shas: [] });
      const removeAll = vi.spyOn(store, 'removeAll').mockResolvedValue(undefined);
      const remove = vi.spyOn(store, 'remove').mockResolvedValue(undefined);

      await service.deleteRepoDocs(SYNC_REPO_ID, SYNC_DB, ['reports']);

      const swept = sweptIds(removeAll, remove);
      expect(swept).toContain('sync:sales~ddoc:reports');
      expect(swept).toContain('conflict:sales~ddoc:reports');
    });

    it('sweeps the whole set in one bulk delete rather than a round trip per document', async () => {
      vi.spyOn(GitHubProvider.prototype, 'commitFiles').mockResolvedValue({ commit_sha: 'del1', file_shas: [] });
      const removeAll = vi.spyOn(store, 'removeAll').mockResolvedValue(undefined);
      const remove = vi.spyOn(store, 'remove').mockResolvedValue(undefined);

      await service.deleteRepoDocs(SYNC_REPO_ID, SYNC_DB, ['reports', 'views']);

      expect(removeAll).toHaveBeenCalledTimes(1);
      expect(remove).not.toHaveBeenCalled();
    });
  });

  /**
   * Issue #6 item 2, the wider half: deleting a design document from CouchDB (design-list's
   * "delete from CouchDB" mode, which goes straight to `DbMgmtService.deleteDocuments`) left both
   * its sync: and its conflict: document behind — bookkeeping for a document that no longer
   * exists on the CouchDB side. The id shapes belong to this service, not to a component, so the
   * cleanup lives here next to deleteRepoDocs' own sweep.
   */
  describe('forgetSyncState', () => {
    it('drops both the sync: and the conflict: document for each design doc', async () => {
      const removeAll = vi.spyOn(store, 'removeAll').mockResolvedValue(undefined);

      await service.forgetSyncState(SYNC_DB, ['_design/reports', 'views']);

      expect(removeAll).toHaveBeenCalledTimes(1);
      // Accepts CouchDB's own `_design/x` form and a bare name alike, exactly like every other
      // ddoc id this service takes.
      expect(removeAll.mock.calls[0][0]).toEqual([
        'sync:sales~ddoc:reports',
        'conflict:sales~ddoc:reports',
        'sync:sales~ddoc:views',
        'conflict:sales~ddoc:views'
      ]);
    });

    it('makes no request when nothing was deleted', async () => {
      const removeAll = vi.spyOn(store, 'removeAll').mockResolvedValue(undefined);
      await service.forgetSyncState(SYNC_DB, []);
      expect(removeAll).not.toHaveBeenCalled();
    });
  });

  describe('syncToRepo', () => {
    beforeEach(() => {
      stubRepoAndAccount();
      vi.spyOn(store, 'put').mockResolvedValue({ id: 'ok', rev: '1-a' });
      vi.spyOn(GitHubProvider.prototype, 'listTree').mockResolvedValue([]);
      vi.spyOn(GitHubProvider.prototype, 'getFile').mockResolvedValue(null);
    });

    it('syncToRepo commits every selected doc in one commit and records the blob sha', async () => {
      const commit = vi.spyOn(GitHubProvider.prototype, 'commitFiles')
        .mockResolvedValue({ commit_sha: 'c1', file_shas: [
          { path: 'sales/_design/reports.json', blob_sha: 'b1' },
        ] });
      // Repo/account come from the shared beforeEach; no prior git file and no sync: record —
      // this is the document's first-ever sync, from a CouchDB doc that already exists.
      request.mockResolvedValue({ _id: '_design/reports', _rev: '1-a', views: {} });
      const result = await service.syncToRepo('gitrepo:1', 'sales', {
        docs: [`${SINGLE_SERVER_ID}|sales|_design/reports`],
      });
      expect(commit).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ status: 'synced', synced: 1, conflicts: 0 });
      expect(vi.mocked(store.put).mock.calls.some(([id]) => id === 'sync:sales~ddoc:reports')).toBe(true);
    });

    // Nothing anywhere asserted a sync-state document's PAYLOAD — only that a write happened at
    // the right id. A `git_sha: null`, or the pre-push rev, would sail through every existing
    // assertion here and leave a document that classify() reads as diverged forever, on both this
    // table's next render and the next sync's own pre-flight.
    it('records the pushed rev and the COMMITTED blob sha in the sync: document', async () => {
      vi.spyOn(GitHubProvider.prototype, 'commitFiles').mockResolvedValue({
        commit_sha: 'c1',
        file_shas: [{ path: 'sales/_design/reports.json', blob_sha: 'blob-after-commit' }]
      });
      request.mockResolvedValue({ _id: '_design/reports', _rev: '4-d', views: {} });

      await service.syncToRepo('gitrepo:1', 'sales', {
        docs: [`${SINGLE_SERVER_ID}|sales|_design/reports`]
      });

      const write = vi.mocked(store.put).mock.calls.find(([id]) => id === 'sync:sales~ddoc:reports');
      expect(write).toBeDefined();
      const doc = write![1] as Record<string, unknown>;
      expect(doc).toMatchObject({
        doc_type: 'sync_state',
        database: 'sales',
        ddoc_id: '_design/reports',
        git_repo_id: 'gitrepo:1',
        // The sha the commit actually produced — not the pre-commit tree sha, and never null.
        git_sha: 'blob-after-commit',
        ddoc_rev: '4-d'
      });
      expect(doc.last_sync).toEqual(expect.any(String));
      expect(doc.updated_at).toEqual(expect.any(String));
    });

    // The heal path did the work and counted nothing, so Task 8's now user-facing counters turned
    // a reconcile-only sync into "Synced to repo successfully (0 synced)".
    it('counts a reconcile-only sync as reconciled rather than reporting an empty success', async () => {
      vi.spyOn(GitHubProvider.prototype, 'listTree').mockResolvedValue([
        { path: 'sales/_design/reports.json', sha: 'sha1' }
      ]);
      vi.spyOn(GitHubProvider.prototype, 'getFile').mockResolvedValue(JSON.stringify({ views: { a: 1 } }));
      request.mockResolvedValue({ _id: '_design/reports', _rev: '1-a', views: { a: 1 } });

      const result = await service.syncToRepo('gitrepo:1', 'sales', {
        docs: [`${SINGLE_SERVER_ID}|sales|_design/reports`]
      });

      expect(result).toMatchObject({ status: 'synced', synced: 0, reconciled: 1 });
    });

    /**
     * Issue #6 item 10: `readAndClassify`'s `JSON.parse` was unguarded, so one hand-edited file in
     * the repository aborted the whole sync with a raw `SyntaxError` — reaching the user as
     * "Sync failed: Unexpected token h in JSON at position 1", which names neither the file nor
     * anything to do about it. `getRepoDocs` tolerates the same file only because its parse sits
     * inside a `Promise.allSettled`.
     */
    it('names the file, the branch and the problem when a repository file is not valid JSON', async () => {
      vi.spyOn(GitHubProvider.prototype, 'listTree').mockResolvedValue([
        { path: 'sales/_design/reports.json', sha: 'sha1' }
      ]);
      vi.spyOn(GitHubProvider.prototype, 'getFile').mockResolvedValue('{ hand edited, not json }');
      request.mockResolvedValue({ _id: '_design/reports', _rev: '1-a', views: {} });
      const commit = vi.spyOn(GitHubProvider.prototype, 'commitFiles');

      let caught: Error | null = null;
      try {
        await service.syncToRepo('gitrepo:1', 'sales', {
          docs: [`${SINGLE_SERVER_ID}|sales|_design/reports`]
        });
      } catch (err) {
        caught = err as Error;
      }

      expect(caught).not.toBeNull();
      expect(caught!.message).toContain('sales/_design/reports.json');
      expect(caught!.message).toMatch(/not valid json/i);
      expect(caught!.message).toContain('main'); // the branch it was read from
      // Nothing may be committed off a file this sync could not read.
      expect(commit).not.toHaveBeenCalled();
    });

    it('syncToRepo reports the conflict instead of overwriting the file', async () => {
      // couch rev and git sha both moved past the recorded sync state, content differs
      stubRepoAndAccount({
        'sync:sales~ddoc:reports': {
          database: 'sales', ddoc_id: '_design/reports', git_repo_id: 'gitrepo:1',
          ddoc_rev: '2-b', git_sha: 'sha-old'
        }
      });
      vi.spyOn(GitHubProvider.prototype, 'listTree').mockResolvedValue([
        { path: 'sales/_design/reports.json', sha: 'sha-new' }
      ]);
      vi.spyOn(GitHubProvider.prototype, 'getFile').mockResolvedValue(
        JSON.stringify({ views: { a: { map: 'from-git' } } })
      );
      request.mockResolvedValue({ _id: '_design/reports', _rev: '3-c', views: { a: { map: 'from-couch' } } });
      const commit = vi.spyOn(GitHubProvider.prototype, 'commitFiles');
      const result = await service.syncToRepo('gitrepo:1', 'sales', {
        docs: [`${SINGLE_SERVER_ID}|sales|_design/reports`],
      });
      expect(commit).not.toHaveBeenCalled();
      expect(result).toMatchObject({ status: 'conflict', synced: 0, conflicts: 1 });
    });

    it('syncToRepo writes a conflict document that listConflicts then returns', async () => {
      // …as above…
      stubRepoAndAccount({
        'sync:sales~ddoc:reports': {
          database: 'sales', ddoc_id: '_design/reports', git_repo_id: 'gitrepo:1',
          ddoc_rev: '2-b', git_sha: 'sha-old'
        }
      });
      vi.spyOn(GitHubProvider.prototype, 'listTree').mockResolvedValue([
        { path: 'sales/_design/reports.json', sha: 'sha-new' }
      ]);
      vi.spyOn(GitHubProvider.prototype, 'getFile').mockResolvedValue(
        JSON.stringify({ views: { a: { map: 'from-git' } } })
      );
      request.mockResolvedValue({ _id: '_design/reports', _rev: '3-c', views: { a: { map: 'from-couch' } } });
      await service.syncToRepo('gitrepo:1', 'sales', {
        docs: [`${SINGLE_SERVER_ID}|sales|_design/reports`],
      });
      const written = vi.mocked(store.put).mock.calls.map(([id]) => id);
      expect(written).toContain('conflict:sales~ddoc:reports');
    });

    // Carried from Task 6 review: writeConflict's own store.put failure used to propagate and
    // replace the conflict outcome with a bookkeeping error — the user would see
    // "couchcompanion unreachable" instead of the real answer, "this document has a conflict."
    it('still reports the conflict even when persisting the conflict record itself fails', async () => {
      stubRepoAndAccount({
        'sync:sales~ddoc:reports': {
          database: 'sales', ddoc_id: '_design/reports', git_repo_id: 'gitrepo:1',
          ddoc_rev: '2-b', git_sha: 'sha-old'
        }
      });
      vi.spyOn(GitHubProvider.prototype, 'listTree').mockResolvedValue([
        { path: 'sales/_design/reports.json', sha: 'sha-new' }
      ]);
      vi.spyOn(GitHubProvider.prototype, 'getFile').mockResolvedValue(
        JSON.stringify({ views: { a: { map: 'from-git' } } })
      );
      request.mockResolvedValue({ _id: '_design/reports', _rev: '3-c', views: { a: { map: 'from-couch' } } });
      vi.spyOn(store, 'put').mockRejectedValue(new Error('couchcompanion unreachable'));

      const result = await service.syncToRepo('gitrepo:1', 'sales', {
        docs: [`${SINGLE_SERVER_ID}|sales|_design/reports`],
      });
      expect(result).toMatchObject({ status: 'conflict', synced: 0, conflicts: 1 });
    });

    it('syncToRepo skips a document whose content already matches the file', async () => {
      stubRepoAndAccount({
        'sync:sales~ddoc:reports': {
          database: 'sales', ddoc_id: '_design/reports', git_repo_id: 'gitrepo:1',
          ddoc_rev: '1-a', git_sha: 'sha1'
        }
      });
      vi.spyOn(GitHubProvider.prototype, 'listTree').mockResolvedValue([
        { path: 'sales/_design/reports.json', sha: 'sha1' }
      ]);
      vi.spyOn(GitHubProvider.prototype, 'getFile').mockResolvedValue(JSON.stringify({ views: { a: 1 } }));
      request.mockResolvedValue({ _id: '_design/reports', _rev: '1-a', views: { a: 1 } });
      const commit = vi.spyOn(GitHubProvider.prototype, 'commitFiles');
      const result = await service.syncToRepo('gitrepo:1', 'sales', {
        docs: [`${SINGLE_SERVER_ID}|sales|_design/reports`],
      });
      expect(commit).not.toHaveBeenCalled();
      expect(result).toMatchObject({ status: 'synced', synced: 0 });
    });

    it('syncToRepo rejects a doc key that names a different database', async () => {
      await expect(service.syncToRepo('gitrepo:1', 'sales', {
        docs: [`${SINGLE_SERVER_ID}|hr|_design/reports`],
      })).rejects.toThrow(/sales/);
    });

    it('throws when the repository is not registered', async () => {
      vi.spyOn(store, 'get').mockResolvedValue(null);
      await expect(
        service.syncToRepo('missing', 'sales', { docs: [`${SINGLE_SERVER_ID}|sales|_design/reports`] })
      ).rejects.toThrow(ApiError);
    });

    // Task 6 decision 3: GitHub answers a moved-underneath-us branch with a 422 whose message is
    // terse REST prose. A user needs to know what to do about it, not the raw wording.
    it('surfaces a moved branch as an actionable error instead of the raw GitHub message', async () => {
      request.mockResolvedValue({ _id: '_design/reports', _rev: '1-a', views: {} });
      vi.spyOn(GitHubProvider.prototype, 'commitFiles').mockRejectedValue(
        new GitHttpError(422, 'Update is not a fast forward')
      );
      await expect(
        service.syncToRepo('gitrepo:1', 'sales', { docs: [`${SINGLE_SERVER_ID}|sales|_design/reports`] })
      ).rejects.toThrow(/branch "main"/i);
    });

    // CRITICAL, fix round 1: classify() correctly says newer_in_git here (only the file moved),
    // but the pre-fix code applied ANY non-conflict status, which included this one — pushing the
    // stale, unchanged CouchDB copy and silently reverting whatever changed the file.
    it("refuses to push a document that only moved in git — pushing would revert a colleague's edit", async () => {
      stubRepoAndAccount({
        'sync:sales~ddoc:reports': {
          database: 'sales', ddoc_id: '_design/reports', git_repo_id: 'gitrepo:1',
          ddoc_rev: '2-b', git_sha: 'sha-old'
        }
      });
      vi.spyOn(GitHubProvider.prototype, 'listTree').mockResolvedValue([
        { path: 'sales/_design/reports.json', sha: 'sha-new' }
      ]);
      vi.spyOn(GitHubProvider.prototype, 'getFile').mockResolvedValue(
        JSON.stringify({ views: { a: { map: 'colleagues-edit' } } })
      );
      // CouchDB is untouched since the last sync — only the file moved.
      request.mockResolvedValue({ _id: '_design/reports', _rev: '2-b', views: { a: { map: 'old' } } });
      const commit = vi.spyOn(GitHubProvider.prototype, 'commitFiles');

      const result = await service.syncToRepo('gitrepo:1', 'sales', {
        docs: [`${SINGLE_SERVER_ID}|sales|_design/reports`]
      });

      expect(commit).not.toHaveBeenCalled();
      expect(result).toMatchObject({ status: 'synced', synced: 0, conflicts: 0 });
      // Skipped, not healed — CouchDB is genuinely behind git for this doc; claiming it's in
      // sync would be as wrong as overwriting it.
      expect(vi.mocked(store.put).mock.calls.some(([id]) => id === 'sync:sales~ddoc:reports')).toBe(false);
    });

    // Every sync: sweep (unlinkRepo, deleteRepo, a repo re-point) manufactures exactly this state
    // for documents that may have been genuinely conflicting a moment earlier — classify() alone
    // says 'unknown' here, which the OLD code (Task 6 decision 4) treated as blindly safe.
    it('treats a no-sync-record disagreement as a conflict rather than guessing a winner', async () => {
      vi.spyOn(GitHubProvider.prototype, 'listTree').mockResolvedValue([
        { path: 'sales/_design/reports.json', sha: 'sha1' }
      ]);
      vi.spyOn(GitHubProvider.prototype, 'getFile').mockResolvedValue(
        JSON.stringify({ views: { a: { map: 'from-git' } } })
      );
      request.mockResolvedValue({ _id: '_design/reports', _rev: '1-a', views: { a: { map: 'from-couch' } } });
      const commit = vi.spyOn(GitHubProvider.prototype, 'commitFiles');

      const result = await service.syncToRepo('gitrepo:1', 'sales', {
        docs: [`${SINGLE_SERVER_ID}|sales|_design/reports`]
      });

      expect(commit).not.toHaveBeenCalled();
      expect(result).toMatchObject({ status: 'conflict', synced: 0, conflicts: 1 });
    });

    it('treats a no-sync-record agreement as already synced, recording state without a commit', async () => {
      vi.spyOn(GitHubProvider.prototype, 'listTree').mockResolvedValue([
        { path: 'sales/_design/reports.json', sha: 'sha1' }
      ]);
      vi.spyOn(GitHubProvider.prototype, 'getFile').mockResolvedValue(JSON.stringify({ views: { a: 1 } }));
      request.mockResolvedValue({ _id: '_design/reports', _rev: '1-a', views: { a: 1 } });
      const commit = vi.spyOn(GitHubProvider.prototype, 'commitFiles');

      const result = await service.syncToRepo('gitrepo:1', 'sales', {
        docs: [`${SINGLE_SERVER_ID}|sales|_design/reports`]
      });

      expect(commit).not.toHaveBeenCalled();
      expect(result).toMatchObject({ status: 'synced', synced: 0, conflicts: 0 });
      expect(vi.mocked(store.put).mock.calls.some(([id]) => id === 'sync:sales~ddoc:reports')).toBe(true);
    });

    it('collapses a duplicated doc key into a single push rather than double-counting it', async () => {
      const commit = vi.spyOn(GitHubProvider.prototype, 'commitFiles').mockResolvedValue({
        commit_sha: 'c1',
        file_shas: [{ path: 'sales/_design/reports.json', blob_sha: 'b1' }]
      });
      request.mockResolvedValue({ _id: '_design/reports', _rev: '1-a', views: {} });

      const result = await service.syncToRepo('gitrepo:1', 'sales', {
        docs: [`${SINGLE_SERVER_ID}|sales|_design/reports`, `${SINGLE_SERVER_ID}|sales|_design/reports`]
      });

      expect(commit).toHaveBeenCalledTimes(1);
      expect((commit.mock.calls[0][3] as unknown[]).length).toBe(1);
      expect(result).toMatchObject({ synced: 1 });
    });

    it('stamps a written conflict with the owning repository id', async () => {
      stubRepoAndAccount({
        'sync:sales~ddoc:reports': {
          database: 'sales', ddoc_id: '_design/reports', git_repo_id: 'gitrepo:1',
          ddoc_rev: '2-b', git_sha: 'sha-old'
        }
      });
      vi.spyOn(GitHubProvider.prototype, 'listTree').mockResolvedValue([
        { path: 'sales/_design/reports.json', sha: 'sha-new' }
      ]);
      vi.spyOn(GitHubProvider.prototype, 'getFile').mockResolvedValue(
        JSON.stringify({ views: { a: { map: 'from-git' } } })
      );
      request.mockResolvedValue({ _id: '_design/reports', _rev: '3-c', views: { a: { map: 'from-couch' } } });

      await service.syncToRepo('gitrepo:1', 'sales', {
        docs: [`${SINGLE_SERVER_ID}|sales|_design/reports`]
      });

      const conflictWrite = vi.mocked(store.put).mock.calls.find(([id]) => id === 'conflict:sales~ddoc:reports');
      expect(conflictWrite?.[1]).toMatchObject({ git_repo_id: 'gitrepo:1' });
    });

    it('preserves resolved and detected_at when the same conflict is re-detected', async () => {
      const existingConflict = {
        _id: 'conflict:sales~ddoc:reports',
        _rev: '1-a',
        server_id: SINGLE_SERVER_ID,
        db_name: 'sales',
        ddoc_id: '_design/reports',
        git_repo_id: 'gitrepo:1',
        couch_rev: '3-c',
        git_sha: 'sha-new',
        conflict_branch: 'main',
        resolved: true,
        detected_at: '2026-08-01T00:00:00Z'
      };
      stubRepoAndAccount({
        'sync:sales~ddoc:reports': {
          database: 'sales', ddoc_id: '_design/reports', git_repo_id: 'gitrepo:1',
          ddoc_rev: '2-b', git_sha: 'sha-old'
        },
        'conflict:sales~ddoc:reports': existingConflict
      });
      vi.spyOn(GitHubProvider.prototype, 'listTree').mockResolvedValue([
        { path: 'sales/_design/reports.json', sha: 'sha-new' }
      ]);
      vi.spyOn(GitHubProvider.prototype, 'getFile').mockResolvedValue(
        JSON.stringify({ views: { a: { map: 'from-git' } } })
      );
      request.mockResolvedValue({ _id: '_design/reports', _rev: '3-c', views: { a: { map: 'from-couch' } } });

      await service.syncToRepo('gitrepo:1', 'sales', {
        docs: [`${SINGLE_SERVER_ID}|sales|_design/reports`]
      });

      const conflictWrite = vi.mocked(store.put).mock.calls.find(([id]) => id === 'conflict:sales~ddoc:reports');
      expect(conflictWrite?.[1]).toMatchObject({ resolved: true, detected_at: '2026-08-01T00:00:00Z' });
    });

    it('resets resolved and refreshes detected_at when the conflicting pair actually changes', async () => {
      const existingConflict = {
        _id: 'conflict:sales~ddoc:reports',
        server_id: SINGLE_SERVER_ID,
        db_name: 'sales',
        ddoc_id: '_design/reports',
        git_repo_id: 'gitrepo:1',
        couch_rev: '3-c', // stale — the live document below has already moved on to 4-d
        git_sha: 'sha-new',
        conflict_branch: 'main',
        resolved: true,
        detected_at: '2026-08-01T00:00:00Z'
      };
      stubRepoAndAccount({
        'sync:sales~ddoc:reports': {
          database: 'sales', ddoc_id: '_design/reports', git_repo_id: 'gitrepo:1',
          ddoc_rev: '2-b', git_sha: 'sha-old'
        },
        'conflict:sales~ddoc:reports': existingConflict
      });
      vi.spyOn(GitHubProvider.prototype, 'listTree').mockResolvedValue([
        { path: 'sales/_design/reports.json', sha: 'sha-newer' }
      ]);
      vi.spyOn(GitHubProvider.prototype, 'getFile').mockResolvedValue(
        JSON.stringify({ views: { a: { map: 'from-git-again' } } })
      );
      request.mockResolvedValue({ _id: '_design/reports', _rev: '4-d', views: { a: { map: 'from-couch-again' } } });

      await service.syncToRepo('gitrepo:1', 'sales', {
        docs: [`${SINGLE_SERVER_ID}|sales|_design/reports`]
      });

      const conflictWrite = vi.mocked(store.put).mock.calls.find(([id]) => id === 'conflict:sales~ddoc:reports');
      expect(conflictWrite?.[1]).toMatchObject({ resolved: false, couch_rev: '4-d', git_sha: 'sha-newer' });
      expect((conflictWrite?.[1] as { detected_at: string }).detected_at).not.toBe('2026-08-01T00:00:00Z');
    });

    // NEW-1, fix round 2: a document absent from BOTH sides (a stale selection racing a delete on
    // both sides between the list rendering and the sync click) must never fabricate a conflict —
    // classify() alone would fall through to 'unknown', and folding that through a trivially-false
    // contentEqual (there is no content anywhere to compare) manufactured a permanent phantom
    // conflict document before this fix.
    it('skips a document that exists on neither side rather than fabricating a conflict', async () => {
      vi.spyOn(GitHubProvider.prototype, 'listTree').mockResolvedValue([]); // no file in git
      vi.spyOn(GitHubProvider.prototype, 'getFile').mockResolvedValue(null);
      request.mockRejectedValue(new ApiError(404, 'missing')); // no document in couch either
      const commit = vi.spyOn(GitHubProvider.prototype, 'commitFiles');

      const result = await service.syncToRepo('gitrepo:1', 'sales', {
        docs: [`${SINGLE_SERVER_ID}|sales|_design/gone`]
      });

      expect(commit).not.toHaveBeenCalled();
      expect(result).toMatchObject({ status: 'synced', synced: 0, conflicts: 0, skipped: 1 });
      expect(vi.mocked(store.put).mock.calls.some(([id]) => id === 'conflict:sales~ddoc:gone')).toBe(false);
    });

    // The same absent-everywhere case survives even with a STALE sync: record left over from
    // before the document was deleted from both sides — classify()'s own "both moved, content
    // differs" branch would otherwise reach the same false-conflict outcome.
    it('skips an absent-everywhere document even when a stale sync: record still names it', async () => {
      stubRepoAndAccount({
        'sync:sales~ddoc:gone': {
          database: 'sales', ddoc_id: '_design/gone', git_repo_id: 'gitrepo:1',
          ddoc_rev: '2-b', git_sha: 'sha-old'
        }
      });
      vi.spyOn(GitHubProvider.prototype, 'listTree').mockResolvedValue([]);
      vi.spyOn(GitHubProvider.prototype, 'getFile').mockResolvedValue(null);
      request.mockRejectedValue(new ApiError(404, 'missing'));
      const commit = vi.spyOn(GitHubProvider.prototype, 'commitFiles');

      const result = await service.syncToRepo('gitrepo:1', 'sales', {
        docs: [`${SINGLE_SERVER_ID}|sales|_design/gone`]
      });

      expect(commit).not.toHaveBeenCalled();
      expect(result).toMatchObject({ status: 'synced', conflicts: 0 });
      expect(vi.mocked(store.put).mock.calls.some(([id]) => id === 'conflict:sales~ddoc:gone')).toBe(false);
    });

    // NEW-3, fix round 2: a refused (wrong-direction) document produced no counter at all, so
    // {status:'synced', synced:0, conflicts:0} was indistinguishable from "nothing to do."
    it('counts a direction-refused document in skipped rather than leaving it invisible', async () => {
      stubRepoAndAccount({
        'sync:sales~ddoc:reports': {
          database: 'sales', ddoc_id: '_design/reports', git_repo_id: 'gitrepo:1',
          ddoc_rev: '2-b', git_sha: 'sha-old'
        }
      });
      vi.spyOn(GitHubProvider.prototype, 'listTree').mockResolvedValue([
        { path: 'sales/_design/reports.json', sha: 'sha-new' }
      ]);
      vi.spyOn(GitHubProvider.prototype, 'getFile').mockResolvedValue(
        JSON.stringify({ views: { a: { map: 'colleagues-edit' } } })
      );
      request.mockResolvedValue({ _id: '_design/reports', _rev: '2-b', views: { a: { map: 'old' } } });

      const result = await service.syncToRepo('gitrepo:1', 'sales', {
        docs: [`${SINGLE_SERVER_ID}|sales|_design/reports`]
      });

      expect(result).toMatchObject({ status: 'synced', synced: 0, conflicts: 0, skipped: 1 });
    });
  });

  describe('syncToCouch', () => {
    beforeEach(() => {
      stubRepoAndAccount();
      vi.spyOn(store, 'put').mockResolvedValue({ id: 'ok', rev: '1-a' });
      vi.spyOn(GitHubProvider.prototype, 'listTree').mockResolvedValue([]);
      vi.spyOn(GitHubProvider.prototype, 'getFile').mockResolvedValue(null);
    });

    it('syncToCouch injects the live _rev so the PUT updates rather than 409s', async () => {
      // The live doc is at 7-g, unmoved since the last sync (couch side untouched); only the
      // file moved (sha-old -> shaX) — a clean newer_in_git, not a guess.
      stubRepoAndAccount({
        'sync:sales~ddoc:reports': {
          database: 'sales', ddoc_id: '_design/reports', git_repo_id: 'gitrepo:1',
          ddoc_rev: '7-g', git_sha: 'sha-old'
        }
      });
      vi.spyOn(GitHubProvider.prototype, 'listTree').mockResolvedValue([
        { path: 'sales/_design/reports.json', sha: 'shaX' }
      ]);
      vi.spyOn(GitHubProvider.prototype, 'getFile').mockResolvedValue(JSON.stringify({ views: { a: 1 } }));
      request.mockImplementation(async (method: string) => {
        if (method === 'GET') return { _id: '_design/reports', _rev: '7-g', views: { a: 0 } };
        return { ok: true, id: '_design/reports', rev: '8-h' };
      });
      await service.syncToCouch('gitrepo:1', 'sales', {
        docs: [`${SINGLE_SERVER_ID}|sales|_design/reports`],
      });
      const put = request.mock.calls.find(([m]) => m === 'PUT');
      expect((put?.[2] as { _rev: string })._rev).toBe('7-g');
    });

    // The mirror of syncToRepo's payload test, and the sharper of the two: the rev recorded here
    // must be the one CouchDB MINTED for the write (8-h), never the pre-PUT rev the document had
    // (7-g). Recording 7-g would leave a sync: document that disagrees with the live doc from the
    // moment it is written, which classify() reads as "CouchDB moved" forever after.
    it('records the POST-PUT rev and the applied git sha in the sync: document', async () => {
      stubRepoAndAccount({
        'sync:sales~ddoc:reports': {
          database: 'sales', ddoc_id: '_design/reports', git_repo_id: 'gitrepo:1',
          ddoc_rev: '7-g', git_sha: 'sha-old'
        }
      });
      vi.spyOn(GitHubProvider.prototype, 'listTree').mockResolvedValue([
        { path: 'sales/_design/reports.json', sha: 'shaX' }
      ]);
      vi.spyOn(GitHubProvider.prototype, 'getFile').mockResolvedValue(JSON.stringify({ views: { a: 1 } }));
      request.mockImplementation(async (method: string) => {
        if (method === 'GET') return { _id: '_design/reports', _rev: '7-g', views: { a: 0 } };
        return { ok: true, id: '_design/reports', rev: '8-h' };
      });

      await service.syncToCouch('gitrepo:1', 'sales', {
        docs: [`${SINGLE_SERVER_ID}|sales|_design/reports`]
      });

      const write = vi.mocked(store.put).mock.calls.find(([id]) => id === 'sync:sales~ddoc:reports');
      expect(write).toBeDefined();
      const doc = write![1] as Record<string, unknown>;
      expect(doc).toMatchObject({
        doc_type: 'sync_state',
        database: 'sales',
        ddoc_id: '_design/reports',
        git_repo_id: 'gitrepo:1',
        git_sha: 'shaX',
        ddoc_rev: '8-h'
      });
      expect(doc.ddoc_rev).not.toBe('7-g');
      expect(doc.last_sync).toEqual(expect.any(String));
    });

    it('syncToCouch creates a design doc that does not exist yet, with no _rev', async () => {
      vi.spyOn(GitHubProvider.prototype, 'listTree').mockResolvedValue([
        { path: 'sales/_design/fresh.json', sha: 'shaFresh' }
      ]);
      vi.spyOn(GitHubProvider.prototype, 'getFile').mockResolvedValue(JSON.stringify({ views: {} }));
      request.mockImplementation(async (method: string) => {
        if (method === 'GET') throw new ApiError(404, 'missing');
        return { ok: true, id: '_design/fresh', rev: '1-a' };
      });
      await service.syncToCouch('gitrepo:1', 'sales', {
        docs: [`${SINGLE_SERVER_ID}|sales|_design/fresh`],
      });
      const put = request.mock.calls.find(([m]) => m === 'PUT');
      expect(put?.[2]).not.toHaveProperty('_rev');
    });

    /**
     * The heal branch (#7): repo and CouchDB already hold identical content, so there is
     * nothing to write — but the sync state must still be recorded, or the pair stays
     * classified as diverged forever and every later sync re-does this work.
     *
     * Previously untested in the "to CouchDB" direction. A regression that made this branch
     * PUT anyway would bump `_rev` on every sync of an unchanged doc, and a regression that
     * made it skip `saveSyncState` would leave permanent phantom divergence — neither
     * observable from the existing tests.
     */
    it('syncToCouch heals bookkeeping for identical content without writing the doc', async () => {
      const identical = { views: { a: 1 } };
      stubRepoAndAccount({
        'sync:sales~ddoc:reports': {
          database: 'sales', ddoc_id: '_design/reports', git_repo_id: 'gitrepo:1',
          ddoc_rev: '3-c', git_sha: 'sha-stale'
        }
      });
      vi.spyOn(GitHubProvider.prototype, 'listTree').mockResolvedValue([
        { path: 'sales/_design/reports.json', sha: 'sha-new' }
      ]);
      vi.spyOn(GitHubProvider.prototype, 'getFile').mockResolvedValue(JSON.stringify(identical));
      request.mockImplementation(async (method: string) => {
        if (method === 'GET') return { _id: '_design/reports', _rev: '9-i', ...identical };
        throw new Error('syncToCouch must not write when the content already matches');
      });

      await service.syncToCouch('gitrepo:1', 'sales', {
        docs: [`${SINGLE_SERVER_ID}|sales|_design/reports`]
      });

      expect(request.mock.calls.filter(([m]) => m === 'PUT')).toHaveLength(0);

      const write = vi.mocked(store.put).mock.calls.find(([id]) => id === 'sync:sales~ddoc:reports');
      expect(write).toBeDefined();
      expect(write![1]).toMatchObject({
        doc_type: 'sync_state',
        // The live rev and the current git sha, not the stale pair we started from — that is
        // what makes the next classification come out "in sync".
        ddoc_rev: '9-i',
        git_sha: 'sha-new'
      });
    });

    /**
     * The refusal branch (#7). `syncToCouch`'s signature is frozen at `Promise<void>` (D6), so
     * a refusal leaves no counter — only the absence of a write proves it happened.
     */
    it('syncToCouch refuses to pull when only the CouchDB side has moved', async () => {
      stubRepoAndAccount({
        'sync:sales~ddoc:reports': {
          database: 'sales', ddoc_id: '_design/reports', git_repo_id: 'gitrepo:1',
          ddoc_rev: '4-d', git_sha: 'sha-same'
        }
      });
      vi.spyOn(GitHubProvider.prototype, 'listTree').mockResolvedValue([
        { path: 'sales/_design/reports.json', sha: 'sha-same' }   // git unmoved
      ]);
      vi.spyOn(GitHubProvider.prototype, 'getFile').mockResolvedValue(
        JSON.stringify({ views: { a: 1 } })
      );
      request.mockImplementation(async (method: string) => {
        // CouchDB has moved on to 5-e with different content.
        if (method === 'GET') return { _id: '_design/reports', _rev: '5-e', views: { a: 2 } };
        throw new Error('syncToCouch must not clobber a doc only CouchDB has changed');
      });

      await service.syncToCouch('gitrepo:1', 'sales', {
        docs: [`${SINGLE_SERVER_ID}|sales|_design/reports`]
      });

      expect(request.mock.calls.filter(([m]) => m === 'PUT')).toHaveLength(0);
      // And it must not quietly "heal" the bookkeeping either — that would erase the evidence
      // that CouchDB is ahead and make the next run think the pair is in sync.
      const write = vi.mocked(store.put).mock.calls.find(([id]) => id === 'sync:sales~ddoc:reports');
      expect(write).toBeUndefined();
    });

    it('syncToCouch refuses a conflicted doc rather than clobbering local edits', async () => {
      stubRepoAndAccount({
        'sync:sales~ddoc:reports': {
          database: 'sales', ddoc_id: '_design/reports', git_repo_id: 'gitrepo:1',
          ddoc_rev: '2-b', git_sha: 'sha-old'
        }
      });
      vi.spyOn(GitHubProvider.prototype, 'listTree').mockResolvedValue([
        { path: 'sales/_design/reports.json', sha: 'sha-new' }
      ]);
      vi.spyOn(GitHubProvider.prototype, 'getFile').mockResolvedValue(
        JSON.stringify({ views: { a: { map: 'from-git' } } })
      );
      request.mockResolvedValue({ _id: '_design/reports', _rev: '3-c', views: { a: { map: 'from-couch' } } });
      await expect(service.syncToCouch('gitrepo:1', 'sales', {
        docs: [`${SINGLE_SERVER_ID}|sales|_design/reports`],
      })).rejects.toThrow(/conflict/i);
      expect(request.mock.calls.filter(([m]) => m === 'PUT')).toHaveLength(0);
    });

    // Carried from Task 6 review: without writeConflict's own try/catch, a store.put failure here
    // used to replace this method's own "resolve it first" message with the bookkeeping failure —
    // "couchcompanion unreachable" instead of the actual, actionable reason the sync stopped.
    it('still rejects with the conflict message, not a bookkeeping error, when the conflict record cannot be saved', async () => {
      stubRepoAndAccount({
        'sync:sales~ddoc:reports': {
          database: 'sales', ddoc_id: '_design/reports', git_repo_id: 'gitrepo:1',
          ddoc_rev: '2-b', git_sha: 'sha-old'
        }
      });
      vi.spyOn(GitHubProvider.prototype, 'listTree').mockResolvedValue([
        { path: 'sales/_design/reports.json', sha: 'sha-new' }
      ]);
      vi.spyOn(GitHubProvider.prototype, 'getFile').mockResolvedValue(
        JSON.stringify({ views: { a: { map: 'from-git' } } })
      );
      request.mockResolvedValue({ _id: '_design/reports', _rev: '3-c', views: { a: { map: 'from-couch' } } });
      vi.spyOn(store, 'put').mockRejectedValue(new Error('couchcompanion unreachable'));

      await expect(service.syncToCouch('gitrepo:1', 'sales', {
        docs: [`${SINGLE_SERVER_ID}|sales|_design/reports`],
      })).rejects.toThrow(/conflict.*resolve it first/i);
    });

    // Fix round 2: syncToCouch used to throw on a conflict WITHOUT writing the conflict: record,
    // so its own "Resolve it first" message could point at a conflicts list containing no such
    // entry unless a syncToRepo happened to run first and recorded it.
    it('writes a conflict record before rejecting, so listConflicts can surface it', async () => {
      stubRepoAndAccount({
        'sync:sales~ddoc:reports': {
          database: 'sales', ddoc_id: '_design/reports', git_repo_id: 'gitrepo:1',
          ddoc_rev: '2-b', git_sha: 'sha-old'
        }
      });
      vi.spyOn(GitHubProvider.prototype, 'listTree').mockResolvedValue([
        { path: 'sales/_design/reports.json', sha: 'sha-new' }
      ]);
      vi.spyOn(GitHubProvider.prototype, 'getFile').mockResolvedValue(
        JSON.stringify({ views: { a: { map: 'from-git' } } })
      );
      request.mockResolvedValue({ _id: '_design/reports', _rev: '3-c', views: { a: { map: 'from-couch' } } });

      await expect(service.syncToCouch('gitrepo:1', 'sales', {
        docs: [`${SINGLE_SERVER_ID}|sales|_design/reports`],
      })).rejects.toThrow(/conflict/i);

      const conflictWrite = vi.mocked(store.put).mock.calls.find(([id]) => id === 'conflict:sales~ddoc:reports');
      expect(conflictWrite?.[1]).toMatchObject({ git_repo_id: 'gitrepo:1', resolved: false });
    });

    // The asymmetric half of Task 6's conflict rule: syncToRepo excludes a conflicted doc from
    // its commit and keeps going; syncToCouch rejects the whole call before any PUT, so a caller
    // can never be left unsure which of a batch's local edits survived.
    it('rejects the whole batch before writing anything when any requested doc conflicts', async () => {
      stubRepoAndAccount({
        'sync:sales~ddoc:reports': {
          database: 'sales', ddoc_id: '_design/reports', git_repo_id: 'gitrepo:1',
          ddoc_rev: '2-b', git_sha: 'sha-old'
        }
      });
      vi.spyOn(GitHubProvider.prototype, 'listTree').mockResolvedValue([
        { path: 'sales/_design/reports.json', sha: 'sha-new' },
        { path: 'sales/_design/views.json', sha: 'shaV' }
      ]);
      vi.spyOn(GitHubProvider.prototype, 'getFile').mockImplementation(async (_url, _branch, path) =>
        path.endsWith('reports.json')
          ? JSON.stringify({ views: { a: { map: 'from-git' } } })
          : JSON.stringify({ views: {} })
      );
      request.mockImplementation(async (method: string, path: string) => {
        if (method === 'GET' && path.endsWith('_design/reports')) {
          return { _id: '_design/reports', _rev: '3-c', views: { a: { map: 'from-couch' } } };
        }
        if (method === 'GET') throw new ApiError(404, 'missing');
        return { ok: true, id: 'x', rev: '1-a' };
      });
      await expect(service.syncToCouch('gitrepo:1', 'sales', {
        docs: [`${SINGLE_SERVER_ID}|sales|_design/views`, `${SINGLE_SERVER_ID}|sales|_design/reports`],
      })).rejects.toThrow(/conflict/i);
      expect(request.mock.calls.filter(([m]) => m === 'PUT')).toHaveLength(0);
    });

    /**
     * Issue #6 item 5. The `throw` sat *inside* the per-doc loop, so documents 2..N of a
     * conflicted batch were never classified and never recorded: the conflicts list came back
     * missing every conflict but the first, and the user only learned about the next one after
     * resolving that one and re-running — once per conflict. Collecting them and throwing after
     * the loop keeps the all-or-nothing write guarantee (nothing is PUT before the loop finishes
     * either way) and lets the message name every document that has to be resolved.
     */
    it('records every conflict in the batch, not just the first', async () => {
      stubRepoAndAccount({
        'sync:sales~ddoc:reports': {
          database: 'sales', ddoc_id: '_design/reports', git_repo_id: 'gitrepo:1',
          ddoc_rev: '2-b', git_sha: 'sha-old'
        },
        'sync:sales~ddoc:views': {
          database: 'sales', ddoc_id: '_design/views', git_repo_id: 'gitrepo:1',
          ddoc_rev: '2-b', git_sha: 'shaV-old'
        }
      });
      vi.spyOn(GitHubProvider.prototype, 'listTree').mockResolvedValue([
        { path: 'sales/_design/reports.json', sha: 'sha-new' },
        { path: 'sales/_design/views.json', sha: 'shaV-new' }
      ]);
      vi.spyOn(GitHubProvider.prototype, 'getFile').mockImplementation(async (_url, _branch, path) =>
        JSON.stringify({ views: { a: { map: `from-git:${path}` } } })
      );
      request.mockImplementation(async (method: string, path: string) => {
        if (method === 'GET') {
          return { _id: path, _rev: '3-c', views: { a: { map: `from-couch:${path}` } } };
        }
        throw new Error('syncToCouch must not write anything for a conflicted batch');
      });

      let caught: Error | null = null;
      try {
        await service.syncToCouch('gitrepo:1', 'sales', {
          docs: [`${SINGLE_SERVER_ID}|sales|_design/reports`, `${SINGLE_SERVER_ID}|sales|_design/views`]
        });
      } catch (err) {
        caught = err as Error;
      }

      expect(caught).not.toBeNull();
      // Both conflicts on file, so the conflicts screen is complete after one run...
      const written = vi.mocked(store.put).mock.calls.map(([id]) => id);
      expect(written).toContain('conflict:sales~ddoc:reports');
      expect(written).toContain('conflict:sales~ddoc:views');
      // ...and the error names both, not just whichever came first.
      expect(caught!.message).toContain('_design/reports');
      expect(caught!.message).toContain('_design/views');
      expect(request.mock.calls.filter(([m]) => m === 'PUT')).toHaveLength(0);
    });

    // Issue #6 item 10, the write-side half: an unparseable repository file cannot be classified,
    // so this batch must stop before any of it reaches CouchDB — not skip the bad file and apply
    // the rest, which would leave the user with a partly-applied sync they never asked for.
    it('aborts the batch before writing anything when a repository file is not valid JSON', async () => {
      vi.spyOn(GitHubProvider.prototype, 'listTree').mockResolvedValue([
        { path: 'sales/_design/broken.json', sha: 'shaB' },
        { path: 'sales/_design/fine.json', sha: 'shaF' }
      ]);
      vi.spyOn(GitHubProvider.prototype, 'getFile').mockImplementation(async (_url, _branch, path) =>
        path.endsWith('broken.json') ? '{ hand edited, not json }' : JSON.stringify({ views: {} })
      );
      request.mockImplementation(async (method: string) => {
        if (method === 'GET') throw new ApiError(404, 'missing');
        return { ok: true, id: 'x', rev: '1-a' };
      });

      await expect(
        service.syncToCouch('gitrepo:1', 'sales', {
          docs: [`${SINGLE_SERVER_ID}|sales|_design/broken`, `${SINGLE_SERVER_ID}|sales|_design/fine`]
        })
      ).rejects.toThrow(/sales\/_design\/broken\.json/);

      expect(request.mock.calls.filter(([m]) => m === 'PUT')).toHaveLength(0);
    });

    // CRITICAL, fix round 1: the mirror image of syncToRepo's newer_in_git refusal above.
    // classify() says newer_in_couch here (only the live document moved — a view-editor edit);
    // the pre-fix code pulled the stale file anyway, silently destroying that edit.
    it("refuses to pull a document that only moved in couch — pulling would revert a live edit", async () => {
      stubRepoAndAccount({
        'sync:sales~ddoc:reports': {
          database: 'sales', ddoc_id: '_design/reports', git_repo_id: 'gitrepo:1',
          ddoc_rev: '2-b', git_sha: 'sha-old'
        }
      });
      vi.spyOn(GitHubProvider.prototype, 'listTree').mockResolvedValue([
        { path: 'sales/_design/reports.json', sha: 'sha-old' }
      ]);
      vi.spyOn(GitHubProvider.prototype, 'getFile').mockResolvedValue(JSON.stringify({ views: { a: { map: 'old' } } }));
      // The user just edited this in the view editor — couch moved, git did not.
      request.mockResolvedValue({ _id: '_design/reports', _rev: '3-c', views: { a: { map: 'live-edit' } } });

      await service.syncToCouch('gitrepo:1', 'sales', {
        docs: [`${SINGLE_SERVER_ID}|sales|_design/reports`]
      });

      expect(request.mock.calls.filter(([m]) => m === 'PUT')).toHaveLength(0);
    });

    it('treats a no-sync-record disagreement as a conflict, refusing the whole batch', async () => {
      vi.spyOn(GitHubProvider.prototype, 'listTree').mockResolvedValue([
        { path: 'sales/_design/reports.json', sha: 'sha1' }
      ]);
      vi.spyOn(GitHubProvider.prototype, 'getFile').mockResolvedValue(
        JSON.stringify({ views: { a: { map: 'from-git' } } })
      );
      request.mockResolvedValue({ _id: '_design/reports', _rev: '1-a', views: { a: { map: 'from-couch' } } });

      await expect(service.syncToCouch('gitrepo:1', 'sales', {
        docs: [`${SINGLE_SERVER_ID}|sales|_design/reports`]
      })).rejects.toThrow(/conflict/i);
      expect(request.mock.calls.filter(([m]) => m === 'PUT')).toHaveLength(0);
    });

    it('collapses a duplicated doc key into a single PUT', async () => {
      vi.spyOn(GitHubProvider.prototype, 'listTree').mockResolvedValue([
        { path: 'sales/_design/fresh.json', sha: 'shaFresh' }
      ]);
      vi.spyOn(GitHubProvider.prototype, 'getFile').mockResolvedValue(JSON.stringify({ views: {} }));
      request.mockImplementation(async (method: string) => {
        if (method === 'GET') throw new ApiError(404, 'missing');
        return { ok: true, id: '_design/fresh', rev: '1-a' };
      });

      await service.syncToCouch('gitrepo:1', 'sales', {
        docs: [`${SINGLE_SERVER_ID}|sales|_design/fresh`, `${SINGLE_SERVER_ID}|sales|_design/fresh`]
      });

      expect(request.mock.calls.filter(([m]) => m === 'PUT')).toHaveLength(1);
    });

    // IMPORTANT, fix round 1: the doc comment used to claim this method was all-or-nothing; it
    // isn't (only the pre-flight classification pass genuinely is) — a write failing partway
    // through a batch must be legible about exactly what landed, since the frozen Promise<void>
    // signature (D6) leaves no way to return partial results as data.
    it('names which documents were written and which were not when a write fails mid-batch', async () => {
      vi.spyOn(GitHubProvider.prototype, 'listTree').mockResolvedValue([
        { path: 'sales/_design/one.json', sha: 'sha1' },
        { path: 'sales/_design/two.json', sha: 'sha2' }
      ]);
      vi.spyOn(GitHubProvider.prototype, 'getFile').mockImplementation(async (_url, _branch, path) =>
        JSON.stringify({ views: { marker: path } })
      );
      let putCount = 0;
      request.mockImplementation(async (method: string) => {
        if (method === 'GET') throw new ApiError(404, 'missing');
        putCount += 1;
        if (putCount === 2) throw new Error('network blip');
        return { ok: true, id: 'x', rev: '1-a' };
      });

      let caught: Error | null = null;
      try {
        await service.syncToCouch('gitrepo:1', 'sales', {
          docs: [`${SINGLE_SERVER_ID}|sales|_design/one`, `${SINGLE_SERVER_ID}|sales|_design/two`]
        });
      } catch (err) {
        caught = err as Error;
      }

      expect(caught).not.toBeNull();
      expect(caught!.message).toContain('wrote 1 of 2');
      expect(caught!.message).toContain('written: [_design/one]');
      expect(caught!.message).toContain('never written: [_design/two]');
      expect(caught!.message).toContain('network blip');
    });

    // NEW-2, fix round 2: before this fix, a document was only counted as "applied" after its
    // sync: bookkeeping write also succeeded — so a PUT that landed followed by a failed
    // bookkeeping write reported the document as NOT applied, exactly backwards from what
    // happened. A reader trusting that message would re-run the sync believing nothing was
    // written, when the CouchDB document was already there.
    it('reports a document as written even when only its sync-state bookkeeping fails afterward', async () => {
      vi.spyOn(GitHubProvider.prototype, 'listTree').mockResolvedValue([
        { path: 'sales/_design/one.json', sha: 'sha1' }
      ]);
      vi.spyOn(GitHubProvider.prototype, 'getFile').mockResolvedValue(JSON.stringify({ views: {} }));
      request.mockImplementation(async (method: string) => {
        if (method === 'GET') throw new ApiError(404, 'missing');
        return { ok: true, id: '_design/one', rev: '1-a' };
      });
      vi.spyOn(store, 'put').mockRejectedValue(new Error('couchcompanion unreachable'));

      let caught: Error | null = null;
      try {
        await service.syncToCouch('gitrepo:1', 'sales', {
          docs: [`${SINGLE_SERVER_ID}|sales|_design/one`]
        });
      } catch (err) {
        caught = err as Error;
      }

      expect(caught).not.toBeNull();
      expect(caught!.message).toContain('written: [_design/one]');
      expect(caught!.message).toContain('not recorded');
      expect(caught!.message).not.toContain('never written: [_design/one]');
    });

    // NEW-1, fix round 2 (the syncToCouch side of the same fix): before this round, an
    // absent-everywhere document rejected the WHOLE batch as a conflict rather than being skipped.
    it('skips a document that exists on neither side rather than rejecting the batch', async () => {
      vi.spyOn(GitHubProvider.prototype, 'listTree').mockResolvedValue([]);
      vi.spyOn(GitHubProvider.prototype, 'getFile').mockResolvedValue(null);
      request.mockRejectedValue(new ApiError(404, 'missing'));

      await service.syncToCouch('gitrepo:1', 'sales', {
        docs: [`${SINGLE_SERVER_ID}|sales|_design/gone`]
      });

      expect(request.mock.calls.filter(([m]) => m === 'PUT')).toHaveLength(0);
      expect(vi.mocked(store.put).mock.calls.some(([id]) => id === 'conflict:sales~ddoc:gone')).toBe(false);
    });
  });

  describe('listConflicts', () => {
    const unresolved: DesignConflict = {
      _id: 'conflict:sales~ddoc:reports',
      server_id: SINGLE_SERVER_ID,
      db_name: 'sales',
      ddoc_id: '_design/reports',
      couch_rev: '3-c',
      git_sha: 'sha-new',
      conflict_branch: 'main',
      resolved: false,
      detected_at: '2026-08-01T00:00:00Z'
    };
    const resolved: DesignConflict = {
      ...unresolved,
      _id: 'conflict:sales~ddoc:views',
      ddoc_id: '_design/views',
      resolved: true
    };

    it('lists conflicts with unresolved ones first', async () => {
      vi.spyOn(store, 'list').mockResolvedValue([resolved, unresolved]);
      const result = await service.listConflicts();
      expect(result.map((c) => c._id)).toEqual(['conflict:sales~ddoc:reports', 'conflict:sales~ddoc:views']);
    });

    it('returns an empty array when there are no conflicts', async () => {
      vi.spyOn(store, 'list').mockResolvedValue([]);
      expect(await service.listConflicts()).toEqual([]);
    });

    it('scopes to a single server when given', async () => {
      vi.spyOn(store, 'list').mockResolvedValue([unresolved, { ...unresolved, _id: 'conflict:x', server_id: 'other' }]);
      const result = await service.listConflicts(SINGLE_SERVER_ID);
      expect(result).toEqual([unresolved]);
    });
  });

  describe('resolveConflict', () => {
    it('resolveConflict marks the document resolved without changing either version', async () => {
      vi.spyOn(store, 'get').mockImplementation(async (id: string) => {
        if (id === 'conflict:sales~ddoc:reports') {
          return {
            _id: 'conflict:sales~ddoc:reports',
            server_id: SINGLE_SERVER_ID,
            db_name: 'sales',
            ddoc_id: '_design/reports',
            couch_rev: '3-c',
            git_sha: 'sha-new',
            conflict_branch: 'main',
            resolved: false,
            detected_at: '2026-08-01T00:00:00Z'
          } as never;
        }
        return null;
      });
      vi.spyOn(store, 'put').mockResolvedValue({ id: 'conflict:sales~ddoc:reports', rev: '2-b' });

      const resolved = await service.resolveConflict('conflict:sales~ddoc:reports');
      expect(resolved.resolved).toBe(true);
      expect(request.mock.calls.filter(([m]) => m === 'PUT')).toHaveLength(0);
      // Neither recorded version moved — resolving is an acknowledgment, not a sync action.
      expect(resolved.couch_rev).toBe('3-c');
      expect(resolved.git_sha).toBe('sha-new');
    });

    it('throws when the conflict does not exist', async () => {
      vi.spyOn(store, 'get').mockResolvedValue(null);
      await expect(service.resolveConflict('missing')).rejects.toThrow(ApiError);
    });
  });

  describe('getConflictVersions', () => {
    const conflict: DesignConflict = {
      _id: 'conflict:sales~ddoc:reports',
      server_id: SINGLE_SERVER_ID,
      db_name: SYNC_DB,
      ddoc_id: '_design/reports',
      git_repo_id: SYNC_REPO_ID,
      couch_rev: '3-c',
      git_sha: 'sha-new',
      conflict_branch: 'main',
      resolved: false,
      detected_at: '2026-08-01T00:00:00Z'
    };

    it('fetches the couch revision and the git file at the conflict branch', async () => {
      stubRepoAndAccount();
      request.mockResolvedValue({ _id: '_design/reports', views: { all: { map: 'couch' } } });
      const getFile = vi
        .spyOn(GitHubProvider.prototype, 'getFile')
        .mockResolvedValue(JSON.stringify({ views: { all: { map: 'git' } } }));

      const result = await service.getConflictVersions(conflict);

      expect(result.couch).toEqual({ _id: '_design/reports', views: { all: { map: 'couch' } } });
      expect(result.git).toEqual({ views: { all: { map: 'git' } } });
      expect(request).toHaveBeenCalledWith('GET', expect.stringContaining('rev=3-c'));
      expect(getFile).toHaveBeenCalledWith(SYNC_REPO.url, 'main', expect.stringContaining('reports.json'));
    });

    it('resolves the couch side to null when the revision is gone (compacted away)', async () => {
      stubRepoAndAccount();
      request.mockRejectedValue(new ApiError(404, 'missing'));
      vi.spyOn(GitHubProvider.prototype, 'getFile').mockResolvedValue(null);

      const result = await service.getConflictVersions(conflict);
      expect(result.couch).toBeNull();
    });

    it('resolves the git side to null when the repository can no longer be resolved', async () => {
      request.mockResolvedValue({ _id: '_design/reports' });

      const result = await service.getConflictVersions({ ...conflict, git_repo_id: null });
      expect(result.git).toBeNull();
      expect(result.couch).toEqual({ _id: '_design/reports' });
    });

    it('never rejects — a git-side failure is logged and folded to null', async () => {
      stubRepoAndAccount();
      request.mockResolvedValue({ _id: '_design/reports' });
      vi.spyOn(GitHubProvider.prototype, 'getFile').mockRejectedValue(new Error('rate limited'));

      const result = await service.getConflictVersions(conflict);
      expect(result.git).toBeNull();
      expect(result.couch).toEqual({ _id: '_design/reports' });
    });
  });
});
