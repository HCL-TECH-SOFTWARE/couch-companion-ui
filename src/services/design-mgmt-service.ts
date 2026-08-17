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

import { ApiClient } from './api-client.js';
import { ApiError } from './api-error.js';
import { dbPath, docPath } from './db-mgmt-service.js';
import {
  designDocRepoPath,
  ddocIdFromPath,
  serializeDdoc,
  sameContent,
  classify,
  resolveUnknown,
  canApply,
  type SyncStatus
} from './git/design-sync.js';
import { CouchCompanionStore, ID_PREFIX, syncStateId, conflictId } from './git/couchcompanion-store.js';
import { GitCredentialStore, type CredentialMode } from './git/git-credential-store.js';
import { GitHttp, GitHttpError } from './git/git-http.js';
import { GitHubProvider, parseRepoUrl } from './git/github-provider.js';
import type { FileChange } from './git/git-provider.js';
import { SINGLE_SERVER_ID } from './single-server.js';
import { getLogger } from './log-service.js';
import { runViewIsolated } from './view-runner-host.js';
import type {
  TrackedDesignDoc,
  GitDesignDoc,
  GitRepo,
  RepoTarget,
  DesignConflict
} from '../plugins/design-mgmt/types.js';

const log = getLogger('services/design-mgmt-service');

export interface RegisterRepoBody {
  name?: string;
  url: string;
  branch?: string;
  path?: string;
  mode?: string;
  auth?: { type: 'none' } | { type: 'token'; token: string };
  account_id?: string;
  targets?: RepoTarget[];
}

export interface GetRepoResponse {
  repo: GitRepo | null;
}

export interface ListReposResponse {
  repos: GitRepo[];
  /**
   * Whether the list may be incomplete. Retained as part of the response shape, but **always
   * `false`**: the cap it reported was the retired backend's, and nothing client-side imposes one.
   * `repo-overview.ts` used to render a "capped at 1000 entries" notice from it — copy that could
   * never appear, and a test that mocked a value the service cannot produce. Both are gone; do not
   * add a new reader without first giving {@link DesignMgmtService.listRepos} a real cap to report.
   */
  truncated?: boolean;
}

export interface UnlinkRepoResponse {
  /**
   * What actually happened:
   *  - `target_removed` — the target was dropped and the repository kept its remaining ones.
   *  - `repo_deleted` — that was its last target, so the repository document went with it.
   *  - `not_linked` — **nothing was linked, so nothing was done.** Added because
   *    {@link DesignMgmtService.unlinkRepo} used to answer `target_removed` for
   *    {@link DesignMgmtService.detachTarget}'s no-op too, and `repo-overview.ts` dutifully
   *    reported "Target unlinked (N connections remain)" as a success for a removal that never
   *    happened. Not an error — the caller's desired state was already true — but a caller must be
   *    able to tell the two apart before it says anything, or updates its own copy of the listing.
   */
  action: 'target_removed' | 'repo_deleted' | 'not_linked';
  repo_id: string;
  remaining_targets: number;
  deleted_sync_docs: number;
}

export interface SyncRequest {
  docs: string[];
}

export interface SyncResult {
  status: string;
  synced?: number;
  conflicts?: number;
  /**
   * Requested documents that were neither pushed nor flagged as a conflict — refused by the
   * direction-aware guard (fix round 1's `canApply`) because the requested direction wasn't safe
   * for that document's state, or because the document doesn't currently exist on either side
   * (fix round 2's `readAndClassify` short-circuit). Additive (D6-safe): a `SyncResult` with
   * `conflicts: 0` used to be indistinguishable from "there was nothing to do" — this makes the
   * difference visible instead of silently discarding it, the same failure the hardcoded
   * `conflicts: 0` this task replaced represented, wearing a different hat.
   */
  skipped?: number;
  /**
   * Documents that already matched on both sides and so needed no commit, but whose `sync:`
   * bookkeeping was (re-)recorded. Additive, and added for the same reason as `skipped`: the heal
   * path counted nothing, so a reconcile-only sync reported `{synced: 0}` and Task 8's now
   * user-facing counters turned that into "Synced to repo successfully (0 synced)" for a call that
   * did exactly what it was asked to.
   */
  reconciled?: number;
}

/**
 * What {@link DesignMgmtService.getRepoDocs} reports when the list it returns is smaller than the
 * repository's — enough for a caller to say on screen exactly how many documents are missing, and
 * which.
 */
export interface RepoDocsTruncation {
  /**
   * How many documents were actually returned. Issue #6 item 6: this used to be reported *before*
   * the per-file reads ran, so it counted files the service was about to attempt — every read that
   * then failed (and was dropped) made the number an overstatement, and a caller rendering
   * "Showing N of M" said 50 for a list of 48.
   */
  shown: number;
  /** How many design documents the repository holds for this database. */
  total: number;
  /** Every path that isn't in the returned list: dropped by the cap first, then unreadable. So
   *  `shown + droppedPaths.length === total`, and a caller naming these names all of them. */
  droppedPaths: string[];
  /**
   * The subset of {@link droppedPaths} that was within the cap but could not be read (too large
   * for the Contents API, rate-limited, unparseable, …) rather than being cut by it. Additive and
   * optional: a caller that only wants "what is missing" reads `droppedPaths` and ignores this,
   * while one that wants to explain *why* can tell the two causes apart — they need different
   * advice (narrow the design root vs. fix that one file).
   */
  unreadablePaths?: string[];
}

export interface TestViewRequest {
  map_function: string;
  reduce_function?: string | null;
  /** Whole documents to run the map function against, not their ids. */
  sample_docs?: Record<string, unknown>[];
}

/** One key/value pair emitted by the map function. `key` and `value` are arbitrary JSON. */
export interface TestViewRow {
  key?: unknown;
  value?: unknown;
  /** Source document id. */
  id?: string;
}

export interface TestViewResult {
  rows?: TestViewRow[];
  error?: string | null;
}

export interface ConnectGitAccountRequest {
    provider: string;
    label: string;
    base_url: string | null;
    token: string | null;
    username: string | null;
}

export interface GitAccount {
  _id: string;
  provider: string;
  label: string;
  username?: string | null;
  base_url?: string | null;
  /**
   * Where this account's token is allowed to live (D12). Additive and optional (D6-safe), but not
   * decorative: without it no component could tell which mode it was in, so a token prompt told
   * every user their account "does not store its access token … not saved anywhere" — false for
   * both persisting modes — and a rotated PAT in one of them was unrecoverable, because the retry
   * only ever `remember()`ed the new token for the session while `GitCredentialStore.get` kept
   * re-reading the stale stored one on every fresh tab. Absent on documents written before this
   * field existed, which {@link DesignMgmtService.providerFor} already treats as `'none'`.
   */
  credential_mode?: CredentialMode;
}

/**
 * The outcome of {@link DesignMgmtService.changeCredentialMode}.
 *
 * `token_required` is not an error: it is the one situation where the move genuinely cannot be
 * performed silently — the old mode was `none`, so the only copy of the token was this tab's
 * session cache, and this tab does not have it (a reload, or a different tab). Nothing has been
 * changed; the caller collects a token and calls again with it. Every other origin (`indexeddb`,
 * `couchdb`) survives a reload and moves without a prompt, and `none` as a *target* needs no
 * token at all.
 */
export type CredentialModeChange =
  | { status: 'changed'; from: CredentialMode; to: CredentialMode }
  | { status: 'token_required' };

export interface RemoteRepo {
  full_name: string;
  clone_url: string;
  default_branch: string;
  private: boolean;
  description?: string;
}

/**
 * How a `gitaccount:*` document actually looks inside `couchcompanion` — a superset of the public
 * {@link GitAccount}: it also carries `credential_mode` and, in `couchdb` mode only, the token
 * itself under `auth`. Never returned to a caller directly; every read goes through
 * {@link DesignMgmtService.maskAccount}.
 */
interface GitAccountDoc {
  _id: string;
  _rev?: string;
  doc_type?: string;
  provider: string;
  label: string;
  username?: string | null;
  base_url?: string | null;
  credential_mode?: CredentialMode;
  auth?: { token: string };
  created_at?: string;
}

/**
 * The `sync:<db>~ddoc:<name>` document {@link CouchCompanionStore} holds per tracked design doc.
 * Task 6's sync flows own writing these; {@link DesignMgmtService.listDesignDocs} only reads them
 * to fill in the git columns.
 */
interface SyncStateDoc {
  _id: string;
  /** Present on anything {@link CouchCompanionStore.list} returned (`include_docs=true`), which is
   *  what lets the sweeps delete in bulk without re-reading each document for its revision. */
  _rev?: string;
  database: string;
  ddoc_id: string;
  git_repo_id?: string | null;
  git_sha?: string | null;
  ddoc_rev?: string | null;
  last_sync?: string | null;
  /** CouchDB has no document mtime; when this is set, it's Task 6's sync flow's own timestamp. */
  updated_at?: string | null;
}

/** `reports` and `_design/reports` both name the same document. */
const normalizeDdocId = (ddocId: string): string =>
  ddocId.startsWith('_design/') ? ddocId : `_design/${ddocId}`;

/**
 * Each file `getRepoDocs` reads is its own GitHub API call, against a rate limit the caller does
 * not control (D — Task 6 brief). A repository with hundreds of design docs must degrade to "the
 * first 50, and a log line saying so", never a silent truncation that reads as "that's everything".
 */
const MAX_REPO_DOCS = 50;

/**
 * Parses the `server|db|ddoc` wire format {@link SyncRequest.docs} carries (still that shape —
 * D6 froze it, even though a single server (D2/D3) makes the segment redundant; `design-list.ts`
 * builds these keys today and is not being touched). Throws — naming the actual and expected
 * database — when a key's database segment does not match the database this sync call was scoped
 * to, rather than silently syncing (or worse, deleting) a document in the wrong database.
 */
function parseDocKey(key: string, dbName: string): string {
  const parts = key.split('|');
  if (parts.length !== 3) {
    throw new Error(`Malformed sync document key "${key}" — expected "server|db|ddoc".`);
  }
  const [, db, ddocId] = parts;
  if (db !== dbName) {
    throw new Error(`Doc key "${key}" names database "${db}", not "${dbName}" — refusing to sync it here.`);
  }
  return normalizeDdocId(ddocId);
}

/**
 * Canonical identity for a repository URL — lowercase `host/owner/repo` via
 * {@link parseRepoUrl} — so `.../widgets` and `.../widgets.git` (or a trailing slash, or a
 * different-case owner/repo) are recognized as the same repository instead of spawning a
 * duplicate registration. `parseRepoUrl` itself only lowercases `host` (its `owner`/`repo` feed
 * `GitHubProvider.slug()`, whose case must survive untouched for the API calls that use it); the
 * `.toLowerCase()` here is what actually makes the whole identity case-insensitive, not a
 * decoration. Falls back to a trimmed, lowercased raw comparison for a URL `parseRepoUrl` can't
 * parse, rather than throwing out of `registerRepo` over a URL that isn't well-formed enough to
 * canonicalize.
 */
function repoIdentity(url: string): string {
  try {
    const { host, owner, repo } = parseRepoUrl(url);
    return `${host}/${owner}/${repo}`.toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

/**
 * Best-effort `owner/repo` display name for a repository registered without an explicit `name`
 * (`RegisterRepoBody.name` is optional). Not used for routing — `GitHubProvider` does its own,
 * stricter parsing of the same URL when it actually calls the API.
 */
function repoNameFromUrl(url: string): string {
  const path = url.split(/[?#]/)[0].replace(/\/+$/, '').replace(/\.git$/, '');
  const parts = path.split('/').filter(Boolean);
  return parts.slice(-2).join('/') || url;
}

/**
 * `crypto.randomUUID()` requires a secure context, which a plain-http CouchDB admin box is not
 * guaranteed to be — guarded the same way the rest of this codebase already does (see
 * `cca-element.ts`, `shared-worker-transport.ts`).
 */
function newId(prefix: string): string {
  const uuid =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}${uuid}`;
}

/** Coerces a public wire type (already plain data) into the untyped body `CouchCompanionStore.put` accepts. */
const toDoc = (value: object): Record<string, unknown> => value as Record<string, unknown>;

/**
 * Encapsulates all design-management operations.
 *
 * Design-doc CRUD and the git account/repository registry talk to CouchDB directly — the former
 * to the target database, the latter through {@link CouchCompanionStore}. The sync flows
 * (`syncToRepo`, `syncToCouch`, `getRepoDocs`, `deleteRepoDocs`, `listConflicts`,
 * `resolveConflict`) talk to CouchDB and, through {@link GitHubProvider}, the git host directly —
 * Task 6 rewired them off the retired `/api/...` backend, including real conflict detection
 * ({@link classify} in `git/design-sync.ts`) the backend never actually performed. `testView`
 * (Task 7) runs the map function in the browser instead of calling the retired backend — CouchDB
 * 3 has no server-side `_temp_view` either, so there is no CouchDB-native replacement.
 *
 * @param api - shared ApiClient (token already set by AuthService)
 * @param store - the `couchcompanion` document store (git accounts, repos, sync/conflict state)
 * @param credentials - resolves/persists git PATs per the account's chosen {@link CredentialMode}
 */
export class DesignMgmtService {
  constructor(
    private api: ApiClient,
    private store: CouchCompanionStore,
    private credentials: GitCredentialStore
  ) {}

  // -------------------------------------------------------------------------
  // design-docs tag
  // -------------------------------------------------------------------------

  /**
   * Lists every design document in a database, enriched with its git sync state where one exists.
   *
   * `GET /{db}/_design_docs` — deliberately without `include_docs=true`: `id`/`value.rev` from the
   * bare listing are all `TrackedDesignDoc` needs, and fetching every design doc's full body (they
   * can run tens of KB each) to throw it away was pure waste on every page load.
   *
   * The `sync:` lookup (`store.list(ID_PREFIX.sync)`, filtered to this database) is settled
   * independently via `.catch()` rather than joined into the same failure as the main read:
   * `couchcompanion` is admin-only, so a non-admin db member — exactly who this method's own
   * premise says should be able to browse design docs read-only — gets a 403 from the store the
   * moment any admin has ever registered a repository anywhere. That 403 is real and must still
   * surface from the git-account/repo screens that read `couchcompanion` directly; here it only
   * means "no git state to show", the same as a server that has never synced. The catch logs
   * (`db`/`status`/`message` only — never a token, never a document body) so the degraded state
   * is diagnosable instead of a design-doc table that quietly never shows git columns.
   */
  async listDesignDocs(serverId: string, dbName: string): Promise<TrackedDesignDoc[]> {
    const [resp, syncDocs] = await Promise.all([
      this.api.request<{
        rows: Array<{ id: string; value?: { rev?: string } }>;
      }>('GET', `${dbPath(dbName)}/_design_docs`),
      this.store.list<SyncStateDoc>(ID_PREFIX.sync).catch((err: unknown) => {
        log.warn('Could not load git sync state; showing design docs without git columns', {
          db: dbName,
          status: err instanceof ApiError ? err.status : undefined,
          message: err instanceof Error ? err.message : String(err)
        });
        return [];
      })
    ]);

    const syncByDdoc = new Map<string, SyncStateDoc>();
    for (const sync of syncDocs) {
      if (sync.database === dbName) syncByDdoc.set(sync.ddoc_id, sync);
    }

    return (resp.rows ?? []).map((row): TrackedDesignDoc => {
      const sync = syncByDdoc.get(row.id);
      return {
        server_id: serverId,
        server_name: null,
        db_name: dbName,
        ddoc_id: row.id,
        rev: row.value?.rev ?? null,
        ddoc_rev: sync?.ddoc_rev ?? null,
        git_repo_id: sync?.git_repo_id ?? null,
        last_git_sha: sync?.git_sha ?? null,
        last_sync: sync?.last_sync ?? null,
        updated_at: sync?.updated_at ?? null,
        sync_status: 'unknown'
      };
    });
  }

  /** `GET /{db}/_design/{name}`. Accepts either `_design/reports` or a bare `reports`. */
  getDesignDoc(serverId: string, dbName: string, ddocId: string): Promise<Record<string, unknown>> {
    return this.api.request('GET', docPath(dbName, normalizeDdocId(ddocId)));
  }

  /**
   * `PUT /{db}/_design/{name}` with `body` sent verbatim.
   *
   * Only a database or server admin may write a design document (verified live: a member gets a
   * **403** `"You are not a db or server admin."`); that error is surfaced as-is, never reworded.
   */
  saveDesignDoc(
    serverId: string,
    dbName: string,
    ddocId: string,
    body: unknown
  ): Promise<{ ok: boolean; id: string; rev: string }> {
    return this.api.request('PUT', docPath(dbName, normalizeDdocId(ddocId)), body);
  }

  /**
   * Executes the map function in the browser.
   *
   * CouchDB 3 answers `POST /{db}/_temp_view` with `410 gone`, so there is no server-side way to
   * try a view — and the backend this fork replaces never ran the function either: it checked
   * that the source began with `function`, contained `emit`, and had balanced braces, then
   * returned "[preview] doc N would be processed" for each sample. This runs the real thing, via
   * {@link runViewIsolated} (a Worker when one is available, an honestly-degraded in-page
   * fallback when it isn't) — no network call, so nothing here can fail with an `ApiError`.
   */
  async testView(req: TestViewRequest): Promise<TestViewResult> {
    const result = await runViewIsolated(req.map_function, req.sample_docs ?? [], req.reduce_function ?? null);
    return { rows: result.rows, error: result.error ?? undefined };
  }

  // -------------------------------------------------------------------------
  // git-repos tag
  // -------------------------------------------------------------------------

  /** The repository, if any, whose `sync_targets` include this (serverId, dbName) pair. */
  async getRepo(serverId: string, dbName: string): Promise<GetRepoResponse> {
    const repos = await this.store.list<GitRepo>(ID_PREFIX.repo);
    const repo =
      repos.find((r) => r.sync_targets?.some((t) => t.server_id === serverId && t.db_name === dbName)) ?? null;
    return { repo };
  }

  /**
   * Every registered repository, optionally filtered case-insensitively on name or url.
   * `truncated` is always `false` now — the fleet-wide cap the old backend enforced doesn't exist
   * client-side.
   */
  async listRepos(filter?: string): Promise<ListReposResponse> {
    const q = filter?.trim().toLowerCase();
    const repos = await this.store.list<GitRepo>(ID_PREFIX.repo);
    const filtered = !q
      ? repos
      : repos.filter(
          (r) => (r.name ?? '').toLowerCase().includes(q) || (r.url ?? '').toLowerCase().includes(q)
        );
    return { repos: filtered, truncated: false };
  }

  /**
   * Drops a single (serverId, dbName) target from `repo`, sweeping both the `sync:` documents
   * that target owned (`d.git_repo_id === repo._id && d.database === dbName` — with a single
   * server, D2/D3, that pair *is* the target) and, since fix round 1, its `conflict:` documents
   * the same way, then deletes `repo` if nothing tracked by it remains, else persists the
   * shrunken target list. A no-op — nothing removed, nothing written — when `repo` was never
   * actually tracking `dbName` for `serverId`, so a caller can never report (or act on) a removal
   * that didn't happen.
   *
   * `deletedSyncDocs` counts only `sync:` documents, matching {@link UnlinkRepoResponse}'s
   * existing, already-relied-on field name — the `conflict:` sweep is real but silent in the
   * return value rather than widening that contract.
   *
   * Sweeping `conflict:` here closes a real hole: without it, `unlinkRepo`/`registerRepo`'s
   * re-point path reset every affected document's sync state to "no record" while leaving its
   * `conflict:` document (if any) behind, un-owned and unfindable by any later sweep — exactly
   * the state {@link resolveUnknown} exists to handle safely going forward, but the stale document
   * itself should not linger regardless.
   *
   * The one helper both {@link unlinkRepo} and {@link registerRepo}'s cross-repo strip go
   * through, so "how a database stops being tracked by a repository" has exactly one
   * implementation rather than two that can drift.
   */
  private async detachTarget(
    repo: GitRepo,
    serverId: string,
    dbName: string
  ): Promise<{ removed: boolean; deletedSyncDocs: number; remainingTargets: number }> {
    const existingTargets = repo.sync_targets ?? [];
    const remaining = existingTargets.filter((t) => !(t.server_id === serverId && t.db_name === dbName));
    if (remaining.length === existingTargets.length) {
      return { removed: false, deletedSyncDocs: 0, remainingTargets: existingTargets.length };
    }

    const [syncDocs, conflictDocs] = await Promise.all([
      this.store.list<SyncStateDoc>(ID_PREFIX.sync),
      this.store.list<DesignConflict>(ID_PREFIX.conflict)
    ]);
    const toRemoveSync = syncDocs.filter((d) => d.git_repo_id === repo._id && d.database === dbName);
    const toRemoveConflict = conflictDocs.filter((d) => d.git_repo_id === repo._id && d.db_name === dbName);
    // One bulk delete carrying the revisions the listing above already returned — see
    // {@link CouchCompanionStore.removeAll}.
    await this.store.removeAll([...toRemoveSync, ...toRemoveConflict]);

    if (remaining.length === 0) {
      await this.store.remove(repo._id!);
    } else {
      await this.store.put(repo._id!, toDoc({ ...repo, sync_targets: remaining }));
    }
    return { removed: true, deletedSyncDocs: toRemoveSync.length, remainingTargets: remaining.length };
  }

  /**
   * Registers a target for `body.url`, or appends to the matching repository if one is already
   * registered under that URL (compared by {@link repoIdentity}, not raw string equality — see
   * IMPORTANT 2) — one document per repository, however many databases track it.
   *
   * This is also how a database gets *re-pointed* at a different repository: `design-list.ts`'s
   * "Manage Repository" drawer calls this for a (serverId, dbName) that may already be a target
   * of this repo, another repo, or no repo at all. Two things follow from that, both fixed after
   * review (Task 5 fix round 1):
   *
   *   1. **Same repo, same target** (editing branch/path): the existing target for this
   *      (serverId, dbName) is replaced, not duplicated — CRITICAL 1. Without this, every
   *      "Update" silently left the stale target in place (readers all use `.find()`/`[0]`, so
   *      they kept the old branch) while `sync_targets` grew without bound.
   *   2. **Same target, different repo** (re-pointing): the (serverId, dbName) target is dropped
   *      from every *other* repository — IMPORTANT 2. Without this, two repo documents could both
   *      claim the same target, and which one `getRepo` returned (via `.find()` over `_all_docs`
   *      order) was undefined — nondeterministic for the design list, the view editor, and
   *      Task 6's sync.
   *
   * The strip in (2) runs via {@link detachTarget} — which also sweeps that other repo's `sync:`
   * docs for `dbName`, fixed in review round 2: leaving them behind orphaned a `git_repo_id`
   * pointing at a now-deleted (or no-longer-tracking) document, and neither `deleteRepo`'s nor
   * `unlinkRepo`'s own sweep could ever find them again (both filter on the *new* repo's id).
   *
   * The strip also runs **after** the new/merged registration is durable, not before (also fixed
   * in round 2) — a `registerRepo` call used to be able to fail *after* deleting the old repo but
   * *before* writing the new one, destroying a registration instead of leaving it untouched. Now
   * the worst a failed write leaves behind is the target still claimed by two repos, which the
   * next successful `registerRepo` for either one self-heals — the strip runs over every match,
   * every time.
   *
   * Looks up `body.account_id` (when given) to stamp the repo's `provider` — `design-list.ts`'s
   * "Manage repository" flow (`openManageRepoDrawer`) reads that field back off `getRepo` and
   * refuses to open without it, so it cannot be left unset on documents created here.
   */
  async registerRepo(serverId: string, dbName: string, body: RegisterRepoBody): Promise<GitRepo> {
    const target: RepoTarget = {
      server_id: serverId,
      db_name: dbName,
      branch: body.branch ?? 'main',
      path: body.path ?? ''
    };
    const isSameTarget = (t: RepoTarget) => t.server_id === serverId && t.db_name === dbName;

    const account = body.account_id ? await this.store.get<GitAccountDoc>(body.account_id) : null;
    const provider = account?.provider as GitRepo['provider'] | undefined;

    const repos = await this.store.list<GitRepo>(ID_PREFIX.repo);
    const wantedIdentity = repoIdentity(body.url);
    const existing = repos.find((r) => r.url && repoIdentity(r.url) === wantedIdentity);

    let result: GitRepo;
    if (existing?._id) {
      const merged: GitRepo = {
        ...existing,
        account_id: body.account_id ?? existing.account_id ?? null,
        provider: provider ?? existing.provider,
        // Replace any prior target for this (serverId, dbName), never append a second one
        // (CRITICAL 1).
        sync_targets: [...(existing.sync_targets ?? []).filter((t) => !isSameTarget(t)), target]
      };
      const saved = await this.store.put(existing._id, toDoc(merged));
      result = { ...merged, _id: saved.id, _rev: saved.rev };
    } else {
      const id = newId(ID_PREFIX.repo);
      const doc: GitRepo = {
        doc_type: 'git_repo',
        name: body.name ?? repoNameFromUrl(body.url),
        provider,
        url: body.url,
        account_id: body.account_id ?? null,
        sync_targets: [target],
        sync_status: 'idle',
        last_sync: null,
        created_at: new Date().toISOString()
      };
      const saved = await this.store.put(id, toDoc(doc));
      result = { ...doc, _id: saved.id, _rev: saved.rev };
    }

    // Now that the new/merged registration is durable: reclaim this target from every OTHER
    // repository still claiming it (IMPORTANT 2), sweeping their sync: docs for dbName as we go.
    await Promise.all(
      repos
        .filter((r) => r._id && r._id !== existing?._id && r.sync_targets?.some(isSameTarget))
        .map((r) => this.detachTarget(r, serverId, dbName))
    );

    return result;
  }

  /**
   * Removes every `sync:` and `conflict:` document that referenced this repository, then the
   * repository registration itself — in that order, so a throw partway through leaves the
   * repository document still in place, still naming the bookkeeping a retry can find and finish
   * cleaning up. The opposite order is what strands documents: deleting the repository first, then
   * failing, leaves `sync:`/`conflict:` docs whose `git_repo_id` points at something no lookup can
   * ever resolve again. (This sentence used to state the rationale backwards; the code was always
   * the right way round, and matches {@link detachTarget}'s identical sweep-then-write order.)
   * `conflict:` sweeping added in fix round 1 — previously a deleted repository's unresolved
   * conflicts lingered forever.
   */
  async deleteRepo(id: string): Promise<void> {
    const [syncDocs, conflictDocs] = await Promise.all([
      this.store.list<SyncStateDoc>(ID_PREFIX.sync),
      this.store.list<DesignConflict>(ID_PREFIX.conflict)
    ]);
    await this.store.removeAll([
      ...syncDocs.filter((d) => d.git_repo_id === id),
      ...conflictDocs.filter((d) => d.git_repo_id === id)
    ]);
    await this.store.remove(id);
  }

  /**
   * Unlinks a single (serverId, dbName) target via {@link detachTarget}. Deletes the whole
   * repository once its last target is gone; otherwise just drops that one target and keeps the
   * rest — reporting `deleted_sync_docs` truthfully either way, and never claiming (or acting on)
   * a removal for a target this repository wasn't actually tracking: that case comes back as
   * `not_linked` (see {@link UnlinkRepoResponse.action}) rather than being reported as a removal.
   */
  async unlinkRepo(id: string, serverId: string, dbName: string): Promise<UnlinkRepoResponse> {
    const repo = await this.store.get<GitRepo>(id);
    if (!repo) throw new ApiError(404, `Git repository not found: ${id}`);

    const { removed, deletedSyncDocs, remainingTargets } = await this.detachTarget(repo, serverId, dbName);

    const action: UnlinkRepoResponse['action'] = !removed
      ? 'not_linked'
      : remainingTargets === 0
        ? 'repo_deleted'
        : 'target_removed';

    return {
      action,
      repo_id: id,
      remaining_targets: remainingTargets,
      deleted_sync_docs: deletedSyncDocs
    };
  }

  /**
   * Resolves a repository id to its document, the sync target for `dbName`, and a ready-to-use
   * provider — the shared preamble every sync flow below needs. A repository with no
   * `account_id`, or one whose targets don't cover `dbName`, cannot sync anything; both throw
   * here instead of leaving each flow to rediscover the same failure mode independently.
   */
  private async resolveSyncTarget(
    repoId: string,
    dbName: string
  ): Promise<{ repo: GitRepo; target: RepoTarget; provider: GitHubProvider }> {
    const repo = await this.store.get<GitRepo>(repoId);
    if (!repo) throw new ApiError(404, `Git repository not found: ${repoId}`);
    if (!repo.url) throw new Error(`Repository ${repoId} has no url configured.`);
    const target = repo.sync_targets?.find((t) => t.db_name === dbName);
    if (!target) throw new ApiError(404, `"${dbName}" is not a sync target of repository ${repoId}.`);
    if (!repo.account_id) throw new Error(`Repository ${repoId} has no linked git account.`);
    const { provider } = await this.providerFor(repo.account_id);
    return { repo, target, provider };
  }

  /** `GET /{db}/_design/{name}}`, with a 404 resolved to `null` — "this design doc doesn't exist
   *  in CouchDB (yet, or any more)" is a normal input to every sync flow, not a failure. */
  private async readDesignDocOrNull(dbName: string, ddocId: string): Promise<Record<string, unknown> | null> {
    try {
      return await this.api.request<Record<string, unknown>>('GET', docPath(dbName, ddocId));
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    }
  }

  /**
   * Reads one design doc's live CouchDB body, its file (if any) at the repository path, and any
   * prior `sync:` record, then classifies it — {@link resolveUnknown} already applied, so
   * `status` is never the raw `'unknown'`. The single place both {@link syncToRepo} and
   * {@link syncToCouch} read from; before fix round 1 each flow carried its own ~25-line copy of
   * exactly this, and the copies had silently diverged on what "safe to apply" meant.
   *
   * Fix round 2, NEW-1: when the document exists on **neither** side right now, this returns
   * `'synced'` (a safe no-op every caller already treats as "nothing to write here") without ever
   * calling `classify()`/`resolveUnknown` at all — reachable in practice from a stale UI
   * selection, where another tab or user deletes both the CouchDB document and the git file
   * between the list rendering and the sync click. Without this short-circuit, `classify()` falls
   * through to `'unknown'` (neither of its "one side has never seen it" rules fires when *both*
   * are absent), and folding that through `contentEqual` — trivially `false`, since there is no
   * content on either side to compare — fabricated a `'conflict'` for a document that doesn't
   * exist anywhere: `syncToRepo` wrote a permanent phantom conflict record, and `syncToCouch`
   * rejected the entire batch over it. This also covers the case where a *stale* `sync:` record
   * exists for a document since deleted from both sides — `classify()`'s own "both moved, content
   * differs" branch would otherwise reach the same false-conflict outcome.
   */
  private async readAndClassify(
    dbName: string,
    ddocId: string,
    repoUrl: string,
    target: RepoTarget,
    provider: GitHubProvider,
    shaByPath: Map<string, string>
  ): Promise<{
    filePath: string;
    couchDoc: Record<string, unknown> | null;
    gitBody: Record<string, unknown> | null;
    couchRev: string | null;
    gitSha: string | null;
    contentEqual: boolean;
    status: SyncStatus;
  }> {
    const filePath = designDocRepoPath(target.path, dbName, ddocId);
    const [couchDoc, fileContent, syncState] = await Promise.all([
      this.readDesignDocOrNull(dbName, ddocId),
      provider.getFile(repoUrl, target.branch, filePath),
      this.store.get<SyncStateDoc>(syncStateId(dbName, ddocId))
    ]);

    const couchRev = (couchDoc?._rev as string | undefined) ?? null;
    const gitSha = shaByPath.get(filePath) ?? null;
    const gitBody = fileContent !== null ? this.parseRepoFile(fileContent, filePath, target.branch) : null;
    const contentEqual = couchDoc !== null && gitBody !== null && sameContent(couchDoc, gitBody);

    if (couchRev === null && gitSha === null) {
      return { filePath, couchDoc, gitBody, couchRev, gitSha, contentEqual, status: 'synced' };
    }

    const rawStatus = classify({
      couchRev,
      gitSha,
      syncedRev: syncState?.ddoc_rev ?? null,
      syncedSha: syncState?.git_sha ?? null,
      contentEqual
    });

    return { filePath, couchDoc, gitBody, couchRev, gitSha, contentEqual, status: resolveUnknown(rawStatus, contentEqual) };
  }

  /**
   * Parses one design-doc file out of the repository, **failing the sync** — naming the file, the
   * branch and what is wrong with it — when it isn't valid JSON.
   *
   * The parse used to be a bare `JSON.parse` in {@link readAndClassify}, so a single hand-edited
   * file surfaced as `Sync failed: Unexpected token h in JSON at position 1`: a message that names
   * neither the file, nor the branch, nor anything the user can do (issue #6 item 10).
   *
   * **Why this aborts the sync rather than skipping the file.** Both flows write, and neither can
   * do so safely without this content:
   *  - `syncToCouch` would have to *write this document's body into CouchDB* — impossible when it
   *    cannot be parsed. Skipping would silently drop a document the user explicitly selected,
   *    with no counter to report it through (the signature is frozen at `Promise<void>`, D6) — a
   *    sync that says nothing and does less than asked.
   *  - `syncToRepo` needs the file to compute `contentEqual`, which is what separates "safe to
   *    push" from "conflict". Treating an unparseable file as *absent* (the other plausible skip)
   *    is worse than useless: it classifies as "only CouchDB has it" and pushes straight over the
   *    very file nobody could read, which is precisely the overwrite the conflict machinery exists
   *    to prevent.
   *
   * Both loops classify before they write anything, so the throw lands before the commit and
   * before the first `PUT` — the batch is refused whole, not left half-applied. `getRepoDocs` is
   * the deliberate exception: it only *reads*, so it drops an unparseable file (inside its
   * `Promise.allSettled`) and still lists everything else, exactly as it does for one that is too
   * large to fetch.
   */
  private parseRepoFile(content: string, filePath: string, branch: string): Record<string, unknown> {
    try {
      return JSON.parse(content) as Record<string, unknown>;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `The repository file "${filePath}" on branch "${branch}" is not valid JSON (${detail}), ` +
          `so this sync cannot tell what it contains. Fix or delete that file, then sync again.`
      );
    }
  }

  /** Upserts the `sync:` bookkeeping doc for one design doc after it's confirmed to match on both
   *  sides — either just-pushed/-pulled, or already identical and merely being reconciled. */
  private async saveSyncState(
    dbName: string,
    ddocId: string,
    repoId: string,
    couchRev: string | null,
    gitSha: string | null
  ): Promise<void> {
    const now = new Date().toISOString();
    await this.store.put(
      syncStateId(dbName, ddocId),
      toDoc({
        doc_type: 'sync_state',
        database: dbName,
        ddoc_id: ddocId,
        git_repo_id: repoId,
        git_sha: gitSha,
        ddoc_rev: couchRev,
        last_sync: now,
        updated_at: now
      })
    );
  }

  /**
   * Records a detected conflict so {@link listConflicts} surfaces it — never overwritten by the
   * sync that found it (that's the whole point: the conflicted doc is excluded from the commit
   * that would otherwise clobber one side).
   *
   * Fix round 1: re-detecting the *same* conflict (the `(couch_rev, git_sha)` pair unchanged from
   * what's already on file) preserves the existing document's `resolved` and `detected_at`
   * instead of rebuilding it from scratch. Without this, acknowledging a conflict
   * (`resolveConflict`) never stuck — the next sync attempt against the same, still-unreconciled
   * pair would flip `resolved` back to `false` and stamp a fresh `detected_at`, making an
   * already-acknowledged conflict look brand new. Only a genuinely *new* pair (either rev/sha
   * actually moved since the document was last written) resets both fields.
   *
   * Also stamps `git_repo_id` (fix round 1 — the field the repo-scoped sweeps in
   * {@link detachTarget}/{@link deleteRepo} need; absent on a conflict written before this field
   * existed, which those sweeps then simply cannot find, same as any other stale document).
   *
   * The write is wrapped in its own try/catch (Task 8), deliberately swallowing a failure rather
   * than letting it propagate: both callers detected a genuine conflict before calling this, and
   * that is the fact the user must see. Before this fix, a `store.put` failure here
   * (`couchcompanion` unreachable, a transient 5xx, ...) replaced the conflict message the caller
   * was about to show/throw with this method's own failure — "couchcompanion unreachable" instead
   * of "this document has a conflict, resolve it first," which is not only less true but actively
   * hides the reason the sync stopped. The record simply doesn't get persisted this time; the next
   * sync attempt against the same (still-unresolved) pair calls this again.
   */
  private async writeConflict(
    dbName: string,
    ddocId: string,
    couchRev: string | null,
    gitSha: string | null,
    branch: string,
    repoId: string
  ): Promise<void> {
    const id = conflictId(dbName, ddocId);
    const couchRevValue = couchRev ?? '';
    const gitShaValue = gitSha ?? '';
    try {
      const existing = await this.store.get<DesignConflict>(id);
      const samePair = existing?.couch_rev === couchRevValue && existing?.git_sha === gitShaValue;

      await this.store.put(
        id,
        toDoc({
          doc_type: 'conflict',
          server_id: SINGLE_SERVER_ID,
          db_name: dbName,
          ddoc_id: ddocId,
          git_repo_id: repoId,
          couch_rev: couchRevValue,
          git_sha: gitShaValue,
          conflict_branch: branch,
          resolved: samePair ? existing!.resolved : false,
          detected_at: samePair ? existing!.detected_at : new Date().toISOString()
        })
      );
    } catch (err) {
      log.warn('Could not persist a conflict record; the conflict itself is still reported to the caller', {
        db: dbName,
        ddocId,
        message: err instanceof Error ? err.message : String(err)
      });
    }
  }

  /**
   * `GitHubProvider.commitFiles` rejects with a 422 `GitHttpError` when the branch moved
   * underneath the sync (its ref update always passes `force: false`) — the raw GitHub message is
   * terse REST-API prose ("Update is not a fast forward"), not something a user can act on. This
   * names the branch and says what actually happened instead of passing that message through
   * verbatim (Task 6 decision 3). Any other failure (network, auth, rate limit) is rethrown as-is.
   */
  private explainCommitFailure(err: unknown, branch: string): Error {
    if (err instanceof GitHttpError && err.status === 422) {
      return new Error(
        `Branch "${branch}" changed in the repository while this sync was running. Reload and try again.`
      );
    }
    return err instanceof Error ? err : new Error(String(err));
  }

  /**
   * Returns the design documents found in the git repository for a given database.
   *
   * Enumerates the target path via `GitHubProvider.listTree` (one API call), then reads each
   * matching file's content via `getFile` (one call per file). That per-file cost is why the
   * fan-out is capped at {@link MAX_REPO_DOCS} — each file is a call against a rate limit the
   * caller does not control, and returning every one of a very large repository's files by
   * default would read as "the repository has this many files" when it silently doesn't. The
   * truncation warning logs the dropped *paths*, not just a count — from this method's own
   * output a silent count still reads to a caller as "the repository has 50 files".
   *
   * `onTruncated` (additive and optional, so no existing caller changes) exists because a
   * `log.warn` is not a disclosure: nothing rendered it, so in the UI the cap *was* the silent
   * truncation this method's own comment says it must never be. A caller that passes this can put
   * the fact on screen; one that doesn't still gets the log. It fires **after** the per-file reads
   * (issue #6 item 6 — it used to fire before them, reporting a `shown` that counted files this
   * method had not read yet, and so overstated the list by every read that then failed) and covers
   * both reasons a document can be missing from the result: the cap, and a file that could not be
   * read at all. See {@link RepoDocsTruncation}.
   *
   * Two fix-round-1 corrections:
   *  - **Scoped to `dbName`.** `listTree` with the target's (commonly empty, repo-root) `path`
   *    returns the *whole* tree; `ddocIdFromPath` alone matches any `**\/_design/*.json`,
   *    including another database's files (`hr/_design/salaries.json`) or a root-level one
   *    (`_design/rootlevel.json`) — both would have been returned stamped `db_name: dbName`,
   *    rendered as phantom git-only rows, and "Delete from Git" would then commit a delete for a
   *    path that isn't actually this database's. Filtered to entries whose path is *exactly*
   *    what `designDocRepoPath(target.path, dbName, <recovered id>)` would build.
   *  - **One bad file no longer fails the whole list.** `getFile` deliberately *throws* (not
   *    `null`) for a file too large for the Contents API — correct and load-bearing for the sync
   *    flows below, which must never conflate "too large to read" with "does not exist" and
   *    overwrite it. This read-only listing has no such write-safety obligation, so a single
   *    oversized or otherwise unreadable file is dropped (logged) via `Promise.allSettled`
   *    instead of failing every other document in the database.
   */
  async getRepoDocs(
    id: string,
    dbName: string,
    onTruncated?: (info: RepoDocsTruncation) => void
  ): Promise<GitDesignDoc[]> {
    const { repo, target, provider } = await this.resolveSyncTarget(id, dbName);
    const tree = await provider.listTree(repo.url!, target.branch, target.path);
    const entries = tree.filter((e) => {
      const ddocId = ddocIdFromPath(e.path);
      return ddocId !== null && e.path === designDocRepoPath(target.path, dbName, ddocId);
    });
    const included = entries.slice(0, MAX_REPO_DOCS);
    const cappedPaths = entries.slice(MAX_REPO_DOCS).map((e) => e.path);
    if (cappedPaths.length > 0) {
      log.warn(`Repository has more design docs than the ${MAX_REPO_DOCS}-file cap; showing a subset`, {
        db: dbName,
        repoId: id,
        total: entries.length,
        dropped: cappedPaths.length,
        droppedPaths: cappedPaths
      });
    }

    const settled = await Promise.allSettled(
      included.map(async (entry): Promise<GitDesignDoc> => {
        const content = await provider.getFile(repo.url!, target.branch, entry.path);
        return {
          info: {
            db_name: dbName,
            ddoc_id: ddocIdFromPath(entry.path)!,
            git_repo_id: id,
            git_sha: entry.sha,
            last_updated: null
          },
          content: content ? (JSON.parse(content) as Record<string, unknown>) : {}
        };
      })
    );

    const docs: GitDesignDoc[] = [];
    const unreadablePaths: string[] = [];
    settled.forEach((outcome, i) => {
      if (outcome.status === 'fulfilled') {
        docs.push(outcome.value);
        return;
      }
      unreadablePaths.push(included[i].path);
      log.warn('Could not read a design doc from the repository; omitting it from the list', {
        db: dbName,
        repoId: id,
        path: included[i].path,
        message: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)
      });
    });

    // Reported only now, with the count of what actually came back rather than of what this
    // method set out to read (issue #6 item 6), and covering both reasons a document can be
    // missing — the cap, and a file that could not be read. A caller putting this on screen is
    // the only disclosure either one gets; a `log.warn` nobody renders is not one.
    if (docs.length < entries.length) {
      onTruncated?.({
        shown: docs.length,
        total: entries.length,
        droppedPaths: [...cappedPaths, ...unreadablePaths],
        unreadablePaths
      });
    }
    return docs;
  }

  /**
   * Removes the given design docs from the git repository in one commit (`content: null` per
   * path — the same "delete" `GitHubProvider.commitFiles` already understands), then drops their
   * `sync:` **and `conflict:`** bookkeeping so a deleted file doesn't linger as "still tracked" or,
   * worse, as an unresolved conflict against a file that no longer exists. A no-op — no commit, no
   * repository/account lookup — when `docsToDelete` is empty, matching `commitFiles`' own refusal
   * to create an empty commit.
   *
   * The `conflict:` half was missing (issue #6 item 2) while {@link detachTarget},
   * {@link deleteRepo} and {@link unlinkRepo} all swept it: deleting the very file a conflict was
   * detected against left the record behind, and no later sweep for that (database, ddoc) pair
   * could produce a matching one again — it simply sat in the conflicts list forever.
   */
  async deleteRepoDocs(
    id: string,
    dbName: string,
    docsToDelete: string[]
  ): Promise<Record<string, { deleted: boolean; commit_sha: string }>> {
    if (docsToDelete.length === 0) return {};
    const { repo, target, provider } = await this.resolveSyncTarget(id, dbName);
    const changes: FileChange[] = docsToDelete.map((name) => ({
      path: designDocRepoPath(target.path, dbName, name),
      content: null
    }));
    let result;
    try {
      result = await provider.commitFiles(
        repo.url!,
        target.branch,
        `Delete ${docsToDelete.length} design doc(s) via Couch Companion`,
        changes
      );
    } catch (err) {
      throw this.explainCommitFailure(err, target.branch);
    }
    await this.forgetSyncState(dbName, docsToDelete);

    const out: Record<string, { deleted: boolean; commit_sha: string }> = {};
    for (const name of docsToDelete) out[name] = { deleted: true, commit_sha: result.commit_sha };
    return out;
  }

  /**
   * Drops the git bookkeeping — the `sync:` record and any `conflict:` record — for design
   * documents that no longer exist on the side the caller just deleted them from. Touches neither
   * CouchDB nor the repository: it only forgets what was being tracked.
   *
   * {@link deleteRepoDocs} uses it for its own post-commit sweep, but it is public because the
   * *CouchDB*-side delete has exactly the same leak (issue #6 item 2, widened): `design-list.ts`'s
   * "delete from CouchDB" mode calls `DbMgmtService.deleteDocuments` directly and leaves both
   * documents behind — a `sync:` record claiming a design doc is tracked when it is gone, and a
   * `conflict:` record no longer resolvable against anything. The `sync:`/`conflict:` id shapes
   * belong to this service (nothing outside it should have to know them), so the cleanup lives
   * here rather than in the component.
   *
   * Accepts either `_design/reports` or a bare `reports` — {@link syncStateId}/{@link conflictId}
   * normalize both. One bulk delete for the whole set; already-absent documents are skipped by
   * {@link CouchCompanionStore.removeAll} rather than failing the sweep.
   */
  async forgetSyncState(dbName: string, ddocIds: string[]): Promise<void> {
    if (ddocIds.length === 0) return;
    await this.store.removeAll(
      ddocIds.flatMap((ddocId) => [syncStateId(dbName, ddocId), conflictId(dbName, ddocId)])
    );
  }

  /**
   * Writes the requested design documents from CouchDB into the git repository, as one commit.
   *
   * Every requested doc key is validated up front (`parseDocKey`, throwing on a key naming a
   * different database), duplicates collapsed (a key repeated in the request must not be pushed,
   * or counted, twice), before any I/O happens — a malformed request must never partially apply.
   * Per doc, {@link readAndClassify} reads the live CouchDB body, the repository file (if any),
   * and any prior `sync:` record, then resolves a status.
   *
   * Three outcomes, fix round 1's direction-aware gate (`canApply(status, 'toRepo')`) replacing
   * the earlier "anything that isn't a conflict" rule that silently pushed a stale CouchDB copy
   * over a colleague's git-side edit (`newer_in_git`, refused now — CRITICAL, fix round 1):
   *  - `conflict` is excluded from the commit and recorded via {@link writeConflict} instead of
   *    overwriting the file.
   *  - `newer_in_git` (only the file moved) is refused and silently skipped, counted in the
   *    returned `skipped` (fix round 2, NEW-3) — there is nothing in CouchDB newer than what's
   *    already in the repository, so pushing would just revert it. A document that currently
   *    exists on **neither** side (fix round 2, NEW-1 — e.g. a stale selection racing a delete on
   *    both sides) is skipped the same way, not treated as a conflict.
   *  - `newer_in_couch` or `synced` may be applied. A `synced` (or, after `resolveUnknown`, an
   *    already-agreeing pair with no sync record) whose content already matches what's in the
   *    repository is skipped too, but for a different reason (not counted in `skipped` — nothing
   *    was refused, there was just nothing to commit) — forcing a no-op commit would spam the
   *    repository's history on every sync; its `sync:` state is still reconciled.
   *
   * Everything left over lands in exactly one `commitFiles` call, and each pushed (or reconciled)
   * doc gets its `sync:` state updated with the new git blob sha.
   */
  async syncToRepo(id: string, dbName: string, req: SyncRequest): Promise<SyncResult> {
    const ddocIds = [...new Set(req.docs.map((key) => parseDocKey(key, dbName)))];
    const { repo, target, provider } = await this.resolveSyncTarget(id, dbName);

    const tree = await provider.listTree(repo.url!, target.branch, target.path);
    const shaByPath = new Map(tree.map((e) => [e.path, e.sha]));

    const toCommit: { ddocId: string; filePath: string; couchRev: string; body: Record<string, unknown> }[] = [];
    const toHeal: { ddocId: string; couchRev: string; gitSha: string | null }[] = [];
    let conflicts = 0;
    let skipped = 0;

    for (const ddocId of ddocIds) {
      const { filePath, couchDoc, couchRev, gitSha, contentEqual, status } = await this.readAndClassify(
        dbName,
        ddocId,
        repo.url!,
        target,
        provider,
        shaByPath
      );

      if (status === 'conflict') {
        conflicts += 1;
        await this.writeConflict(dbName, ddocId, couchRev, gitSha, target.branch, id);
        continue;
      }
      if (!canApply(status, 'toRepo')) {
        skipped += 1; // newer_in_git — nothing to push; refused, not conflicted.
        continue;
      }
      if (!couchDoc) {
        // Exists on neither side (readAndClassify's NEW-1 short-circuit) — nothing to push.
        skipped += 1;
        continue;
      }
      if (contentEqual) {
        toHeal.push({ ddocId, couchRev: couchRev!, gitSha });
        continue;
      }
      toCommit.push({ ddocId, filePath, couchRev: couchRev!, body: couchDoc });
    }

    let synced = 0;
    if (toCommit.length > 0) {
      const changes: FileChange[] = toCommit.map((p) => ({ path: p.filePath, content: serializeDdoc(p.body) }));
      let result;
      try {
        result = await provider.commitFiles(
          repo.url!,
          target.branch,
          `Sync ${toCommit.length} design doc(s) from CouchDB via Couch Companion`,
          changes
        );
      } catch (err) {
        throw this.explainCommitFailure(err, target.branch);
      }
      const shaByCommittedPath = new Map(result.file_shas.map((f) => [f.path, f.blob_sha]));
      for (const p of toCommit) {
        await this.saveSyncState(dbName, p.ddocId, id, p.couchRev, shaByCommittedPath.get(p.filePath) ?? null);
        synced += 1;
      }
    }

    await Promise.all(toHeal.map((h) => this.saveSyncState(dbName, h.ddocId, id, h.couchRev, h.gitSha)));

    return {
      status: conflicts > 0 ? 'conflict' : 'synced',
      synced,
      conflicts,
      skipped,
      // Counted, not folded into `synced`: nothing was committed for these, and a caller that
      // reports "N synced" must not claim a commit that never happened. Leaving them uncounted is
      // what produced "Synced to repo successfully (0 synced)" for a reconcile-only sync.
      reconciled: toHeal.length
    };
  }

  /**
   * Applies the requested design documents from the git repository to CouchDB.
   *
   * The mirror image of {@link syncToRepo} — same up-front key validation and de-duplication,
   * same {@link readAndClassify} per doc (including its NEW-1 short-circuit for a document that
   * exists on neither side, silently skipped rather than misclassified as a conflict), same
   * direction-aware gate (`canApply(status, 'toCouch')`), refusing `newer_in_couch` (only the
   * CouchDB document moved — pulling the file would silently destroy that edit; this exact case
   * was fix round 1's CRITICAL finding) the same way `syncToRepo` refuses `newer_in_git`.
   * Conflicts are still handled the other way round from `syncToRepo` on purpose: every requested
   * doc is classified in one pre-flight pass before any `PUT` is issued, and if *any* of them is a
   * `conflict`, the whole call rejects with nothing written — silently applying part of a batch
   * while refusing the rest would leave the caller unable to tell which of their local edits
   * survived, a risk a single CouchDB write sequence doesn't carry the same recovery story that
   * one atomic git commit does. A conflict here is still recorded via {@link writeConflict}
   * before the throw (fix round 2 — previously this method's own "resolve it first" error could
   * point at a conflicts list with no matching entry, unless a `syncToRepo` had happened to run
   * first and recorded it).
   *
   * That pre-flight pass is the only part of this method that is genuinely all-or-nothing. The
   * write loop after it is not (fix round 1 — the doc comment used to claim otherwise): each `PUT`
   * is a separate CouchDB write, so a failure on document 2 of 3 leaves document 1 already
   * written and its `sync:` state saved. Because this method's signature is frozen at
   * `Promise<void>` (D6), a partial failure can't be returned as data — instead it's thrown as an
   * error naming exactly which documents were written, which were written but had their `sync:`
   * bookkeeping fail right after (fix round 2, NEW-2 — a document is recorded as written the
   * instant its `PUT` resolves, *before* the bookkeeping write is even attempted, so that failure
   * can never be mis-reported as "not written" — a re-run is always safe either way, since it
   * just `PUT`s the same content again), and which were never attempted at all. For everything
   * applied, the live CouchDB `_rev` is injected into the body when the document already exists,
   * and omitted entirely when it doesn't (a `_rev` on a create is a guaranteed 409 — Task 6
   * decision 2). The repository body is stripped of any `_id`/`_rev`/`_revisions` it happens to
   * carry (a hand-edited file could) before CouchDB's own id/rev are applied. A doc whose content
   * already matches CouchDB's is skipped (its `sync:` state is still reconciled) for the same
   * reason `syncToRepo` skips one — a no-op write is not free, and CouchDB would still mint a new,
   * semantically pointless revision.
   */
  async syncToCouch(id: string, dbName: string, req: SyncRequest): Promise<void> {
    const ddocIds = [...new Set(req.docs.map((key) => parseDocKey(key, dbName)))];
    const { repo, target, provider } = await this.resolveSyncTarget(id, dbName);

    const tree = await provider.listTree(repo.url!, target.branch, target.path);
    const shaByPath = new Map(tree.map((e) => [e.path, e.sha]));

    const toApply: { ddocId: string; gitSha: string | null; couchRev: string | null; body: Record<string, unknown> }[] =
      [];
    const toHeal: { ddocId: string; couchRev: string | null; gitSha: string | null }[] = [];
    const conflicted: string[] = [];

    for (const ddocId of ddocIds) {
      const { gitBody, couchRev, gitSha, contentEqual, status } = await this.readAndClassify(
        dbName,
        ddocId,
        repo.url!,
        target,
        provider,
        shaByPath
      );

      if (status === 'conflict') {
        // Fix round 2: write the conflict record here too, exactly as syncToRepo does — this
        // error message points the user at "resolve it first," and until this fix that pointed
        // at a conflicts list containing no such entry unless a syncToRepo happened to run first.
        //
        // Issue #6 item 5: recorded and *collected*, not thrown on the spot. The throw used to sit
        // right here, inside the loop, so documents 2..N of a conflicted batch were never
        // classified and never recorded — the conflicts screen showed one entry, the user resolved
        // it, re-ran, and met the next conflict for the first time. Nothing is written to CouchDB
        // before this loop completes, so deferring the throw to just after it costs nothing of the
        // all-or-nothing guarantee below and buys a complete conflicts list from a single run.
        conflicted.push(ddocId);
        await this.writeConflict(dbName, ddocId, couchRev, gitSha, target.branch, id);
        continue;
      }
      if (!canApply(status, 'toCouch')) {
        // newer_in_couch — nothing to pull; refused, not applied. syncToCouch's signature is
        // frozen at Promise<void> (D6), so this has no counter to report it through the way
        // syncToRepo's `skipped` does — a log line is the only trace this refusal leaves.
        log.info('Refused to pull a design doc into CouchDB — only the CouchDB side has moved', {
          db: dbName,
          ddocId,
          status
        });
        continue;
      }
      if (gitBody === null) continue; // Nothing in the repository to pull for this doc (incl. NEW-1's absent-everywhere case).
      if (contentEqual) {
        toHeal.push({ ddocId, couchRev, gitSha });
        continue;
      }
      toApply.push({ ddocId, gitSha, couchRev, body: gitBody });
    }

    // Every conflict in the batch is on file by now, and still nothing has been written: the
    // whole call rejects, naming all of them, so one run tells the user everything they have to
    // resolve rather than one document per attempt.
    if (conflicted.length > 0) {
      const names = conflicted.map((ddocId) => `"${ddocId}"`).join(', ');
      throw new Error(
        conflicted.length === 1
          ? `Cannot sync ${names} to CouchDB: it has a conflict with the repository. Resolve it first.`
          : `Cannot sync ${conflicted.length} documents to CouchDB: ${names} have conflicts with the ` +
            `repository. Resolve them first.`
      );
    }

    // Fix round 2, NEW-2: `written` records a document the instant its PUT resolves — before
    // `saveSyncState` even runs — so a bookkeeping failure right after a successful write can
    // never be reported as "not applied." `recorded` tracks the (usually identical) subset whose
    // sync: state was *also* saved; the difference between the two, when non-empty, is a document
    // that landed in CouchDB but whose bookkeeping needs a re-sync — never a document at risk of
    // being silently re-clobbered, since a re-run just PUTs the same content again.
    const written: string[] = [];
    const recorded: string[] = [];
    try {
      for (const p of toApply) {
        // Destructured only to drop CouchDB metadata a hand-edited repo file might carry — this
        // project's ESLint config has no unused-vars rule to satisfy, so no suppression is needed.
        const { _id, _rev, _revisions, ...rest } = p.body as Record<string, unknown> & {
          _id?: unknown;
          _rev?: unknown;
          _revisions?: unknown;
        };
        const body: Record<string, unknown> = { ...rest, _id: p.ddocId, ...(p.couchRev ? { _rev: p.couchRev } : {}) };
        const saved = await this.api.request<{ ok: boolean; id: string; rev: string }>(
          'PUT',
          docPath(dbName, p.ddocId),
          body
        );
        written.push(p.ddocId);
        await this.saveSyncState(dbName, p.ddocId, id, saved.rev, p.gitSha);
        recorded.push(p.ddocId);
      }
    } catch (err) {
      const neverWritten = toApply.slice(written.length).map((p) => p.ddocId);
      const writtenNotRecorded = written.slice(recorded.length);
      const message = err instanceof Error ? err.message : String(err);
      const notRecordedNote =
        writtenNotRecorded.length > 0
          ? ` (written but its sync state was not recorded — safe to re-sync: [${writtenNotRecorded.join(', ')}])`
          : '';
      throw new Error(
        `syncToCouch wrote ${written.length} of ${toApply.length} document(s) to CouchDB before failing — ` +
          `written: [${written.join(', ')}]${notRecordedNote}, never written: [${neverWritten.join(', ')}]. ` +
          `Cause: ${message}`
      );
    }

    await Promise.all(toHeal.map((h) => this.saveSyncState(dbName, h.ddocId, id, h.couchRev, h.gitSha)));
  }

  // -------------------------------------------------------------------------
  // git-accounts tag
  // -------------------------------------------------------------------------

  /**
   * Never includes `auth` — a secret is masked at this boundary so no caller can leak what it
   * never received.
   */
  private maskAccount(doc: GitAccountDoc): GitAccount {
    return {
      _id: doc._id,
      provider: doc.provider,
      label: doc.label,
      username: doc.username ?? null,
      base_url: doc.base_url ?? null,
      // Where the token lives, never the token itself — this stays an explicit allow-list.
      credential_mode: doc.credential_mode ?? 'none'
    };
  }

  async getGitAccounts(): Promise<GitAccount[]> {
    const accounts = await this.store.list<GitAccountDoc>(ID_PREFIX.account);
    return accounts.map((doc) => this.maskAccount(doc));
  }

  /**
   * Verifies the token with the provider (`whoami`) before persisting anything, then writes the
   * account document. The token is embedded in the document body only in `couchdb` mode; every
   * other mode routes it to {@link GitCredentialStore.put} instead.
   *
   * `credential_mode` is not part of the frozen {@link ConnectGitAccountRequest} shape (D6); it is
   * read off the request loosely so a future settings UI can opt an account into `couchdb` or
   * `indexeddb` storage without widening this method's declared parameter type. Absent, it
   * defaults to `'none'`.
   */
  async postGitAccounts(req: ConnectGitAccountRequest): Promise<GitAccount> {
    const mode: CredentialMode =
      (req as ConnectGitAccountRequest & { credential_mode?: CredentialMode }).credential_mode ?? 'none';

    let username = req.username ?? null;
    if (req.provider === 'github' && req.token) {
      const whoami = await new GitHubProvider(new GitHttp(() => req.token), req.base_url ?? null).whoami();
      username = username ?? whoami.login;
    }

    const id = newId(ID_PREFIX.account);
    const doc = {
      doc_type: 'git_account',
      provider: req.provider,
      label: req.label,
      username,
      base_url: req.base_url ?? null,
      credential_mode: mode,
      created_at: new Date().toISOString(),
      ...(mode === 'couchdb' && req.token ? { auth: { token: req.token } } : {})
    };

    const saved = await this.store.put(id, doc);

    if (req.token) {
      if (mode === 'couchdb') {
        // Already embedded in the document above; just warm the session cache.
        this.credentials.remember(id, req.token);
      } else {
        await this.credentials.put(id, mode, req.token);
      }
    }

    return this.maskAccount({ ...doc, _id: saved.id });
  }

  async getGitAccount(id: string): Promise<GitAccount> {
    const doc = await this.store.get<GitAccountDoc>(id);
    if (!doc) throw new ApiError(404, `Git account not found: ${id}`);
    return this.maskAccount(doc);
  }

  /**
   * Renames an account, and nothing else.
   *
   * Deliberately not folded into a general `updateGitAccount`: a rename must never be able to
   * take the security-critical path {@link changeCredentialMode} owns, and the mode change needs
   * a return type that can say "I need a token" — which a rename should not have to model.
   *
   * Reads and writes the **whole** document: {@link CouchCompanionStore.put} replaces rather than
   * merges (its own doc comment notwithstanding), so a partial body would silently drop
   * `provider` — permanently breaking {@link providerFor}, which throws for anything that is not
   * `github` and would never see the field restored — along with `username`, `base_url`,
   * `created_at`, `doc_type` and, in `couchdb` mode, `auth.token` itself. Losing the token to a
   * rename would be indistinguishable from a revoked PAT.
   *
   * Only `label` and `credential_mode` are editable at all (#9). `base_url` is excluded on
   * purpose: `providerFor` builds the API root from it, a PAT is host-scoped, and `repoIdentity`
   * canonicalises on host — so repointing an account would silently orphan every repository
   * registered under the old host. `provider` is stamped onto repositories by `registerRepo` and
   * must never move.
   */
  async renameGitAccount(accountId: string, label: string): Promise<GitAccount> {
    const trimmed = label.trim();
    if (!trimmed) throw new ApiError(400, 'A git account needs a label.');

    const doc = await this.store.get<GitAccountDoc>(accountId);
    if (!doc) throw new ApiError(404, `Git account not found: ${accountId}`);

    const { _rev: _ignored, ...rest } = doc;
    const next = { ...rest, label: trimmed };
    await this.store.put(accountId, toDoc(next));
    return this.maskAccount(next);
  }

  /**
   * Moves an account's token to a different {@link CredentialMode} — the operation #9 was filed
   * as a warning about, and the reason it has to live here rather than in the screen: `credentials`
   * is private, is not on `AppContext`, and {@link maskAccount} is an allow-list that guarantees no
   * public method ever hands a caller a token. A component physically cannot move one.
   *
   * The hazard is not the field, it is the copy underneath it. {@link GitCredentialStore.put}
   * writes under the *new* mode and does not purge the old backing store, while
   * {@link GitCredentialStore.get} consults the session cache *before* the mode — so in the tab
   * that made the change everything keeps working and the abandoned copy is invisible. Only
   * {@link GitCredentialStore.forget} clears all three locations.
   *
   * Hence the fixed order — read, `forget()`, write the document, then `put()`:
   *
   * 1. `forget()` runs **before** any write, mirroring the guarantee {@link deleteGitAccount}
   *    already makes, and **after** the token is safely in a local — it clears the session cache
   *    first, which for an account in mode `none` is the only place the token exists.
   * 2. The document is written **before** the new token. The reverse order would strand a live
   *    token in a store nothing will ever consult again if the document write fails; this order's
   *    worst outcome is "no token anywhere", which the existing sync-time prompt already recovers
   *    from.
   *
   * The body written strips `auth` unconditionally rather than re-reading the document after
   * `forget()`. Both prevent resurrecting the token `forget()` just stripped, but the strip does
   * not depend on `CouchTokenIo.writeToken` continuing to be implemented as "remove `auth`, keep
   * the rest" — and it costs one fewer round trip. See {@link renameGitAccount} for why the rest
   * of the document is written back whole.
   *
   * @param token - a freshly typed token, preferred over any stored copy; required only when the
   *   old mode is `none` and this tab has nothing cached, which is answered with
   *   `{status: 'token_required'}` **having changed nothing at all**.
   */
  async changeCredentialMode(
    accountId: string,
    newMode: CredentialMode,
    token?: string
  ): Promise<CredentialModeChange> {
    const doc = await this.store.get<GitAccountDoc>(accountId);
    if (!doc) throw new ApiError(404, `Git account not found: ${accountId}`);
    const oldMode: CredentialMode = doc.credential_mode ?? 'none';

    // Mode `none` stores nothing, so there is nothing to carry across and no reason to demand a
    // token: for that target, `forget()` below *is* the whole operation.
    let carried: string | null = null;
    if (newMode !== 'none') {
      carried = token ?? (await this.credentials.get(accountId, oldMode));
      if (!carried) return { status: 'token_required' };
    }

    await this.credentials.forget(accountId);

    const { _rev: _ignored, auth: _purged, ...rest } = doc;
    await this.store.put(accountId, toDoc({ ...rest, credential_mode: newMode }));

    if (carried !== null) await this.credentials.put(accountId, newMode, carried);
    return { status: 'changed', from: oldMode, to: newMode };
  }

  /**
   * `store.remove` plus {@link GitCredentialStore.forget}, so deleting an account can never leave
   * its token behind in IndexedDB or the session cache after the document is gone. `forget()` runs
   * in `finally` — even if removing the document fails partway, the token still gets purged rather
   * than stranded because the earlier step threw.
   */
  async deleteGitAccount(id: string): Promise<void> {
    try {
      await this.store.remove(id);
    } finally {
      await this.credentials.forget(id);
    }
  }

  /**
   * Warms the in-tab session cache with a token entered at a sync-time prompt — the entire
   * behavior credential mode `none` promises (D12): a token typed here is held only in
   * {@link GitCredentialStore}'s in-memory `Map` for the rest of this tab's life, exactly like a
   * token freshly connected in `none` mode already is. Never reaches IndexedDB or `couchcompanion`
   * — `GitCredentialStore.remember` has no code path to either.
   */
  rememberAccountToken(accountId: string, token: string): void {
    this.credentials.remember(accountId, token);
  }

  /**
   * Stores a token entered at a sync-time prompt **under the account's own credential mode** —
   * session-only for `none` (via {@link rememberAccountToken}), and through
   * {@link GitCredentialStore.put} for `indexeddb`/`couchdb`, replacing whatever stale copy is
   * there.
   *
   * The prompt used to `remember()` unconditionally, which is correct for `none` and a trap for
   * the two persisting modes: `GitCredentialStore.get` consults the session cache first, so the
   * retry succeeded and the tab kept working — but `postGitAccounts` was the only caller that ever
   * wrote through `put()`, so the rejected token was still on disk (or in `couchcompanion`) and
   * every fresh tab read it back. With no account-edit screen anywhere in the app, a rotated PAT
   * was permanently unrecoverable: prompt, work, reload, prompt again, forever.
   *
   * A failed mode lookup degrades to session-only rather than throwing — the user has just typed a
   * token to get their sync unstuck, and losing it over a `couchcompanion` read is a worse
   * outcome than not persisting it.
   */
  async saveAccountToken(accountId: string, token: string): Promise<CredentialMode> {
    let mode: CredentialMode = 'none';
    try {
      const account = await this.store.get<GitAccountDoc>(accountId);
      mode = account?.credential_mode ?? 'none';
    } catch (err) {
      log.warn('Could not read a git account credential mode; keeping the token for this tab only', {
        accountId,
        message: err instanceof Error ? err.message : String(err)
      });
      this.rememberAccountToken(accountId, token);
      return 'none';
    }

    if (mode === 'none') this.rememberAccountToken(accountId, token);
    else await this.credentials.put(accountId, mode, token);
    return mode;
  }

  /**
   * Resolves the stored account, its credential-mode token (if any), and a ready-to-use
   * {@link GitHubProvider}. GitHub is the only provider implemented (D11); any other `provider`
   * value throws rather than silently returning a non-functional client.
   *
   * Does not itself require a token — {@link getGitRepoBranches} works against public repositories
   * without one. Callers that need authentication (like {@link getGitAccountRepos}) check the
   * returned `token` themselves.
   *
   * Returns only `{label, base_url, provider, token}` rather than the raw `GitAccountDoc` — that
   * document carries `auth.token` in `couchdb` mode, and this file's own header comment already
   * promises it is "never returned to a caller directly". Handing the whole doc out of a private
   * method made that promise a matter of caller discipline instead of a structural guarantee;
   * Task 6 was pointed at reusing this method, so the narrower return type is the hazard actually
   * being closed off, not just this file's two current callers.
   */
  private async providerFor(
    accountId: string
  ): Promise<{ label: string; base_url: string | null; provider: GitHubProvider; token: string | null }> {
    const account = await this.store.get<GitAccountDoc>(accountId);
    if (!account) throw new ApiError(404, `Git account not found: ${accountId}`);
    if (account.provider !== 'github') {
      throw new Error(`"${account.provider}" accounts are not supported yet — only GitHub is implemented.`);
    }
    const mode: CredentialMode = account.credential_mode ?? 'none';
    const token = await this.credentials.get(accountId, mode);
    const base_url = account.base_url ?? null;
    const provider = new GitHubProvider(new GitHttp(() => token), base_url);
    return { label: account.label, base_url, provider, token };
  }

  async getGitAccountRepos(id: string): Promise<RemoteRepo[]> {
    const { label, provider, token } = await this.providerFor(id);
    if (!token) {
      throw new Error(`No access token available for "${label ?? id}" — enter its token to continue.`);
    }
    return provider.listRepos();
  }

  async getGitRepoBranches(account_id: string, repo_url: string): Promise<string[]> {
    const { provider } = await this.providerFor(account_id);
    return provider.listBranches(repo_url);
  }

  // -------------------------------------------------------------------------
  // conflicts tag
  // -------------------------------------------------------------------------

  /**
   * Lists design document conflicts, unresolved ones first (a stable sort — CouchDB's `_all_docs`
   * order among equal-`resolved` documents is preserved). `store.list` already scopes to the
   * `conflict:` prefix; `serverId` narrows further when the caller wants a single-server view,
   * even though with one server (D2/D3) it never actually excludes anything today.
   */
  async listConflicts(serverId?: string): Promise<DesignConflict[]> {
    const sid = serverId?.trim();
    const conflicts = await this.store.list<DesignConflict>(ID_PREFIX.conflict);
    const scoped = sid ? conflicts.filter((c) => c.server_id === sid) : conflicts;
    return [...scoped].sort((a, b) => Number(a.resolved) - Number(b.resolved));
  }

  /**
   * Marks a conflict as resolved without changing either version — resolving is an acknowledgment
   * ("I've looked, no further action needed here"), not a sync action; neither the CouchDB
   * document nor the git file is touched.
   *
   * @param id - the conflict document's `_id`
   * @returns the updated conflict, with `resolved` set to true
   */
  async resolveConflict(id: string): Promise<DesignConflict> {
    const existing = await this.store.get<DesignConflict>(id);
    if (!existing) throw new ApiError(404, `Conflict not found: ${id}`);
    const updated: DesignConflict = { ...existing, resolved: true };
    const saved = await this.store.put(id, toDoc(updated));
    return { ...updated, _id: saved.id };
  }

  /**
   * Fetches the two document bodies a recorded conflict names, so the conflict viewer can show
   * them side by side instead of only the revision/sha it was detected against.
   *
   * Either side can legitimately come back `null`, and neither absence is an error worth failing
   * the whole comparison over: the CouchDB revision named in the conflict may already be gone
   * (CouchDB only keeps a former revision until the next compaction), and the git side needs the
   * conflict's repository to still be registered, its account still resolvable, and the file to
   * still exist at `conflict_branch`. {@link detachTarget} and {@link deleteRepo} do sweep the
   * conflicts they own, but only the ones they can find: a conflict written before `git_repo_id`
   * existed, or one whose repository was removed outside those paths, outlives what it names — as
   * does one whose file was simply moved or deleted on the branch. Each side is fetched
   * independently and a failure on either is logged and folded into `null`, exactly like
   * {@link listDesignDocs}'s own best-effort sync-state read.
   */
  async getConflictVersions(conflict: DesignConflict): Promise<ConflictVersions> {
    const [couch, git] = await Promise.all([
      this.readDesignDocAtRev(conflict.db_name, conflict.ddoc_id, conflict.couch_rev).catch((err) => {
        log.warn('Could not load the CouchDB side of a conflict for comparison', {
          db: conflict.db_name,
          ddocId: conflict.ddoc_id,
          message: err instanceof Error ? err.message : String(err)
        });
        return null;
      }),
      this.readConflictGitVersion(conflict).catch((err) => {
        log.warn('Could not load the git side of a conflict for comparison', {
          db: conflict.db_name,
          ddocId: conflict.ddoc_id,
          message: err instanceof Error ? err.message : String(err)
        });
        return null;
      })
    ]);
    return { couch, git };
  }

  /** `GET /{db}/{ddoc}?rev={rev}` — a 404 (the revision has since been compacted away, or never
   *  existed) resolves to `null` rather than throwing; an empty `rev` is treated the same way. */
  private async readDesignDocAtRev(
    dbName: string,
    ddocId: string,
    rev: string
  ): Promise<Record<string, unknown> | null> {
    if (!rev) return null;
    try {
      return await this.api.request<Record<string, unknown>>(
        'GET',
        `${docPath(dbName, ddocId)}?rev=${encodeURIComponent(rev)}`
      );
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    }
  }

  /** The git side of a conflict: the file at `conflict_branch`, at the path the conflict's
   *  repository target would build for it — `null` when the repository, its account, or that
   *  target can no longer be resolved, exactly the same as `getFile`'s own "no such file" `null`. */
  private async readConflictGitVersion(conflict: DesignConflict): Promise<Record<string, unknown> | null> {
    if (!conflict.git_repo_id) return null;
    const repo = await this.store.get<GitRepo>(conflict.git_repo_id);
    if (!repo?.url || !repo.account_id) return null;
    const target = repo.sync_targets?.find((t) => t.db_name === conflict.db_name);
    if (!target) return null;
    const { provider } = await this.providerFor(repo.account_id);
    const filePath = designDocRepoPath(target.path, conflict.db_name, conflict.ddoc_id);
    const content = await provider.getFile(repo.url, conflict.conflict_branch, filePath);
    return content !== null ? (JSON.parse(content) as Record<string, unknown>) : null;
  }
}

/** The two document bodies {@link DesignMgmtService.getConflictVersions} resolves for a side-by-side
 *  comparison — either can be `null` when that side is no longer reachable. */
export interface ConflictVersions {
  couch: Record<string, unknown> | null;
  git: Record<string, unknown> | null;
}
