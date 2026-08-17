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
 * The shared repository/database mapping (#34) — and the proof that the two screens which answer
 * "is this database under version control?" from opposite directions go through it, so a change
 * to one cannot silently disagree with the other.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getContext } from '../src/context';
import { ApiClient } from '../src/services/api-client';
import { DesignMgmtService } from '../src/services/design-mgmt-service';
import { CouchCompanionStore } from '../src/services/git/couchcompanion-store';
import { GitCredentialStore } from '../src/services/git/git-credential-store';
import {
  flattenReposToTargets,
  indexTargetsByDatabase,
  targetKey
} from '../src/services/repo-targets';
import type { GitRepo, RepoTarget } from '../src/plugins/design-mgmt/types';
import type { DatabaseOverview } from '../src/plugins/db-mgmt/types';

import '../src/plugins/design-mgmt/repo-overview';
import '../src/plugins/db-mgmt/db-list';

const repo = (over: Partial<GitRepo>): GitRepo => ({
  _id: 'gitrepo:one',
  name: 'couchdb-designs',
  url: 'https://github.com/example/couchdb-designs.git',
  provider: 'github',
  account_id: 'gitaccount:work',
  sync_status: 'idle',
  sync_targets: [],
  ...over
});

const target = (db_name: string, over: Partial<RepoTarget> = {}): RepoTarget => ({
  server_id: 'srv1',
  db_name,
  branch: 'main',
  path: '/',
  ...over
});

describe('flattenReposToTargets', () => {
  it('emits one row per sync target, in repository then target order', () => {
    const rows = flattenReposToTargets([
      repo({ _id: 'gitrepo:a', name: 'a', sync_targets: [target('orders'), target('invoices')] }),
      repo({ _id: 'gitrepo:b', name: 'b', sync_targets: [target('audit')] })
    ]);

    expect(rows.map((r) => [r.repo.name, r.target.db_name])).toEqual([
      ['a', 'orders'],
      ['a', 'invoices'],
      ['b', 'audit']
    ]);
  });

  it('emits nothing for a repository that tracks no database', () => {
    expect(flattenReposToTargets([repo({ sync_targets: [] })])).toEqual([]);
    expect(flattenReposToTargets([repo({ sync_targets: undefined })])).toEqual([]);
  });

  /**
   * `cca-data-table` is told `row-key="key"`, so this shape is load-bearing for repo-overview's
   * row identity — it has to stay unique per (repo, server, database, branch).
   */
  it('gives every row a key unique to its repository, server, database and branch', () => {
    const rows = flattenReposToTargets([
      repo({
        _id: 'gitrepo:a',
        sync_targets: [
          target('orders'),
          { server_id: 'srv2', db_name: 'orders', branch: 'main', path: '/' },
          { server_id: 'srv1', db_name: 'orders', branch: 'release', path: '/' }
        ]
      })
    ]);

    expect(new Set(rows.map((r) => r.key)).size).toBe(3);
  });
});

describe('indexTargetsByDatabase', () => {
  it('files each tracked database under its (server, database) pair', () => {
    const index = indexTargetsByDatabase([
      repo({
        _id: 'gitrepo:a',
        name: 'designs',
        sync_targets: [
          target('orders', { branch: 'trunk' }),
          { server_id: 'srv2', db_name: 'orders', branch: 'release', path: '/' }
        ]
      })
    ]);

    expect(index.get(targetKey('srv1', 'orders'))!.target.branch).toBe('trunk');
    expect(index.get(targetKey('srv2', 'orders'))!.target.branch).toBe('release');
  });

  it('holds nothing for a database no repository tracks', () => {
    const index = indexTargetsByDatabase([repo({ sync_targets: [target('orders')] })]);
    expect(index.get(targetKey('srv1', 'invoices'))).toBeUndefined();
  });

  it('never collides two databases of the same name on different servers', () => {
    expect(targetKey('srv1', 'orders')).not.toBe(targetKey('srv2', 'orders'));
    // …and no server id / database name pair can be split differently across the separator.
    expect(targetKey('a', 'b-c')).not.toBe(targetKey('a-b', 'c'));
  });

  /**
   * `registerRepo` strips a target from every other repository, so this is not supposed to happen.
   * When a document written before that rule (or edited by hand) breaks it anyway, the column has
   * to name the repository the *rest of the app* resolves — `DesignMgmtService.getRepo`'s `.find()`
   * over the same list — rather than a second, equally arbitrary answer.
   */
  it('resolves a doubly-claimed database to the same repository getRepo does', async () => {
    const repos = [
      repo({ _id: 'gitrepo:first', name: 'first', sync_targets: [target('orders')] }),
      repo({ _id: 'gitrepo:second', name: 'second', sync_targets: [target('orders')] })
    ];

    const api = new ApiClient('http://test');
    const store = new CouchCompanionStore(api);
    vi.spyOn(store, 'list').mockResolvedValue(repos as never);
    const service = new DesignMgmtService(
      api,
      store,
      new GitCredentialStore({ readToken: async () => null, writeToken: async () => {} })
    );

    const viaService = await service.getRepo('srv1', 'orders');
    const viaIndex = indexTargetsByDatabase(repos).get(targetKey('srv1', 'orders'));

    expect(viaIndex!.repo._id).toBe('gitrepo:first');
    expect(viaIndex!.repo._id).toBe(viaService.repo!._id);
  });
});

/**
 * The reason the helper is shared rather than copied. Both screens are given the *same*
 * repository document and have to say the same thing about the same database; a reimplementation
 * on either side that picked a different target, or spelled the branch differently, fails here.
 */
describe('the database-first and repository-first screens agree', () => {
  const REPOS: GitRepo[] = [
    repo({
      _id: 'gitrepo:designs',
      name: 'couchdb-designs',
      sync_targets: [
        { server_id: 'srv1', db_name: 'orders', branch: 'trunk', path: '/ddocs' },
        { server_id: 'srv2', db_name: 'orders', branch: 'release', path: '/ddocs' }
      ]
    })
  ];

  const DBS: DatabaseOverview[] = [
    { db_name: 'orders', servers: [{ server_id: 'srv1', server_name: 'Alpha', doc_count: 3 }] },
    { db_name: 'invoices', servers: [{ server_id: 'srv1', server_name: 'Alpha', doc_count: 1 }] }
  ] as DatabaseOverview[];

  const mounted: Element[] = [];

  async function mount<T extends Element>(tag: string): Promise<T> {
    const el = document.createElement(tag) as T;
    document.body.appendChild(el);
    mounted.push(el);
    for (let i = 0; i < 4; i++) {
      await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;
      await Promise.resolve();
    }
    return el;
  }

  beforeEach(() => {
    vi.spyOn(getContext().auth, 'isAdmin', 'get').mockReturnValue(true);
    vi.spyOn(getContext().designMgmt, 'listRepos').mockResolvedValue({
      repos: structuredClone(REPOS),
      truncated: false
    });
    vi.spyOn(getContext().designMgmt, 'getGitAccounts').mockResolvedValue([
      { _id: 'gitaccount:work', provider: 'github', label: 'Work', username: 'octocat', base_url: null }
    ] as never);
    vi.spyOn(getContext().serverMgmt, 'listServers').mockResolvedValue({
      servers: [{ id: 'srv1', name: 'Alpha' }],
      nextBookmark: ''
    } as never);
    vi.spyOn(getContext().dbMgmt, 'listDatabases').mockResolvedValue(structuredClone(DBS));
    vi.spyOn(getContext().router, 'navigate').mockImplementation(() => {});
  });

  afterEach(() => {
    for (const node of mounted) node.remove();
    mounted.length = 0;
    vi.restoreAllMocks();
  });

  it('names the same repository and branch for the same database', async () => {
    const overview = await mount('cca-repo-overview');
    const overviewRows = (
      overview.shadowRoot!.querySelector('cca-data-table') as unknown as {
        rows: Array<{ repo: GitRepo; target: { server_id: string; db_name: string; branch: string } }>;
      }
    ).rows;
    const overviewRow = overviewRows.find(
      (r) => r.target.server_id === 'srv1' && r.target.db_name === 'orders'
    )!;

    const dbList = await mount('cca-db-list');
    const cells = (
      dbList.shadowRoot!.querySelector('cca-data-table') as Element
    ).shadowRoot!;
    const repoText = cells.querySelector('[data-version-control-repo]')!.textContent!.trim();
    const branchText = cells.querySelector('[data-version-control-branch]')!.textContent!.trim();

    expect(repoText).toBe(overviewRow.repo.name);
    expect(branchText).toBe(overviewRow.target.branch);
    // Not merely equal to each other — equal to the document both were handed.
    expect(repoText).toBe('couchdb-designs');
    expect(branchText).toBe('trunk');
  });
});
