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
 * On-demand E2E harness: exercises `DesignMgmtService`'s git-sync flows against a REAL GitHub
 * Enterprise (or github.com) repository and a REAL CouchDB — every path Phase 5's 1562 mocked
 * unit tests cannot, because they mock `GitHubProvider`/`GitHttp` outright. Excluded from the
 * default `npm test` run (see `vitest.config.ts`'s `exclude`); run explicitly via
 * `npm run test:e2e`. See `.env.example` for every variable this file reads, and
 * `.superpowers/sdd/e2e-harness-report.md` for how to run it and what it covers.
 *
 * SKIPS (visibly — `describe.skipIf`, never a silent pass) when any of the four required
 * variables is absent; the `console.warn` below names exactly which one.
 *
 * Every write lands on a throwaway branch (`e2e/<runId>`, deleted in `afterAll`) under a
 * per-run repository path prefix, and in a throwaway CouchDB database (also dropped in
 * `afterAll`) — never on `main`/`master`, and never touching a real developer's database. See
 * `test/e2e/helpers/run-context.ts` for the guards.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ApiClient } from '../../src/services/api-client.js';
import { dbPath, docPath } from '../../src/services/db-mgmt-service.js';
import {
  CouchCompanionStore,
  conflictId,
} from '../../src/services/git/couchcompanion-store.js';
import { GitCredentialStore, type CouchTokenIo } from '../../src/services/git/git-credential-store.js';
import { GitHttp } from '../../src/services/git/git-http.js';
import { GitHubProvider } from '../../src/services/git/github-provider.js';
import { designDocRepoPath, serializeDdoc } from '../../src/services/git/design-sync.js';
import { DesignMgmtService, type GitAccount } from '../../src/services/design-mgmt-service.js';
import { SINGLE_SERVER_ID } from '../../src/services/single-server.js';
import type { GitRepo } from '../../src/plugins/design-mgmt/types.js';

import { hasCredentials, missingVar, loadEnv, type E2eEnv } from './helpers/env.js';
import { fetchAdminJwt } from './helpers/keycloak-auth.js';
import { installLeakGuard, type LeakGuard } from './helpers/leak-guard.js';
import {
  newRunId,
  assertNotProtectedDb,
  createRunBranch,
  deleteRunBranch,
  getCommitParents,
  getHeadSha,
  apiRoot,
  type RunBranch,
} from './helpers/run-context.js';

const skip = !hasCredentials();

if (skip) {
  // eslint-disable-next-line no-console -- test-harness diagnostic; this suite is not production code.
  console.warn(
    `[e2e] SKIPPED: ${missingVar()} is not set. Copy .env.example to .env.local and fill it in ` +
      '(or export real env vars) to run the real-GitHub/real-CouchDB E2E suite. `npm test` never ' +
      'reaches this file — see vitest.config.ts.',
  );
}

/** Mirrors `src/context.ts`'s private `couchTokenIo` adapter exactly — the wiring
 *  `GitCredentialStore` needs to round-trip a token through a git-account document in `couchdb`
 *  mode. Duplicated rather than imported: it is not exported from `context.ts`, and this harness
 *  must not modify production files to make itself easier to write. Only `forget()` actually
 *  exercises this (it unconditionally calls `writeToken`, even in the `none` mode this suite
 *  uses) — see `git-credential-store.ts`. */
function couchTokenIo(store: CouchCompanionStore): CouchTokenIo {
  return {
    async readToken(accountId: string) {
      const account = await store.get<{ auth?: { token?: string } }>(accountId);
      return account?.auth?.token ?? null;
    },
    async writeToken(accountId: string, token: string | null) {
      const account = await store.get<Record<string, unknown>>(accountId);
      if (!account) return;
      const { auth: _auth, ...rest } = account;
      await store.put(accountId, token === null ? rest : { ...rest, auth: { token } });
    },
  };
}

const ddocKey = (dbName: string, ddocId: string) => `${SINGLE_SERVER_ID}|${dbName}|${ddocId}`;

/** A minimal, syntactically valid design doc body carrying a `tag` field this suite mutates to
 *  simulate an edit on one side or the other. */
const makeBody = (tag: string, extra: Record<string, unknown> = {}) => ({
  views: { by_id: { map: 'function (doc) { emit(doc._id, doc._rev); }' } },
  tag,
  ...extra,
});

describe.skipIf(skip)('DesignMgmtService E2E (real GitHub + real CouchDB)', () => {
  // Definite-assignment (`!`) — every one of these is assigned in `beforeAll` below, which
  // `describe.skipIf` guarantees has run before any `it()` in this suite executes.
  let env!: E2eEnv;
  let runId!: string;
  let dbName!: string;
  let pathPrefix!: string;
  let branch!: RunBranch;
  let http!: GitHttp;
  let verifyProvider!: GitHubProvider; // independent client, used only to read back real state for assertions
  let api!: ApiClient;
  let store!: CouchCompanionStore;
  let designMgmt!: DesignMgmtService;
  let account!: GitAccount;
  let repo!: GitRepo;
  let guard!: LeakGuard;

  beforeAll(async () => {
    env = loadEnv();
    runId = newRunId();
    dbName = `e2e-${runId}`;
    pathPrefix = `e2e-runs/${runId}`;

    guard = installLeakGuard();
    guard.watch(env.gitToken);

    http = new GitHttp(() => env.gitToken);
    verifyProvider = new GitHubProvider(http, env.gitBaseUrl);
    branch = await createRunBranch(http, env.gitRepo, env.gitBaseUrl, runId);

    api = new ApiClient(env.couchUrl);

    if (env.authMode === 'basic') {
      // No Keycloak involved at all — the only path that works against a CouchDB with no
      // `[jwt_keys]` (#11). The password is watched before it is ever used, so a leak in any
      // later log line fails the run.
      guard.watch(env.adminPassword);
      api.setCredential({
        kind: 'basic',
        username: env.adminUser,
        password: env.adminPassword,
      });
    } else {
      const jwt = await fetchAdminJwt(env).catch((err: Error) => {
        throw new Error(
          `${err.message}\nIf this CouchDB has no [jwt_keys] configured, set ` +
            'CCA_E2E_AUTH_MODE=basic (with CCA_E2E_ADMIN_USER/CCA_E2E_ADMIN_PASSWORD) to ' +
            'authenticate with a CouchDB account instead. See .env.example.',
        );
      });
      guard.watch(jwt);
      api.setToken(jwt);
    }

    // Fail fast, with a clear cause, if the chosen auth path doesn't actually carry _admin —
    // every later assertion in this file depends on it.
    const session = await api.request<{ userCtx?: { roles?: string[] } }>('GET', '/_session');
    if (!session?.userCtx?.roles?.includes('_admin')) {
      throw new Error(
        `The ${env.authMode} credential did not grant _admin on CouchDB — check ` +
          'CCA_E2E_ADMIN_USER/CCA_E2E_ADMIN_PASSWORD' +
          (env.authMode === 'jwt' ? ' and the devcontainer realm.' : '.'),
      );
    }

    assertNotProtectedDb(dbName);
    await api.request('PUT', dbPath(dbName));

    store = new CouchCompanionStore(api);
    const credentials = new GitCredentialStore(couchTokenIo(store));
    designMgmt = new DesignMgmtService(api, store, credentials);

    account = await designMgmt.postGitAccounts({
      provider: 'github',
      label: `e2e ${runId}`,
      base_url: env.gitBaseUrl,
      token: env.gitToken,
      username: null,
    });

    repo = await designMgmt.registerRepo(SINGLE_SERVER_ID, dbName, {
      url: env.gitRepo,
      branch: branch.branch,
      path: pathPrefix,
      account_id: account._id,
    });
  }, 120_000);

  afterAll(async () => {
    if (repo?._id) {
      try {
        await designMgmt.deleteRepo(repo._id);
      } catch (err) {
        console.warn('[e2e] could not delete the git-repo doc (tolerated):', (err as Error).message);
      }
    }
    if (account?._id) {
      try {
        await designMgmt.deleteGitAccount(account._id);
      } catch (err) {
        console.warn('[e2e] could not delete the git-account doc (tolerated):', (err as Error).message);
      }
    }
    try {
      await api.request('DELETE', dbPath(dbName));
    } catch (err) {
      console.warn(`[e2e] could not drop database "${dbName}" (tolerated):`, (err as Error).message);
    }
    await deleteRunBranch(http, env.gitRepo, env.gitBaseUrl, branch.branch);
    guard.restore();
  }, 120_000);

  /** Creates a design doc in CouchDB and syncs it to the repo in the same call, so every
   *  "start from an agreed baseline" test needn't repeat the two-step dance. */
  async function createSyncedDoc(name: string, tag: string): Promise<{ ddocId: string; key: string }> {
    const ddocId = `_design/${name}`;
    const key = ddocKey(dbName, ddocId);
    await designMgmt.saveDesignDoc(SINGLE_SERVER_ID, dbName, ddocId, makeBody(tag));
    const result = await designMgmt.syncToRepo(repo._id!, dbName, { docs: [key] });
    expect(result.synced, `baseline sync of ${ddocId} must actually commit`).toBe(1);
    return { ddocId, key };
  }

  /** Writes a file straight to the git branch with no CouchDB counterpart — a "git-only" document
   *  no sync ever created. */
  async function commitGitOnlyFile(name: string, tag: string): Promise<string> {
    const filePath = designDocRepoPath(pathPrefix, dbName, name);
    await verifyProvider.commitFiles(env.gitRepo, branch.branch, `E2E: add git-only ${name}`, [
      { path: filePath, content: serializeDdoc(makeBody(tag)) },
    ]);
    return filePath;
  }

  describe('1. One commit for N documents', () => {
    it('syncs three design docs as exactly one commit containing all three files', async () => {
      const names = ['alpha', 'beta', 'gamma'];
      const ddocIds = names.map((n) => `_design/${n}`);
      for (const [i, name] of names.entries()) {
        await designMgmt.saveDesignDoc(SINGLE_SERVER_ID, dbName, ddocIds[i], makeBody(name));
      }

      const before = await getHeadSha(http, env.gitRepo, env.gitBaseUrl, branch.branch);

      const result = await designMgmt.syncToRepo(repo._id!, dbName, {
        docs: ddocIds.map((id) => ddocKey(dbName, id)),
      });
      expect(result.synced).toBe(3);
      expect(result.conflicts).toBe(0);

      const after = await getHeadSha(http, env.gitRepo, env.gitBaseUrl, branch.branch);
      expect(after).not.toBe(before);

      // Exactly one new commit landed — a multi-file sync that took N commits (one per file)
      // would leave `after`'s commit with a single parent that is NOT `before`, chained through
      // intermediate commits; a single atomic commit's parent IS `before` directly.
      const parents = await getCommitParents(http, env.gitRepo, env.gitBaseUrl, after);
      expect(parents).toEqual([before]);

      const tree = await verifyProvider.listTree(env.gitRepo, branch.branch, pathPrefix);
      const paths = new Set(tree.map((e) => e.path));
      for (const id of ddocIds) {
        expect(paths.has(designDocRepoPath(pathPrefix, dbName, id))).toBe(true);
      }
    });
  });

  describe('2. UTF-8 round trip', () => {
    it('round-trips non-ASCII map-function source and field values through a real GitHub blob', async () => {
      const ddocId = '_design/nihongo';
      const key = ddocKey(dbName, ddocId);
      const original = {
        views: { by_lang: { map: 'function (doc) { emit("日本語", doc._id); }' } },
        naïve: 'café — a naïve façade, résumé, 東京',
      };
      await designMgmt.saveDesignDoc(SINGLE_SERVER_ID, dbName, ddocId, original);

      const pushResult = await designMgmt.syncToRepo(repo._id!, dbName, { docs: [key] });
      expect(pushResult.synced).toBe(1);

      // Read the real blob back from GitHub (base64-decoded by fromBase64Utf8) and confirm the
      // non-ASCII survived the round trip through a real Contents/Git-Data-API blob, not a mock.
      const filePath = designDocRepoPath(pathPrefix, dbName, ddocId);
      const raw = await verifyProvider.getFile(env.gitRepo, branch.branch, filePath);
      expect(raw).not.toBeNull();
      const parsed = JSON.parse(raw!) as typeof original;
      expect(parsed.naïve).toBe(original.naïve);
      expect(parsed.views.by_lang.map).toBe(original.views.by_lang.map);

      // Now delete the CouchDB side and pull it back from git — exercises the decode direction
      // (fromBase64Utf8) against the same real blob, completing the round trip.
      const current = await designMgmt.getDesignDoc(SINGLE_SERVER_ID, dbName, ddocId);
      await api.request('DELETE', `${docPath(dbName, ddocId)}?rev=${encodeURIComponent(current._rev as string)}`);

      await designMgmt.syncToCouch(repo._id!, dbName, { docs: [key] });
      const restored = await designMgmt.getDesignDoc(SINGLE_SERVER_ID, dbName, ddocId);
      expect(restored.naïve).toBe(original.naïve);
      expect((restored.views as { by_lang: { map: string } }).by_lang.map).toBe(original.views.by_lang.map);
    });
  });

  describe('3. Direction refusals', () => {
    it('pull (syncToCouch) does not overwrite a document changed only in CouchDB', async () => {
      const { ddocId, key } = await createSyncedDoc('drift-couch', 'baseline');

      const current = await designMgmt.getDesignDoc(SINGLE_SERVER_ID, dbName, ddocId);
      await designMgmt.saveDesignDoc(SINGLE_SERVER_ID, dbName, ddocId, {
        ...current,
        tag: 'couch-only-edit',
      });

      await designMgmt.syncToCouch(repo._id!, dbName, { docs: [key] });

      const after = await designMgmt.getDesignDoc(SINGLE_SERVER_ID, dbName, ddocId);
      expect(after.tag).toBe('couch-only-edit');

      const filePath = designDocRepoPath(pathPrefix, dbName, ddocId);
      const gitRaw = await verifyProvider.getFile(env.gitRepo, branch.branch, filePath);
      const gitBody = JSON.parse(gitRaw!) as { tag: string };
      expect(gitBody.tag).toBe('baseline'); // the file was never touched
    });

    it('push (syncToRepo) does not overwrite a file changed only in the repository', async () => {
      const { ddocId, key } = await createSyncedDoc('drift-git', 'baseline');
      const filePath = designDocRepoPath(pathPrefix, dbName, ddocId);

      await verifyProvider.commitFiles(env.gitRepo, branch.branch, 'E2E: edit drift-git only in git', [
        { path: filePath, content: serializeDdoc(makeBody('git-only-edit')) },
      ]);

      const result = await designMgmt.syncToRepo(repo._id!, dbName, { docs: [key] });
      expect(result.synced).toBe(0);
      expect(result.skipped).toBe(1);
      expect(result.conflicts).toBe(0);

      const gitRaw = await verifyProvider.getFile(env.gitRepo, branch.branch, filePath);
      const gitBody = JSON.parse(gitRaw!) as { tag: string };
      expect(gitBody.tag).toBe('git-only-edit'); // the push never reverted it

      const couchDoc = await designMgmt.getDesignDoc(SINGLE_SERVER_ID, dbName, ddocId);
      expect(couchDoc.tag).toBe('baseline'); // nothing was pushed
    });
  });

  describe('4. Conflict creation', () => {
    it('refuses both directions and records a conflict: document when both sides changed', async () => {
      const { ddocId, key } = await createSyncedDoc('conflict-doc', 'baseline');
      const filePath = designDocRepoPath(pathPrefix, dbName, ddocId);

      const current = await designMgmt.getDesignDoc(SINGLE_SERVER_ID, dbName, ddocId);
      await designMgmt.saveDesignDoc(SINGLE_SERVER_ID, dbName, ddocId, { ...current, tag: 'couch-conflict' });
      await verifyProvider.commitFiles(env.gitRepo, branch.branch, 'E2E: conflicting git edit', [
        { path: filePath, content: serializeDdoc(makeBody('git-conflict')) },
      ]);

      const pushResult = await designMgmt.syncToRepo(repo._id!, dbName, { docs: [key] });
      expect(pushResult.conflicts).toBe(1);
      expect(pushResult.synced).toBe(0);

      await expect(designMgmt.syncToCouch(repo._id!, dbName, { docs: [key] })).rejects.toThrow(
        /conflict.*resolve it first/is,
      );

      const conflicts = await designMgmt.listConflicts();
      const recorded = conflicts.find((c) => c.db_name === dbName && c.ddoc_id === ddocId);
      expect(recorded).toBeDefined();
      expect(recorded!.resolved).toBe(false);

      // The literal `conflict:` document the spec calls out, fetched directly.
      const conflictDoc = await store.get<{ doc_type?: string }>(conflictId(dbName, ddocId));
      expect(conflictDoc?.doc_type).toBe('conflict');

      const couchDoc = await designMgmt.getDesignDoc(SINGLE_SERVER_ID, dbName, ddocId);
      expect(couchDoc.tag).toBe('couch-conflict'); // neither side was overwritten
      const gitRaw = await verifyProvider.getFile(env.gitRepo, branch.branch, filePath);
      expect((JSON.parse(gitRaw!) as { tag: string }).tag).toBe('git-conflict');
    });
  });

  describe('5. Delete-set correctness', () => {
    it('deletes exactly the confirmed set — synced docs removed, git-only docs untouched', async () => {
      // Sequential, not Promise.all: each call is a real commit against the same branch ref, and
      // GitHub's ref update is `force: false` (see GitHubProvider.commitFiles) — two commits
      // racing from the same starting sha both read the same base, and the loser's PATCH 422s as
      // "not a fast forward". That race is real GitHub behavior, discovered by this harness
      // against the real API — a UI-driven sync is never self-concurrent this way, so there is
      // nothing to fix in production code; the test just must not create a race the product
      // itself never would.
      const synced = [
        await createSyncedDoc('sync-a', 'a'),
        await createSyncedDoc('sync-b', 'b'),
        await createSyncedDoc('sync-c', 'c'),
      ];
      const gitOnlyPaths = [
        await commitGitOnlyFile('git-only-d', 'd'),
        await commitGitOnlyFile('git-only-e', 'e'),
      ];

      const before = await verifyProvider.listTree(env.gitRepo, branch.branch, pathPrefix);
      const pathsBefore = new Set(before.map((e) => e.path));
      for (const p of gitOnlyPaths) expect(pathsBefore.has(p)).toBe(true);

      // "Delete from both", mirroring design-list.ts's fixed `_deleteTargets('both')`: acts on
      // exactly the synced intersection (3 docs), never the git-only ones (2 docs) even though
      // both groups were "selected" in the sense of being eligible/visible in this run.
      for (const { ddocId } of synced) {
        const doc = await designMgmt.getDesignDoc(SINGLE_SERVER_ID, dbName, ddocId);
        await api.request('DELETE', `${docPath(dbName, ddocId)}?rev=${encodeURIComponent(doc._rev as string)}`);
      }
      const names = synced.map(({ ddocId }) => ddocId.replace(/^_design\//, ''));
      const deleteResult = await designMgmt.deleteRepoDocs(repo._id!, dbName, names);

      expect(Object.keys(deleteResult).sort()).toEqual([...names].sort());
      const shas = Object.values(deleteResult).map((r) => r.commit_sha);
      expect(new Set(shas).size).toBe(1); // one commit removed all three — not three commits
      for (const r of Object.values(deleteResult)) expect(r.deleted).toBe(true);

      const after = await verifyProvider.listTree(env.gitRepo, branch.branch, pathPrefix);
      const pathsAfter = new Set(after.map((e) => e.path));

      const deletedPaths = synced.map(({ ddocId }) => designDocRepoPath(pathPrefix, dbName, ddocId));
      for (const p of deletedPaths) expect(pathsAfter.has(p)).toBe(false); // the confirmed 3, gone

      // Exactly what was listed — not the 5-deletion regression (3 confirmed + 2 untouched
      // git-only docs mistakenly swept in) Phase 5's final review found.
      for (const p of gitOnlyPaths) expect(pathsAfter.has(p)).toBe(true);
      expect(pathsBefore.size - pathsAfter.size).toBe(deletedPaths.length);

      for (const { ddocId } of synced) {
        await expect(designMgmt.getDesignDoc(SINGLE_SERVER_ID, dbName, ddocId)).rejects.toMatchObject({
          status: 404,
        });
      }
    });
  });

  describe('6. Rate-limit headers', () => {
    it('exposes X-RateLimit-Remaining on a browser-style (CORS) response', async () => {
      // Deliberately a raw fetch, not GitHttp — GitHttp.request only returns the parsed JSON
      // body, discarding response headers, so the header-visibility claim can only be checked
      // against the real HTTP response directly. An explicit Origin simulates what a browser
      // sends on a real cross-origin request, so GitHub's CORS layer answers the same way it
      // would for the product's own browser-side fetches.
      const resp = await fetch(`${apiRoot(env.gitBaseUrl)}/rate_limit`, {
        headers: {
          Authorization: `Bearer ${env.gitToken}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          Origin: 'http://localhost:5173',
        },
      });
      expect(resp.ok).toBe(true);

      const remaining = resp.headers.get('x-ratelimit-remaining');
      expect(remaining).not.toBeNull();
      expect(Number.isFinite(Number(remaining))).toBe(true);

      const exposed = resp.headers.get('access-control-expose-headers') ?? '';
      expect(exposed.toLowerCase()).toMatch(/x-ratelimit-remaining/);
    });
  });
});
