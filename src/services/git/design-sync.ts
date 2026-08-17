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
 * Pure helpers for the design-doc <-> git sync flows in `design-mgmt-service.ts`. Nothing in this
 * module performs I/O — that split is deliberate (Task 6 decision 1) so path building,
 * serialization and conflict classification are testable without a `CouchCompanionStore`, an
 * `ApiClient`, or a `GitHubProvider`.
 */

/** Deep-sorts object keys so serialization is deterministic. Arrays keep their order — in a
 *  design doc an array's order is meaningful. Also drops CouchDB's own bookkeeping fields
 *  (`_id`, `_rev`, `_revisions`) wherever they appear, so a rev bump is never mistaken for a
 *  content change. */
const sortKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([k]) => k !== '_id' && k !== '_rev' && k !== '_revisions')
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
};

/**
 * The `<root>/<db>/_design/<name>.json` path a design doc lives at inside a repository.
 * `root` tolerates a leading/trailing slash and an empty string (the target's repo-root case);
 * `ddocId` accepts either `_design/name` or a bare `name`.
 */
export const designDocRepoPath = (root: string, db: string, ddocId: string): string => {
  const cleanRoot = root.replace(/^\/+|\/+$/g, '');
  const name = ddocId.replace(/^_design\//, '');
  return [cleanRoot, db, '_design', `${name}.json`].filter((segment) => segment.length > 0).join('/');
};

/** Recovers `_design/<name>` from a repo path built by {@link designDocRepoPath}; `null` for any
 *  other file (a README, a `.gitignore`, ...). */
export const ddocIdFromPath = (path: string): string | null => {
  const match = path.match(/(?:^|\/)_design\/([^/]+)\.json$/);
  return match ? `_design/${match[1]}` : null;
};

/**
 * Canonical JSON for a design doc: CouchDB metadata stripped, keys sorted recursively, pretty
 * printed for a readable repo diff. Two calls on semantically identical documents always produce
 * identical bytes — the property {@link sameContent} and every sync flow's "did this actually
 * change" check depend on.
 */
export const serializeDdoc = (doc: Record<string, unknown>): string => `${JSON.stringify(sortKeys(doc), null, 2)}\n`;

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};

/** Whether two design-doc bodies are the same content, ignoring `_id`/`_rev`/`_revisions` and key
 *  order (but not array order — see {@link designDocRepoPath}'s sibling comment). */
export const sameContent = (a: unknown, b: unknown): boolean => serializeDdoc(asRecord(a)) === serializeDdoc(asRecord(b));

export type SyncStatus = 'synced' | 'newer_in_couch' | 'newer_in_git' | 'conflict' | 'unknown';

/**
 * Classifies one design doc's sync state from the live CouchDB rev/git blob sha, the values
 * recorded at the last successful sync, and whether the two sides' current content agrees.
 *
 * A side git or CouchDB has never seen at all wins outright — `newer_in_couch`/`newer_in_git` —
 * regardless of whether a sync record exists, because there is nothing on the other side to be
 * "in conflict" with. Only once both sides have a version does the absence of a prior sync record
 * (`unknown`) or its presence (movement-since-last-sync) come into play. When both moved since the
 * last sync, content equality decides: two sides that landed on the same bytes are `synced`, not a
 * `conflict`, no matter how they each got there independently.
 */
export const classify = (args: {
  couchRev: string | null;
  gitSha: string | null;
  syncedRev: string | null;
  syncedSha: string | null;
  contentEqual: boolean;
}): SyncStatus => {
  const { couchRev, gitSha, syncedRev, syncedSha, contentEqual } = args;

  if (couchRev !== null && gitSha === null) return 'newer_in_couch';
  if (couchRev === null && gitSha !== null) return 'newer_in_git';

  if (syncedRev === null && syncedSha === null) return 'unknown';

  const couchMoved = couchRev !== syncedRev;
  const gitMoved = gitSha !== syncedSha;

  if (couchMoved && gitMoved) return contentEqual ? 'synced' : 'conflict';
  if (couchMoved) return 'newer_in_couch';
  if (gitMoved) return 'newer_in_git';
  return 'synced';
};

/**
 * Resolves `classify()`'s `'unknown'` verdict, for the case where **both sides currently have
 * some version** but there is no sync record to compare them against, into a concrete status.
 * This state is not exotic: every path that sweeps `sync:` records (`unlinkRepo`, `deleteRepo`,
 * a repository re-point, or an admin dropping `couchcompanion` outright) manufactures it for
 * documents that may have been genuinely conflicting a moment before the sweep. Guessing a
 * direction here — the fix round 1 bug — would silently discard whichever side loses. There is
 * no history to fall back on, so the only honest signal left is whether the two sides currently
 * agree: agreement is safe either way (`'synced'` — nothing to write, only to record);
 * disagreement has no basis to pick a winner (`'conflict'`). Every other status passes through
 * unchanged — it was derived from real history, not a manufactured absence of one.
 *
 * `classify()` also returns `'unknown'` for the opposite extreme — a document present on
 * **neither** side — and this function must never be handed that case: folding it through
 * `contentEqual` (trivially `false`, since there is no content on either side to compare) would
 * manufacture a `'conflict'` for a document that exists nowhere (fix round 2, NEW-1 — a
 * regression this very fold introduced). That case is intercepted in `readAndClassify`
 * (`design-mgmt-service.ts`) *before* `classify()` is ever called, precisely so this function's
 * only remaining job is the "both exist, no history" case its name and comment describe.
 */
export const resolveUnknown = (status: SyncStatus, contentEqual: boolean): SyncStatus =>
  status === 'unknown' ? (contentEqual ? 'synced' : 'conflict') : status;

/** Which way a sync is moving content: CouchDB into the repository, or the repository into
 *  CouchDB. */
export type SyncDirection = 'toRepo' | 'toCouch';

/**
 * Whether a document's status (after {@link resolveUnknown} has already resolved any
 * `'unknown'`) may be applied in the given direction. `'synced'` is always a safe no-op;
 * `'conflict'` is always refused. The two "only one side moved" statuses are direction-specific:
 * pushing a `'newer_in_git'` document's (stale, unrelated) CouchDB content into the repository
 * would silently revert whatever changed the file; pulling a `'newer_in_couch'` document's
 * (equally stale) file into CouchDB would just as silently revert a live edit. This is the fix
 * for fix round 1's data-loss bug: both sync flows used to apply *any* non-`'conflict'` status,
 * which included the wrong-direction case.
 */
export const canApply = (status: SyncStatus, direction: SyncDirection): boolean => {
  if (status === 'synced') return true;
  if (status === 'newer_in_couch') return direction === 'toRepo';
  if (status === 'newer_in_git') return direction === 'toCouch';
  return false; // 'conflict', and 'unknown' as a defensive default should it ever reach here.
};
