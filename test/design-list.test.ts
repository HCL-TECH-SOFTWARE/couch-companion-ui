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
 * Unit tests for CcaDesignList component.
 *
 * Tests rendering, filtering, sync status display, and user interactions.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LitElement, render } from 'lit';
import { getContext } from '../src/context';
import type { CcaDesignList } from '../src/plugins/design-mgmt/design-list.js';
import '../src/plugins/design-mgmt/design-list.js';
import type { TrackedDesignDoc } from '../src/plugins/design-mgmt/types.js';
import { ApiError } from '../src/services/api-error.js';
import { describeDbAccessError } from '../src/services/db-enumeration.js';
import type { CcaDbPicker } from '../src/components/cca-db-picker.js';
import { GitHubProvider } from '../src/services/git/github-provider.js';
import { GitHttpError } from '../src/services/git/git-http.js';
import { SINGLE_SERVER_ID } from '../src/services/single-server.js';

// ---------------------------------------------------------------------------
// Stub wa-* and cca-* custom elements so the component can render in jsdom
// ---------------------------------------------------------------------------
class WaStub extends LitElement {
  createRenderRoot() {
    return this;
  }
}

for (const tag of [
  'wa-card', 'wa-button', 'wa-badge', 'wa-checkbox', 'wa-icon',
  'wa-input', 'wa-select', 'wa-option', 'wa-label', 'wa-form',
  'wa-dialog', 'wa-spinner',
]) {
  if (!customElements.get(tag)) {
    customElements.define(tag, class extends WaStub {});
  }
}

for (const tag of ['cca-data-table', 'cca-form']) {
  if (!customElements.get(tag)) {
    customElements.define(tag, class extends WaStub {});
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function getEl(): CcaDesignList {
  const el = document.createElement('cca-design-list') as CcaDesignList;
  document.body.appendChild(el);
  return el;
}

async function updated(el: CcaDesignList) {
  await el.updateComplete;
}

function requireShadowRoot(el: CcaDesignList): ShadowRoot {
  if (!el.shadowRoot) throw new Error('expected shadowRoot');
  return el.shadowRoot;
}

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------
const mockDocs: TrackedDesignDoc[] = [
  {
    server_id: 'srv1',
    server_name: 'Server 1',
    db_name: 'animals',
    ddoc_id: '_design/animals',
    rev: '1-abc123',
    ddoc_rev: '1-abc123',
    git_repo_id: 'repo:test123',
    last_git_sha: 'abc123',
    last_sync: '2026-05-22T10:00:00Z',
    updated_at: '2026-05-22T10:00:00Z',
    sync_status: 'in_sync',
  },
  {
    server_id: 'srv1',
    server_name: 'Server 1',
    db_name: 'users',
    ddoc_id: '_design/users',
    rev: '3-ghi789',
    ddoc_rev: '2-old456',
    git_repo_id: 'repo:test123',
    last_git_sha: 'ghi789',
    last_sync: '2026-05-22T08:00:00Z',
    updated_at: '2026-05-22T12:00:00Z',
    sync_status: 'repo_ahead',
  },
];

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
describe('CcaDesignList', () => {
  let element: CcaDesignList;

  beforeEach(async () => {
    const ctx = getContext();
    // Every other test in this file exercises the admin experience (Task 8 added gating on top of
    // it) — default to admin here so existing assertions keep testing what they always tested; the
    // 'Admin gating' describe block below overrides this per-test for the non-admin scenarios.
    vi.spyOn(ctx.auth, 'isAdmin', 'get').mockReturnValue(true);
    // Silence network calls made in connectedCallback
    vi.spyOn(ctx.serverMgmt, 'listServers').mockResolvedValue({ servers: [], nextBookmark: '' });
    vi.spyOn(ctx.serverMgmt, 'getDatabases').mockResolvedValue([]);
    vi.spyOn(ctx.designMgmt, 'getRepo').mockResolvedValue({ repo: null } as any);
    vi.spyOn(ctx.designMgmt, 'getRepoDocs').mockResolvedValue([]);
    vi.spyOn(ctx.designMgmt, 'listDesignDocs').mockResolvedValue([]);
    vi.spyOn(ctx.designMgmt, 'getGitRepoBranches').mockResolvedValue(['main', 'develop']);
    vi.spyOn(ctx.designMgmt, 'getGitAccountRepos').mockResolvedValue([
      {
        full_name: 'user/test-repo',
        clone_url: 'https://github.com/user/test-repo.git',
        default_branch: 'main',
        private: false,
        description: 'Test repository'
      }
    ]);

    element = getEl();
    // Wait for connectedCallback async work to settle
    await element.updateComplete;
    await Promise.resolve();
    await element.updateComplete;
  });

  afterEach(() => {
    element.remove();
    vi.restoreAllMocks();
  });

  describe('Core Functionality', () => {
    it('should render component with table structure', async () => {
      await updated(element);
      expect(element).toBeDefined();
      // component renders a cca-data-table (wraps the table)
      expect(requireShadowRoot(element).querySelector('cca-data-table')).not.toBeNull();
    });

    it('should display and filter design documents by database', async () => {
      // @ts-ignore
      element.docs = mockDocs;
      // @ts-ignore
      element.loading = false;
      // @ts-ignore
      element.selectedServer = 'srv1';
      // @ts-ignore
      element.selectedDatabase = 'animals';
      await updated(element);

      // Rows are passed as a property to cca-data-table (a stub in tests)
      const table = requireShadowRoot(element).querySelector('cca-data-table') as any;
      expect(table).not.toBeNull();
      const animalsRows: TrackedDesignDoc[] = table.rows ?? [];
      expect(animalsRows.some((d: TrackedDesignDoc) => d.ddoc_id === '_design/animals')).toBe(true);
      expect(animalsRows.every((d: TrackedDesignDoc) => d.ddoc_id !== '_design/users')).toBe(true);

      // Switch database
      // @ts-ignore
      element.selectedDatabase = 'users';
      await updated(element);

      const usersRows: TrackedDesignDoc[] = (requireShadowRoot(element).querySelector('cca-data-table') as any)?.rows ?? [];
      expect(usersRows.some((d: TrackedDesignDoc) => d.ddoc_id === '_design/users')).toBe(true);
      expect(usersRows.every((d: TrackedDesignDoc) => d.ddoc_id !== '_design/animals')).toBe(true);
    });

    it('should display sync status badges', async () => {
      // @ts-ignore
      element.docs = mockDocs;
      // @ts-ignore
      element.loading = false;
      // @ts-ignore
      element.selectedServer = 'srv1';
      // @ts-ignore
      element.selectedDatabase = 'animals';
      await updated(element);

      // wa-badge elements are rendered by the cca-data-table column renderers
      // The filteredDocs drives the rows prop; check rows are passed through
      const table = requireShadowRoot(element).querySelector('cca-data-table') as any;
      expect(table).not.toBeNull();
      // The table receives the filtered docs; assert at least one doc in animals
      expect(table.rows?.length).toBeGreaterThan(0);
    });

    it('should handle empty document list', async () => {
      // @ts-ignore
      element.docs = [];
      // @ts-ignore
      element.loading = false;
      await updated(element);

      expect(element.shadowRoot).toBeDefined();
    });

    it('text search filters the merged set by ddoc_id, case-insensitively', async () => {
      const gitOnlyDoc: TrackedDesignDoc = {
        server_id: 'srv1',
        server_name: null,
        db_name: 'animals',
        ddoc_id: '_design/gitonly',
        rev: null,
        ddoc_rev: null,
        git_repo_id: 'repo:test123',
        last_git_sha: 'zzz999',
        last_sync: '2026-05-22T09:00:00Z',
        updated_at: '2026-05-22T09:00:00Z',
        sync_status: 'unknown',
      };
      // @ts-ignore
      element.docs = [
        ...mockDocs,
        { ...mockDocs[0], ddoc_id: '_design/birds' },
        gitOnlyDoc,
      ];
      // @ts-ignore
      element.loading = false;
      // @ts-ignore
      element.selectedServer = 'srv1';
      // @ts-ignore
      element.selectedDatabase = 'animals';
      await updated(element);

      const input = requireShadowRoot(element).querySelector('wa-input[name="search"]') as any;
      expect(input).not.toBeNull();
      input.value = 'GITON';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await updated(element);

      const rows: TrackedDesignDoc[] =
        (requireShadowRoot(element).querySelector('cca-data-table') as any).rows ?? [];
      // The git-only doc is found; couch-sourced docs not matching are hidden
      expect(rows.map((d) => d.ddoc_id)).toEqual(['_design/gitonly']);
    });

    it('search composes with the database scope instead of replacing it', async () => {
      // @ts-ignore
      element.docs = mockDocs; // animals + users dbs, both ddoc_ids contain "_design"
      // @ts-ignore
      element.loading = false;
      // @ts-ignore
      element.selectedServer = 'srv1';
      // @ts-ignore
      element.selectedDatabase = 'animals';
      await updated(element);

      const input = requireShadowRoot(element).querySelector('wa-input[name="search"]') as any;
      input.value = '_design';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await updated(element);

      const rows: TrackedDesignDoc[] =
        (requireShadowRoot(element).querySelector('cca-data-table') as any).rows ?? [];
      // "_design" matches every ddoc_id, but only the animals-db doc is in scope
      expect(rows.map((d) => d.ddoc_id)).toEqual(['_design/animals']);
    });

    it('clearing the search restores the full scoped set', async () => {
      // @ts-ignore
      element.docs = [...mockDocs, { ...mockDocs[0], ddoc_id: '_design/birds' }];
      // @ts-ignore
      element.loading = false;
      // @ts-ignore
      element.selectedServer = 'srv1';
      // @ts-ignore
      element.selectedDatabase = 'animals';
      await updated(element);

      const input = requireShadowRoot(element).querySelector('wa-input[name="search"]') as any;
      input.value = 'birds';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await updated(element);
      let rows: TrackedDesignDoc[] =
        (requireShadowRoot(element).querySelector('cca-data-table') as any).rows ?? [];
      expect(rows).toHaveLength(1);

      input.value = '';
      input.dispatchEvent(new CustomEvent('wa-clear', { bubbles: true }));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await updated(element);
      rows = (requireShadowRoot(element).querySelector('cca-data-table') as any).rows ?? [];
      expect(rows.map((d) => d.ddoc_id).sort()).toEqual(['_design/animals', '_design/birds']);
    });

    it('changing the search resets the selection so hidden rows cannot be bulk-acted on', async () => {
      // @ts-ignore
      element.docs = [...mockDocs, { ...mockDocs[0], ddoc_id: '_design/birds' }];
      // @ts-ignore
      element.loading = false;
      // @ts-ignore
      element.selectedServer = 'srv1';
      // @ts-ignore
      element.selectedDatabase = 'animals';
      // @ts-ignore
      element.selectedDocs = new Set(['srv1|animals|_design/animals']);
      await updated(element);

      const input = requireShadowRoot(element).querySelector('wa-input[name="search"]') as any;
      input.value = 'birds'; // hides the selected _design/animals row
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await updated(element);

      // @ts-ignore
      expect(element.selectedDocs.size).toBe(0);
    });
  });

  describe('Document Selection', () => {
    it('should render selection checkboxes via cca-data-table columns', async () => {
      // @ts-ignore
      element.docs = mockDocs;
      // @ts-ignore
      element.loading = false;
      // @ts-ignore
      element.selectedServer = 'srv1';
      // @ts-ignore
      element.selectedDatabase = 'animals';
      await updated(element);

      // The tableColumns definition includes a checkbox column; verify the
      // data-table is rendered (checkbox rendering is delegated to it)
      const table = requireShadowRoot(element).querySelector('cca-data-table');
      expect(table).not.toBeNull();
    });
  });

  describe('Git Sync', () => {
    it('should show sync buttons when repo is connected', async () => {
      // @ts-ignore
      element.loading = false;
      // @ts-ignore
      element.selectedDatabase = 'animals';
      // @ts-ignore
      element.hasGitRepo = true;
      // @ts-ignore
      element.repoId = 'repo:test123';
      await updated(element);

      const buttons = requireShadowRoot(element).querySelectorAll('wa-button');
      expect(buttons.length).toBeGreaterThan(0);
    });

    /**
     * #49: neither sync button means anything without a registered repository — pressing
     * "Sync to Repo" with no `repoId` only produced a toast. This pins the negative case
     * the positive test above does not cover: admin, database selected, but no repo yet.
     */
    it('hides the sync buttons when no repository is registered yet', async () => {
      // @ts-ignore
      element.loading = false;
      // @ts-ignore
      element.selectedDatabase = 'animals';
      // @ts-ignore
      element.repoId = null;
      await updated(element);

      expect(requireShadowRoot(element).querySelector('[data-testid="sync-to-repo"]')).toBeNull();
      expect(requireShadowRoot(element).querySelector('[data-testid="sync-to-couch"]')).toBeNull();
    });
  });

  describe('Navigation — server-segment URL (#518)', () => {
    it('navigates to /design-docs/:serverId/editor/:db/:ddoc when a row is opened', async () => {
      const ctx = getContext();
      const navigateSpy = vi.spyOn(ctx.router, 'navigate');

      // @ts-ignore — call the private method directly with a synthetic event
      element.launchDocEditor(new CustomEvent('cca-row-click', {
        detail: {
          server_id: 'srv1',
          db_name: 'animals',
          ddoc_id: '_design/animals',
        } as TrackedDesignDoc,
      }));

      expect(navigateSpy).toHaveBeenCalledOnce();
      const url: string = navigateSpy.mock.calls[0][0];
      // Server segment must be in the SECOND position
      expect(url).toMatch(/^\/design-docs\/srv1\/editor\/animals\/_design%2Fanimals$/);
    });

    it('URL encodes server_id, db_name, and ddoc_id', () => {
      const ctx = getContext();
      const navigateSpy = vi.spyOn(ctx.router, 'navigate');

      // @ts-ignore
      element.launchDocEditor(new CustomEvent('cca-row-click', {
        detail: {
          server_id: 'my server',
          db_name: 'my-db',
          ddoc_id: '_design/my design',
        } as TrackedDesignDoc,
      }));

      const url: string = navigateSpy.mock.calls[0][0];
      expect(url).toBe('/design-docs/my%20server/editor/my-db/_design%2Fmy%20design');
    });
  });

  describe('Branch Selection', () => {
    it('loads branches when repo is selected', async () => {
      const ctx = getContext();
      const mockRepo = {
        full_name: 'user/test-repo',
        clone_url: 'https://github.com/user/test-repo.git',
        default_branch: 'main',
        private: false,
        description: 'Test repository'
      };

      // @ts-ignore — set private state
      element.selectedAccountId = 'account:123';
      // @ts-ignore
      element.availableRepos = [mockRepo];
      await updated(element);

      // Simulate repo selection by calling the handler directly
      const event = new Event('change');
      Object.defineProperty(event, 'target', {
        value: { value: mockRepo.clone_url },
        writable: false
      });

      // @ts-ignore — call private method
      await element.handleRepoSelect(event);
      await updated(element);

      // Assert branches were loaded (currently hardcoded in implementation)
      // @ts-ignore
      expect(element.repoBranches).toBeDefined();
      // @ts-ignore
      expect(element.repoBranches.length).toBeGreaterThan(0);
    });

    it('populates branch dropdown with fetched branches', async () => {
      const mockBranches = ['main', 'develop', 'feature/test'];
      const ctx = getContext();
      vi.spyOn(ctx.designMgmt, 'getGitRepoBranches').mockResolvedValue(mockBranches);

      // @ts-ignore
      element.selectedAccountId = 'account:456';
      // @ts-ignore
      element.repoBranches = mockBranches;
      await updated(element);

      // @ts-ignore
      expect(element.repoBranches).toEqual(mockBranches);
      // @ts-ignore
      expect(element.repoBranches).toHaveLength(3);
    });

    it('sets branch value in form when branch is selected', async () => {
      // @ts-ignore
      element.repoBranches = ['main', 'develop'];
      await updated(element);

      // Mock the cca-form element
      const mockForm = {
        setFieldValue: vi.fn()
      };
      vi.spyOn(element.shadowRoot!, 'querySelector').mockReturnValue(mockForm as any);

      const event = new Event('change');
      Object.defineProperty(event, 'target', {
        value: { value: 'develop' },
        writable: false
      });

      // @ts-ignore — call private method
      element.handleBranchSelect(event);

      expect(mockForm.setFieldValue).toHaveBeenCalledWith('branch', 'develop');
    });

    it('handles branch loading errors gracefully', async () => {
      const ctx = getContext();
      vi.spyOn(ctx.designMgmt, 'getGitRepoBranches').mockRejectedValue(
        new Error('Failed to fetch branches')
      );

      const mockRepo = {
        full_name: 'user/error-repo',
        clone_url: 'https://github.com/user/error-repo.git',
        default_branch: 'main',
        private: false
      };

      // @ts-ignore
      element.selectedAccountId = 'account:789';
      // @ts-ignore
      element.availableRepos = [mockRepo];
      await updated(element);

      const event = new Event('change');
      Object.defineProperty(event, 'target', {
        value: { value: mockRepo.clone_url },
        writable: false
      });

      // @ts-ignore
      await element.handleRepoSelect(event);
      await updated(element);

      // Component should handle error gracefully by falling back to default branch
      // @ts-ignore
      expect(element.repoBranches).toEqual(['main']);
    });

    it('handles empty branch list', async () => {
      const ctx = getContext();
      vi.spyOn(ctx.designMgmt, 'getGitRepoBranches').mockResolvedValue([]);

      // @ts-ignore
      element.repoBranches = [];
      await updated(element);

      // @ts-ignore
      expect(element.repoBranches).toEqual([]);
      // @ts-ignore
      expect(element.repoBranches).toHaveLength(0);
    });

    it('handles branches with special characters', async () => {
      const branchesWithSlashes = [
        'main',
        'feature/add-login',
        'bugfix/issue-123',
        'release/v1.0.0'
      ];

      // @ts-ignore
      element.repoBranches = branchesWithSlashes;
      await updated(element);

      // @ts-ignore
      expect(element.repoBranches).toEqual(branchesWithSlashes);
      // @ts-ignore
      expect(element.repoBranches.some((b: string) => b.includes('/'))).toBe(true);
    });
  });

  describe('Git Repository Registration (#816 — RepoTarget requires branch and path)', () => {
    it('carries branch and path on the target, not just server_id/db_name (fixes 400)', async () => {
      const ctx = getContext();
      const registerSpy = vi.spyOn(ctx.designMgmt, 'registerRepo').mockResolvedValue({
        _id: 'repo:new',
        name: 'user/test-repo',
        url: 'https://github.com/user/test-repo.git',
        mode: 'sync',
        sync_targets: [],
        last_sync: null,
        sync_status: 'idle'
      } as any);

      const mockRepo = {
        full_name: 'user/test-repo',
        clone_url: 'https://github.com/user/test-repo.git',
        default_branch: 'main',
        private: false
      };

      // @ts-ignore — set private state
      element.selectedServer = 'srv1';
      // @ts-ignore
      element.selectedDatabase = 'animals';
      // @ts-ignore
      element.selectedAccountId = 'account:123';
      // @ts-ignore
      element.availableRepos = [mockRepo];
      await updated(element);

      // handleRepoRegister reads the selected repo URL off the rendered <wa-select name="repo">;
      // stub shadowRoot.querySelector to hand it back directly, as the Branch Selection tests do.
      vi.spyOn(element.shadowRoot!, 'querySelector').mockReturnValue({ value: mockRepo.clone_url } as any);

      const submitEvent = new CustomEvent('cca-form-submit', {
        detail: { data: { path: '/designs' } }
      });

      // @ts-ignore — call the private handler directly
      await element.handleRepoRegister(submitEvent);

      expect(registerSpy).toHaveBeenCalledWith(
        'srv1',
        'animals',
        expect.objectContaining({
          branch: 'main',
          path: '/designs',
          targets: [{ server_id: 'srv1', db_name: 'animals', branch: 'main', path: '/designs' }]
        })
      );
    });

    it('falls back to the repo default branch and root path when the form leaves them blank', async () => {
      const ctx = getContext();
      const registerSpy = vi.spyOn(ctx.designMgmt, 'registerRepo').mockResolvedValue({
        _id: 'repo:new',
        name: 'user/test-repo',
        url: 'https://github.com/user/test-repo.git',
        mode: 'sync',
        sync_targets: [],
        last_sync: null,
        sync_status: 'idle'
      } as any);

      const mockRepo = {
        full_name: 'user/test-repo',
        clone_url: 'https://github.com/user/test-repo.git',
        default_branch: 'develop',
        private: false
      };

      // @ts-ignore
      element.selectedServer = 'srv1';
      // @ts-ignore
      element.selectedDatabase = 'animals';
      // @ts-ignore
      element.selectedAccountId = 'account:123';
      // @ts-ignore
      element.availableRepos = [mockRepo];
      await updated(element);

      vi.spyOn(element.shadowRoot!, 'querySelector').mockReturnValue({ value: mockRepo.clone_url } as any);

      const submitEvent = new CustomEvent('cca-form-submit', { detail: { data: {} } });

      // @ts-ignore
      await element.handleRepoRegister(submitEvent);

      expect(registerSpy).toHaveBeenCalledWith(
        'srv1',
        'animals',
        expect.objectContaining({
          branch: 'develop',
          path: '/',
          targets: [{ server_id: 'srv1', db_name: 'animals', branch: 'develop', path: '/' }]
        })
      );
    });
  });

  it('renders no in-body server picker — the header owns server selection (#759)', async () => {
    const element = getEl();
    await element.updateComplete;
    await new Promise((r) => setTimeout(r, 0));
    // @ts-ignore
    element.loading = false;
    // @ts-ignore
    element.selectedServer = 'srv1';
    await element.updateComplete;
    expect(element.shadowRoot!.querySelector('cca-server-select')).toBeNull();
    element.remove();
  });

  describe('Delete Functionality', () => {
    beforeEach(async () => {
      // @ts-ignore
      element.docs = mockDocs;
      // @ts-ignore
      element.selectedServer = 'srv1';
      // @ts-ignore
      element.selectedDatabase = 'animals';
      // @ts-ignore
      element.repoId = 'repo:test123';
      // canWriteDb is resolved asynchronously via selectDatabase(); this describe sets
      // selectedServer/selectedDatabase directly, so set it directly too (isAdmin: true from the
      // outer beforeEach makes this the true answer regardless).
      // @ts-ignore
      element.canWriteDb = true;
      await updated(element);
    });

    it('should prepare delete for CouchDB-only documents', async () => {
      const couchOnlyDoc: TrackedDesignDoc = {
        server_id: 'srv1',
        server_name: 'Server 1',
        db_name: 'animals',
        ddoc_id: '_design/couch-only',
        rev: '1-abc',
        ddoc_rev: '1-abc',
        git_repo_id: null,
        last_git_sha: null,
        last_sync: null,
        updated_at: '2026-05-22T10:00:00Z',
        sync_status: 'couch_only',
      };

      // @ts-ignore
      element.docs = [couchOnlyDoc];
      // @ts-ignore
      element.selectedDocs = new Set(['srv1|animals|_design/couch-only']);
      await updated(element);

      // @ts-ignore - Call prepareDelete
      element.prepareDelete('couch');
      await updated(element);

      // @ts-ignore
      expect(element.showDeleteConfirm).toBe(true);
      // @ts-ignore
      expect(element.deleteMessage).toContain('1 document(s)');
      // @ts-ignore
      expect(element.deleteMessage).toContain('CouchDB');
      // @ts-ignore
      expect(element.deleteDocList).toEqual(['_design/couch-only']);
    });

    it('should prepare delete for Git-only documents', async () => {
      const gitOnlyDoc: TrackedDesignDoc = {
        server_id: 'srv1',
        server_name: 'Server 1',
        db_name: 'animals',
        ddoc_id: '_design/git-only',
        rev: null,
        ddoc_rev: null,
        git_repo_id: 'repo:test123',
        last_git_sha: 'xyz789',
        last_sync: '2026-05-22T10:00:00Z',
        updated_at: '2026-05-22T10:00:00Z',
        sync_status: 'git_only',
      };

      // @ts-ignore
      element.docs = [gitOnlyDoc];
      // @ts-ignore
      element.selectedDocs = new Set(['srv1|animals|_design/git-only']);
      await updated(element);

      // @ts-ignore
      element.prepareDelete('git');
      await updated(element);

      // @ts-ignore
      expect(element.showDeleteConfirm).toBe(true);
      // @ts-ignore
      expect(element.deleteMessage).toContain('Git repository');
      // @ts-ignore
      expect(element.deleteDocList).toEqual(['_design/git-only']);
    });

    it('should prepare delete for synced documents (both)', async () => {
      // @ts-ignore
      element.selectedDocs = new Set(['srv1|animals|_design/animals']);
      await updated(element);

      // @ts-ignore
      element.prepareDelete('both');
      await updated(element);

      // @ts-ignore
      expect(element.showDeleteConfirm).toBe(true);
      // @ts-ignore
      expect(element.deleteMessage).toContain('both CouchDB and Git');
      // @ts-ignore
      expect(element.deleteDocList).toEqual(['_design/animals']);
    });

    it('should call deleteRepoDocs with stripped _design/ prefix', async () => {
      const ctx = getContext();
      const deleteRepoDocsSpy = vi.spyOn(ctx.designMgmt, 'deleteRepoDocs').mockResolvedValue({
        animals: { deleted: true, commit_sha: 'abc123' }
      });

      const gitOnlyDoc: TrackedDesignDoc = {
        server_id: 'srv1',
        server_name: 'Server 1',
        db_name: 'animals',
        ddoc_id: '_design/animals',
        rev: null,
        ddoc_rev: null,
        git_repo_id: 'repo:test123',
        last_git_sha: 'xyz789',
        last_sync: '2026-05-22T10:00:00Z',
        updated_at: '2026-05-22T10:00:00Z',
        sync_status: 'git_only',
      };

      // @ts-ignore
      element.docs = [gitOnlyDoc];
      // @ts-ignore
      element.selectedDocs = new Set(['srv1|animals|_design/animals']);
      // @ts-ignore
      element.repoId = 'repo:test123';
      await updated(element);

      // @ts-ignore - Call handleDeleteByMode directly
      await element.handleDeleteByMode('git');

      expect(deleteRepoDocsSpy).toHaveBeenCalledWith(
        'repo:test123',
        'animals',
        ['animals'] // Should strip _design/ prefix
      );
    });

    it('should disable main delete button when no synced docs selected', async () => {
      const couchOnlyDoc: TrackedDesignDoc = {
        server_id: 'srv1',
        server_name: 'Server 1',
        db_name: 'animals',
        ddoc_id: '_design/couch-only',
        rev: '1-abc',
        ddoc_rev: '1-abc',
        git_repo_id: null,
        last_git_sha: null,
        last_sync: null,
        updated_at: '2026-05-22T10:00:00Z',
        sync_status: 'couch_only',
      };

      // @ts-ignore
      element.docs = [couchOnlyDoc];
      // @ts-ignore
      element.selectedDocs = new Set(['srv1|animals|_design/couch-only']);
      await updated(element);

      const shadow = requireShadowRoot(element);
      // Find the main delete button (first wa-button with appearance="filled" and trash icon)
      const buttons = shadow.querySelectorAll('wa-button[appearance="filled"]');
      const deleteButton = Array.from(buttons).find(btn => 
        btn.querySelector('wa-icon[name="trash"]')
      ) as any;
      
      // Main delete button should be disabled when only CouchDB-only docs are selected
      // (since main button is for "both" and syncedCount === 0)
      expect(deleteButton).toBeDefined();
      expect(deleteButton.hasAttribute('disabled')).toBe(true);
    });

    it('should cancel delete confirmation', async () => {
      // @ts-ignore
      element.showDeleteConfirm = true;
      // @ts-ignore
      element.pendingDeleteMode = 'couch';
      await updated(element);

      // @ts-ignore
      element.cancelDelete();
      await updated(element);

      // @ts-ignore
      expect(element.showDeleteConfirm).toBe(false);
      // @ts-ignore
      expect(element.pendingDeleteMode).toBe(null);
    });
  });

  describe('Header Actions', () => {
    describe('Visibility', () => {
      /**
       * #49: no database, no header actions. This used to assert the opposite — "Connect Git
       * Account" was pushed unconditionally because connecting an account is not
       * database-scoped. True, but from this screen there is nothing to do with an account
       * until a database is chosen, so it left one lone button over an empty table.
       *
       * `addHeaderActions` must not be called at all rather than called with `[]`: the header
       * renders an empty action group for the latter, which is the "empty header" the
       * `_updateHeaderActions` doc comment already warns about.
       */
      it('shows no header actions when no server/db is selected', async () => {
        const addHeaderActionsSpy = vi.spyOn(await import('../src/components/cca-header.js'), 'addHeaderActions');

        // @ts-ignore
        element.selectedServer = '';
        // @ts-ignore
        element.selectedDatabase = '';
        // @ts-ignore
        element._updateHeaderActions();

        expect(addHeaderActionsSpy).not.toHaveBeenCalled();
      });

      it('shows no header actions when a server but no database is selected', async () => {
        const addHeaderActionsSpy = vi.spyOn(await import('../src/components/cca-header.js'), 'addHeaderActions');

        // @ts-ignore
        element.selectedServer = 'srv1';
        // @ts-ignore
        element.selectedDatabase = '';
        // @ts-ignore - a server admin who could otherwise do all three
        element.canWriteDb = true;
        // @ts-ignore
        element._updateHeaderActions();

        expect(addHeaderActionsSpy).not.toHaveBeenCalled();
      });

      it('shows all three actions when server+db selected and no repo', async () => {
        const addHeaderActionsSpy = vi.spyOn(await import('../src/components/cca-header.js'), 'addHeaderActions');
        
        // @ts-ignore
        element.selectedServer = 'srv1';
        // @ts-ignore
        element.selectedDatabase = 'animals';
        // @ts-ignore
        element.hasGitRepo = false;
        // @ts-ignore - what refreshCanWriteDb() sets for a server admin, without a _security read
        element.canWriteDb = true;
        // @ts-ignore
        element._updateHeaderActions();
        
        expect(addHeaderActionsSpy).toHaveBeenCalled();
        const actions = addHeaderActionsSpy.mock.calls[0][0];
        expect(actions).toHaveLength(3);
        expect(actions[0].tooltip).toBe('Connect Git Account');
        expect(actions[1].tooltip).toBe('Register Repository');
        expect(actions[2].tooltip).toBe('Create Design Doc');
      });

      it('hides Register Repo when git repo exists', async () => {
        const addHeaderActionsSpy = vi.spyOn(await import('../src/components/cca-header.js'), 'addHeaderActions');
        
        // @ts-ignore
        element.selectedServer = 'srv1';
        // @ts-ignore
        element.selectedDatabase = 'animals';
        // @ts-ignore - repoId replaces hasGitRepo
        element.repoId = 'repo:test';
        // @ts-ignore - what refreshCanWriteDb() sets for a server admin, without a _security read
        element.canWriteDb = true;
        // @ts-ignore
        element._updateHeaderActions();
        
        expect(addHeaderActionsSpy).toHaveBeenCalled();
        const actions = addHeaderActionsSpy.mock.calls[0][0];
        expect(actions).toHaveLength(2);
        expect(actions[0].tooltip).toBe('Connect Git Account');
        expect(actions[1].tooltip).toBe('Create Design Doc');
        expect(actions.find((a: any) => a.tooltip === 'Register Repository')).toBeUndefined();
      });

      it('clears header actions on disconnect', async () => {
        const clearHeaderActionsSpy = vi.spyOn(await import('../src/components/cca-header.js'), 'clearHeaderActions');
        
        element.disconnectedCallback();
        
        expect(clearHeaderActionsSpy).toHaveBeenCalled();
      });
    });

    /**
     * The repository drawer is the *registration* flow, and now its only one: the
     * `connectionOnlyMode` variant that opened this same drawer just to create an account was
     * reachable only from `_openAccountConnectionForm`, which in turn was reachable only from a
     * `_selectProvider` no production code called. "Connect Git Account" uses the connect-account
     * dialog (see 'Provider Dialog Context'), so connecting an account here always continues into
     * picking a repository.
     */
    describe('Account drawer (the repository-registration flow)', () => {
      it('opens the drawer on the account step for repo registration', async () => {
        const ctx = getContext();
        vi.spyOn(ctx.designMgmt, 'getGitAccounts').mockResolvedValue([]);

        // @ts-ignore
        element.selectedServer = 'srv1';
        // @ts-ignore
        element.selectedDatabase = 'animals';

        // @ts-ignore
        await element.openAccountDrawer('github');
        await updated(element);

        // @ts-ignore
        expect(element.showGitDrawer).toBe(true);
        // @ts-ignore - no accounts yet, so the form is the first thing shown
        expect(element.showAccountForm).toBe(true);
        // @ts-ignore
        expect(element.manageMode).toBe(false);
      });

      it('proceeds to repo registration after the account is connected', async () => {
        const ctx = getContext();
        const mockAccount = {
          _id: 'acc:456',
          provider: 'github',
          label: 'Test Account',
          username: 'testuser',
          token: 'token123',
          base_url: null
        };
        vi.spyOn(ctx.designMgmt, 'postGitAccounts').mockResolvedValue(mockAccount);
        vi.spyOn(ctx.designMgmt, 'getGitAccountRepos').mockResolvedValue([]);

        // @ts-ignore
        element.showGitDrawer = true;
        // @ts-ignore
        element.gitProvider = 'github';
        // @ts-ignore
        element.gitAccounts = [];

        const event = new CustomEvent('submit:form', {
          detail: {
            data: {
              label: 'Test Account',
              token: 'token123'
            }
          }
        });

        // @ts-ignore
        await element.handleAccountConnect(event);
        await updated(element);

        // @ts-ignore - Drawer should still be open
        expect(element.showGitDrawer).toBe(true);
        // @ts-ignore - Should have auto-selected the new account
        expect(element.selectedAccountId).toBe('acc:456');
      });
    });

    describe('Provider Dialog Context', () => {
      it('sets providerDialogForRegistration = false for Connect Git Account', async () => {
        // @ts-ignore
        element._openProviderDialog();
        
        // @ts-ignore
        expect(element.providerDialogForRegistration).toBe(false);
        // @ts-ignore
        expect(element.showProviderDialog).toBe(true);
      });

      it('sets providerDialogForRegistration = true for Register Repo', async () => {
        // @ts-ignore
        element.selectedServer = 'srv1';
        // @ts-ignore
        element.selectedDatabase = 'animals';
        
        // @ts-ignore
        element._openRegisterRepoDialog();
        
        // @ts-ignore
        expect(element.providerDialogForRegistration).toBe(true);
        // @ts-ignore
        expect(element.showProviderDialog).toBe(true);
      });

      /**
       * Clicks the provider dialog's own button — the path a user actually takes. The two tests
       * this replaces called the private branching helper (`_selectProvider`) directly, and that
       * helper had **no caller in `src/`**: the dialog's `onSelectProvider` callback never read
       * `providerDialogForRegistration` and always opened the connect-account form. So the tests
       * were green while "Register Repository" asked an admin to connect a second account.
       */
      function clickProviderInDialog(provider = 'github') {
        const dialog = requireShadowRoot(element).querySelector(
          'wa-dialog[label="Select Git Provider"]'
        );
        if (!dialog) throw new Error('provider dialog is not rendered');
        const button = Array.from(dialog.querySelectorAll('wa-button')).find((b) =>
          b.querySelector(`wa-icon[name="${provider}"]`)
        );
        if (!button) throw new Error(`no ${provider} button inside the provider dialog`);
        (button as HTMLElement).click();
      }

      it('opens the connect-account form when a provider is picked for Connect Git Account', async () => {
        const ctx = getContext();
        vi.spyOn(ctx.designMgmt, 'getGitAccounts').mockResolvedValue([]);

        // @ts-ignore
        element.loading = false;
        // @ts-ignore
        element._openProviderDialog();
        await updated(element);

        clickProviderInDialog();
        await updated(element);

        // @ts-ignore
        expect(element.showProviderDialog).toBe(false);
        // @ts-ignore
        expect(element.showConnectAccountDialog).toBe(true);
        // @ts-ignore - the repository drawer belongs to the registration branch only
        expect(element.showGitDrawer).toBe(false);
      });

      it('opens the repository drawer when a provider is picked for Register Repository', async () => {
        const ctx = getContext();
        const getGitAccounts = vi.spyOn(ctx.designMgmt, 'getGitAccounts').mockResolvedValue([]);

        // @ts-ignore
        element.loading = false;
        // @ts-ignore
        element.selectedServer = 'srv1';
        // @ts-ignore
        element.selectedDatabase = 'animals';
        // @ts-ignore
        element._openRegisterRepoDialog();
        await updated(element);

        clickProviderInDialog();
        await updated(element);

        // @ts-ignore
        expect(element.showProviderDialog).toBe(false);
        // @ts-ignore - an admin who already connected an account must not be asked for another
        expect(element.showConnectAccountDialog).toBe(false);
        // @ts-ignore
        expect(element.showGitDrawer).toBe(true);
        expect(getGitAccounts).toHaveBeenCalled();
      });
    });

    /**
     * The INLINE provider row in `_renderGitRepoDisplay` (#7, I4). Distinct from the provider
     * dialog covered in `connect-git-account-flow.test.ts` — this is a second render site
     * reading the same `SUPPORTED_PROVIDERS`, and it was the one that used to offer GitHub,
     * Bitbucket and GitLab alike. Picking either of the latter two *persisted* a
     * `gitaccount:` document with no validation, then failed with "not supported yet" the
     * moment anything used it — and with no account-delete screen reachable from here, the
     * dead account could not be removed.
     */
    describe('Inline provider row (D11/I4)', () => {
      function inlineProviderIcons(): string[] {
        // @ts-ignore - private render helper
        const host = document.createElement('div');
        // @ts-ignore
        render(element._renderGitRepoDisplay(), host);
        return Array.from(host.querySelectorAll('wa-icon[family="brands"]')).map(
          (el) => el.getAttribute('name') ?? '',
        );
      }

      beforeEach(() => {
        // @ts-ignore - the row only renders for an admin with no repo yet registered
        element.selectedServer = 'srv1';
        // @ts-ignore
        element.selectedDatabase = 'animals';
        // @ts-ignore
        element.gitRepo = null;
      });

      it('offers GitHub only', () => {
        expect(inlineProviderIcons()).toEqual(['github']);
      });

      it('offers no GitLab or Bitbucket icon', () => {
        const icons = inlineProviderIcons();
        expect(icons).not.toContain('gitlab');
        expect(icons).not.toContain('bitbucket');
      });

      it('renders nothing at all for a non-admin — connecting writes couchcompanion (D9)', () => {
        const ctx = getContext();
        vi.spyOn(ctx.auth, 'isAdmin', 'get').mockReturnValue(false);

        expect(inlineProviderIcons()).toEqual([]);
      });
    });

    /**
     * #49: once a repository is registered, the row it sits in reads as an actionable
     * control rather than a label with a bare icon next to it — an admin gets a real
     * `wa-button`, not `<span>name</span>` plus an unlabelled `pen-to-square` glyph.
     */
    describe('Connected repository display (#49)', () => {
      function renderGitRepoDisplay(): HTMLElement {
        const host = document.createElement('div');
        // @ts-ignore - private render helper
        render(element._renderGitRepoDisplay(), host);
        return host;
      }

      beforeEach(() => {
        // @ts-ignore
        element.repoId = 'repo:test123';
        // @ts-ignore
        element.repoName = 'my-designs';
        // @ts-ignore
        element.gitProvider = 'github';
      });

      it('renders the repository as a wa-button for an admin', () => {
        const host = renderGitRepoDisplay();
        const button = host.querySelector('wa-button[data-testid="manage-repo"]');
        expect(button).not.toBeNull();
        expect(button!.textContent).toContain('my-designs');
      });

      it('renders plain text, not a button, for a non-admin — there is nothing to open', () => {
        const ctx = getContext();
        vi.spyOn(ctx.auth, 'isAdmin', 'get').mockReturnValue(false);

        const host = renderGitRepoDisplay();
        expect(host.querySelector('wa-button[data-testid="manage-repo"]')).toBeNull();
        expect(host.textContent).toContain('my-designs');
      });
    });

    describe('Immediate Header Updates', () => {
      it('updates header actions immediately when database is selected', async () => {
        const addHeaderActionsSpy = vi.spyOn(await import('../src/components/cca-header.js'), 'addHeaderActions');
        
        // @ts-ignore
        element.selectedServer = 'srv1';
        // @ts-ignore
        element.selectedDatabase = '';
        
        // Clear previous calls
        addHeaderActionsSpy.mockClear();
        
        // Select database (should call _updateHeaderActions immediately)
        // @ts-ignore
        await element.selectDatabase('animals');
        
        // Should be called at least once immediately
        expect(addHeaderActionsSpy).toHaveBeenCalled();
        
        // First call should happen before loadDesignDocs completes
        const firstCallActions = addHeaderActionsSpy.mock.calls[0][0];
        expect(firstCallActions.length).toBeGreaterThan(0);
      });

      it('updates header actions again after loadDesignDocs completes', async () => {
        const ctx = getContext();
        const addHeaderActionsSpy = vi.spyOn(await import('../src/components/cca-header.js'), 'addHeaderActions');
        
        // Mock a slow loadDesignDocs
        let designDocsResolved = false;
        vi.spyOn(ctx.designMgmt, 'listDesignDocs').mockImplementation(async () => {
          await new Promise(resolve => setTimeout(resolve, 100));
          designDocsResolved = true;
          return [];
        });
        
        // @ts-ignore
        element.selectedServer = 'srv1';
        addHeaderActionsSpy.mockClear();
        
        // @ts-ignore
        const selectPromise = element.selectDatabase('animals');
        
        // Should be called immediately (before loadDesignDocs completes)
        expect(addHeaderActionsSpy).toHaveBeenCalled();
        expect(designDocsResolved).toBe(false);
        
        // Wait for loadDesignDocs to complete
        await selectPromise;
        
        // Should be called again after loadDesignDocs
        expect(addHeaderActionsSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
        expect(designDocsResolved).toBe(true);
      });
    });

    describe('Create Design Doc Action', () => {
      it('navigates to editor when server+db selected', async () => {
        const ctx = getContext();
        const navigateSpy = vi.spyOn(ctx.router, 'navigate');
        
        // @ts-ignore
        element.selectedServer = 'srv1';
        // @ts-ignore
        element.selectedDatabase = 'animals';
        
        // @ts-ignore
        element._openCreateDocDialog();
        
        expect(navigateSpy).toHaveBeenCalledOnce();
        const url = navigateSpy.mock.calls[0][0];
        expect(url).toBe('/design-docs/srv1/editor/animals/_new');
      });

      it('shows error toast when server not selected', async () => {
        // Mock toast to capture calls
        const toastSpy = vi.spyOn(await import('../src/components/cca-toast.js'), 'toast');
        
        // @ts-ignore
        element.selectedServer = '';
        // @ts-ignore
        element.selectedDatabase = 'animals';
        
        // @ts-ignore
        element._openCreateDocDialog();
        
        expect(toastSpy).toHaveBeenCalledWith(
          'Please select a server and database first',
          'error'
        );
      });

      it('shows error toast when database not selected', async () => {
        const toastSpy = vi.spyOn(await import('../src/components/cca-toast.js'), 'toast');
        
        // @ts-ignore
        element.selectedServer = 'srv1';
        // @ts-ignore
        element.selectedDatabase = '';
        
        // @ts-ignore
        element._openCreateDocDialog();
        
        expect(toastSpy).toHaveBeenCalledWith(
          'Please select a server and database first',
          'error'
        );
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Admin gating (D9) — a db member reads design docs fine but PUTting one (or
  // anything touching couchcompanion) is admin-only. Browsing must stay open;
  // every write action must explain why it is unavailable rather than 403ing.
  // ---------------------------------------------------------------------------
  describe('Admin gating (D9 — git sync and repo management are admin-only)', () => {
    beforeEach(async () => {
      const ctx = getContext();
      vi.spyOn(ctx.auth, 'isAdmin', 'get').mockReturnValue(false);
      // @ts-ignore
      element.docs = mockDocs;
      // @ts-ignore
      element.loading = false;
      // @ts-ignore
      element.selectedServer = 'srv1';
      // @ts-ignore
      element.selectedDatabase = 'animals';
      await updated(element);
    });

    it('hides the sync actions from a non-admin, who cannot write a design doc anyway', async () => {
      expect(requireShadowRoot(element).querySelector('[data-testid="sync-to-repo"]')).toBeNull();
      expect(requireShadowRoot(element).querySelector('[data-testid="sync-to-couch"]')).toBeNull();
    });

    it('still lists design docs for a non-admin — reading them is allowed', async () => {
      const table = requireShadowRoot(element).querySelector('cca-data-table') as any;
      expect(table).not.toBeNull();
      expect(table.rows.length).toBeGreaterThan(0);
    });

    it('explains why sync is unavailable rather than just hiding it', async () => {
      expect(requireShadowRoot(element).textContent).toMatch(/administrator/i);
    });

    it('hides every header action from a plain member — no server role, not a db admin either', async () => {
      const addHeaderActionsSpy = vi.spyOn(await import('../src/components/cca-header.js'), 'addHeaderActions');
      // @ts-ignore - `{db}/_security` does not name this user, so CouchDB refuses their PUT too
      element.canWriteDb = false;
      // @ts-ignore
      element._updateHeaderActions();
      expect(addHeaderActionsSpy).not.toHaveBeenCalled();
    });

    /**
     * The gate this pins used to be `if (!isAdmin) return` *before* any action was pushed, so a
     * database admin got the footer's "Create New" button and an empty header. Only the two
     * `couchcompanion` writers stay server-admin-only.
     */
    it('still offers Create Design Doc once the database itself names them an admin', async () => {
      const addHeaderActionsSpy = vi.spyOn(await import('../src/components/cca-header.js'), 'addHeaderActions');
      // @ts-ignore - what refreshCanWriteDb() resolves from {db}/_security for a db admin
      element.canWriteDb = true;
      // @ts-ignore
      element._updateHeaderActions();

      const offered = addHeaderActionsSpy.mock.calls
        .flatMap(([actions]) => actions)
        .map((a) => a.tooltip);
      expect(offered).toEqual(['Create Design Doc']);
    });

    it('does not attempt to load repo/git state for a non-admin (couchcompanion is admin-only)', async () => {
      const ctx = getContext();
      const getRepoSpy = vi.spyOn(ctx.designMgmt, 'getRepo');
      // @ts-ignore
      element.repoId = null;
      // @ts-ignore
      await element.loadDesignDocs();
      expect(getRepoSpy).not.toHaveBeenCalled();
    });

    it('hides the Create New / delete actions for a non-admin', async () => {
      expect(requireShadowRoot(element).textContent).not.toContain('Create New');
    });
  });

  // ---------------------------------------------------------------------------
  // Database-admin capability (fix round 1) — isAdmin (server-admin, roles.includes('_admin'))
  // wrongly gated create/delete, which CouchDB itself grants to a *database* admin (named in
  // {db}/_security.admins by name or role) with no server role at all. canWriteDb probes
  // {db}/_security and must agree with what CouchDB would actually let this user do.
  // ---------------------------------------------------------------------------
  describe('Database-admin capability (a db admin without the server _admin role)', () => {
    async function settle() {
      await element.updateComplete;
      await Promise.resolve();
      await element.updateComplete;
      await Promise.resolve();
      await element.updateComplete;
    }

    it('shows create/delete actions for a database admin who is not a server admin', async () => {
      const ctx = getContext();
      vi.spyOn(ctx.auth, 'isAdmin', 'get').mockReturnValue(false);
      vi.spyOn(ctx.auth, 'state', 'get').mockReturnValue({
        authenticated: true, username: 'dbadmin', companionServer: null, roles: []
      });
      vi.spyOn(ctx.dbMgmt, 'listDatabaseAccess').mockResolvedValue({
        admin: { name: ['dbadmin'], roles: [] },
        member: { name: [], roles: [] }
      });

      // @ts-ignore
      element.selectedServer = 'srv1';
      // @ts-ignore
      await element.selectDatabase('animals');
      await settle();

      expect(requireShadowRoot(element).textContent).toContain('Create New');
    });

    it('recognizes db-admin status granted by a shared role, not just by username', async () => {
      const ctx = getContext();
      vi.spyOn(ctx.auth, 'isAdmin', 'get').mockReturnValue(false);
      vi.spyOn(ctx.auth, 'state', 'get').mockReturnValue({
        authenticated: true, username: 'alice', companionServer: null, roles: ['animals-admins']
      });
      vi.spyOn(ctx.dbMgmt, 'listDatabaseAccess').mockResolvedValue({
        admin: { name: [], roles: ['animals-admins'] },
        member: { name: [], roles: [] }
      });

      // @ts-ignore
      element.selectedServer = 'srv1';
      // @ts-ignore
      await element.selectDatabase('animals');
      await settle();

      expect(requireShadowRoot(element).textContent).toContain('Create New');
    });

    it('keeps the read-only note for a plain db member named nowhere in admins', async () => {
      const ctx = getContext();
      vi.spyOn(ctx.auth, 'isAdmin', 'get').mockReturnValue(false);
      vi.spyOn(ctx.auth, 'state', 'get').mockReturnValue({
        authenticated: true, username: 'plain-member', companionServer: null, roles: []
      });
      vi.spyOn(ctx.dbMgmt, 'listDatabaseAccess').mockResolvedValue({
        admin: { name: ['someone-else'], roles: [] },
        member: { name: ['plain-member'], roles: [] }
      });

      // @ts-ignore
      element.selectedServer = 'srv1';
      // @ts-ignore
      await element.selectDatabase('animals');
      await settle();

      expect(requireShadowRoot(element).textContent).not.toContain('Create New');
      expect(requireShadowRoot(element).textContent).toMatch(/administrator/i);
    });

    it('treats an unreadable _security as read-only rather than defaulting to permissive', async () => {
      const ctx = getContext();
      vi.spyOn(ctx.auth, 'isAdmin', 'get').mockReturnValue(false);
      vi.spyOn(ctx.dbMgmt, 'listDatabaseAccess').mockRejectedValue(new Error('network blip'));

      // @ts-ignore
      element.selectedServer = 'srv1';
      // @ts-ignore
      await element.selectDatabase('animals');
      await settle();

      expect(requireShadowRoot(element).textContent).not.toContain('Create New');
    });

    /**
     * The footer button and the header action have to answer to the same capability. They did
     * not: `_updateHeaderActions` bailed on `!isAdmin` before pushing anything, so a db admin saw
     * "Create New" at the bottom of the page and an empty header. `canWriteDb` resolves
     * asynchronously from `{db}/_security`, so the header also has to be recomputed when the
     * answer lands, not only at the synchronous moment the database was selected.
     */
    it('puts Create Design Doc in the header for a db admin, once _security has answered', async () => {
      const ctx = getContext();
      const addHeaderActionsSpy = vi.spyOn(await import('../src/components/cca-header.js'), 'addHeaderActions');
      vi.spyOn(ctx.auth, 'isAdmin', 'get').mockReturnValue(false);
      vi.spyOn(ctx.auth, 'state', 'get').mockReturnValue({
        authenticated: true, username: 'dbadmin', companionServer: null, roles: []
      });
      vi.spyOn(ctx.dbMgmt, 'listDatabaseAccess').mockResolvedValue({
        admin: { name: ['dbadmin'], roles: [] },
        member: { name: [], roles: [] }
      });

      // @ts-ignore
      element.selectedServer = 'srv1';
      addHeaderActionsSpy.mockClear();
      // @ts-ignore
      await element.selectDatabase('animals');
      await settle();

      const offered = addHeaderActionsSpy.mock.calls
        .flatMap(([actions]) => actions)
        .map((a) => a.tooltip);
      expect(offered).toContain('Create Design Doc');
      // …and only that: both of these write `couchcompanion`, which stays server-admin-only.
      expect(offered).not.toContain('Connect Git Account');
      expect(offered).not.toContain('Register Repository');
    });

    it('does not probe _security for a server admin — isAdmin is a self-sufficient fast path', async () => {
      const ctx = getContext();
      vi.spyOn(ctx.auth, 'isAdmin', 'get').mockReturnValue(true);
      const accessSpy = vi.spyOn(ctx.dbMgmt, 'listDatabaseAccess');

      // @ts-ignore
      element.selectedServer = 'srv1';
      // @ts-ignore
      await element.selectDatabase('animals');
      await settle();

      expect(accessSpy).not.toHaveBeenCalled();
      expect(requireShadowRoot(element).textContent).toContain('Create New');
    });
  });

  // ---------------------------------------------------------------------------
  // Page-load deadlock (fix round 2 CRITICAL) — connectedCallback used to hold `loading: true`
  // (render()'s only-a-spinner, no-dialog branch) across the entire selectDatabase() ->
  // loadDesignDocs() -> getDesignDocsFromRepo() -> withTokenRetry() -> promptForToken() chain, so
  // a sync-time token prompt triggered during the initial page load awaited a click on a dialog
  // that could never render — a permanent deadlock. This is exactly the arrival path
  // repo-overview.ts's target pills use (`/design-docs/:serverId?database=:db`), and also a plain
  // reload or bookmark.
  // ---------------------------------------------------------------------------
  describe('Page-load deadlock (a deep link must not hang on a sync-time token prompt)', () => {
    it('renders the design-doc list, not the loading spinner, when a deep-linked page load needs a token prompt', async () => {
      const ctx = getContext();
      vi.spyOn(ctx.auth, 'isAdmin', 'get').mockReturnValue(true);
      vi.spyOn(ctx.serverMgmt, 'listServers').mockResolvedValue({
        servers: [{ id: 'srv1', name: 'Server 1' }],
        nextBookmark: ''
      });
      vi.spyOn(ctx.serverMgmt, 'getDatabases').mockResolvedValue([{ db_name: 'animals' }] as any);
      vi.spyOn(ctx.router, 'currentQuery').mockReturnValue(new URLSearchParams('database=animals'));
      vi.spyOn(ctx.designMgmt, 'getRepo').mockResolvedValue({
        repo: {
          _id: 'repo:test123',
          url: 'https://github.com/acme/widgets',
          account_id: 'account:none-mode',
          provider: 'github',
          sync_targets: [{ server_id: 'srv1', db_name: 'animals', branch: 'main', path: '' }]
        }
      } as any);
      vi.spyOn(ctx.designMgmt, 'listDesignDocs').mockResolvedValue([]);
      // The page-load git-status fetch hits the exact signal the prompt exists for.
      vi.spyOn(ctx.designMgmt, 'getRepoDocs').mockRejectedValue(new GitHttpError(401, 'Bad credentials'));
      // The prompt names the account by label, which it looks up itself — on this path the
      // component's own gitAccounts list is still empty, which is why it used to show a raw
      // gitaccount:<uuid>.
      vi.spyOn(ctx.designMgmt, 'getGitAccount').mockResolvedValue({
        _id: 'account:none-mode', provider: 'github', label: 'no-token-acct', credential_mode: 'none'
      });

      const el = document.createElement('cca-design-list') as CcaDesignList;
      el.serverId = 'srv1';
      document.body.appendChild(el);

      try {
        // Let connectedCallback's async chain run far enough to reach the prompt.
        await el.updateComplete;
        await new Promise((r) => setTimeout(r, 0));
        await el.updateComplete;
        await new Promise((r) => setTimeout(r, 0));
        await el.updateComplete;

        // @ts-ignore
        expect(el.loading).toBe(false);
        expect(el.tokenPrompt.isOpen).toBe(true);
        const dialog = el.shadowRoot!.querySelector('wa-dialog[label="Git Access Token Required"]')!;
        expect(dialog).not.toBeNull();
        // The deferred label bug: gitAccounts is empty on this path, so the prompt has to resolve
        // the label itself rather than showing a raw account id.
        expect(dialog.textContent).toContain('no-token-acct');
        // The regression itself: the page must not be stuck on the full-page spinner card, which
        // has no dialog in it at all — the prompt would await a click that could never happen.
        expect(el.shadowRoot!.textContent).not.toContain('Loading design documents...');
      } finally {
        el.remove();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Sync-time token prompt — the entire behavior of credential mode 'none' (D12):
  // no token is stored anywhere, so the UI has to ask for it right when a sync
  // needs it, and never write it anywhere durable.
  // ---------------------------------------------------------------------------
  describe('Sync-time token prompt (credential mode none — D12)', () => {
    beforeEach(async () => {
      // @ts-ignore
      element.selectedServer = 'srv1';
      // @ts-ignore
      element.selectedDatabase = 'animals';
      // @ts-ignore
      element.repoId = 'repo:test123';
      // @ts-ignore
      element.repoAccountId = 'account:none-mode';
      // @ts-ignore
      element.gitAccounts = [{ _id: 'account:none-mode', provider: 'github', label: 'no-token-acct' }];
      // @ts-ignore
      element.selectedDocs = new Set(['srv1|animals|_design/animals']);
      await updated(element);
    });

    /**
     * Drives the REAL `DesignMgmtService.syncToRepo` (not mocked) against mode `none` with
     * nothing remembered — the exact scenario the fix-round-1 review proved broken: `syncToRepo`
     * never throws the "No access token available" string (only `getGitAccountRepos` does); what
     * a token-less/expired request actually produces is a real `GitHttpError` with `status: 401`
     * from GitHub itself. Only `GitHubProvider`'s own network-facing methods and the
     * `couchcompanion`/CouchDB reads underneath are stubbed — everything from `handleSyncToRepo`
     * down through `resolveSyncTarget`/`providerFor`/the sync loop runs for real, so this is what
     * would have caught the original bug (mocking `syncToRepo` itself could not).
     */
    function stubRealSyncChain() {
      const ctx = getContext();
      vi.spyOn(GitHubProvider.prototype, 'getFile').mockResolvedValue(null);
      vi.spyOn(ctx.api, 'request').mockImplementation(async (method: string, path: string) => {
        const decoded = decodeURIComponent(path);
        if (method === 'GET' && decoded === '/couchcompanion/repo:test123') {
          return {
            _id: 'repo:test123',
            url: 'https://github.com/acme/widgets',
            account_id: 'account:none-mode',
            provider: 'github',
            sync_targets: [{ server_id: 'srv1', db_name: 'animals', branch: 'main', path: '' }]
          };
        }
        if (method === 'GET' && decoded === '/couchcompanion/account:none-mode') {
          return { _id: 'account:none-mode', provider: 'github', label: 'no-token-acct', credential_mode: 'none' };
        }
        if (method === 'GET' && decoded === '/animals/_design/animals') {
          throw new ApiError(404, 'missing');
        }
        if (method === 'GET' && decoded.startsWith('/couchcompanion/sync:animals')) {
          throw new ApiError(404, 'missing');
        }
        throw new Error(`stubRealSyncChain: unexpected api.request(${method}, ${path})`);
      });
    }

    it('prompts for the token after a real 401 from GitHub, and the retry succeeds', async () => {
      const ctx = getContext();
      stubRealSyncChain();
      // Genuinely remembers the token (not stubbed away) — the retry's success depends on the
      // real GitCredentialStore actually having it the second time providerFor asks.
      const rememberSpy = vi.spyOn(ctx.designMgmt, 'rememberAccountToken');
      const listTreeSpy = vi
        .spyOn(GitHubProvider.prototype, 'listTree')
        .mockRejectedValueOnce(new GitHttpError(401, 'Bad credentials'))
        .mockResolvedValueOnce([]);

      // @ts-ignore — the real DesignMgmtService.syncToRepo is what's under test; not mocked.
      element.handleSyncToRepo();
      await new Promise((r) => setTimeout(r, 0));
      await updated(element);

      expect(element.tokenPrompt.isOpen).toBe(true);

      element.tokenPrompt.value = 'ghp_typed_at_prompt';
      element.tokenPrompt.confirm();
      await new Promise((r) => setTimeout(r, 0));
      await updated(element);

      expect(listTreeSpy).toHaveBeenCalledTimes(2);
      // Mode 'none' on this account, so the real saveAccountToken routes to the session cache.
      expect(rememberSpy).toHaveBeenCalledWith('account:none-mode', 'ghp_typed_at_prompt');
      expect(element.tokenPrompt.isOpen).toBe(false);
    });

    it('does not persist a token entered at the prompt for a mode-none account', async () => {
      const ctx = getContext();
      // The real saveAccountToken runs: it reads the account's mode, finds 'none', and routes to
      // the session cache. Every couchcompanion touch is served here so a write would be visible.
      const apiSpy = vi.spyOn(ctx.api, 'request').mockImplementation(async (method: string, path: string) => {
        if (method === 'GET' && decodeURIComponent(path) === '/couchcompanion/account:none-mode') {
          return { _id: 'account:none-mode', provider: 'github', label: 'no-token-acct', credential_mode: 'none' };
        }
        throw new Error(`unexpected api.request(${method}, ${path})`);
      });
      const rememberSpy = vi.spyOn(ctx.designMgmt, 'rememberAccountToken');
      vi.spyOn(ctx.designMgmt, 'syncToRepo')
        .mockRejectedValueOnce(new GitHttpError(401, 'Bad credentials'))
        .mockResolvedValueOnce({ status: 'synced', synced: 1, conflicts: 0, skipped: 0 });

      // @ts-ignore
      element.handleSyncToRepo();
      await new Promise((r) => setTimeout(r, 0));
      await updated(element);

      element.tokenPrompt.value = 'ghp_typed_at_prompt';
      element.tokenPrompt.confirm();
      await new Promise((r) => setTimeout(r, 0));
      await updated(element);

      // The token reaches the retry via the in-memory session cache only — never a doc write.
      expect(rememberSpy).toHaveBeenCalledWith('account:none-mode', 'ghp_typed_at_prompt');
      expect(apiSpy.mock.calls.every(([method]) => method === 'GET')).toBe(true);
    });

    it('replaces the stored copy, and says so, for an account that DOES persist its token', async () => {
      // A rotated PAT in indexeddb/couchdb mode used to be unrecoverable: the retry only
      // remember()ed the new token for the tab, while GitCredentialStore.get re-read the stale
      // stored one on every fresh tab and nothing but postGitAccounts ever wrote through put().
      // With no account-edit screen anywhere, that loop had no exit.
      const ctx = getContext();
      vi.spyOn(ctx.designMgmt, 'getGitAccount').mockResolvedValue({
        _id: 'account:none-mode', provider: 'github', label: 'browser-stored', credential_mode: 'indexeddb'
      });
      const saveSpy = vi.spyOn(ctx.designMgmt, 'saveAccountToken').mockResolvedValue('indexeddb');
      vi.spyOn(ctx.designMgmt, 'syncToRepo')
        .mockRejectedValueOnce(new GitHttpError(401, 'Bad credentials'))
        .mockResolvedValueOnce({ status: 'synced', synced: 1, conflicts: 0, skipped: 0 });

      // @ts-ignore
      element.handleSyncToRepo();
      await new Promise((r) => setTimeout(r, 0));
      await updated(element);

      const dialog = requireShadowRoot(element).querySelector('wa-dialog[label="Git Access Token Required"]')!;
      expect(dialog.textContent).toContain('browser-stored');
      expect(dialog.textContent).toMatch(/replaces the copy held in this browser profile/i);
      expect(dialog.textContent).not.toMatch(/is not saved anywhere/i);

      element.tokenPrompt.value = 'ghp_rotated';
      element.tokenPrompt.confirm();
      await new Promise((r) => setTimeout(r, 0));
      await updated(element);

      expect(saveSpy).toHaveBeenCalledWith('account:none-mode', 'ghp_rotated');
    });

    it('surfaces the original error, without retrying, when the prompt is cancelled', async () => {
      const ctx = getContext();
      const toastSpy = vi.spyOn(await import('../src/components/cca-toast.js'), 'toast');
      vi.spyOn(ctx.designMgmt, 'getGitAccount').mockResolvedValue({
        _id: 'account:none-mode', provider: 'github', label: 'no-token-acct', credential_mode: 'none'
      });
      const saveSpy = vi.spyOn(ctx.designMgmt, 'saveAccountToken').mockResolvedValue('none');
      const syncSpy = vi.spyOn(ctx.designMgmt, 'syncToRepo').mockRejectedValue(new GitHttpError(401, 'Bad credentials'));

      // @ts-ignore
      element.handleSyncToRepo();
      await new Promise((r) => setTimeout(r, 0));
      await updated(element);
      expect(element.tokenPrompt.isOpen).toBe(true);

      element.tokenPrompt.cancel();
      await new Promise((r) => setTimeout(r, 0));
      await updated(element);

      expect(syncSpy).toHaveBeenCalledTimes(1);
      expect(saveSpy).not.toHaveBeenCalled();
      expect(toastSpy).toHaveBeenCalledWith(expect.stringContaining('Sync failed'), 'error');
    });
  });

  // ---------------------------------------------------------------------------
  // Truthful sync reporting — Task 6 made SyncResult.status/skipped real; Task 8
  // has to actually show them instead of an unconditional "Synced successfully".
  // ---------------------------------------------------------------------------
  describe('Sync result reporting (conflicts/skips are no longer invisible)', () => {
    beforeEach(async () => {
      // @ts-ignore
      element.selectedServer = 'srv1';
      // @ts-ignore
      element.selectedDatabase = 'animals';
      // @ts-ignore
      element.repoId = 'repo:test123';
      // @ts-ignore
      element.selectedDocs = new Set(['srv1|animals|_design/animals']);
      await updated(element);
    });

    it('reports a conflict result as an error, not a success toast', async () => {
      const ctx = getContext();
      const toastSpy = vi.spyOn(await import('../src/components/cca-toast.js'), 'toast');
      vi.spyOn(ctx.designMgmt, 'syncToRepo').mockResolvedValue({
        status: 'conflict',
        synced: 0,
        conflicts: 1,
        skipped: 0
      });

      // @ts-ignore
      element.handleSyncToRepo();
      await new Promise((r) => setTimeout(r, 0));
      await updated(element);

      expect(toastSpy).toHaveBeenCalledWith(expect.stringMatching(/conflict/i), 'error');
    });

    it('reports skipped documents instead of claiming an unconditional success', async () => {
      const ctx = getContext();
      const toastSpy = vi.spyOn(await import('../src/components/cca-toast.js'), 'toast');
      vi.spyOn(ctx.designMgmt, 'syncToRepo').mockResolvedValue({
        status: 'synced',
        synced: 1,
        conflicts: 0,
        skipped: 2
      });

      // @ts-ignore
      element.handleSyncToRepo();
      await new Promise((r) => setTimeout(r, 0));
      await updated(element);

      expect(toastSpy).toHaveBeenCalledWith(expect.stringMatching(/2 skipped/i), 'info');
    });
  });

  // ---------------------------------------------------------------------------
  // Bulk delete — the dialog, the commit and the toast must all name the same
  // documents. They did not: prepareDelete('both') listed the docs present on
  // BOTH sides while handleDeleteByMode('both') deleted every selected doc git
  // had a copy of, git-only ones included. Inert until Task 6 made
  // deleteRepoDocs a real GitHub commit.
  // ---------------------------------------------------------------------------
  describe('Delete by mode (dialog, commit and toast must agree)', () => {
    /** Three synced docs (both sides) + two git-only docs, all selected. */
    const MIXED: TrackedDesignDoc[] = [
      ...['a', 'b', 'c'].map((n) => ({
        server_id: 'srv1', server_name: null, db_name: 'animals',
        ddoc_id: `_design/${n}`, rev: `1-${n}`, ddoc_rev: `1-${n}`,
        git_repo_id: 'repo:test123', last_git_sha: `sha-${n}`,
        last_sync: null, updated_at: null, sync_status: 'synced',
      })),
      ...['g1', 'g2'].map((n) => ({
        server_id: 'srv1', server_name: null, db_name: 'animals',
        ddoc_id: `_design/${n}`, rev: null, ddoc_rev: null,
        git_repo_id: 'repo:test123', last_git_sha: `sha-${n}`,
        last_sync: null, updated_at: null, sync_status: 'newer_in_git',
      })),
    ] as TrackedDesignDoc[];

    let deleteDocumentsSpy: ReturnType<typeof vi.spyOn>;
    let deleteRepoDocsSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(async () => {
      const ctx = getContext();
      deleteDocumentsSpy = vi.spyOn(ctx.dbMgmt, 'deleteDocuments').mockResolvedValue({} as any);
      deleteRepoDocsSpy = vi.spyOn(ctx.designMgmt, 'deleteRepoDocs').mockResolvedValue({});
      // @ts-ignore
      element.selectedServer = 'srv1';
      // @ts-ignore
      element.selectedDatabase = 'animals';
      // @ts-ignore
      element.repoId = 'repo:test123';
      // @ts-ignore
      element.docs = MIXED;
      // @ts-ignore
      element.selectedDocs = new Set(MIXED.map((d) => `${d.server_id}|${d.db_name}|${d.ddoc_id}`));
      await updated(element);
    });

    it("deletes from git exactly the documents the 'both' confirmation listed — not every selected doc git has", async () => {
      const toastSpy = vi.spyOn(await import('../src/components/cca-toast.js'), 'toast');

      // @ts-ignore
      element.prepareDelete('both');
      await updated(element);
      // @ts-ignore
      const listed: string[] = element.deleteDocList;
      // @ts-ignore
      expect(element.deleteMessage).toContain('3 document(s)');
      expect(listed).toEqual(['_design/a', '_design/b', '_design/c']);

      // @ts-ignore
      await element.handleDeleteByMode('both');

      expect(deleteDocumentsSpy).toHaveBeenCalledTimes(1);
      expect((deleteDocumentsSpy.mock.calls[0][2] as any).documents.map((d: any) => d.id))
        .toEqual(['_design/a', '_design/b', '_design/c']);
      // The defect: this used to receive g1/g2 as well, and commit five deletions.
      expect(deleteRepoDocsSpy).toHaveBeenCalledTimes(1);
      expect(deleteRepoDocsSpy.mock.calls[0][2]).toEqual(['a', 'b', 'c']);
      // And both toasts have to report that same 3, not a third number.
      expect(toastSpy).toHaveBeenCalledWith('Deleted 3 document(s) from CouchDB', 'success');
      expect(toastSpy).toHaveBeenCalledWith('Deleted 3 document(s) from Git', 'success');
    });

    it("'Delete from CouchDB' still covers every selected doc CouchDB has, synced ones included", async () => {
      // @ts-ignore
      await element.handleDeleteByMode('couch');
      expect((deleteDocumentsSpy.mock.calls[0][2] as any).documents.map((d: any) => d.id))
        .toEqual(['_design/a', '_design/b', '_design/c']);
      expect(deleteRepoDocsSpy).not.toHaveBeenCalled();
    });

    /**
     * Issue #6 item 2, widened. `deleteRepoDocs` sweeps its own `sync:`/`conflict:` bookkeeping
     * after a git delete; the CouchDB side goes straight to `dbMgmt.deleteDocuments` and left it
     * behind.
     *
     * Scope matters here. Only a **couch-only** document's records are unambiguously orphaned. A
     * *synced* document deleted from CouchDB alone still exists in git, and its `sync:` record is
     * exactly what makes the next "Sync to CouchDB" read it as "newer in git" and restore it —
     * behaviour README.md:97 documents on purpose. These tests pin that boundary in both
     * directions, so a future "tidy up" cannot quietly change a documented sync outcome.
     */
    describe('sweeping orphaned git bookkeeping after a CouchDB delete', () => {
      const COUCH_ONLY: TrackedDesignDoc = {
        server_id: 'srv1', server_name: null, db_name: 'animals',
        ddoc_id: '_design/local1', rev: '1-aaa', ddoc_rev: null,
        git_repo_id: null, last_git_sha: null,
        last_sync: null, updated_at: null, sync_status: 'unknown',
      } as unknown as TrackedDesignDoc;

      let forgetSpy: ReturnType<typeof vi.spyOn>;

      beforeEach(async () => {
        forgetSpy = vi
          .spyOn(getContext().designMgmt, 'forgetSyncState')
          .mockResolvedValue(undefined);
        // @ts-ignore
        element.docs = [...MIXED, COUCH_ONLY];
        // @ts-ignore
        element.selectedDocs = new Set(
          [...MIXED, COUCH_ONLY].map((d) => `${d.server_id}|${d.db_name}|${d.ddoc_id}`)
        );
        await updated(element);
      });

      it('forgets the records of a document git never had', async () => {
        // @ts-ignore
        await element.handleDeleteByMode('couch');

        expect(forgetSpy).toHaveBeenCalledTimes(1);
        expect(forgetSpy.mock.calls[0][0]).toBe('animals');
        expect(forgetSpy.mock.calls[0][1]).toEqual(['_design/local1']);
      });

      it('leaves a synced document\'s sync record alone — git still has it, and it drives the restore', async () => {
        // @ts-ignore
        await element.handleDeleteByMode('couch');

        const forgotten = forgetSpy.mock.calls.flatMap((c) => c[1] as string[]);
        expect(forgotten).not.toContain('_design/a');
      });

      it('forgets nothing when the CouchDB delete failed', async () => {
        deleteDocumentsSpy.mockRejectedValueOnce(new Error('conflict'));

        // @ts-ignore
        await element.handleDeleteByMode('couch');

        // The documents are still there, so their tracking records are still correct.
        expect(forgetSpy).not.toHaveBeenCalled();
      });

      it("does not double-sweep in 'both' mode — deleteRepoDocs already does it", async () => {
        // @ts-ignore
        element.selectedDocs = new Set(MIXED.map((d) => `${d.server_id}|${d.db_name}|${d.ddoc_id}`));
        await updated(element);

        // @ts-ignore
        await element.handleDeleteByMode('both');

        expect(deleteRepoDocsSpy).toHaveBeenCalledTimes(1);
        expect(forgetSpy).not.toHaveBeenCalled();
      });
    });

    it("'Delete from Git' covers git-only and synced docs, and touches nothing in CouchDB", async () => {
      // @ts-ignore
      await element.handleDeleteByMode('git');
      expect(deleteRepoDocsSpy.mock.calls[0][2]).toEqual(['g1', 'g2', 'a', 'b', 'c']);
      expect(deleteDocumentsSpy).not.toHaveBeenCalled();
    });

    it('refuses the whole operation, rather than doing only its CouchDB half, with no repo linked', async () => {
      const toastSpy = vi.spyOn(await import('../src/components/cca-toast.js'), 'toast');
      // @ts-ignore
      element.repoId = null;
      // @ts-ignore
      await element.handleDeleteByMode('both');

      expect(deleteDocumentsSpy).not.toHaveBeenCalled();
      expect(deleteRepoDocsSpy).not.toHaveBeenCalled();
      expect(toastSpy).toHaveBeenCalledWith(expect.stringMatching(/nothing was deleted/i), 'error');
    });

    /**
     * The other half of the same honesty problem: 'both' correctly deletes only the three synced
     * documents, but the button enables on `syncedCount > 0` no matter what else is selected and
     * the delete then cleared the *whole* selection — so the two git-only documents looked
     * handled and were not. The dialog has to name them, and they have to stay selected.
     */
    it("names the selected documents a 'both' delete will not touch", async () => {
      // @ts-ignore
      element.prepareDelete('both');
      await updated(element);

      // @ts-ignore
      const message: string = element.deleteMessage;
      expect(message).toContain('3 document(s)');
      expect(message).toMatch(/2 .*\bnot\b/i);
      expect(message).toContain('_design/g1');
      expect(message).toContain('_design/g2');
    });

    it('leaves the untouched documents selected instead of clearing the whole selection', async () => {
      // @ts-ignore
      await element.handleDeleteByMode('both');

      // @ts-ignore
      expect([...element.selectedDocs].sort()).toEqual([
        'srv1|animals|_design/g1',
        'srv1|animals|_design/g2'
      ]);
    });

    it("says nothing about skipped documents when the mode covers the whole selection", async () => {
      // @ts-ignore
      element.prepareDelete('git');
      await updated(element);

      // 'git' takes git-only *and* synced — every selected document is accounted for.
      // @ts-ignore
      expect(element.deleteMessage).toBe(
        'Are you sure you want to delete 5 document(s) from Git repository?'
      );
    });

    it('counts each dropdown action over disjoint groups, so no document is double-counted', async () => {
      // @ts-ignore
      expect(element._getDeleteCounts()).toEqual({ syncedCount: 3, couchCount: 3, gitCount: 5 });
    });
  });

  // ---------------------------------------------------------------------------
  // Repository-listing cap. The service has always logged it, but nothing
  // rendered that log — so in the UI the 50-file cap WAS the silent truncation
  // it exists to avoid, and the README claimed otherwise.
  // ---------------------------------------------------------------------------
  describe('Repository listing cap (the warning has to reach the screen)', () => {
    it('names how many documents were left out, and which', async () => {
      const ctx = getContext();
      vi.spyOn(ctx.designMgmt, 'getRepoDocs').mockImplementation(async (_id, _db, onTruncated) => {
        onTruncated?.({
          shown: 50,
          total: 53,
          droppedPaths: ['sales/_design/x.json', 'sales/_design/y.json', 'sales/_design/z.json']
        });
        return [];
      });

      // @ts-ignore
      element.selectedServer = 'srv1';
      // @ts-ignore
      element.selectedDatabase = 'animals';
      // @ts-ignore
      element.repoId = 'repo:test123';
      // @ts-ignore
      await element.getDesignDocsFromRepo('repo:test123');
      await updated(element);

      const notice = requireShadowRoot(element).querySelector('[data-repo-truncated]');
      expect(notice).not.toBeNull();
      expect(notice!.textContent).toContain('50 of 53');
      expect(notice!.textContent).toContain('x, y, z');
    });

    it('shows nothing when the listing was complete', async () => {
      // @ts-ignore
      element.selectedServer = 'srv1';
      // @ts-ignore
      element.selectedDatabase = 'animals';
      // @ts-ignore
      await element.getDesignDocsFromRepo('repo:test123');
      await updated(element);

      expect(requireShadowRoot(element).querySelector('[data-repo-truncated]')).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Conflict banner — the conflict viewer route had no nav entry and no inbound
  // link anywhere in the app.
  // ---------------------------------------------------------------------------
  describe('Conflict banner (links to the conflict viewer)', () => {
    it('links to the conflict viewer when a listed document has a conflict', async () => {
      // @ts-ignore
      element.docs = [{ ...mockDocs[0], sync_status: 'conflict' }];
      // @ts-ignore
      element.loading = false;
      // @ts-ignore
      element.selectedServer = 'srv1';
      // @ts-ignore
      element.selectedDatabase = 'animals';
      await updated(element);

      const link = requireShadowRoot(element).querySelector('[data-conflict-link]');
      expect(link).not.toBeNull();
      expect(link!.textContent).toMatch(/conflict/i);
    });

    it('shows no conflict banner when nothing is conflicted', async () => {
      // @ts-ignore
      element.docs = mockDocs;
      // @ts-ignore
      element.loading = false;
      // @ts-ignore
      element.selectedServer = 'srv1';
      // @ts-ignore
      element.selectedDatabase = 'animals';
      await updated(element);

      expect(requireShadowRoot(element).querySelector('[data-conflict-link]')).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Reaching a database without _all_dbs (#5). CouchDB 3.5.2 answers `GET /_all_dbs` with 401
  // ("You are not a server admin.") for a non-admin, while `GET /{db}/_design_docs` answers 200
  // for a plain member of that database — so the screen genuinely works once it has a name, and
  // the only thing actually refused is the *enumeration*. Before this, the 401 was toasted and
  // the list emptied, which left an empty dropdown (no way in) AND silently killed the one
  // escape hatch that should have worked: the `?database=` deep link repo-overview.ts generates,
  // because connectedCallback gated it on `this.databases.includes(databaseParam)`.
  // ---------------------------------------------------------------------------
  describe('Reaching a database without _all_dbs (#5)', () => {
    const mounted: CcaDesignList[] = [];

    afterEach(() => {
      while (mounted.length) mounted.pop()!.remove();
    });

    /** The exact refusal CouchDB 3.5.2 returns for `GET /_all_dbs` as a signed-in non-admin. */
    const allDbsRefusal = () => new ApiError(401, 'You are not a server admin.');

    /**
     * Mounts the component the way a real page load does — route `:serverId` plus an optional
     * `?database=` — with `getDatabases` either answering or refusing.
     */
    async function mountPageLoad(
      dbs: { resolve: string[] } | { reject: unknown },
      query = ''
    ): Promise<CcaDesignList> {
      const ctx = getContext();
      vi.spyOn(ctx.serverMgmt, 'listServers').mockResolvedValue({
        servers: [{ id: 'srv1', name: 'Server 1' }],
        nextBookmark: ''
      });
      if ('resolve' in dbs) {
        vi.spyOn(ctx.serverMgmt, 'getDatabases').mockResolvedValue(
          dbs.resolve.map((db_name) => ({ db_name })) as any
        );
      } else {
        vi.spyOn(ctx.serverMgmt, 'getDatabases').mockRejectedValue(dbs.reject);
      }
      vi.spyOn(ctx.router, 'currentQuery').mockReturnValue(new URLSearchParams(query));

      const el = document.createElement('cca-design-list') as CcaDesignList;
      el.serverId = 'srv1';
      document.body.appendChild(el);
      mounted.push(el);
      // connectedCallback's chain is listServers -> getDatabases -> selectDatabase -> load.
      for (let i = 0; i < 4; i++) {
        await el.updateComplete;
        await new Promise((r) => setTimeout(r, 0));
      }
      await el.updateComplete;
      return el;
    }

    function picker(el: CcaDesignList): CcaDbPicker {
      const found = requireShadowRoot(el).querySelector('cca-db-picker') as CcaDbPicker | null;
      if (!found) throw new Error('expected a cca-db-picker in the design-list shadow root');
      return found;
    }

    it('offers a typable database field with an explanation when _all_dbs is refused', async () => {
      const el = await mountPageLoad({ reject: allDbsRefusal() });

      expect(picker(el).unavailable).toBe(true);
      // The shared copy from db-enumeration.ts, not a second sentence written here.
      expect(picker(el).reason).toBe(describeDbAccessError(allDbsRefusal()));
      // The dead end the fix removes: a dropdown that can only ever be empty.
      expect(requireShadowRoot(el).querySelector('wa-select[name="database"]')).toBeNull();
    });

    it('opens ?database= and loads its design docs even though _all_dbs was refused', async () => {
      const ctx = getContext();
      const listSpy = vi.spyOn(ctx.designMgmt, 'listDesignDocs').mockResolvedValue([]);

      const el = await mountPageLoad({ reject: allDbsRefusal() }, 'database=animals');

      // @ts-ignore — private state is the subject here
      expect(el.selectedDatabase).toBe('animals');
      expect(listSpy).toHaveBeenCalledWith('srv1', 'animals');
      expect(picker(el).value).toBe('animals');
    });

    it('still opens ?database= unchanged when the list loaded normally', async () => {
      const ctx = getContext();
      const listSpy = vi.spyOn(ctx.designMgmt, 'listDesignDocs').mockResolvedValue([]);

      const el = await mountPageLoad({ resolve: ['animals', 'users'] }, 'database=animals');

      // @ts-ignore
      expect(el.selectedDatabase).toBe('animals');
      expect(listSpy).toHaveBeenCalledWith('srv1', 'animals');
      expect(picker(el).unavailable).toBe(false);
      expect(picker(el).databases).toEqual(['animals', 'users']);
    });

    it('refuses a ?database= the loaded list contradicts, and loads nothing for it', async () => {
      const ctx = getContext();
      const listSpy = vi.spyOn(ctx.designMgmt, 'listDesignDocs').mockResolvedValue([]);

      const el = await mountPageLoad({ resolve: ['animals', 'users'] }, 'database=ghost');

      // @ts-ignore
      expect(el.selectedDatabase).toBe('');
      expect(listSpy).not.toHaveBeenCalled();
      expect(picker(el).unavailable).toBe(false);
    });

    it('keeps the error toast for a failure that is not a refusal', async () => {
      const toastSpy = vi.spyOn(await import('../src/components/cca-toast.js'), 'toast');

      const el = await mountPageLoad({ reject: new ApiError(500, 'Internal server error') });

      expect(toastSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to load databases'),
        'error'
      );
      // A broken server is not "you may not enumerate" — do not invite the user to type a name
      // as though the list were merely withheld.
      expect(picker(el).unavailable).toBe(false);
    });

    it('loads the design docs of a database typed by hand', async () => {
      const ctx = getContext();
      const listSpy = vi.spyOn(ctx.designMgmt, 'listDesignDocs').mockResolvedValue([]);
      const el = await mountPageLoad({ reject: allDbsRefusal() });

      picker(el).dispatchEvent(
        new CustomEvent('cca-db-change', {
          detail: { database: 'typed_by_hand' },
          bubbles: true,
          composed: true
        })
      );
      for (let i = 0; i < 3; i++) {
        await el.updateComplete;
        await new Promise((r) => setTimeout(r, 0));
      }

      // @ts-ignore
      expect(el.selectedDatabase).toBe('typed_by_hand');
      expect(listSpy).toHaveBeenCalledWith('srv1', 'typed_by_hand');
    });
  });

  // ---------------------------------------------------------------------------
  // Arriving via the "Design Docs" nav item (#83). That nav item points at
  // `/design-docs/$all` (plugin-registry.ts), the only route this screen has since PR #60
  // removed the shared server-select dropdown that used to steer a user off `$all` onto a
  // concrete server id. Under D2 there is exactly one server (SINGLE_SERVER_ID), and
  // connectedCallback must resolve `$all` to it directly — db-list.ts's `_openServerId`
  // getter already does exactly this for the same reason.
  // ---------------------------------------------------------------------------
  describe('Arriving via the nav item\'s $all route (#83)', () => {
    const mounted: CcaDesignList[] = [];

    afterEach(() => {
      while (mounted.length) mounted.pop()!.remove();
    });

    it('resolves $all to the single server and enables the database picker', async () => {
      const ctx = getContext();
      vi.spyOn(ctx.serverMgmt, 'listServers').mockResolvedValue({
        servers: [{ id: SINGLE_SERVER_ID, name: 'CouchDB' }],
        nextBookmark: ''
      });
      vi.spyOn(ctx.serverMgmt, 'getDatabases').mockResolvedValue([
        { db_name: 'animals' },
        { db_name: 'users' }
      ] as any);
      vi.spyOn(ctx.router, 'currentQuery').mockReturnValue(new URLSearchParams(''));

      const el = document.createElement('cca-design-list') as CcaDesignList;
      el.serverId = '$all';
      document.body.appendChild(el);
      mounted.push(el);
      for (let i = 0; i < 4; i++) {
        await el.updateComplete;
        await new Promise((r) => setTimeout(r, 0));
      }
      await el.updateComplete;

      // @ts-ignore — private state is the subject here
      expect(el.selectedServer).toBe(SINGLE_SERVER_ID);
      const picker = requireShadowRoot(el).querySelector('cca-db-picker') as CcaDbPicker | null;
      if (!picker) throw new Error('expected a cca-db-picker in the design-list shadow root');
      expect(picker.disabled).toBe(false);
      expect(picker.databases).toEqual(['animals', 'users']);
    });

    it('also opens ?database= on the $all route, not just a named server', async () => {
      const ctx = getContext();
      vi.spyOn(ctx.serverMgmt, 'listServers').mockResolvedValue({
        servers: [{ id: SINGLE_SERVER_ID, name: 'CouchDB' }],
        nextBookmark: ''
      });
      vi.spyOn(ctx.serverMgmt, 'getDatabases').mockResolvedValue([
        { db_name: 'animals' }
      ] as any);
      vi.spyOn(ctx.router, 'currentQuery').mockReturnValue(new URLSearchParams('database=animals'));
      const listSpy = vi.spyOn(ctx.designMgmt, 'listDesignDocs').mockResolvedValue([]);

      const el = document.createElement('cca-design-list') as CcaDesignList;
      el.serverId = '$all';
      document.body.appendChild(el);
      mounted.push(el);
      for (let i = 0; i < 4; i++) {
        await el.updateComplete;
        await new Promise((r) => setTimeout(r, 0));
      }
      await el.updateComplete;

      // @ts-ignore
      expect(el.selectedDatabase).toBe('animals');
      expect(listSpy).toHaveBeenCalledWith(SINGLE_SERVER_ID, 'animals');
    });
  });

  // ---------------------------------------------------------------------------
  // #92 item 3 — Design Docs → create a Mango index. A Mango index IS a design
  // document, but until now the only way to one was via the Databases list; #81
  // had already wired the opposite direction (doc-browser/doc-query → here).
  // ---------------------------------------------------------------------------
  describe('Create Index entry point (#92)', () => {
    beforeEach(async () => {
      // @ts-ignore — canWriteDb gates the whole doc-actions footer, and it normally
      // resolves asynchronously through selectDatabase(); set it directly, as the
      // Delete describe above does.
      element.canWriteDb = true;
      // @ts-ignore
      element.loading = false;
      await updated(element);
    });

    it('offers the button beside "Create New" in the doc actions', async () => {
      // @ts-ignore
      element.selectedServer = 'srv1';
      // @ts-ignore
      element.selectedDatabase = 'animals';
      await updated(element);

      const btn = requireShadowRoot(element).querySelector('[data-testid="create-index"]');
      expect(btn).not.toBeNull();
      expect(btn!.textContent).toContain('Create Index');

      // "Beside Create New" is the requirement, so pin that they share a container and
      // that Create New still comes first — a button that drifted into the sync group or
      // replaced Create New would otherwise pass a bare not-null check.
      const actions = Array.from(
        btn!.parentElement!.querySelectorAll('wa-button'),
      ).map((b) => b.textContent!.trim());
      expect(actions).toEqual(['Create New', 'Create Index']);
    });

    it('navigates to the selected database\'s index screen', async () => {
      const navigateSpy = vi.spyOn(getContext().router, 'navigate');
      // @ts-ignore
      element.selectedServer = 'srv1';
      // @ts-ignore
      element.selectedDatabase = 'animals';
      await updated(element);

      (requireShadowRoot(element).querySelector(
        '[data-testid="create-index"]',
      ) as HTMLElement).click();

      expect(navigateSpy).toHaveBeenCalledOnce();
      expect(navigateSpy.mock.calls[0][0]).toBe('/databases/srv1/animals/indexes');
    });

    it('URL-encodes the server and database segments', async () => {
      const navigateSpy = vi.spyOn(getContext().router, 'navigate');
      // @ts-ignore
      element.selectedServer = 'my server';
      // @ts-ignore
      element.selectedDatabase = 'my/db';
      await updated(element);

      // @ts-ignore — private handler, called directly so the assertion is about the URL
      element.handleCreateIndex();

      expect(navigateSpy.mock.calls[0][0]).toBe('/databases/my%20server/my%2Fdb/indexes');
    });

    it('degrades with a toast — and no navigation — when no database is selected', async () => {
      const toastSpy = vi.spyOn(await import('../src/components/cca-toast.js'), 'toast');
      const navigateSpy = vi.spyOn(getContext().router, 'navigate');
      // @ts-ignore
      element.selectedServer = 'srv1';
      // @ts-ignore
      element.selectedDatabase = '';
      await updated(element);

      // @ts-ignore
      element.handleCreateIndex();

      expect(toastSpy).toHaveBeenCalledWith(
        'Please select a server and database first',
        'error',
      );
      // The route is /databases/:serverId/:dbName/indexes — navigating with a blank
      // segment would resolve somewhere else entirely, so nothing may be dispatched.
      expect(navigateSpy).not.toHaveBeenCalled();
    });

    it('degrades with a toast — and no navigation — when no server is selected', async () => {
      const toastSpy = vi.spyOn(await import('../src/components/cca-toast.js'), 'toast');
      const navigateSpy = vi.spyOn(getContext().router, 'navigate');
      // @ts-ignore
      element.selectedServer = '';
      // @ts-ignore
      element.selectedDatabase = 'animals';
      await updated(element);

      // @ts-ignore
      element.handleCreateIndex();

      expect(toastSpy).toHaveBeenCalledWith(
        'Please select a server and database first',
        'error',
      );
      expect(navigateSpy).not.toHaveBeenCalled();
    });

    it('is hidden from a user who cannot write design documents', async () => {
      // @ts-ignore — creating an index PUTs a design document, so it belongs behind the
      // same gate as Create New rather than being offered and then 403ing.
      element.canWriteDb = false;
      // @ts-ignore
      element.selectedServer = 'srv1';
      // @ts-ignore
      element.selectedDatabase = 'animals';
      await updated(element);

      expect(
        requireShadowRoot(element).querySelector('[data-testid="create-index"]'),
      ).toBeNull();
    });
  });
});
