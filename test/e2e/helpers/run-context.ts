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

import { GitHttp } from '../../../src/services/git/git-http.js';
import { parseRepoUrl } from '../../../src/services/git/github-provider.js';

/** Databases this harness must never create, drop, or write into — a real developer's data on
 *  the shared devcontainer CouchDB, not this run's own throwaway. `couchcompanion` is
 *  deliberately absent: it is the product's own bookkeeping database, lazily created by
 *  `CouchCompanionStore`, and this suite is expected to write to it (git accounts/repos/sync
 *  state) the same way the real app does — it cleans up its own rows via `deleteRepo`/
 *  `deleteGitAccount` in `afterAll` instead of avoiding the database outright. */
const PROTECTED_DBS = new Set(['p4src', 'p4tgt', 'phase3demo', 'idp', '_users', '_replicator']);

const PROTECTED_BRANCHES = new Set(['main', 'master']);

/** A short id unique enough that two runs (two CI jobs, a human and CI at once) never collide —
 *  used to derive this run's branch name, repo path prefix, and throwaway database name. Not
 *  cryptographically random: collision cost here is "two runs briefly share a CouchDB/branch
 *  namespace", not a security property. */
export function newRunId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Throws if `dbName` names a real, shared database — the last line of defense before any create
 *  or drop this harness issues against CouchDB. */
export function assertNotProtectedDb(dbName: string): void {
  if (PROTECTED_DBS.has(dbName)) {
    throw new Error(`Refusing to touch protected database "${dbName}".`);
  }
}

/** Throws if `branch` is `main` or `master` — the last line of defense before any git write this
 *  harness issues, independent of how `branch` was derived. */
export function assertNotProtectedBranch(branch: string): void {
  if (PROTECTED_BRANCHES.has(branch)) {
    throw new Error(`Refusing to operate on protected branch "${branch}".`);
  }
}

/** `GitHubProvider`'s own `apiRoot` is a private getter; duplicated here (one line) rather than
 *  widening that class's surface for a test-only caller. Exported — the rate-limit-header test
 *  needs the bare API root, not a repo-scoped path. */
export function apiRoot(baseUrl: string | null): string {
  return baseUrl ? `${baseUrl.replace(/\/+$/, '')}/api/v3` : 'https://api.github.com';
}

/** `GitHubProvider`'s own `repoApi` is private; this is the same two-line derivation via the
 *  already-exported {@link parseRepoUrl}, duplicated here rather than widening that class's
 *  surface for a test-only caller. */
export function repoApi(repoUrl: string, baseUrl: string | null): string {
  const { owner, repo } = parseRepoUrl(repoUrl);
  return `${apiRoot(baseUrl)}/repos/${owner}/${repo}`;
}

export interface RunBranch {
  runId: string;
  branch: string;
  defaultBranch: string;
  baseSha: string;
}

/**
 * Creates `e2e/<runId>` off the repository's current default branch via the Git Data API — the
 * same "read the ref, POST a new ref" shape `GitHubProvider.commitFiles` uses for a tree/commit,
 * just one level up. Every write this suite performs lands on this branch, never the default one.
 */
export async function createRunBranch(
  http: GitHttp,
  repoUrl: string,
  baseUrl: string | null,
  runId: string,
): Promise<RunBranch> {
  const api = repoApi(repoUrl, baseUrl);
  const branch = `e2e/${runId}`;
  assertNotProtectedBranch(branch);

  const repoInfo = await http.request<{ default_branch?: string }>('GET', api);
  const defaultBranch = repoInfo?.default_branch;
  if (!defaultBranch) throw new Error(`Could not resolve the default branch of ${repoUrl}.`);

  const ref = await http.request<{ object?: { sha?: string } }>(
    'GET',
    `${api}/git/refs/heads/${encodeURIComponent(defaultBranch)}`,
  );
  const baseSha = ref?.object?.sha;
  if (!baseSha) throw new Error(`Could not resolve the HEAD sha of "${defaultBranch}" in ${repoUrl}.`);

  await http.request('POST', `${api}/git/refs`, {
    body: { ref: `refs/heads/${branch}`, sha: baseSha },
  });

  return { runId, branch, defaultBranch, baseSha };
}

/** Deletes the run's throwaway branch. Failure is swallowed (logged to stderr, not thrown) — a
 *  branch left behind after a failed cleanup is a minor annoyance the next run's namespacing
 *  already isolates against; failing `afterAll` over it would mask whatever the tests themselves
 *  reported. */
export async function deleteRunBranch(
  http: GitHttp,
  repoUrl: string,
  baseUrl: string | null,
  branch: string,
): Promise<void> {
  assertNotProtectedBranch(branch);
  try {
    const api = repoApi(repoUrl, baseUrl);
    await http.request('DELETE', `${api}/git/refs/heads/${encodeURIComponent(branch)}`);
  } catch (err) {
    // eslint-disable-next-line no-console -- test-harness cleanup diagnostic, not production code.
    console.warn(`[e2e] could not delete branch "${branch}" (tolerated):`, (err as Error).message);
  }
}

/** Gets a commit's parent shas — used to assert "exactly one new commit" (a single-parent commit
 *  whose parent is the sha captured immediately before the sync call). `GitHubProvider` has no
 *  public accessor for this; it is a thin, test-only wrapper over the same Git Data API endpoint
 *  `commitFiles` already calls internally. */
export async function getCommitParents(
  http: GitHttp,
  repoUrl: string,
  baseUrl: string | null,
  sha: string,
): Promise<string[]> {
  const api = repoApi(repoUrl, baseUrl);
  const commit = await http.request<{ parents?: { sha: string }[] }>('GET', `${api}/git/commits/${sha}`);
  return (commit?.parents ?? []).map((p) => p.sha);
}

/** The branch's current head commit sha — thin wrapper mirroring {@link getCommitParents}, kept
 *  here instead of reusing `GitHubProvider.headSha` so every raw Git Data API helper this suite
 *  needs lives in one file. */
export async function getHeadSha(
  http: GitHttp,
  repoUrl: string,
  baseUrl: string | null,
  branch: string,
): Promise<string> {
  const api = repoApi(repoUrl, baseUrl);
  const ref = await http.request<{ object?: { sha?: string } }>(
    'GET',
    `${api}/git/refs/heads/${encodeURIComponent(branch)}`,
  );
  const sha = ref?.object?.sha;
  if (!sha) throw new Error(`Could not resolve the HEAD sha of "${branch}" in ${repoUrl}.`);
  return sha;
}
