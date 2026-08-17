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
 * Unit tests for cca-repo-overview — the fleet-wide git repository view (#692, #824, #798).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';
import { LitElement, render } from 'lit';
import { getContext } from '../src/context';
import type { GitRepo } from '../src/plugins/design-mgmt/types';
import type { TableColumn } from '../src/components/cca-data-table';
import { GitHttpError } from '../src/services/git/git-http';
import type { Deployment } from '../src/services/deployment-mode';

import '../src/plugins/design-mgmt/repo-overview';
import type { CcaRepoOverview } from '../src/plugins/design-mgmt/repo-overview';
import { CcaToast } from '../src/components/cca-toast';

class WaStub extends LitElement {
  createRenderRoot() {
    return this;
  }
}
for (const tag of ['wa-badge', 'wa-icon', 'wa-tooltip', 'wa-input', 'wa-callout', 'cca-data-table']) {
  if (!customElements.get(tag)) {
    customElements.define(tag, class extends WaStub {});
  }
}

// Wire shape per api/openapi.yaml GitRepo: branch/path live on each sync target (the backend
// stamps the repo's tracked branch onto every one); there is no top-level branch or targets.
const REPOS: GitRepo[] = [
  {
    _id: 'repo:one',
    account_id: 'acc:github',
    name: 'couchdb-designs',
    provider: 'github',
    url: 'https://github.com/example/couchdb-designs.git',
    mode: 'sync',
    sync_targets: [
      { server_id: 'server:prod-us-east', db_name: 'users', branch: 'main', path: '/' },
      { server_id: 'server:prod-eu-west', db_name: 'users', branch: 'main', path: '/' }
    ],
    last_sync: '2026-07-14T09:00:00Z',
    sync_status: 'idle'
  },
  {
    _id: 'repo:two',
    account_id: 'acc:github',
    name: 'edge-factory-views',
    provider: 'github',
    url: 'https://github.com/example/edge-views.git',
    mode: 'gitpush',
    sync_targets: [{ server_id: 'server:edge-factory-1', db_name: 'work-orders', branch: 'release', path: '/factory' }],
    last_sync: null,
    sync_status: 'idle'
  }
];

const SERVERS = [
  { id: 'server:prod-us-east', name: 'Prod US East' },
  { id: 'server:prod-eu-west', name: 'Prod EU West' },
  { id: 'server:edge-factory-1', name: 'Edge Factory 1' }
];

// `token` is a decoy: `maskAccount` is an allow-list and never emits one, so anything that puts
// this string on screen is rendering a secret it invented. The account-edit tests assert against it.
const GIT_ACCOUNTS = [
  {
    _id: 'acc:github',
    provider: 'github',
    label: 'Work GitHub',
    username: 'octocat',
    token: 'redacted',
    base_url: null,
    credential_mode: 'couchdb'
  }
];

let mounted: Element[] = [];

function mount(): CcaRepoOverview {
  const el = document.createElement('cca-repo-overview') as CcaRepoOverview;
  document.body.appendChild(el);
  mounted.push(el);
  return el;
}

async function settle(el: CcaRepoOverview) {
  await el.updateComplete;
  await Promise.resolve();
  await el.updateComplete;
  await Promise.resolve();
  await el.updateComplete;
}

function table(el: CcaRepoOverview) {
  return el.shadowRoot!.querySelector('cca-data-table') as unknown as {
    rows: Array<{ key: string; repo: GitRepo; target: { server_id: string; db_name: string; branch: string; path: string } }>;
    columns: TableColumn<unknown>[];
  } | null;
}

/** Renders a column's cell for one row into a detached host so it can be inspected. */
function cell(columns: TableColumn<unknown>[], label: string, row: unknown): HTMLElement {
  const column = columns.find((c) => c.label === label);
  if (!column?.render) throw new Error(`no render() for column ${label}`);
  const host = document.createElement('div');
  render(column.render(row) as never, host);
  return host;
}

function rowForRepo(el: CcaRepoOverview, repoId: string) {
  return table(el)!.rows.find((r) => r.repo._id === repoId)!;
}

function searchInput(el: CcaRepoOverview): HTMLInputElement {
  return el.shadowRoot!.querySelector('wa-input[name="repo-search"]') as unknown as HTMLInputElement;
}

function type(el: CcaRepoOverview, value: string) {
  const input = searchInput(el);
  (input as unknown as { value: string }).value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

// ---------------------------------------------------------------------------
// Account-edit drawer helpers (#9)
// ---------------------------------------------------------------------------

type ServiceFn = (...args: never[]) => unknown;

/** Service methods stubbed onto the singleton because they do not exist yet; removed in afterEach. */
const installedServiceStubs: string[] = [];

/**
 * `changeCredentialMode` / `renameGitAccount` are landing in `DesignMgmtService` in parallel with
 * this screen (issue #9, tasks A and B). `vi.spyOn` throws on a method that does not exist yet, so
 * this installs a stub in that case and spies once the real method is there — either way the drawer
 * is pinned against the agreed signature, and the day task A lands nothing here has to change.
 */
function stubDesignMgmt(name: string, impl: ServiceFn) {
  const service = getContext().designMgmt as unknown as Record<string, ServiceFn>;
  if (typeof service[name] === 'function') {
    return vi.spyOn(service, name).mockImplementation(impl);
  }
  const fn = vi.fn(impl);
  service[name] = fn as unknown as ServiceFn;
  installedServiceStubs.push(name);
  return fn;
}

function editButton(host: CcaRepoOverview, accountId = 'acc:github'): HTMLElement | null {
  return host.shadowRoot!.querySelector(`wa-button[data-edit-account="${accountId}"]`);
}

function editDrawer(host: CcaRepoOverview): HTMLElement {
  return host.shadowRoot!.querySelector('wa-drawer[data-account-edit]') as HTMLElement;
}

async function openEditor(host: CcaRepoOverview, accountId = 'acc:github'): Promise<HTMLElement> {
  editButton(host, accountId)!.click();
  await settle(host);
  return editDrawer(host);
}

const fieldValue = (field: Element | null): string | undefined =>
  (field as unknown as { value?: string } | null)?.value;

function labelField(drawer: HTMLElement) {
  return drawer.querySelector('wa-input[name="account-label"]') as HTMLElement;
}

function tokenField(drawer: HTMLElement) {
  return drawer.querySelector('wa-input[name="account-token"]') as HTMLElement | null;
}

function saveButton(drawer: HTMLElement) {
  return drawer.querySelector('wa-button[data-save-account]') as HTMLElement;
}

function typeInto(field: HTMLElement, value: string) {
  (field as unknown as { value: string }).value = value;
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Reproduces a real wa-radio-group selection: it fires a native `change`, never `wa-change`. */
function selectMode(drawer: HTMLElement, mode: string) {
  const group = drawer.querySelector('wa-radio-group[name="credential-mode"]') as HTMLElement & {
    value: string;
  };
  Object.defineProperty(group, 'value', { value: mode, configurable: true });
  group.dispatchEvent(new Event('change', { bubbles: true }));
}

const successToasts = (spy: MockInstance) =>
  spy.mock.calls.filter(([, variant]) => variant === 'success');

describe('cca-repo-overview', () => {
  let el: CcaRepoOverview;
  let listReposSpy: MockInstance;
  let navigateSpy: MockInstance;

  beforeEach(async () => {
    const toastEl = document.createElement('cca-toast') as CcaToast;
    document.body.appendChild(toastEl);
    mounted.push(toastEl);
    await toastEl.updateComplete;

    // Every existing test in this file exercises the admin experience (Task 8 gated the whole
    // screen behind admin — see the 'Admin gating' describe block below for the non-admin case).
    vi.spyOn(getContext().auth, 'isAdmin', 'get').mockReturnValue(true);

    listReposSpy = vi
      .spyOn(getContext().designMgmt, 'listRepos')
      .mockResolvedValue({ repos: structuredClone(REPOS), truncated: false });
    vi.spyOn(getContext().serverMgmt, 'listServers').mockResolvedValue({
      servers: structuredClone(SERVERS),
      nextBookmark: ''
    } as never);
    vi.spyOn(getContext().designMgmt, 'getGitAccounts').mockResolvedValue(
      structuredClone(GIT_ACCOUNTS) as never
    );
    navigateSpy = vi.spyOn(getContext().router, 'navigate').mockImplementation(() => {});

    el = mount();
    await settle(el);
  });

  afterEach(() => {
    vi.useRealTimers();
    for (const node of mounted) node.remove();
    mounted = [];
    vi.restoreAllMocks();
    // `vi.restoreAllMocks()` only unwinds spies; a stub installed on a method the service does not
    // have yet would otherwise leak into every later test in this file.
    const service = getContext().designMgmt as unknown as Record<string, unknown>;
    for (const name of installedServiceStubs) delete service[name];
    installedServiceStubs.length = 0;
  });

  it('lists every registered repository', async () => {
    expect(listReposSpy).toHaveBeenCalled();
    const rows = table(el)!.rows;
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.repo.name)).toEqual([
      'couchdb-designs',
      'couchdb-designs',
      'edge-factory-views'
    ]);
  });

  it('shows the branch each repository tracks', () => {
    // Branch is carried per sync target on the wire, so the column must derive it.
    const host = cell(table(el)!.columns, 'Branch', rowForRepo(el, 'repo:two'));
    expect(host.textContent).toContain('release');
  });

  it('survives a repository with no sync targets', async () => {
    // Every GitRepo property is spec-optional; a bare document must not crash the view.
    const bare: GitRepo = {
      _id: 'repo:bare',
      account_id: 'acc:github',
      name: 'bare'
    };
    listReposSpy.mockResolvedValueOnce({
      repos: [...structuredClone(REPOS), bare],
      truncated: false
    });

    await (el as unknown as { load: () => Promise<void> }).load();
    await settle(el);

    // Bare repo has no targets, therefore no table row should be emitted for it.
    const rows = table(el)!.rows;
    expect(rows.find((r) => r.repo._id === 'repo:bare')).toBeUndefined();
  });

  it('renders every target of a repository, not just the first', () => {
    // The fan-out is the whole point: repo:one spans two (server, database) pairs.
    const rows = table(el)!.rows.filter((r) => r.repo._id === 'repo:one');
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => `${r.target.server_id}/${r.target.db_name}`)).toEqual([
      'server:prod-us-east/users',
      'server:prod-eu-west/users'
    ]);
  });

  it('navigates to the design docs of the target a pill names, with the database preselected', () => {
    const rows = table(el)!.rows.filter((r) => r.repo._id === 'repo:one');
    const host = cell(table(el)!.columns, 'Target', rows[1]);
    const pill = host.querySelector('wa-badge') as HTMLElement;

    pill.click();

    expect(navigateSpy).toHaveBeenCalledWith('/design-docs/server%3Aprod-eu-west?database=users');
  });

  it('falls back to the raw server id when the server list is unavailable', async () => {
    vi.restoreAllMocks();
    vi.spyOn(getContext().auth, 'isAdmin', 'get').mockReturnValue(true);
    vi.spyOn(getContext().designMgmt, 'listRepos').mockResolvedValue({
      repos: structuredClone(REPOS),
      truncated: false
    });
    vi.spyOn(getContext().designMgmt, 'getGitAccounts').mockResolvedValue(
      structuredClone(GIT_ACCOUNTS) as never
    );
    // A failure naming servers must not cost us the repository list.
    vi.spyOn(getContext().serverMgmt, 'listServers').mockRejectedValue(new Error('boom'));

    const el2 = mount();
    await settle(el2);

    expect(table(el2)!.rows).toHaveLength(3);
    const host = cell(table(el2)!.columns, 'Target', rowForRepo(el2, 'repo:two'));
    expect(host.querySelector('wa-badge')!.textContent).toContain('server:edge-factory-1');
  });

  it('renders an em-dash when a repository has never synced', () => {
    const host = cell(table(el)!.columns, 'Last sync', rowForRepo(el, 'repo:two'));
    expect(host.textContent).toContain('—');
  });

  it('keeps the table populated when a refresh fails', async () => {
    listReposSpy.mockRejectedValue(new Error('nope'));

    await (el as unknown as { load: () => Promise<void> }).load();
    await settle(el);

    // A failed refresh should not blank the view.
    expect(table(el)!.rows).toHaveLength(3);
  });

  it('redirects to design list from Register a repository link', async () => {
    listReposSpy.mockResolvedValueOnce({ repos: [], truncated: false });

    await (el as unknown as { load: () => Promise<void> }).load();
    await settle(el);

    const link = el.shadowRoot!.querySelector('.no-repos a') as HTMLAnchorElement | null;
    expect(link).not.toBeNull();

    link!.click();

    expect(navigateSpy).toHaveBeenCalledWith('/design-docs/$all');
  });

  // ---------------------------------------------------------------------------
  // #824 — server-side search, debounced, with stale-response protection
  // ---------------------------------------------------------------------------

  it('renders the repository name as a link opening in a new tab', () => {
    const host = cell(table(el)!.columns, 'Repository', rowForRepo(el, 'repo:one'));
    const link = host.querySelector('a.repo-name') as HTMLAnchorElement | null;

    expect(link).not.toBeNull();
    expect(link!.getAttribute('href')).toBe(REPOS[0].url);
    expect(link!.getAttribute('target')).toBe('_blank');
    expect(link!.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('shows branch in dedicated column and path in target pills', () => {
    const row = {
      key: 'repo:one-srv1-mydb-main',
      repo: REPOS[0],
      target: {
        server_id: 'srv1',
        db_name: 'mydb',
        branch: 'main',
        path: '/designs'
      }
    };

    // Branch is shown in its own column
    const branchCell = cell(table(el)!.columns, 'Branch', row);
    expect(branchCell.textContent).toContain('main');

    // Path is shown in Design Root column, target pill stays server/database
    const pathCell = cell(table(el)!.columns, 'Design Root', row);
    expect(pathCell.textContent).toContain('/designs');

    const targetsCell = cell(table(el)!.columns, 'Target', row);
    const pill = targetsCell.querySelector('wa-badge')!;
    expect(pill.textContent).toContain('srv1');
    expect(pill.textContent).toContain('mydb');
    expect(pill.textContent).not.toContain('main');
  });

  it('target pill navigates to design-list with the database preselected', () => {
    const row = {
      key: 'repo:one-srv1-mydb-main',
      repo: REPOS[0],
      target: {
        server_id: 'srv1',
        db_name: 'mydb',
        branch: 'main',
        path: '/designs'
      }
    };
    const host = cell(table(el)!.columns, 'Target', row);
    const pill = host.querySelector('wa-badge') as HTMLElement;

    pill.click();

    expect(navigateSpy).toHaveBeenCalledWith('/design-docs/srv1?database=mydb');
  });

  it('gives the unlink button the shared outlined/row-action-button treatment (#112)', () => {
    const host = cell(table(el)!.columns, 'Target', rowForRepo(el, 'repo:two'));
    const btn = host.querySelector('wa-button.row-action-button')!;

    expect(btn.getAttribute('appearance')).toBe('outlined');
    expect(btn.classList.contains('row-action-button')).toBe(true);
  });

  it('passes the search text as the server-side filter after the debounce window', async () => {
    listReposSpy.mockClear();
    vi.useFakeTimers();

    for (const v of ['x', 'xx', 'xxx']) type(el, v);

    expect(listReposSpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);
    expect(listReposSpy).toHaveBeenCalledTimes(1);
    expect(listReposSpy.mock.calls[0][0]).toBe('xxx');
  });

  it('clearing the search reloads immediately without a filter', async () => {
    listReposSpy.mockClear();
    vi.useFakeTimers();

    type(el, 'x');
    const input = searchInput(el);
    // WA's clear button dispatches wa-clear, then a composed `input` for the
    // same (now empty) value — replicate the full shipped event sequence.
    (input as unknown as { value: string }).value = '';
    input.dispatchEvent(new CustomEvent('wa-clear', { bubbles: true }));
    input.dispatchEvent(new Event('input', { bubbles: true }));

    expect(listReposSpy).toHaveBeenCalledTimes(1);
    expect(listReposSpy.mock.calls[0][0]).toBeUndefined();

    await vi.advanceTimersByTimeAsync(1000);
    expect(listReposSpy).toHaveBeenCalledTimes(1);
  });

  it('drops a stale repo response that resolves after a newer reload', async () => {
    listReposSpy.mockClear();
    let resolveStale!: (v: unknown) => void;
    let resolveCurrent!: (v: unknown) => void;
    listReposSpy
      .mockImplementationOnce(() => new Promise((r) => { resolveStale = r; }))
      .mockImplementationOnce(() => new Promise((r) => { resolveCurrent = r; }));
    vi.useFakeTimers();

    type(el, 'a');
    await vi.advanceTimersByTimeAsync(250); // reload 1 (will become stale) in flight
    searchInput(el).dispatchEvent(new CustomEvent('wa-clear', { bubbles: true })); // reload 2 (current)
    expect(listReposSpy).toHaveBeenCalledTimes(2);

    // The stale response lands first; once the current response completes, stale data must not win.
    const stale: GitRepo[] = [{ ...REPOS[0], _id: 'repo:stale' }];
    resolveStale({ repos: stale, truncated: false });
    await vi.advanceTimersByTimeAsync(0);

    resolveCurrent({ repos: structuredClone(REPOS), truncated: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(table(el)!.rows.map((r) => r.repo._id)).toEqual([
      'repo:one',
      'repo:one',
      'repo:two'
    ]);
  });

  // ---------------------------------------------------------------------------
  // Unlinking a target (issue #6 item 1)
  // ---------------------------------------------------------------------------
  describe('unlinking a target', () => {
    /** Puts the component in the state the confirm dialog leaves it in, then unlinks. */
    async function unlink(overview: CcaRepoOverview, repoId: string) {
      const internals = overview as unknown as {
        unlinkTarget: { repoId: string; target: unknown } | null;
        showUnlinkConfirm: boolean;
        handleUnlinkTarget: () => Promise<void>;
      };
      const repo = REPOS.find((r) => r._id === repoId)!;
      internals.unlinkTarget = { repoId, target: repo.sync_targets![0] };
      internals.showUnlinkConfirm = true;
      await internals.handleUnlinkTarget();
      await settle(overview);
    }

    it('confirms a real unlink as a success', async () => {
      const toastSpy = vi.spyOn(await import('../src/components/cca-toast.js'), 'toast');
      vi.spyOn(getContext().designMgmt, 'unlinkRepo').mockResolvedValue({
        action: 'target_removed',
        repo_id: 'repo:one',
        remaining_targets: 1,
        deleted_sync_docs: 3
      });

      await unlink(el, 'repo:one');

      expect(toastSpy).toHaveBeenCalledWith(expect.stringMatching(/unlinked/i), 'success');
    });

    // The service used to answer 'target_removed' even when it removed nothing, so this screen
    // reported "Target unlinked (2 connections remain)" as a success for a target that was never
    // linked in the first place. It is not an error either — the user's desired state was already
    // true — so it must be said plainly, without claiming a removal.
    it('does not claim a removal when nothing was linked', async () => {
      const toastSpy = vi.spyOn(await import('../src/components/cca-toast.js'), 'toast');
      vi.spyOn(getContext().designMgmt, 'unlinkRepo').mockResolvedValue({
        action: 'not_linked',
        repo_id: 'repo:one',
        remaining_targets: 2,
        deleted_sync_docs: 0
      });

      await unlink(el, 'repo:one');

      expect(toastSpy).toHaveBeenCalledTimes(1);
      const [message, variant] = toastSpy.mock.calls[0] as [string, string];
      expect(variant).toBe('info'); // neither a success to celebrate nor an error to raise
      expect(message).not.toMatch(/unlinked/i);
      expect(message).toMatch(/not linked/i);
    });

    it('leaves the listing untouched when nothing was unlinked', async () => {
      vi.spyOn(getContext().designMgmt, 'unlinkRepo').mockResolvedValue({
        action: 'not_linked',
        repo_id: 'repo:one',
        remaining_targets: 2,
        deleted_sync_docs: 0
      });

      await unlink(el, 'repo:one');

      // Nothing was removed server-side, so nothing may disappear from the screen either.
      expect(table(el)!.rows).toHaveLength(3);
    });
  });

  // ---------------------------------------------------------------------------
  // Editing a connected account (#9) — label, and where the access token is kept.
  // The fixture account stores its token on the CouchDB server, so every mode
  // change below is a real move away from `couchdb`.
  // ---------------------------------------------------------------------------
  describe('editing a git account (#9)', () => {
    let changeCredentialMode: MockInstance;
    let renameGitAccount: MockInstance;
    let toastSpy: MockInstance;

    beforeEach(async () => {
      changeCredentialMode = stubDesignMgmt('changeCredentialMode', (() =>
        Promise.resolve({ status: 'changed', from: 'couchdb', to: 'indexeddb' })) as never);
      renameGitAccount = stubDesignMgmt('renameGitAccount', ((_id: string, label: string) =>
        Promise.resolve({ ...GIT_ACCOUNTS[0], label })) as never);
      toastSpy = vi.spyOn(await import('../src/components/cca-toast.js'), 'toast');
    });

    it('offers an edit action for every connected account', async () => {
      vi.spyOn(getContext().designMgmt, 'getGitAccounts').mockResolvedValue([
        ...structuredClone(GIT_ACCOUNTS),
        {
          _id: 'acc:personal',
          provider: 'github',
          label: 'Personal GitHub',
          username: 'me',
          base_url: null,
          credential_mode: 'none'
        }
      ] as never);

      const el2 = mount();
      await settle(el2);

      expect(el2.shadowRoot!.querySelectorAll('wa-button[data-edit-account]')).toHaveLength(2);
    });

    it('opens the drawer on the chosen account, with its label and storage mode already set', async () => {
      const drawer = await openEditor(el);

      expect(drawer.hasAttribute('open')).toBe(true);
      expect(fieldValue(labelField(drawer))).toBe('Work GitHub');
      expect(
        (drawer.querySelector('wa-radio-group[name="credential-mode"]') as unknown as { value: string })
          .value
      ).toBe('couchdb');
      // Read-only context the user needs to know which account this is, and cannot change here.
      expect(drawer.textContent).toContain('octocat');
    });

    it('sends the newly chosen storage mode to the service', async () => {
      const drawer = await openEditor(el);
      selectMode(drawer, 'indexeddb');
      await settle(el);

      saveButton(drawer).click();
      await settle(el);

      expect(changeCredentialMode).toHaveBeenCalledWith('acc:github', 'indexeddb', undefined);
    });

    it('names the store the token is leaving before anything is saved', async () => {
      const drawer = await openEditor(el);
      selectMode(drawer, 'indexeddb');
      await settle(el);

      // The purge is the part the user cannot see for themselves (I9-6): saying where the token is
      // going is not enough, the message has to say the old copy goes away and name where from.
      expect(drawer.textContent).toContain('couchcompanion');
      expect(drawer.textContent).toMatch(/deletes the copy/i);
    });

    it('asks for the access token instead of reporting success when there is nothing to move', async () => {
      changeCredentialMode.mockResolvedValue({ status: 'token_required' });

      const drawer = await openEditor(el);
      selectMode(drawer, 'indexeddb');
      await settle(el);
      saveButton(drawer).click();
      await settle(el);

      expect(tokenField(drawer)).not.toBeNull();
      expect(successToasts(toastSpy)).toHaveLength(0);
      expect(drawer.hasAttribute('open')).toBe(true);
    });

    it('retries the change with the token the user supplies, then reports success', async () => {
      changeCredentialMode.mockResolvedValueOnce({ status: 'token_required' });

      const drawer = await openEditor(el);
      selectMode(drawer, 'indexeddb');
      await settle(el);
      saveButton(drawer).click();
      await settle(el);

      typeInto(tokenField(drawer)!, 'ghp_supplied');
      await settle(el);
      saveButton(drawer).click();
      await settle(el);

      expect(changeCredentialMode).toHaveBeenLastCalledWith('acc:github', 'indexeddb', 'ghp_supplied');
      expect(successToasts(toastSpy)).toHaveLength(1);
    });

    it('needs no token to stop storing one — the purge is the whole operation', async () => {
      changeCredentialMode.mockResolvedValue({ status: 'changed', from: 'couchdb', to: 'none' });

      const drawer = await openEditor(el);
      selectMode(drawer, 'none');
      await settle(el);
      saveButton(drawer).click();
      await settle(el);

      expect(changeCredentialMode).toHaveBeenCalledWith('acc:github', 'none', undefined);
      // No token was asked for and the change went through in one pass.
      expect(editDrawer(el).hasAttribute('open')).toBe(false);
      expect(successToasts(toastSpy)).toHaveLength(1);
      expect(successToasts(toastSpy)[0][0]).toContain('couchcompanion');
    });

    it('renames the account and shows the new label in the list', async () => {
      const drawer = await openEditor(el);
      typeInto(labelField(drawer), 'Renamed GitHub');
      await settle(el);

      saveButton(drawer).click();
      await settle(el);

      expect(renameGitAccount).toHaveBeenCalledWith('acc:github', 'Renamed GitHub');
      expect(el.shadowRoot!.querySelector('.account-label')!.textContent).toContain('Renamed GitHub');
    });

    it('never renders an access token', async () => {
      const drawer = await openEditor(el);

      expect(el.shadowRoot!.innerHTML).not.toContain('redacted');
      expect(
        Array.from(drawer.querySelectorAll('wa-input')).map((field) => fieldValue(field))
      ).not.toContain('redacted');
    });
  });

  // ---------------------------------------------------------------------------
  // Admin gating (D9) — every read on this screen (listRepos, getGitAccounts) goes
  // through couchcompanion, which is admin-only by CouchDB's own default security,
  // so the whole screen — not just its write actions — is admin-only.
  // ---------------------------------------------------------------------------
  describe('Admin gating (D9 — couchcompanion is admin-only)', () => {
    beforeEach(async () => {
      // Overrides the outer beforeEach's admin=true default for this describe block only —
      // the outer mocks for listRepos/getGitAccounts/listServers stay in place (still resolving
      // fixed data) so a gating bug that DOES call them fails on `not.toHaveBeenCalled()` instead
      // of on an unrelated network/store error.
      vi.spyOn(getContext().auth, 'isAdmin', 'get').mockReturnValue(false);
      listReposSpy.mockClear();
    });

    it('hides the sync/connect actions from a non-admin, who cannot write couchcompanion anyway', async () => {
      const addHeaderActionsSpy = vi.spyOn(await import('../src/components/cca-header.js'), 'addHeaderActions');
      const nonAdminEl = mount();
      await settle(nonAdminEl);

      const calls = addHeaderActionsSpy.mock.calls.flatMap(([actions]) => actions);
      expect(calls.find((a: any) => a.tooltip === 'Connect Git Account')).toBeUndefined();
    });

    it('does not attempt to load repositories for a non-admin — couchcompanion is admin-only', async () => {
      const nonAdminEl = mount();
      await settle(nonAdminEl);

      expect(listReposSpy).not.toHaveBeenCalled();
    });

    it('explains why version control is unavailable rather than just hiding it', async () => {
      const nonAdminEl = mount();
      await settle(nonAdminEl);

      expect(nonAdminEl.shadowRoot!.textContent).toMatch(/administrator/i);
    });

    it('offers a non-admin no account editing at all — the callout is the whole screen', async () => {
      const nonAdminEl = mount();
      await settle(nonAdminEl);

      expect(editButton(nonAdminEl)).toBeNull();
      expect(nonAdminEl.shadowRoot!.querySelector('wa-drawer[data-account-edit]')).toBeNull();

      // Control: the same selectors DO match for an admin. Without this the assertions above pass
      // for a typo, and would go on passing if the edit drawer were deleted entirely.
      vi.spyOn(getContext().auth, 'isAdmin', 'get').mockReturnValue(true);
      const adminEl = mount();
      await settle(adminEl);

      expect(editButton(adminEl)).not.toBeNull();
      expect(adminEl.shadowRoot!.querySelector('wa-drawer[data-account-edit]')).not.toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Connecting an account when the request never left the browser (#28).
  //
  // `GitHttp` can say the request was not sent and name the host, but not what to do about it:
  // whose Content-Security-Policy applies depends on who serves the bundle, and only a component
  // can read `getContext().deployment.mode`. Served from CouchDB's /_utils the policy is
  // CouchDB's and the operator can widen it; hosted anywhere else it is not, and naming
  // CouchDB's config key would send them to the wrong file.
  // ---------------------------------------------------------------------------
  describe('Connect account — a request that never left the browser (#28)', () => {
    let toastSpy: MockInstance;
    let savedDeployment: Deployment;

    /** What `GitHttp` now throws when `fetch` rejects before any response exists. */
    const blockedError = () =>
      new GitHttpError(0, 'The request to api.github.com was never sent.', false, 'blocked', 'api.github.com');

    beforeEach(async () => {
      toastSpy = vi.spyOn(await import('../src/components/cca-toast.js'), 'toast');
      savedDeployment = getContext().deployment;
    });

    afterEach(() => {
      getContext().deployment = savedDeployment;
    });

    function deploy(mode: Deployment['mode']) {
      getContext().deployment = { mode, baseUrl: mode === 'same-origin' ? 'http://localhost:5984' : '' };
    }

    /** Fills the connect drawer and clicks its Connect button — the real path a user takes. */
    async function attemptConnect(host: CcaRepoOverview, failure: unknown) {
      vi.spyOn(getContext().designMgmt, 'postGitAccounts').mockRejectedValue(failure);

      const state = host as unknown as Record<string, unknown>;
      state.connectProvider = 'github';
      state.showConnectAccountDialog = true;
      state.connectLabel = 'Work GitHub';
      state.connectToken = 'ghp_example';
      await settle(host);

      const drawer = host.shadowRoot!.querySelector(
        'wa-drawer[label="Connect GitHub Account"]'
      ) as HTMLElement;
      const connect = Array.from(drawer.querySelectorAll('wa-button')).find((b) =>
        /^connect/i.test((b.textContent ?? '').trim())
      ) as HTMLElement;
      connect.click();
      await settle(host);
    }

    const errorToast = () =>
      (toastSpy.mock.calls.find(([, variant]) => variant === 'error') ?? [])[0] as string | undefined;

    it('tells a CouchDB-hosted admin whose policy applies and where to read about it', async () => {
      deploy('same-origin');
      await attemptConnect(el, blockedError());

      const message = errorToast() ?? '';
      expect(message).toContain('The request to api.github.com was never sent.');
      expect(message).toMatch(/connect-src/);
      expect(message).toContain('api.github.com');
      expect(message).toMatch(/install\.md/);
    });

    it('says nothing about CouchDB\'s CSP under SPA hosting — the policy is not CouchDB\'s', async () => {
      deploy('spa');
      await attemptConnect(el, blockedError());

      const message = errorToast() ?? '';
      // The failure is still reported; only the advice that would be wrong is withheld.
      expect(message).toContain('The request to api.github.com was never sent.');
      expect(message).not.toMatch(/connect-src|install\.md|utils_header_value/);
    });

    /**
     * The advice is keyed on the failure, not on the deployment: a 401 in same-origin mode is a
     * token problem and pointing at the CSP would be actively misleading.
     */
    it('does not blame the CSP for an error that did reach the host', async () => {
      deploy('same-origin');
      await attemptConnect(el, new GitHttpError(401, 'Bad credentials'));

      const message = errorToast() ?? '';
      expect(message).toContain('Bad credentials');
      expect(message).not.toMatch(/connect-src|install\.md|utils_header_value/);
    });
  });
});
