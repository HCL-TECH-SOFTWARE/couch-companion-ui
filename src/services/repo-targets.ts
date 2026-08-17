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

import type { GitRepo, RepoTarget } from "../plugins/design-mgmt/types.js";

/**
 * The single definition of "which repository tracks which database", shared by the two screens
 * that answer it from opposite directions (#34).
 *
 * A repository document holds its tracked databases as `sync_targets`, so the repo-first screen
 * (`/version-control`) and the database-first screen (`/databases`) both need the same
 * repo x target cross-product — one flattened by repository, one looked up by database. They are
 * built here, from one function, so a change to how a target is identified cannot land on one
 * screen and miss the other.
 *
 * Pure by design: no I/O, no `getContext()`. Callers fetch the repositories (the one lookup that
 * serves a whole table) and pass them in.
 */

/** One (repository, tracked database) pair — the row shape the version-control table renders. */
export interface RepoTargetRow {
  /** Stable per-row identity for `cca-data-table`'s `row-key`. */
  key: string;
  repo: GitRepo;
  target: RepoTarget;
}

/**
 * Every (repository, target) pair across `repos`, in repository order and, within a repository,
 * in `sync_targets` order. A repository tracking no database contributes no row — the
 * version-control table lists tracked databases, not registrations.
 */
export function flattenReposToTargets(repos: GitRepo[]): RepoTargetRow[] {
  const rows: RepoTargetRow[] = [];
  for (const repo of repos) {
    for (const target of repo.sync_targets ?? []) {
      rows.push({
        key: `${repo._id ?? repo.name}-${target.server_id}-${target.db_name}-${target.branch}`,
        repo,
        target,
      });
    }
  }
  return rows;
}

/**
 * The key {@link indexTargetsByDatabase} files a row under. A database is identified by the pair
 * (server, name), never by name alone: the same database name on two servers is two databases.
 *
 * The halves are joined with NUL, which neither a CouchDB database name (CouchDB matches those
 * against ^[a-z][a-z0-9_$()+/-]*$) nor a server id can contain, so no two distinct pairs can
 * collide on one key -- as a separator drawn from either alphabet eventually would.
 */
export function targetKey(serverId: string, dbName: string): string {
  return `${serverId}\u0000${dbName}`;
}

/**
 * The same rows as {@link flattenReposToTargets}, indexed by {@link targetKey} for a table that
 * asks "is *this* database under version control?" once per row against one already-fetched list.
 *
 * Single-valued on purpose, and that is a property of the data rather than a simplification here:
 * `DesignMgmtService.registerRepo` strips a (server, database) target from every *other*
 * repository once the new registration is durable, so a database belongs to exactly one
 * repository. Should a document written before that rule (or edited by hand) still break it, the
 * **first** row wins — the same repository `DesignMgmtService.getRepo` resolves with its own
 * `.find()` over the same list, so this column can never name a repository the design-doc screens
 * disagree with.
 */
export function indexTargetsByDatabase(
  repos: GitRepo[],
): Map<string, RepoTargetRow> {
  const index = new Map<string, RepoTargetRow>();
  for (const row of flattenReposToTargets(repos)) {
    const key = targetKey(row.target.server_id, row.target.db_name);
    if (!index.has(key)) index.set(key, row);
  }
  return index;
}
