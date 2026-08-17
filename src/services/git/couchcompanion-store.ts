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

import { ApiClient } from '../api-client.js';
import { ApiError } from '../api-error.js';
import { dbPath, docPath } from '../db-mgmt-service.js';

/**
 * The database Phase 5's git-sync bookkeeping lives in: linked repositories, git accounts,
 * per-design-doc sync state, and detected conflicts. Lazily created (D13) — see
 * {@link CouchCompanionStore.ensureDatabase} — so a server that has never run a sync still boots
 * the whole app cleanly; nothing here is touched until a write actually needs it.
 */
export const COMPANION_DB = 'couchcompanion';

/**
 * Every document kind owns an id prefix, so a plain `_all_docs` range scan
 * (`startkey: prefix`, `endkey: prefix + high-sentinel`) returns exactly one kind — no Mango
 * index to create, nothing else to lazily bootstrap (spec P5-3).
 */
export const ID_PREFIX = {
  account: 'gitaccount:',
  repo: 'gitrepo:',
  sync: 'sync:',
  conflict: 'conflict:',
  /**
   * The IdP activity log — the only IdP bookkeeping left in this database. Provider metadata
   * moved to the node config's `[oidc]` section (#32); an append-only log is the one thing an
   * ini section genuinely cannot hold, and it is written only when `[oidc] log = true`.
   */
  idpLog: 'idplog:',
} as const;

/**
 * CouchDB's conventional high-value sentinel (U+FFF0): sorts after every string that shares a
 * given prefix, so `endkey: prefix + HIGH_SENTINEL` closes an `_all_docs` range scan started at
 * `startkey: prefix` without spilling into the next id prefix.
 */
const HIGH_SENTINEL = '￰';

/** Strips a leading `_design/` (CouchDB's own form) or `ddoc:` (an already-bare form) off a design-doc id/name. */
function ddocName(ddocId: string): string {
  return ddocId.replace(/^_design\//, '').replace(/^ddoc:/, '');
}

/**
 * Sync-state document id for one design doc in one database. Deliberately drops the server
 * segment the parent's wire format carried (spec section 8) — this product manages a single
 * server (D2/D3), so it would be redundant in every id.
 */
export const syncStateId = (db: string, ddocId: string): string =>
  `${ID_PREFIX.sync}${db}~ddoc:${ddocName(ddocId)}`;

/**
 * Conflict document id for one design doc in one database — same shape as {@link syncStateId},
 * under the `conflict:` prefix. Deterministic on purpose: re-running conflict detection updates
 * the existing record via {@link CouchCompanionStore.put}'s `_rev` carry-forward instead of
 * accumulating duplicates.
 */
export const conflictId = (db: string, ddocId: string): string =>
  `${ID_PREFIX.conflict}${db}~ddoc:${ddocName(ddocId)}`;

/** A plain CouchDB "not found" — the shape for both a missing document and a missing database. */
function isNotFound(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}

/**
 * True when a 404 **answering a document write** means the `couchcompanion` database itself is
 * absent. A `PUT` of a document *creates* it, so a missing document can never be the reason one
 * 404s — the only thing left to be missing is the database. That is the whole test, deliberately:
 * this used to also require the word "database" in `err.message`, which `ApiClient` builds from
 * the response body (`reason` → `error` → `statusText` → `"Request failed"`, api-client.ts:165).
 * Behind a reverse proxy that strips error bodies the message is a bare `"Not Found"`, the regex
 * missed, and the D13 lazy-create in {@link CouchCompanionStore.put} silently never fired — the
 * first write on a fresh server failed permanently, with an error naming nothing actionable.
 *
 * Only valid for a write's own error; a 404 from a *read* is ambiguous (document or database) and
 * both {@link CouchCompanionStore.get} and {@link CouchCompanionStore.list} already treat it as
 * "absent" via {@link isNotFound}. The retry it guards runs exactly once, so a 404 that somehow
 * means something else (a misrouted path, say) costs one harmless `PUT /couchcompanion` and then
 * fails with the same error it would have anyway.
 */
function isMissingDatabaseOnWrite(err: unknown): boolean {
  return isNotFound(err);
}

/**
 * The `couchcompanion` document store: git accounts, linked repositories, per-design-doc sync
 * state, and detected conflicts — one id-prefixed document kind at a time (see {@link ID_PREFIX}).
 *
 * Talks to `ApiClient` directly rather than through `DbMgmtService`. `DbMgmtService.listDocuments`
 * has no way to bound an `_all_docs` scan with `startkey`/`endkey` — only an opaque, replayable
 * bookmark, and no `endkey` at all — which {@link list} genuinely needs. This is not a
 * workaround: `ReplicationService` is built the identical way (`constructor(private api:
 * ApiClient)`), and this codebase's service/component layering rule permits any *service* to own
 * an `ApiClient`; only components are barred from it. Reusing `listDocuments`'s pagination (whose
 * `hasMore`/bookmark semantics are delicate and already relied on by `doc-browser`'s
 * page-replay behavior) for this one extra, differently-shaped consumer risked perturbing it for
 * no benefit to that consumer — and still would not have supplied the missing `endkey`. Mango
 * (`DbMgmtService.queryDocuments`) is deliberately not used either (see {@link ID_PREFIX}): it
 * would also reintroduce `_find`'s silent 25-document cap unless every call remembered an
 * explicit `limit`. `dbPath`/`docPath` are still imported from `db-mgmt-service.ts` — they are
 * already exported and already handle the `_design/` id-encoding edge case correctly.
 *
 * @param api - shared ApiClient (token already set by AuthService)
 */
export class CouchCompanionStore {
  constructor(private api: ApiClient) {}

  /**
   * `PUT /couchcompanion`. A `412 file_exists` — the natural race between two tabs, or two
   * sync actions, both discovering the database is missing — is treated as success, not an
   * error. Never writes `_security` afterwards: a freshly created CouchDB database already
   * carries `{"members":{"roles":["_admin"]},"admins":{"roles":["_admin"]}}` — exactly the
   * admin-only access spec section 8 asks for — so writing it again would only add a way to get
   * it wrong.
   */
  async ensureDatabase(): Promise<void> {
    try {
      await this.api.request('PUT', dbPath(COMPANION_DB));
    } catch (err) {
      if (err instanceof ApiError && err.status === 412) return;
      throw err;
    }
  }

  /**
   * `GET /couchcompanion/_all_docs?include_docs=true`, bounded to exactly one id prefix via
   * `startkey`/`endkey` (both JSON-quoted before percent-encoding — CouchDB's view-collation
   * query parameters require the JSON form, i.e. `startkey=%22gitaccount%3A%22`, not a bare
   * string). Returns every row's `doc`, skipping any row `include_docs` didn't attach one to
   * (e.g. a deleted row CouchDB reports without a `doc`).
   *
   * A **404** here means the `couchcompanion` database itself has never been created (D13) —
   * resolved to `[]`, the correct "nothing synced yet" empty state, not an error.
   *
   * A **403** means an authenticated non-admin hit the admin-only database (the default security
   * a freshly created database carries, per spec section 8) and is being denied. That is the
   * opposite situation from a 404 even though both are thrown from this same call site:
   * swallowing it into the same `[]` would render an empty screen that silently lies about *why*
   * it's empty ("nothing synced yet" vs. "you are not allowed to see this"), so it propagates
   * instead of being caught here.
   */
  async list<T>(prefix: string): Promise<T[]> {
    const startkey = encodeURIComponent(JSON.stringify(prefix));
    const endkey = encodeURIComponent(JSON.stringify(prefix + HIGH_SENTINEL));
    try {
      const resp = await this.api.request<{ rows: Array<{ doc?: T }> }>(
        'GET',
        `${dbPath(COMPANION_DB)}/_all_docs?include_docs=true&startkey=${startkey}&endkey=${endkey}`,
      );
      return (resp.rows ?? []).flatMap((row) => (row.doc ? [row.doc] : []));
    } catch (err) {
      if (isNotFound(err)) return [];
      throw err;
    }
  }

  /** `GET /couchcompanion/{id}`. A 404 (document, or database, absent) resolves to `null`. */
  async get<T>(id: string): Promise<T | null> {
    try {
      return await this.api.request<T>('GET', docPath(COMPANION_DB, id));
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  /**
   * Read-modify-write: fetches the current doc (if any) for its `_rev`, merges `body` over it,
   * then `PUT /couchcompanion/{id}`.
   *
   * If that write 404s the database doesn't exist yet (see {@link isMissingDatabaseOnWrite}), so
   * this calls {@link ensureDatabase} once and retries the write exactly once — never loops. A 404
   * because the *document* doesn't exist (the ordinary create path, and what the initial read hits
   * every time a document is new) never reaches that branch: only the write's own error is
   * inspected, and a `PUT` cannot 404 over a missing document.
   */
  async put(id: string, body: Record<string, unknown>): Promise<{ id: string; rev: string }> {
    const existing = await this.get<{ _rev?: string }>(id);
    const merged = existing?._rev ? { ...body, _rev: existing._rev } : { ...body };
    try {
      return await this.writeDoc(id, merged);
    } catch (err) {
      if (!isMissingDatabaseOnWrite(err)) throw err;
      await this.ensureDatabase();
      return this.writeDoc(id, merged);
    }
  }

  /**
   * Reads the current `_rev` and deletes; a 404 (already gone) is a no-op. Two round trips, which
   * is the right shape only when the caller genuinely holds nothing but an id — for anything that
   * came out of {@link list} (every sweep does), use {@link removeAll}, which already has the
   * `_rev` in hand.
   */
  async remove(id: string): Promise<void> {
    const existing = await this.get<{ _rev: string }>(id);
    if (!existing) return;
    await this.api.request('DELETE', `${docPath(COMPANION_DB, id)}?rev=${encodeURIComponent(existing._rev)}`);
  }

  /**
   * Deletes many documents in **one** `POST /couchcompanion/_bulk_docs`, plus at most one
   * `POST /couchcompanion/_all_docs` to resolve the revisions of entries handed over as bare ids.
   *
   * Every sweep in `design-mgmt-service.ts` (unlinking a target, deleting a repository, deleting
   * design docs from a repository) used to loop {@link remove} over documents `list()` had just
   * returned *with* their `_rev` — a redundant `GET` plus a `DELETE` for each one. Passing the
   * documents straight through costs a single request for the whole sweep; ids with no document to
   * hand (`deleteRepoDocs` builds the `sync:`/`conflict:` ids it wants to drop) are resolved in one
   * batched lookup rather than one `GET` apiece.
   *
   * Absent documents are skipped, not an error — the same "already gone is a no-op" rule
   * {@link remove} follows, and a 404 for the whole call (the database has never been created,
   * D13) means there was nothing to delete in the first place. A row `_bulk_docs` *refuses*
   * (`conflict`, most plausibly a concurrent write) is a different matter: it throws, naming the
   * documents, because a sweep that silently leaves documents behind is exactly the class of leak
   * these call sites exist to prevent. Like the per-document loop it replaces, the throw can still
   * follow rows that were deleted successfully — a retry is safe, since deleting an
   * already-deleted document is a no-op here.
   */
  async removeAll(docs: Array<string | { _id: string; _rev?: string }>): Promise<void> {
    const revById = new Map<string, string>();
    const needRev = new Set<string>();
    for (const doc of docs) {
      if (typeof doc === 'string') needRev.add(doc);
      else if (doc._rev) revById.set(doc._id, doc._rev);
      else needRev.add(doc._id);
    }

    if (needRev.size > 0) {
      const rows = await this.lookupRevs([...needRev]);
      for (const [id, rev] of rows) revById.set(id, rev);
    }
    if (revById.size === 0) return;

    const body = { docs: [...revById].map(([_id, _rev]) => ({ _id, _rev, _deleted: true })) };
    let results: Array<{ ok?: boolean; id: string; error?: string; reason?: string }>;
    try {
      results = await this.api.request('POST', `${dbPath(COMPANION_DB)}/_bulk_docs`, body);
    } catch (err) {
      if (isNotFound(err)) return;
      throw err;
    }

    const refused = (results ?? []).filter((r) => r.ok !== true);
    if (refused.length > 0) {
      const detail = refused.map((r) => `${r.id} (${r.error ?? 'error'}: ${r.reason ?? 'no reason given'})`);
      throw new Error(`couchcompanion refused to delete ${refused.length} document(s): ${detail.join('; ')}`);
    }
  }

  /**
   * `POST /couchcompanion/_all_docs` with `{keys}` — the current `_rev` of each id that has one,
   * in a single request. Rows CouchDB answers with `error: 'not_found'` (or a `deleted` value) are
   * simply absent from the result: there is nothing left to delete for them.
   */
  private async lookupRevs(ids: string[]): Promise<Array<[string, string]>> {
    type Row = { id?: string; key: string; error?: string; value?: { rev?: string; deleted?: boolean } };
    let resp: { rows?: Row[] };
    try {
      resp = await this.api.request('POST', `${dbPath(COMPANION_DB)}/_all_docs`, { keys: ids });
    } catch (err) {
      if (isNotFound(err)) return [];
      throw err;
    }
    return (resp.rows ?? []).flatMap((row) =>
      row.error || row.value?.deleted || !row.value?.rev ? [] : [[row.id ?? row.key, row.value.rev] as [string, string]]
    );
  }

  private writeDoc(id: string, body: Record<string, unknown>): Promise<{ id: string; rev: string }> {
    return this.api.request('PUT', docPath(COMPANION_DB, id), body);
  }
}
