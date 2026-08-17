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
 * Unit tests for the sync-status computation in CcaDesignList.buildDDocs().
 *
 * The logic combines CouchDB docs (TrackedDesignDoc from the API) with git docs
 * (GitDesignDoc from the repo endpoint) to derive a client-side `sync_status`:
 *
 *  - 'unknown'        — no ddoc_rev / no last_git_sha recorded yet (never synced through CCA)
 *  - 'synced'         — neither side moved since the last recorded sync
 *  - 'newer_in_git'   — only the repository's blob sha moved
 *  - 'newer_in_couch' — only the CouchDB rev moved, forwards
 *  - 'conflict'       — BOTH the rev and the git sha moved since the last sync
 *  - 'unknown'        — the rev moved but not forwards (stale sync record, or a delete/recreate)
 *  - 'unknown'        — only exists in git (not in couch)
 */

import { describe, it, expect } from 'vitest';
import { buildDDocs } from '../src/plugins/design-mgmt/design-list.js';
import type { TrackedDesignDoc, GitDesignDoc } from '../src/plugins/design-mgmt/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const SERVER = 'server:abc';
const DB = 'animals';

function makeCouch(
  overrides: Partial<TrackedDesignDoc> = {}
): TrackedDesignDoc {
  return {
    server_id: SERVER,
    server_name: 'alpha',
    db_name: DB,
    ddoc_id: '_design/animals',
    rev: '2-aaaa',
    ddoc_rev: '2-aaaa',
    git_repo_id: 'repo:123',
    last_git_sha: 'sha-old',
    sync_status: 'unknown',
    updated_at: null,
    last_sync: null,
    ...overrides
  };
}

function makeGit(overrides: Partial<GitDesignDoc['info']> = {}): GitDesignDoc {
  return {
    info: {
      db_name: DB,
      ddoc_id: '_design/animals',
      git_repo_id: 'repo:123',
      git_sha: 'sha-old',
      last_updated: null,
      ...overrides
    },
    content: {}
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('buildDDocs — sync status computation', () => {
  it('returns unknown when no git doc exists for a couch doc', () => {
    const docs = buildDDocs([makeCouch()], [], SERVER, DB);
    expect(docs[0].sync_status).toBe('unknown');
  });

  it('returns unknown when ddoc_rev is null (never synced through CCA)', () => {
    const docs = buildDDocs(
      [makeCouch({ ddoc_rev: null })],
      [makeGit()],
      SERVER,
      DB
    );
    expect(docs[0].sync_status).toBe('unknown');
  });

  it('returns synced when couch rev equals ddoc_rev AND git sha matches', () => {
    const docs = buildDDocs(
      [
        makeCouch({
          rev: '3-bbbb',
          ddoc_rev: '3-bbbb',
          last_git_sha: 'sha-xyz'
        })
      ],
      [makeGit({ git_sha: 'sha-xyz' })],
      SERVER,
      DB
    );
    expect(docs[0].sync_status).toBe('synced');
  });

  it('returns newer_in_git when couch rev equals ddoc_rev but git sha differs', () => {
    const docs = buildDDocs(
      [
        makeCouch({
          rev: '3-bbbb',
          ddoc_rev: '3-bbbb',
          last_git_sha: 'sha-old'
        })
      ],
      [makeGit({ git_sha: 'sha-new' })],
      SERVER,
      DB
    );
    expect(docs[0].sync_status).toBe('newer_in_git');
  });

  it('returns newer_in_couch when only the couch rev moved, forwards', () => {
    // CouchDB was edited externally: rev gen 4 > ddoc_rev gen 3. The git sha is UNCHANGED — that
    // is what makes this newer_in_couch rather than a conflict, and the assertion is only
    // meaningful because the both-moved case below holds a different sha.
    const docs = buildDDocs(
      [
        makeCouch({
          rev: '4-cccc',
          ddoc_rev: '3-bbbb',
          last_git_sha: 'sha-old'
        })
      ],
      [makeGit({ git_sha: 'sha-old' })],
      SERVER,
      DB
    );
    expect(docs[0].sync_status).toBe('newer_in_couch');
  });

  it('returns conflict when BOTH the couch rev and the git sha moved since the last sync', () => {
    // The case that matters, and the one this suite never exercised: every rev-mismatch test held
    // git_sha === last_git_sha, so the missing git-sha comparison in the rev-mismatch branch was
    // invisible. A genuine both-sides-moved conflict used to render as newer_in_couch, which reads
    // as "safe to push" — and the push is then refused by a conflict nothing warned about.
    const docs = buildDDocs(
      [
        makeCouch({
          rev: '4-cccc',
          ddoc_rev: '3-bbbb',
          last_git_sha: 'sha-old'
        })
      ],
      [makeGit({ git_sha: 'sha-new' })],
      SERVER,
      DB
    );
    expect(docs[0].sync_status).toBe('conflict');
  });

  it('returns unknown, not conflict, when the couch rev moved but not forwards', () => {
    // ddoc_rev gen 5 > rev gen 3 with the git sha unchanged: a stale sync record, or a document
    // deleted and recreated. Nothing here can tell which, and no conflict record exists — calling
    // it 'conflict' pointed the user at a conflict viewer with no matching entry.
    const docs = buildDDocs(
      [
        makeCouch({
          rev: '3-bbbb',
          ddoc_rev: '5-eeee',
          last_git_sha: 'sha-old'
        })
      ],
      [makeGit({ git_sha: 'sha-old' })],
      SERVER,
      DB
    );
    expect(docs[0].sync_status).toBe('unknown');
  });

  it('returns unknown with null rev when doc only exists in git (not in couch)', () => {
    const docs = buildDDocs(
      [],
      [makeGit({ ddoc_id: '_design/newdoc' })],
      SERVER,
      DB
    );
    expect(docs).toHaveLength(1);
    expect(docs[0].sync_status).toBe('unknown');
    expect(docs[0].rev).toBeNull();
    expect(docs[0].ddoc_id).toBe('_design/newdoc');
  });

  it('merges couch-only and git-only docs into a combined list', () => {
    const couchOnly = makeCouch({ ddoc_id: '_design/couch-only' });
    const gitOnly = makeGit({ ddoc_id: '_design/git-only' });
    const shared = makeCouch({
      rev: '1-aaa',
      ddoc_rev: '1-aaa',
      last_git_sha: 'sha1'
    });
    const sharedGit = makeGit({ git_sha: 'sha1' });

    const docs = buildDDocs(
      [couchOnly, shared],
      [gitOnly, sharedGit],
      SERVER,
      DB
    );

    expect(docs).toHaveLength(3);
    const ids = docs.map((d) => d.ddoc_id);
    expect(ids).toContain('_design/couch-only');
    expect(ids).toContain('_design/git-only');
    expect(ids).toContain('_design/animals');

    const sharedDoc = docs.find((d) => d.ddoc_id === '_design/animals')!;
    expect(sharedDoc.sync_status).toBe('synced');
  });

  it('treats equal rev and ddoc_rev generation as synced (not conflict)', () => {
    // rev === ddoc_rev exactly — should be synced if sha also matches
    const docs = buildDDocs(
      [
        makeCouch({
          rev: '2-aaaa',
          ddoc_rev: '2-aaaa',
          last_git_sha: 'sha-match'
        })
      ],
      [makeGit({ git_sha: 'sha-match' })],
      SERVER,
      DB
    );
    expect(docs[0].sync_status).toBe('synced');
  });

  it('reports a couch-side delete that still exists in git as newer_in_git, matching classify()', () => {
    // A null rev means CouchDB no longer has the document while git still does. classify() calls
    // that newer_in_git (a deliberate, documented behaviour — "sync from repository" resurrects
    // it, see README), so this table must not call it something else.
    const docs = buildDDocs(
      [makeCouch({ rev: null, ddoc_rev: '2-aaaa', last_git_sha: 'sha1' })],
      [makeGit({ git_sha: 'sha1' })],
      SERVER,
      DB
    );
    expect(docs[0].sync_status).toBe('newer_in_git');
  });

  it('reports a doc git has no file for as newer_in_couch, matching classify()', () => {
    const docs = buildDDocs(
      [makeCouch({ rev: '2-aaaa', ddoc_rev: '2-aaaa', last_git_sha: 'sha1' })],
      [makeGit({ git_sha: null })],
      SERVER,
      DB
    );
    expect(docs[0].sync_status).toBe('newer_in_couch');
  });
});
