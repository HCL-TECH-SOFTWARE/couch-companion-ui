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

import type { CredentialMode } from '../../services/git/git-credential-store.js';

/**
 * Fallback for a non-empty error message. `ApiError.message` (and a thrown `Error`'s `message` in
 * general) can be empty — `ApiClient` falls back to `resp.statusText` when the error body carries
 * neither `detail` nor `title`, and browsers routinely return an empty `statusText` for HTTP/2
 * responses. An empty message must never reach the UI: it would leave a dangling colon with
 * nothing after it in a toast or panel. Shared across this plugin's components so the same guard
 * doesn't drift into slightly different wording in each one.
 */
export const UNKNOWN_ERROR = 'Unknown error';

/**
 * Wire shape of a repository as the API serializes it (openapi.yaml `GitRepo`). Every property
 * is spec-optional, and branch/path ride on each sync target — the backend stamps the repo's
 * single tracked branch onto every one; there is no top-level `branch`, `path` or `targets`.
 */
export interface GitRepo {
  _id?: string;
  _rev?: string;
  doc_type?: string;
  name?: string;
  provider?: 'github' | 'gitlab' | 'bitbucket';
  url?: string;
  mode?: string;
  account_id?: string | null;
  sync_targets?: RepoTarget[];
  last_sync?: string | null;
  sync_status?: 'idle' | 'syncing' | 'error';
  created_at?: string;
}

export interface RepoTarget {
  server_id: string;
  db_name: string;
  branch: string;
  path: string;
}

export interface TrackedDesignDoc {
  server_id: string;
  server_name: string | null;
  db_name: string;
  ddoc_id: string;
  rev: string | null;
  ddoc_rev: string | null;
  git_repo_id: string | null;
  last_git_sha: string | null;
  last_sync: string | null;
  updated_at: string | null;
  // Derived client-side — not returned by the API
  sync_status: string | 'unknown';
}

export interface GitDesignDoc {
  info: {
    db_name: string;
    ddoc_id: string;
    git_repo_id: string | null;
    git_sha: string | null;
    last_updated: string | null;
  };
  content: Record<string, unknown>;
}

export interface DesignConflict {
  _id: string;
  server_id: string;
  db_name: string;
  ddoc_id: string;
  /** The repository this conflict was detected against — absent on a conflict written before
   *  this field existed. Lets a repo-scoped sweep (unlinking, deleting) find its own conflicts. */
  git_repo_id?: string | null;
  couch_rev: string;
  git_sha: string;
  conflict_branch: string;
  resolved: boolean;
  detected_at: string;
}

/**
 * A connected git account joined to the repositories registered against it, as the version-control
 * screen groups them.
 *
 * Mirrors the public `GitAccount` (`design-mgmt-service.ts`) field for field rather than extending
 * it: this module is already imported *by* `design-mgmt-service.ts`, and importing back would make
 * the pair mutually dependent for the sake of one intersection. Every field here is what
 * `maskAccount` emits — never `auth`, never a token, and `credential_mode` says only *where* the
 * token lives.
 */
export interface AccountWithRepos {
  _id: string;
  label: string;
  provider: string;
  username?: string | null;
  base_url?: string | null;
  /** Absent on accounts written before D12 existed; `maskAccount` defaults those to `'none'`. */
  credential_mode?: CredentialMode;
  repos: GitRepo[];
}