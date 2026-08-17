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

import { html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { getContext } from '../../context.js';
import { getLogger } from '../../services/log-service.js';
import { UNKNOWN_ERROR, type TrackedDesignDoc, type GitDesignDoc } from './types.js';
import type { GitAccount, RemoteRepo, ConnectGitAccountRequest, RepoDocsTruncation } from '../../services/design-mgmt-service.js';
import { isDatabaseAdmin } from '../../services/db-mgmt-service.js';
import { isEnumerationDenied, describeDbAccessError } from '../../services/db-enumeration.js';
import { SINGLE_SERVER_ID } from '../../services/single-server.js';
import { GitTokenPrompt, reportSyncToRepoResult, blockedRequestAdvice } from './git-sync-ui.js';
import { CcaElement } from '../../components/cca-element.js';
import { TableColumn } from '../../components/cca-data-table';
import { toast } from '../../components/cca-toast.js';
import { addHeaderActions, clearHeaderActions } from '../../components/cca-header.js';
import { shouldAutoOpenConnectGitDialog, renderProviderDialog, renderConnectAccountDialog, renderCredentialModePicker, SUPPORTED_PROVIDERS, type ConnectGitDialogState, type ConnectGitDialogCallbacks } from './connect-git-account-flow.js';
import type { CredentialMode } from '../../services/git/git-credential-store.js';
import type { FormSubmitEvent } from '../../components/cca-form.js';
import type { CcaDbChangeDetail } from '../../components/cca-db-picker.js';
import '../../components/cca-form.js';
import '../../components/cca-db-picker.js';

import type { FormFieldDef } from '../../components/cca-form.js';

const log = getLogger('plugins/design-mgmt/design-list');

function docKey(d: Pick<TrackedDesignDoc, 'server_id' | 'db_name' | 'ddoc_id'>): string {
  return `${d.server_id}|${d.db_name}|${d.ddoc_id}`;
}

/**
 * Client-side sync-status heuristic for the design-doc table — a `TrackedDesignDoc` (from
 * `listDesignDocs`, so it carries the last-synced `ddoc_rev`/`last_git_sha` but never a document
 * body) merged with what the repository currently shows for the same document.
 *
 * Deliberately not `git/design-sync.ts`'s `classify()`: that function additionally needs
 * `contentEqual`, which would require fetching the full CouchDB body this table's own listing
 * intentionally avoids (Task 5 dropped `include_docs=true` — a page load fetching every design
 * doc's full body just to throw it away). It does, however, follow `classify()`'s **shape** as
 * closely as the available data allows, because the two disagreeing is worse than either being
 * approximate:
 *
 *  - A side that has never seen the document at all wins outright, exactly as `classify()` says.
 *  - Otherwise both movements are measured: `rev` against `ddoc_rev` **and** `last_git_sha`
 *    against the repository's current sha. The git-sha comparison needs no document body and the
 *    sha is already in hand, so omitting it (as this function used to, in its `rev !== ddoc_rev`
 *    branch) was a gap, not a limitation: a genuine both-sides-moved conflict rendered as
 *    `newer_in_couch`, which reads as "safe to push" right up until the push is refused by a
 *    conflict the user never saw coming.
 *  - Where `classify()` breaks a both-moved tie on content equality, this cannot — no body — so it
 *    reports `conflict`, the conservative half of that answer. A pair that happens to agree on
 *    content shows as a conflict for one render and settles to `synced` after the next sync
 *    reconciles it; the reverse mistake would hide a real one.
 *  - A `rev` that moved *backwards* in generation (or vanished) is `unknown`, not `conflict`: no
 *    conflict record exists for it, so the old verdict linked the user to a conflict viewer with
 *    nothing in it. Nothing here can tell "the sync record is stale" from "the document was
 *    deleted and recreated", and saying so is more useful than naming the wrong one.
 *
 * Exported so `design-list-sync-status.test.ts` exercises this exact function instead of a
 * hand-maintained copy of it.
 */
export function computeSyncStatus(
  existing: TrackedDesignDoc,
  gitDoc: GitDesignDoc
): TrackedDesignDoc['sync_status'] {
  const gitSha = gitDoc.info.git_sha ?? null;

  // "Only one side has it at all" — classify()'s first two rules, and the reason a CouchDB-side
  // delete that still exists in git reads as newer_in_git here too (a deliberate, documented
  // behaviour: see README's "Sync from repository will bring it back").
  if (existing.rev !== null && gitSha === null) return 'newer_in_couch';
  if (existing.rev === null && gitSha !== null) return 'newer_in_git';

  // No usable sync record — nothing to measure movement against.
  if (!existing.ddoc_rev || !existing.last_git_sha) return 'unknown';

  const couchMoved = existing.rev !== existing.ddoc_rev;
  const gitMoved = existing.last_git_sha !== gitSha;

  if (couchMoved && gitMoved) return 'conflict';
  if (gitMoved) return 'newer_in_git';
  if (!couchMoved) return 'synced';

  const revGen = existing.rev ? parseInt(existing.rev.split('-')[0], 10) : 0;
  const syncGen = parseInt(existing.ddoc_rev.split('-')[0], 10);
  return revGen > syncGen ? 'newer_in_couch' : 'unknown';
}

/**
 * Merges the CouchDB-sourced and git-sourced design-doc lists into the single set the table
 * renders, deriving each row's `sync_status` via {@link computeSyncStatus}. A pure function (no
 * `this`) so the exact merge logic the component renders is what `design-list-sync-status.test.ts`
 * exercises — that test used to reimplement this "to mirror it exactly," which meant the real
 * function went untested and the copy could drift.
 */
export function buildDDocs(
  couchDDocs: TrackedDesignDoc[],
  gitDDocs: GitDesignDoc[],
  selectedServer: string,
  selectedDatabase: string
): TrackedDesignDoc[] {
  const key = (server_id: string, db_name: string, ddoc_id: string) => `${server_id}|${db_name}|${ddoc_id}`;
  const map = new Map<string, TrackedDesignDoc>();

  // Primary source: couch docs
  for (const doc of couchDDocs) {
    const k = key(doc.server_id, doc.db_name, doc.ddoc_id);
    map.set(k, {
      server_id: doc.server_id,
      server_name: doc.server_name ?? null,
      db_name: doc.db_name,
      ddoc_id: doc.ddoc_id,
      rev: doc.rev,
      ddoc_rev: doc.ddoc_rev ?? null,
      git_repo_id: doc.git_repo_id ?? null,
      last_git_sha: doc.last_git_sha ?? null,
      sync_status: 'unknown',
      updated_at: doc.updated_at ?? null,
      last_sync: doc.last_sync ?? null
    });
  }

  // Merge git docs
  for (const doc of gitDDocs) {
    const k = key(selectedServer, doc.info.db_name, doc.info.ddoc_id);
    const existing = map.get(k);

    if (existing) {
      existing.sync_status = computeSyncStatus(existing, doc);
    } else {
      // Only in git, not in couch — use selected server context
      map.set(`${selectedServer}|${selectedDatabase}|${doc.info.ddoc_id}`, {
        server_id: selectedServer ?? '',
        server_name: null,
        db_name: selectedDatabase ?? '',
        ddoc_id: doc.info.ddoc_id,
        rev: null,
        ddoc_rev: null,
        git_repo_id: doc.info.git_repo_id ?? null,
        last_git_sha: doc.info.git_sha ?? null,
        sync_status: 'unknown',
        updated_at: doc.info.last_updated ?? null,
        last_sync: doc.info.last_updated ?? null
      });
    }
  }

  return Array.from(map.values());
}

@customElement('cca-design-list')
export class CcaDesignList extends CcaElement {
  static override get eventSubscriptions() {
    return {
      'submit:form': async function (this: CcaDesignList, _el: HTMLElement, _ev: Event) {
        const customEvent = _ev as CustomEvent<FormSubmitEvent>;
        const data = customEvent.detail.data;

        // Account connection form has 'label' and 'token' fields
        if (data.label && data.token) {
          await this.handleAccountConnect(customEvent);
        }
        // Repo registration/update form has 'path' field
        else if (data.path !== undefined) {
          if (this.manageMode) {
            await this.handleRepoUpdate(customEvent);
          } else {
            await this.handleRepoRegister(customEvent);
          }
        }
      }
    };
  }

  static styles = css`
    :host {
      display: block;
    }
    h2 {
      margin: 0;
      font-size: var(--wa-font-size-l);
    }
    .links {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      width: 100%;
    }
    a {
      color: var(--wa-color-brand-fill-loud);
      text-decoration: underline;
      font-size: var(--wa-font-size-s);
    }
    a:hover {
      font-weight: var(--wa-font-weight-bold);
    }
    .table-wrapper {
      overflow-x: auto;
      padding-top: 1rem;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      width: 100%;
    }
    .header-title {
      font-size: var(--wa-font-size-l);
      font-weight: var(--wa-font-weight-bold);
      margin: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      flex-shrink: 0;
    }
    .form-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 1rem;
      margin-bottom: 1rem;
    }
    .wa-grid {
      display: grid !important;
      grid-template-columns: 1fr 1fr;
    }
    .grid-field {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .grid-field wa-label,
    .grid-field .git-label {
      min-width: 80px;
      flex-shrink: 0;
      color: var(--wa-color-text-normal);
    }
    /* cca-db-picker sits where the database wa-select used to and must keep its exact width in
       both of its states — the dropdown and the free-text field it degrades to. */
    .grid-field wa-select,
    .grid-field cca-db-picker {
      flex: 1;
      max-width: 250px;
    }
    .grid-field .git-fields {
      flex: 1;
    }
    .form-row {
      display: flex;
      flex-direction: row;
      gap: 2rem;
      margin-bottom: 1rem;
      align-items: center;
    }
    .inline-field {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .inline-field wa-label {
      min-width: 80px;
      flex-shrink: 0;
      color: var(--wa-color-text-normal);
    }
    .inline-field wa-select {
      flex: 1;
      max-width: 250px;
    }
    .git-section {
      grid-column: 1 / -1;
      border-top: 1px solid var(--wa-color-surface-border);
      padding-top: 1rem;
      margin-top: 1rem;
    }
    .git-row {
      display: flex;
      gap: 1rem;
      margin-bottom: 1rem;
    }
    .git-field {
      flex: 1;
      display: flex;
      flex-direction: column;
    }
    .form-actions {
      display: flex;
      justify-content: flex-end;
      margin-top: 1rem;
    }

    /* GIT section */
    .git-container {
      display: flex;
      align-items: start;
      gap: 0.5rem;
      margin-bottom: 1rem;
    }
    .git-label {
      min-width: 80px;
      flex-shrink: 0;
      color: var(--wa-color-text-normal);
    }
    .git-fields {
      flex: 1;
      max-width: 800px;
      color: var(--wa-color-text-normal);
    }
    .git-fields-spacer {
      height: 0.5rem;
    }
    .git-design-root-label {
      white-space: nowrap;
      padding-left: 1.75rem;
    }
    .git-input {
      flex: 1;
      width: 100%;
      max-width: unset;
    }
    .git-custom-label {
      color: var(--wa-color-text-normal);
      margin-right: 0.5rem;
    }
    .footer {
      padding-top: 1rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .doc-actions {
      display: flex;
      justify-content: flex-end;
      gap: 0.75rem;
    }
    .sync-action {
      display: flex;
      justify-content: flex-start;
      gap: 0.5rem;
    }
    .admin-only-note {
      font-size: var(--wa-font-size-s);
      color: var(--wa-color-text-quiet);
    }
    .conflict-banner {
      margin-bottom: 1rem;
    }
    .dialog-fields {
      display: flex;
      flex-direction: column;
      gap: 1rem;
      margin-bottom: 1rem;
    }
    wa-icon {
      font-size: var(--wa-font-size-xl);
      color: var(--wa-color-text-normal);
    }
    wa-drawer::part(title) {
      color: var(--wa-color-text-normal);
    }
    wa-drawer label {
      color: var(--wa-color-text-normal);
      font-weight: var(--wa-font-weight-semibold);
      display: block;
      margin-bottom: 0.5rem;
    }
    wa-drawer p {
      color: var(--wa-color-text-normal);
    }
    wa-dialog label {
      color: var(--wa-color-text-normal);
      font-weight: var(--wa-font-weight-semibold);
      display: block;
      margin-bottom: 0.25rem;
      font-size: var(--wa-font-size-s);
    }
    wa-dialog wa-select {
      width: 100%;
    }
    cca-form.no-changes .submit {
      opacity: 0.5;
      cursor: not-allowed;
      pointer-events: none;
    }
  `;

  @property({ type: String }) serverId = '';

  @state() private docs: TrackedDesignDoc[] = [];
  @state() private gitDDocs: GitDesignDoc[] = [];
  /** Set when `getRepoDocs` hit its per-file API-call cap, so the table can say so on screen —
   *  the service's `log.warn` was never rendered anywhere, which made the cap silent in the UI. */
  @state() private repoDocsTruncation: RepoDocsTruncation | null = null;
  @state() private couchDDocs: TrackedDesignDoc[] = [];
  @state() private loading = true;
  @state() private tableLoading = false;
  @state() private servers: Array<{ id: string; name: string }> = [];
  @state() private databases: string[] = [];
  /**
   * CouchDB refused to *enumerate* the databases (`GET /_all_dbs` is server-admin-only by its own
   * default), so {@link databases} is empty for want of permission rather than for want of
   * databases. Set only from the error actually received — never from `isAdmin`, because
   * `[chttpd] admin_only_all_dbs = false` is a legitimate deployment where a non-admin's
   * `_all_dbs` returns 200 and pre-gating would hide a list the server was willing to serve.
   */
  @state() private databaseListDenied = false;
  /** Why the list is missing, in the shared wording of `db-enumeration.ts`. */
  @state() private databaseListDenialReason = '';
  @state() private selectedServer: string = '';
  @state() private selectedDatabase: string = '';
  @state() private searchText: string = '';
  @state() private selectedDocs: Set<string> = new Set();
  @state() private gitProvider: string | null = null;
  @state() private gitUrl: string | null = null;
  @state() private designRoot: string = '';
  @state() private repoId: string | null = null;
  @state() private repoAccountId: string | null = null;
  @state() private repoName: string | null = null;
  @state() private repoBranch: string = '';
  @state() private syncingrepo = false;
  @state() private syncingcouch = false;
  /** May the current user write a design doc in `selectedDatabase`? Server admin OR named as a
   *  *database* admin of it (see {@link isDatabaseAdmin}) — resolved asynchronously (Step 3,
   *  fix round 1), unlike {@link isAdmin} (couchcompanion access, server-admin only, synchronous). */
  @state() private canWriteDb = false;

  // Git connection flow (single drawer)
  @state() private showGitDrawer = false;
  @state() private gitAccounts: GitAccount[] = [];
  @state() private selectedAccountId: string | null = null;
  @state() private availableRepos: RemoteRepo[] = [];
  @state() private selectedRepo: RemoteRepo | null = null;
  @state() private selectedOwner: string | null = null;
  @state() private repoBranches: string[] = [];
  @state() private repoOwners: string[] = [];
  @state() private loadingRepos = false;
  @state() private loadingAccounts = false;
  @state() private showAccountForm = false;
  @state() private showDeleteConfirm = false;
  @state() private deleteMessage = '';
  @state() private deleteDocList: string[] = [];
  @state() private pendingDeleteMode: 'couch' | 'git' | 'both' | null = null;

  // Header action dialogs
  @state() private showProviderDialog = false;
  @state() private providerDialogForRegistration = false;
  @state() private manageMode = false;
  @state() private currentBranch: string | null = null;
  @state() private currentPath: string | null = null;
  @state() private showUpdateConfirm = false;
  @state() private showUnlinkConfirm = false;
  @state() private pendingUpdateData: any = null;
  @state() private hasRepoChanges = false;

  // Shared connect-git dialog state
  @state() private showConnectAccountDialog = false;
  @state() private connectProvider: 'github' | 'gitlab' | 'bitbucket' | null = null;
  @state() private connectLabel = '';
  @state() private connectUsername = '';
  @state() private connectToken = '';
  @state() private connectBaseUrl = '';
  @state() private connectingAccount = false;
  @state() private connectCredentialMode: CredentialMode = 'none';

  /**
   * Sync-time token prompt and single retry, shared with `view-editor.ts` (see `git-sync-ui.ts`).
   * Public so a test can drive it the way a user would, without reaching into private state.
   */
  readonly tokenPrompt = new GitTokenPrompt(this);

  private readonly TOKEN_PLACEHOLDERS = {
    github: 'ghp_...',
    gitlab: 'glpat-...',
    bitbucket: 'API token'
  } as const;

  private readonly BASE_URL_PLACEHOLDERS = {
    github: 'https://github.example.com',
    gitlab: 'https://gitlab.example.com',
    bitbucket: 'https://bitbucket.example.com'
  } as const;

  private static readonly SYNC_INDICATORS: Record<string, { symbol: string; tooltip: string }> = {
    newer_in_couch: { symbol: '>', tooltip: 'CouchDB Version is more recent' },
    newer_in_git: { symbol: '<', tooltip: 'Repo Version is more recent' },
    synced: { symbol: '=', tooltip: 'In Sync' },
    conflict: { symbol: '!', tooltip: 'Conflict Detected' }
  };

  private static usesOwnerFiltering(provider?: string | null): boolean {
    return provider === 'github' || provider === 'bitbucket';
  }

  private tableColumns: TableColumn<TrackedDesignDoc>[] = [
    {
      label: '',
      headerRender: () => html`
        <wa-checkbox
          .checked=${
            this.filteredDocs.length > 0 &&
            this.filteredDocs.every((d) => this.selectedDocs.has(docKey(d)))
          }
          .indeterminate=${
            this.filteredDocs.some((d) => this.selectedDocs.has(docKey(d))) &&
            !this.filteredDocs.every((d) => this.selectedDocs.has(docKey(d)))
          }
          @change=${(e: Event) => this.handleSelectAll(e)}
          @click=${(e: Event) => e.stopPropagation()}></wa-checkbox>
      `,
      render: (d) => html`
        <wa-checkbox
          .checked=${this.selectedDocs.has(docKey(d))}
          @change=${(e: Event) => this.handleDocCheckboxChange(e, d)}
          @click=${(e: Event) => e.stopPropagation()}></wa-checkbox>
      `,
      width: '3rem'
    },
    {
      label: 'Document',
      key: 'ddoc_id'
    },
    {
      label: 'Revision',
      render: (d) => (d.rev ? d.rev.substring(0, 10) : '-'),
      width: '8rem',
      align: 'center'
    },
    {
      label: 'Last Updated',
      render: (d) => {
        const ts = d.updated_at;
        return ts ? new Date(ts).toLocaleDateString() : '-';
      },
      width: '10rem',
      align: 'center'
    },
    {
      label: 'in Couch',
      render: (d) =>
        html`<wa-badge variant=${d.rev ? 'success' : 'danger'} appearance="accent" pill>${d.rev ? '✓' : '✗'}</wa-badge>`,
      width: '6rem',
      align: 'center'
    },
    {
      label: '',
      render: (d) => this.syncIndicator(d.sync_status),
      width: '5rem',
      align: 'center'
    },
    {
      label: 'in Git',
      render: (d) =>
        html`<wa-badge variant=${d.last_git_sha ? 'success' : 'danger'} appearance="accent" pill
          >${d.last_git_sha ? '✓' : '✗'}</wa-badge
        >`,
      width: '6rem',
      align: 'center'
    }
  ];

  async connectedCallback() {
    super.connectedCallback();

    try {
      const { servers } = await getContext().serverMgmt.listServers();
      this.servers = servers;

      // Server comes from the :serverId route property; database may be a query param filter.
      // `$all` resolves to the single server this product manages (D2) rather than staying
      // unset — the "Design Docs" nav item links to `/design-docs/$all` and, since PR #60
      // removed the shared server-select dropdown that used to steer a user off `$all`, nothing
      // else was left to name a server: the database picker stayed disabled forever (#83).
      // db-list.ts's `_openServerId` getter resolves the same route shape the same way.
      const serverParam = this.serverId && this.serverId !== '$all' ? this.serverId : SINGLE_SERVER_ID;
      const query = getContext().router.currentQuery();
      const databaseParam = query.get('database');

      if (serverParam && this.servers.some((s) => s.id === serverParam)) {
        // Load databases for this server
        await this.loadDatabasesForServer(serverParam);
      }

      // The design-doc list must finish its initial paint here, before anything that can block
      // on user interaction: render() shows only a full-page spinner — no dialog in that branch
      // — while `loading` is true. selectDatabase() below can reach a sync-time token prompt via
      // loadDesignDocs -> getDesignDocsFromRepo -> withTokenRetry -> promptForToken(), and a
      // prompt opened before `loading` clears would await a click on a dialog that can never
      // render — a permanent deadlock (fix round 2 CRITICAL). Reproduced via exactly the arrival
      // path repo-overview.ts's target pills use: `?database=` on first paint, a credential-mode
      // `none` account, and no session token yet. tableLoading (set inside loadDesignDocs) is
      // what should — and does — show a loading state from here on, not this component-wide flag.
      this.loading = false;
      this._updateHeaderActions();

      if (serverParam && databaseParam && this._mayOpenFromUrl(databaseParam)) {
        // Load design docs for this server/database
        await this.selectDatabase(databaseParam);
      }

      // Deep-link from repo overview: open the provider picker dialog on arrival. Connecting an
      // account writes couchcompanion (server-admin-only) — every other entry point to this
      // dialog is already gated on isAdmin, and this one walked a non-admin into a raw 403
      // without it (fix round 1).
      if (this.isAdmin && shouldAutoOpenConnectGitDialog(query)) {
        this._openProviderDialog();
      }
    } catch (error) {
      toast(`Failed to load servers: ${error}`, 'error');
      this.loading = false;
    }
  }

  override updated(changedProperties: Map<string, any>) {
    super.updated(changedProperties);
    
    // Attach input listener for path field in manage mode
    if (this.manageMode && this.showGitDrawer) {
      const pathInput = this.shadowRoot?.querySelector('wa-input[name="path"]') as any;
      if (pathInput && !pathInput.hasAttribute('data-listener-attached')) {
        pathInput.setAttribute('data-listener-attached', 'true');
        pathInput.addEventListener('input', () => {
          setTimeout(() => this.checkRepoChanges(), 100);
        });
      }
    }
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    clearHeaderActions();
  }

  /**
   * The **server** `_admin` role. `couchcompanion` is admin-only by CouchDB's own default security
   * (D9, verified live on CouchDB 3.5.2: a db member gets 403 from it), so connecting a git
   * account, registering/managing a repository and syncing are gated on this and nothing else.
   *
   * Creating or deleting a design document is *not* one of those: CouchDB's own refusal reads "You
   * are not a db or server admin", and a database admin is one — that capability is
   * {@link canWriteDb}, which both {@link _renderDocActions} and {@link _updateHeaderActions} use.
   * Browsing and opening design docs read-only needs neither: `_design_docs` and `GET _design/*`
   * both answer 200 for a plain db member.
   */
  private get isAdmin(): boolean {
    return getContext().auth.isAdmin;
  }

  /**
   * Each action is gated on the capability CouchDB itself demands of it, which is not the same
   * capability for all three: connecting an account and registering a repository write
   * `couchcompanion` (server-admin-only, like {@link _renderSyncButtons}), while creating a design
   * document is a `PUT /{db}/_design/x` that a *database* admin may perform too — the
   * {@link canWriteDb} probe the footer's "Create New" button already uses
   * ({@link _renderDocActions}). One `!isAdmin` gate over the whole list meant a database admin
   * got that footer button and an empty header, for the same operation.
   *
   * A user with none of those capabilities gets no header at all rather than an empty one, and the
   * footer's explanatory note (see render()) is what tells them why.
   */
  private _updateHeaderActions() {
    // Lit keeps updating a disconnected element, and disconnectedCallback has already handed the
    // header over to whatever screen replaced this one — `canWriteDb` in particular resolves after
    // an await, so this can be reached from a promise that outlives the component.
    if (!this.isConnected) return;

    clearHeaderActions();

    const actions: Array<{
      icon: string;
      tooltip: string;
      variant?: 'neutral' | 'brand';
      action: () => void;
    }> = [];

    // #49: every header action needs a database. Connecting an account used to be the
    // exception — it is not database-scoped, so it was pushed unconditionally — but from
    // this screen there is nothing to do with an account until a database is chosen, and a
    // lone button over an empty table reads as "this screen is broken". The provider icons
    // in _renderGitRepoDisplay remain the other way in, so this hides a duplicate path
    // rather than the only one.
    if (this.selectedServer && this.selectedDatabase) {
      if (this.isAdmin) {
        actions.push({
          icon: 'code-branch',
          tooltip: 'Connect Git Account',
          variant: 'neutral',
          action: () => this._openProviderDialog()
        });
      }

      // Only show Register Repo if no git repo is registered yet
      if (this.isAdmin && !this.repoId) {
        actions.push({
          icon: 'folder-tree',
          tooltip: 'Register Repository',
          variant: 'neutral',
          action: () => this._openRegisterRepoDialog()
        });
      }

      if (this.canWriteDb) {
        actions.push({
          icon: 'circle-plus',
          tooltip: 'Create Design Doc',
          action: () => this._openCreateDocDialog()
        });
      }
    }

    if (actions.length > 0) addHeaderActions(actions);
  }

  private _openProviderDialog() {
    this.providerDialogForRegistration = false;
    this.showProviderDialog = true;
  }

  private _getConnectDialogState(): ConnectGitDialogState {
    return {
      showProviderDialog: this.showProviderDialog,
      showConnectAccountDialog: this.showConnectAccountDialog,
      connectProvider: this.connectProvider,
      connectLabel: this.connectLabel,
      connectUsername: this.connectUsername,
      connectToken: this.connectToken,
      connectBaseUrl: this.connectBaseUrl,
      connectingAccount: this.connectingAccount,
      credentialMode: this.connectCredentialMode
    };
  }

  private _resetConnectDialog() {
    this.showConnectAccountDialog = false;
    this.connectProvider = null;
    this.connectLabel = '';
    this.connectUsername = '';
    this.connectToken = '';
    this.connectBaseUrl = '';
    this.connectingAccount = false;
    this.connectCredentialMode = 'none';
  }

  private _getConnectDialogCallbacks(): ConnectGitDialogCallbacks {
    return {
      onRequestClose: () => this._resetConnectDialog(),
      onSelectProvider: (provider) => this._selectProvider(provider),
      onConnectClick: async () => {
        const label = this.connectLabel.trim();
        const token = this.connectToken.trim();
        const username = this.connectUsername.trim();

        if (!label || !token) {
          toast('Account label and access token are required', 'error');
          return;
        }

        if (this.connectProvider === 'bitbucket' && !username) {
          toast('Atlassian email is required for Bitbucket', 'error');
          return;
        }

        this.connectingAccount = true;
        try {
          await getContext().designMgmt.postGitAccounts({
            provider: this.connectProvider!,
            label,
            username: this.connectProvider === 'bitbucket' ? username : null,
            token,
            base_url: this.connectBaseUrl.trim() || null,
            // credential_mode is loose on the wire (D6 froze ConnectGitAccountRequest before D12's
            // three-way choice existed) — see DesignMgmtService.postGitAccounts's own comment.
            credential_mode: this.connectCredentialMode
          } as ConnectGitAccountRequest & { credential_mode: CredentialMode });

          const providerName = this.connectProvider === 'github' ? 'GitHub' :
                               this.connectProvider === 'gitlab' ? 'GitLab' : 'Bitbucket';
          toast(`Connected ${providerName} account successfully`, 'success');
          this._resetConnectDialog();
          // Reload accounts
          const allAccounts = await getContext().designMgmt.getGitAccounts();
          this.gitAccounts = allAccounts;
        } catch (error) {
          log.error('Failed to connect git account', error as Error);
          // See `blockedRequestAdvice` — a request the browser refused to send has no network-tab
          // entry to inspect, and the advice depends on who wrote the page's policy (#28).
          toast(
            `Failed to connect account: ${(error as Error).message}${blockedRequestAdvice(error)}`,
            'error'
          );
        } finally {
          this.connectingAccount = false;
        }
      },
      onCancelClick: () => this._resetConnectDialog(),
      onLabelChange: (value) => {
        this.connectLabel = value;
      },
      onUsernameChange: (value) => {
        this.connectUsername = value;
      },
      onTokenChange: (value) => {
        this.connectToken = value;
      },
      onBaseUrlChange: (value) => {
        this.connectBaseUrl = value;
      },
      onCredentialModeChange: (mode) => {
        this.connectCredentialMode = mode;
      }
    };
  }

  /**
   * One provider picker serves two header actions, and which one opened it decides where the
   * click goes: "Register Repository" wants the repository drawer (pick an account, then a repo),
   * "Connect Git Account" wants the connect-account form.
   *
   * The dialog's `onSelectProvider` callback used to skip this branch and always open the connect
   * form, while the branch itself sat here with no caller in `src/` at all — reachable only from
   * the two tests that claimed to cover it. An admin who had already connected an account and
   * clicked "Register Repository" was asked to connect a second one.
   */
  private _selectProvider(provider: 'github' | 'gitlab' | 'bitbucket') {
    this.showProviderDialog = false;
    if (this.providerDialogForRegistration) {
      void this.openAccountDrawer(provider);
      return;
    }
    this.connectProvider = provider;
    this.showConnectAccountDialog = true;
  }

  private _openRegisterRepoDialog() {
    // Server and database are guaranteed to be selected at this point
    // because the button is only shown when both are selected
    this.providerDialogForRegistration = true;
    this.showProviderDialog = true;
  }

  private _openCreateDocDialog() {
    if (!this.selectedServer || !this.selectedDatabase) {
      toast('Please select a server and database first', 'error');
      return;
    }
    
    this.launchDocEditor({
      detail: {
        server_id: this.selectedServer,
        db_name: this.selectedDatabase,
        ddoc_id: '_new'
      }
    } as CustomEvent<TrackedDesignDoc>);
  }

  private handleDocCheckboxChange(event: Event, doc: TrackedDesignDoc) {
    const checkbox = event.target as HTMLInputElement;
    const key = docKey(doc);

    if (checkbox.checked) {
      this.selectedDocs.add(key);
    } else {
      this.selectedDocs.delete(key);
    }

    this.requestUpdate();
  }

  private handleSelectAll(event: Event) {
    const checkbox = event.target as HTMLInputElement;
    if (checkbox.checked) {
      this.filteredDocs.forEach((d) => this.selectedDocs.add(docKey(d)));
    } else {
      this.filteredDocs.forEach((d) => this.selectedDocs.delete(docKey(d)));
    }
    this.requestUpdate();
  }

  private launchDocEditor(event: CustomEvent<TrackedDesignDoc>) {
    const doc = event.detail;
    const serverId = encodeURIComponent(doc.server_id || '$all');
    const dbName = encodeURIComponent(doc.db_name);
    const ddocId = encodeURIComponent(doc.ddoc_id);
    getContext().router.navigate(`/design-docs/${serverId}/editor/${dbName}/${ddocId}`);
  }

  private syncIndicator(sync_status: string) {
    const { symbol, tooltip } =
      CcaDesignList.SYNC_INDICATORS[sync_status] ?? { symbol: '●', tooltip: 'Not Synced' };
    return html`<span title=${tooltip}>${symbol}</span>`;
  }

  /** Refreshes `this.docs` from the currently-loaded couch/git lists via the exported {@link buildDDocs}. */
  private refreshDocs(): TrackedDesignDoc[] {
    this.docs = buildDDocs(this.couchDDocs, this.gitDDocs, this.selectedServer, this.selectedDatabase);
    return this.docs;
  }

  private get accountConnectionFields(): FormFieldDef[] {
    const baseFields: FormFieldDef[] = [
      {
        key: 'label',
        label: 'Account Label',
        required: true,
        placeholder: 'e.g., work-github'
      }
    ];

    // Bitbucket requires username (Atlassian email)
    if (this.gitProvider === 'bitbucket') {
      baseFields.push({
        key: 'username',
        label: 'Atlassian Email',
        type: 'email',
        required: true,
        placeholder: 'user@example.com'
      });
    }

    baseFields.push({
      key: 'token',
      label: 'Access Token',
      type: 'password',
      required: true,
      placeholder: this._getTokenPlaceholder()
    });

    baseFields.push({
      key: 'base_url',
      label: 'Base URL (for self-hosted)',
      placeholder: this._getBaseUrlPlaceholder()
    });

    return baseFields;
  }

  private get repoRegistrationFields(): FormFieldDef[] {
    // Note: Repository and branch selection is handled separately in the template with wa-combobox
    // These are the additional fields after repo selection
    const pathField: FormFieldDef = {
      key: 'path',
      label: 'Design Root Path',
      placeholder: '/'
    };
    
    // Populate with current value when in manage mode
    if (this.manageMode && this.currentPath) {
      pathField.defaultValue = this.currentPath;
    }
    
    return [pathField];
  }

  /**
   * Filter mutations reset the selection, like the server/database switches
   * do — otherwise rows selected, then hidden by a narrower query, would
   * still be swept up by the bulk sync/delete actions while invisible.
   */
  private setSearchText(value: string) {
    if (value === this.searchText) return;
    this.searchText = value;
    this.selectedDocs = new Set();
  }

  private get filteredDocs() {
    if (!this.selectedServer || !this.selectedDatabase) {
      return [];
    }

    const q = this.searchText.trim().toLowerCase();
    return this.docs.filter((doc) => {
      const serverMatch = doc.server_id === this.selectedServer;
      const dbMatch = doc.db_name === this.selectedDatabase;
      const textMatch = !q || doc.ddoc_id.toLowerCase().includes(q);
      return serverMatch && dbMatch && textMatch;
    });
  }

  private get _drawerLabel(): string {
    if (this.manageMode) return 'Manage Repository';
    if (this.selectedAccountId) return 'Register Repository';
    const provider = this.gitProvider
      ? this.gitProvider.charAt(0).toUpperCase() + this.gitProvider.slice(1)
      : 'Git';
    return `Connect ${provider} Account`;
  }

  private _getTokenPlaceholder(): string {
    return this.TOKEN_PLACEHOLDERS[this.gitProvider as keyof typeof this.TOKEN_PLACEHOLDERS] ?? 'API token';
  }

  private _getBaseUrlPlaceholder(): string {
    return this.BASE_URL_PLACEHOLDERS[this.gitProvider as keyof typeof this.BASE_URL_PLACEHOLDERS] ?? 'https://git.example.com';
  }

  private _renderGitRepoDisplay() {
    if (this.repoId) {
      // #49: the repository is a control, so it now looks like one. It used to be plain text
      // beside a bare `pen-to-square` glyph — the whole row was the same weight as the
      // read-only "Design Root" field next to it, and the only affordance was an unlabelled
      // icon. A non-admin still gets static text, because for them there is nothing to open.
      if (!this.isAdmin) {
        return html`
          <wa-icon class="git-provider" name="${this.gitProvider}" family="brands" style="font-size: var(--wa-font-size-larger);"></wa-icon>
          <span>${this.repoName}</span>
        `;
      }
      return html`
        <wa-tooltip for="update-repo" placement="right">Manage repository</wa-tooltip>
        <wa-button
          id="update-repo"
          appearance="outlined"
          size="small"
          data-testid="manage-repo"
          @click=${() => this.openManageRepoDrawer()}>
          <wa-icon slot="prefix" class="git-provider" name="${this.gitProvider}" family="brands"></wa-icon>
          ${this.repoName}
          <wa-icon slot="suffix" name="pen-to-square"></wa-icon>
        </wa-button>
      `;
    }
    // Nothing to click when not an admin — connecting an account writes couchcompanion.
    if (!this.isAdmin) return '';
    // Only the providers that actually work (D11 — `SUPPORTED_PROVIDERS`, the same list the
    // provider dialog offers). This row used to offer GitHub, Bitbucket and GitLab alike: picking
    // one of the latter two *persisted* a `gitaccount:` document with no validation, then failed
    // with "not supported yet" the moment anything tried to use it — and with no account-edit or
    // account-delete screen reachable from here, that dead account could not be removed.
    return html`
      ${SUPPORTED_PROVIDERS.map(
        (provider) => html`
          <wa-icon name=${provider} family="brands" style="font-size: var(--wa-font-size-larger);" @click=${() => this.openAccountDrawer(provider)}></wa-icon>
        `
      )}
    `;
  }

  /**
   * The conflict viewer (`/design-docs/:serverId/conflicts`) has no nav entry and, until this, no
   * inbound link anywhere — a conflict was discoverable only by already knowing the URL. Shown
   * whenever any doc currently in view is flagged `conflict`.
   *
   * In practice this only ever fires for an admin: a `conflict` status requires both `ddoc_rev`
   * (from the sync-state lookup) and a git-sourced row, and both come from `couchcompanion` reads
   * this component already skips for a non-admin (see `loadDesignDocs`/`getDesignDocsFromRepo`) —
   * not a separate gate on this banner, just a consequence of the same admin-only store upstream.
   * The conflict viewer itself is admin-gated too, so even a bookmarked link degrades cleanly.
   */
  private _renderConflictBanner() {
    const count = this.filteredDocs.filter((d) => d.sync_status === 'conflict').length;
    if (count === 0) return '';
    const target = `/design-docs/${encodeURIComponent(this.selectedServer || '$all')}/conflicts`;
    return html`
      <wa-callout class="conflict-banner" variant="danger" appearance="outlined" data-conflict-link>
        <wa-icon slot="icon" name="triangle-exclamation"></wa-icon>
        ${count} design document${count === 1 ? ' has' : 's have'} a sync conflict.
        <a
          href=${target}
          @click=${(e: Event) => {
            e.preventDefault();
            getContext().router.navigate(target);
          }}
          >Review conflicts</a
        >
      </wa-callout>
    `;
  }

  /**
   * Says on screen that the repository listing was capped. The service has always logged this, but
   * a `log.warn` nobody renders is exactly the "silently reads as 'that's everything'" outcome the
   * cap exists to avoid — so the count, and the first few names, go in front of the user.
   */
  private _renderRepoTruncationNotice() {
    const info = this.repoDocsTruncation;
    if (!info) return '';
    const names = info.droppedPaths
      .slice(0, 3)
      .map((p) => p.split('/').pop()?.replace(/\.json$/, '') ?? p);
    const rest = info.droppedPaths.length - names.length;
    return html`
      <wa-callout class="conflict-banner" variant="warning" appearance="outlined" data-repo-truncated>
        <wa-icon slot="icon" name="triangle-exclamation"></wa-icon>
        Showing ${info.shown} of ${info.total} design documents found in the repository — each file
        is a separate API call against GitHub's rate limit. Not shown:
        ${names.join(', ')}${rest > 0 ? `, and ${rest} more` : ''}.
      </wa-callout>
    `;
  }

  private _renderTableLoadingOverlay() {
    if (!this.tableLoading) return '';
    return html`
      <div
        style="position: absolute; inset: 0; background: var(--wa-color-fill-quiet); opacity: 0.95;
          display: flex; align-items: center; justify-content: center;
          z-index: 10; border-radius: 0.5rem;">
        <wa-spinner size="l"></wa-spinner>
      </div>
    `;
  }

  private _renderAccountDrawerContent() {
    if (this.loadingAccounts) {
      return html`<wa-spinner></wa-spinner>`;
    }
    if (this.showAccountForm || this.gitAccounts.length === 0) {
      return this._renderAccountForm();
    }
    if (!this.selectedAccountId) {
      return this._renderAccountSelection();
    }
    return this._renderRepoSelection();
  }

  /**
   * The drawer's "connect a new account" form. The credential-mode choice is rendered *above* the
   * `cca-form` rather than as one of its `FormFieldDef`s: `cca-form` has no radio-group field
   * type, and D12's whole point is that the user sees each option's trade-off stated in full —
   * which is what {@link renderCredentialModePicker} does, sharing its copy with
   * `CREDENTIAL_MODE_COPY` so the promise cannot drift from the implementation.
   *
   * Without it, every account created through this drawer was silently forced to mode `none` with
   * no disclosure at all, while the same app's other entry point asked.
   */
  private _renderAccountForm() {
    return html`
      <div style="margin-bottom: 1rem;">
        ${renderCredentialModePicker(this._getConnectDialogState(), this._getConnectDialogCallbacks())}
      </div>
      <cca-form
        .fields=${this.accountConnectionFields}
        submit-label="Connect"
        cancel-label="Cancel"
        @cca-form-cancel=${() => {
          this.showGitDrawer = false;
          this.showAccountForm = false;
        }}
        @cca-form-submit=${this.handleAccountConnect}></cca-form>
    `;
  }

  private _renderAccountSelection() {
    return html`
      <p>Select an existing account or connect a new one:</p>
      <wa-select
        placeholder="Select account"
        @change=${(e: Event) => {
          const select = e.target as HTMLSelectElement;
          this.selectedAccountId = select.value;
          void this.loadReposForAccount(select.value);
        }}>
        ${this.gitAccounts.map(
          (account) => html`
            <wa-option value=${account._id}>${account.label} (${account.provider})</wa-option>
          `
        )}
      </wa-select>
      <wa-button
        appearance="filled-outlined"
        style="margin-top: 1rem;"
        @click=${() => {
          this.showAccountForm = true;
        }}>
        + Connect New Account
      </wa-button>
    `;
  }

  private _renderRepoSelection() {
    return html`
      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 1rem;">
        <p style="margin: 0;">
          Account: <strong>${this.gitAccounts.find(a => a._id === this.selectedAccountId)?.label}</strong>
        </p>
        <wa-button
          size="s"
          @click=${() => {
            this.selectedAccountId = null;
            this.availableRepos = [];
          }}>
          Change Account
        </wa-button>
      </div>
      ${this._renderOwnerSelection()}
      ${this._renderRepoDropdown()}
      ${this._renderBranchSelection()}
      <cca-form
        class="${this.manageMode && !this.hasRepoChanges ? 'no-changes' : ''}"
        .fields=${this.repoRegistrationFields}
        submit-label="${this.manageMode ? 'Update' : 'Register'}"
        cancel-label="Cancel"
        @cca-form-cancel=${() => {
          this.showGitDrawer = false;
          this.selectedAccountId = null;
          this.availableRepos = [];
        }}
        @cca-form-submit=${this.manageMode ? this.handleRepoUpdate : this.handleRepoRegister}></cca-form>
      ${this.manageMode ? html`
        <wa-button
          appearance="outlined"
          variant="danger"
          style="margin-top: 1rem; width: 100%;"
          @click=${() => { this.showUnlinkConfirm = true; }}>
          Unlink Repository
        </wa-button>
      ` : ''}
    `;
  }

  private _renderOwnerSelection() {
    const account = this.gitAccounts.find(a => a._id === this.selectedAccountId);
    const provider = account?.provider;
    
    if (!CcaDesignList.usesOwnerFiltering(provider)) {
      return '';
    }
    
    if (this.repoOwners.length === 0) {
      return '';
    }

    const label = provider === 'bitbucket' ? 'Workspace' : 'Owner/Organization';

    return html`
      <div style="margin-bottom: 1rem;">
        <label>${label}</label>
        <wa-select
          name="org"
          placeholder="Select ${label.toLowerCase()}"
          value=${this.selectedOwner || ''}
          @change=${this.handleOwnerSelect}>
          ${this.repoOwners.map(
            (owner) => html`<wa-option value=${owner}>${owner}</wa-option>`
          )}
        </wa-select>
      </div>
    `;
  }

  private _renderRepoDropdown() {
    if (this.loadingRepos) {
      return html`<wa-spinner></wa-spinner>`;
    }
    if (this.availableRepos.length === 0) {
      return html`<p>No repositories found for this account.</p>`;
    }
    return html`
      <div style="margin-bottom: 1rem;">
        <label>Repository</label>
        <wa-select
          name="repo"
          placeholder="Select repository"
          value=${this.selectedRepo?.clone_url || ''}
          ?disabled=${this._isRepoSelectDisabled()}
          @change=${this.handleRepoSelect}>
          ${this._getFilteredRepoOptions()}
        </wa-select>
      </div>
    `;
  }

  private _isRepoSelectDisabled(): boolean {
    const account = this.gitAccounts.find(a => a._id === this.selectedAccountId);
    const provider = account?.provider;
    return CcaDesignList.usesOwnerFiltering(provider) && !this.selectedOwner;
  }

  private _getFilteredRepoOptions() {
    const account = this.gitAccounts.find(a => a._id === this.selectedAccountId);
    const provider = account?.provider;
    
    const filteredRepos = CcaDesignList.usesOwnerFiltering(provider)
      ? this.availableRepos.filter(repo => repo.full_name?.split('/')[0] === this.selectedOwner)
      : this.availableRepos;
    
    return filteredRepos.map(repo => {
      const displayName = this._getRepoDisplayName(repo, provider);
      return html`
        <wa-option value=${repo.clone_url}>
          ${displayName}${repo.private ? ' 🔒' : ''}
        </wa-option>
      `;
    });
  }

  private _getRepoDisplayName(repo: RemoteRepo, provider: string | undefined): string {
    if (CcaDesignList.usesOwnerFiltering(provider) && this.selectedOwner) {
      return repo.full_name?.split('/')[1] || repo.full_name || '';
    }
    return repo.full_name || '';
  }

  private _renderBranchSelection() {
    if (!this.selectedRepo) {
      return '';
    }
    const branchValue = this.manageMode && this.currentBranch 
      ? this.currentBranch 
      : (this.selectedRepo?.default_branch || '');
    return html`
      <div style="margin-bottom: 1rem;">
        <label>Branch</label>
        <wa-select
          name="branch"
          placeholder="Select branch"
          value=${branchValue}
          ?disabled=${!this.selectedRepo}
          @change=${this.handleBranchSelect}>
          ${this.repoBranches.map(
            (branch) => html`<wa-option value=${branch}>${branch}</wa-option>`
          )}
        </wa-select>
      </div>
    `;
  }

  /**
   * Sync writes `couchcompanion` sync-state docs, which is server-admin-only regardless of any
   * per-database `_security` (D9) — unlike {@link _renderDocActions}, a database admin does not
   * help here, so this stays on {@link isAdmin} and the copy says "server administrator", not the
   * broader "database or server administrator".
   */
  private _renderSyncButtons() {
    if (!this.isAdmin) {
      return html`<span class="admin-only-note">Only a server administrator can sync design documents with git.</span>`;
    }
    // #49: both directions need a registered repository, so neither button is offered
    // without one — pressing "Sync to Repo" with no `repoId` only ever produced a toast.
    //
    // The admin check stays *above* this deliberately. `repoId` is populated from
    // `couchcompanion`, which is server-admin-only (D9), so a non-admin's `repoId` is
    // always null; folding the two checks together would swallow the explanatory note for
    // every non-admin and leave them an unexplained empty footer.
    if (!this.selectedDatabase || !this.repoId) return '';
    const isSyncing = this.syncingrepo || this.syncingcouch;
    return html`
      <wa-button
        type="submit"
        appearance="filled"
        data-testid="sync-to-repo"
        ?disabled=${isSyncing}
        @click=${this.handleSyncToRepo}>
        ${this.syncingrepo ? html`<wa-spinner slot="prefix" style="--size:1em"></wa-spinner> Syncing…` : 'Sync to Repo'}
      </wa-button>
      <wa-button
        type="submit"
        appearance="filled"
        data-testid="sync-to-couch"
        ?disabled=${isSyncing}
        @click=${this.handleSyncToCouchDB}>
        ${this.syncingcouch ? html`<wa-spinner slot="prefix" style="--size:1em"></wa-spinner> Syncing…` : 'Sync to CouchDB'}
      </wa-button>
    `;
  }

  /**
   * Create/delete both `PUT`/`DELETE` a design document, which CouchDB restricts to a *database*
   * admin (named in `{db}/_security.admins`) or a server admin — not the narrower `couchcompanion`
   * (server-admin-only) gate {@link _renderSyncButtons} uses. Gated on {@link canWriteDb}, not
   * {@link isAdmin}: a legitimate per-database admin without the `_admin` server role is exactly
   * who CouchDB itself would let through here.
   */
  private _renderDocActions() {
    if (!this.canWriteDb) {
      return html`<span class="admin-only-note">Only a database or server administrator can create or delete design documents. Browsing and opening them is unaffected.</span>`;
    }
    return html`
      ${this.selectedDocs.size > 0
        ? html`
            <wa-button-group label="Delete Button Group">
              ${this._renderDeleteActions()}
            </wa-button-group>
          `
        : ''}
      <wa-button type="submit" appearance="filled" @click=${this.handleCreateDesignDoc}>
        <wa-icon name="file-circle-plus" style="font-size: var(--wa-font-size-larger)"></wa-icon>
        Create New</wa-button>
      <wa-button
        type="submit"
        appearance="filled"
        data-testid="create-index"
        @click=${this.handleCreateIndex}>
        <wa-icon name="list-check" style="font-size: var(--wa-font-size-larger)"></wa-icon>
        Create Index</wa-button>
    `;
  }

  private _renderDeleteActions() {
    const { syncedCount, couchCount, gitCount } = this._getDeleteCounts();
    const isSyncing = this.syncingrepo || this.syncingcouch;

    return html`
      <wa-button 
        appearance="filled"
        ?disabled=${isSyncing || syncedCount === 0}
        @click=${() => this.prepareDelete('both')}>
        <wa-icon name="trash" style="font-size: 1.2em"></wa-icon> Delete
      </wa-button>
      <wa-dropdown>
        <wa-button 
          appearance="filled" 
          slot="trigger"
          ?disabled=${isSyncing}>
          <wa-icon name="chevron-down" label="More options" style="font-size: 1.2em" ></wa-icon>
        </wa-button>
        <wa-dropdown-item 
          ?disabled=${couchCount === 0}
          @click=${() => this.prepareDelete('couch')}>
          Delete from CouchDB (${couchCount})
        </wa-dropdown-item>
        <wa-dropdown-item 
          ?disabled=${gitCount === 0}
          @click=${() => this.prepareDelete('git')}>
          Delete from Git (${gitCount})
        </wa-dropdown-item>
      </wa-dropdown>
    `;
  }

  /**
   * Splits the current selection into three **disjoint** groups, named for what a document *is*
   * rather than for which side happens to have a copy of it.
   *
   * The previous names (`couch`/`git`/`synced`) were overlapping sets — `git` was a superset of
   * `synced` — and that overlap was not a cosmetic problem: `prepareDelete('both')` built its
   * confirmation list from `synced` while `handleDeleteByMode('both')` deleted `git`, so selecting
   * three synced documents plus two git-only ones produced a dialog naming three documents and a
   * commit deleting five. Inert while `deleteRepoDocs` hit a `/api` route that does not exist in
   * this fork; a real GitHub commit since Task 6. Disjoint groups make that class of mistake
   * unrepresentable — every caller now has to say explicitly which groups it acts on, via
   * {@link _deleteTargets}.
   */
  private _partitionSelectedDocs() {
    const selected = Array.from(this.selectedDocs)
      .map(key => this.docs.find(d => docKey(d) === key))
      .filter(Boolean) as TrackedDesignDoc[];
    const inCouch = (d: TrackedDesignDoc) => Boolean(d.rev);
    const inGit = (d: TrackedDesignDoc) => Boolean(d.last_git_sha);
    return {
      /** Selected, and present only in CouchDB — there is no repository file to delete. */
      couchOnly: selected.filter(d => inCouch(d) && !inGit(d)),
      /** Selected, and present only in the repository — there is no CouchDB document to delete. */
      gitOnly: selected.filter(d => !inCouch(d) && inGit(d)),
      /** Selected, and present on both sides — the only group "Delete from both" may ever act on. */
      synced: selected.filter(d => inCouch(d) && inGit(d))
    };
  }

  /**
   * The documents a given delete mode acts on, per side. The single source of truth shared by the
   * button counts, the confirmation dialog and the delete itself, so the three can no longer
   * disagree about what is about to be removed.
   */
  private _deleteTargets(mode: 'couch' | 'git' | 'both'): {
    couch: TrackedDesignDoc[];
    git: TrackedDesignDoc[];
  } {
    const { couchOnly, gitOnly, synced } = this._partitionSelectedDocs();
    if (mode === 'couch') return { couch: [...couchOnly, ...synced], git: [] };
    if (mode === 'git') return { couch: [], git: [...gitOnly, ...synced] };
    return { couch: synced, git: synced };
  }

  /**
   * The selected documents a given mode leaves alone — the complement of {@link _deleteTargets}
   * over the same selection.
   *
   * `'both'` acts on the `synced` group only, which is right (there is no CouchDB document to
   * delete for a git-only entry, and no repository file for a couch-only one), but its button
   * enables whenever *anything* synced is selected. Selecting three synced documents plus two
   * git-only ones and pressing Delete therefore deleted three and cleared all five from the
   * selection, so the two survivors read as handled. Naming them lets the confirmation say what it
   * will not touch, and lets the delete leave them selected.
   */
  private _deleteSkipped(mode: 'couch' | 'git' | 'both'): TrackedDesignDoc[] {
    const { couchOnly, gitOnly } = this._partitionSelectedDocs();
    if (mode === 'couch') return gitOnly;
    if (mode === 'git') return couchOnly;
    return [...couchOnly, ...gitOnly];
  }

  private _getDeleteCounts() {
    const { couchOnly, gitOnly, synced } = this._partitionSelectedDocs();
    return {
      syncedCount: synced.length,
      couchCount: couchOnly.length + synced.length,
      gitCount: gitOnly.length + synced.length
    };
  }

  /**
   * Resolves {@link canWriteDb} for `selectedServer`/`selectedDatabase`. Server admin short-
   * circuits without a request (`isAdmin` already implies write access everywhere); otherwise
   * reads `{db}/_security` and checks whether the current user is named — by username or by a
   * shared role — as a *database* admin of it (`isDatabaseAdmin`), which CouchDB treats as
   * sufficient to `PUT` a design document even without the `_admin` server role. A failed read
   * (network error, or the database itself briefly unavailable) is treated as "cannot confirm,
   * so no" rather than defaulting to permissive.
   */
  private async refreshCanWriteDb(): Promise<void> {
    if (this.isAdmin) {
      this.canWriteDb = true;
      return;
    }
    if (!this.selectedServer || !this.selectedDatabase) {
      this.canWriteDb = false;
      return;
    }
    const server = this.selectedServer;
    const database = this.selectedDatabase;
    try {
      const access = await getContext().dbMgmt.listDatabaseAccess(server, database);
      // A slower request racing a newer selection must not stomp the current answer.
      if (server !== this.selectedServer || database !== this.selectedDatabase) return;
      const { username, roles } = getContext().auth.state;
      this.canWriteDb = isDatabaseAdmin(access, username, roles);
    } catch (error) {
      if (server !== this.selectedServer || database !== this.selectedDatabase) return;
      log.warn('Could not read database access control; treating as read-only', error instanceof Error ? error : { error });
      this.canWriteDb = false;
    }
  }

  /**
   * Whether a `?database=` taken from the URL may be opened directly.
   *
   * The membership test this replaces (`this.databases.includes(...)`) existed because the URL is
   * not authoritative and the fetched list is: a stale bookmark or a hand-edited link could name a
   * database that is not on this server, and opening it anyway commits the name to
   * `selectedDatabase`, fires `loadDesignDocs`, and offers header actions ("Create Design Doc")
   * against something that does not exist. That protection is kept exactly where it applies — when
   * the server has told us what its databases are, a name it did not list is still refused.
   *
   * What it must not do is refuse for lack of evidence. `databases` is also empty when `_all_dbs`
   * was denied (the common non-admin case) or when it simply was not fetched, and treating "we do
   * not know" as "it does not exist" silently killed the one route into this screen a non-admin
   * had. With no list, nothing here contradicts the URL, so the request goes ahead and CouchDB
   * itself gives the verdict — 200 for a member, 403/404 otherwise, each with its own wording from
   * `describeDbAccessError`.
   */
  private _mayOpenFromUrl(dbName: string): boolean {
    return this.databases.length === 0 || this.databases.includes(dbName);
  }

  private async loadDatabasesForServer(serverId: string) {
    this.selectedServer = serverId;
    this.selectedDatabase = '';
    this.databases = [];
    this.databaseListDenied = false;
    this.databaseListDenialReason = '';
    this.gitUrl = '';
    this.repoId = null;
    this.repoAccountId = null;
    this.canWriteDb = false;
    this.selectedDocs = new Set();

    if (serverId) {
      try {
        const infos = await getContext().serverMgmt.getDatabases(serverId);
        this.databases = infos.map((db) => db.db_name ?? '').filter(Boolean);
      } catch (error) {
        this.databases = [];
        // A refusal is not a fault: every per-database screen below still answers 200 for a member
        // (verified on CouchDB 3.5.2), so the only thing lost is the list of names. The picker
        // asks for one instead — a toast here would report a broken server for a working one.
        if (isEnumerationDenied(error)) {
          this.databaseListDenied = true;
          this.databaseListDenialReason = describeDbAccessError(error);
        } else {
          toast(`Failed to load databases: ${error}`, 'error');
        }
      }
    } else {
      this.databases = [];
    }
    this._updateHeaderActions();
  }

  private async selectDatabase(dbName: string) {
    this.selectedDatabase = dbName;
    this.gitProvider = null;
    this.repoId = null;
    this.repoAccountId = null;
    this.gitUrl = '';
    this.gitDDocs = [];
    this.selectedDocs = new Set();
    // "Create Design Doc" is gated on canWriteDb, and for anyone but a server admin that answer
    // arrives from `{db}/_security` an await later — so the header is recomputed when it lands,
    // not only at this synchronous point where it is still the previous database's answer.
    void this.refreshCanWriteDb().then(() => this._updateHeaderActions());

    // Update header actions immediately when server+db are selected
    this._updateHeaderActions();

    if (this.selectedServer && this.selectedDatabase) {
      await this.loadDesignDocs();
      // Update again after loading design docs (repoId may have changed)
      this._updateHeaderActions();
    }
  }

  private async handleDatabaseChange(event: CustomEvent<CcaDbChangeDetail>) {
    // cca-db-picker commits on `change` (blur/Enter), never per keystroke, so this runs once per
    // database the user actually settles on rather than once per typed letter.
    await this.selectDatabase(event.detail.database);
  }

  private async loadDesignDocs(): Promise<void> {
    this.tableLoading = true;
    try {
      // Repo/git lookups all read `couchcompanion`, which is admin-only (D9) — a non-admin gets a
      // guaranteed 403 from both, so skip them rather than surface a "Failed to load" toast for
      // something that was never going to work. The design-doc table itself still loads below.
      if (this.isAdmin) {
        if (!this.repoId) await this.getRepoForTarget();
        if (this.repoId) await this.getDesignDocsFromRepo(this.repoId);
      }
      await this.getDesignDocsFromCouchDB();
      this.refreshDocs();
    } finally {
      this.tableLoading = false;
    }
  }

  private async getRepoForTarget(): Promise<void> {
    try {
      const { repo } = await getContext().designMgmt.getRepo(this.selectedServer, this.selectedDatabase);
      log.info('Fetched repo for target', { repo });
      if (!repo) {
        this.repoId = null;
        this.repoAccountId = null;
        return;
      }
      this.repoId = repo._id ?? null;
      this.repoAccountId = repo.account_id ?? null;
      this.gitUrl = repo.url ?? '';
      this.repoName = repo.name ?? null;
      this.gitProvider = repo.provider ?? null;
      const matchingTarget = repo.sync_targets?.find(
        t => t.server_id === this.selectedServer && t.db_name === this.selectedDatabase
      );
      this.designRoot = matchingTarget?.path ?? '';
      this.repoBranch = matchingTarget?.branch ?? '';
    } catch (error) {
      log.error('Failed to look up repo for target', error as Error);
    }
  }

  /**
   * Errors used to be swallowed into `log.error` only — the git column would just stay empty with
   * no signal to the user that anything failed (as opposed to "this repository has no design
   * docs"). A toast makes the two cases distinguishable.
   *
   * Wrapped in {@link withTokenRetry} (fix round 1) — this is the page-load path, and credential
   * mode `none`'s whole point is a token that does not survive a reload: without this, a reloaded
   * tab hit an unrecoverable "Bad credentials" toast on every load with no way to recover short of
   * reopening the Register Repository drawer.
   */
  private async getDesignDocsFromRepo(repoId: string): Promise<void> {
    this.repoDocsTruncation = null;
    try {
      this.gitDDocs = await this.withTokenRetry(this.repoAccountId, () =>
        getContext().designMgmt.getRepoDocs(repoId, this.selectedDatabase, (info) => {
          this.repoDocsTruncation = info;
        })
      );
    } catch (error) {
      log.error('Failed to load git design docs', error as Error);
      this.gitDDocs = [];
      toast(`Could not load git status for design documents: ${(error as Error).message || UNKNOWN_ERROR}`, 'error');
    }
  }

  private async getDesignDocsFromCouchDB() {
    try {
      this.couchDDocs = await getContext().designMgmt.listDesignDocs(this.selectedServer, this.selectedDatabase);
    } catch (error) {
      log.error('Failed to load design docs', error as Error);
    }
  }

  // Git Connection Drawer Methods
  private async openAccountDrawer(provider: string) {
    this.gitProvider = provider;
    this.loadingAccounts = true;
    this.showGitDrawer = true;
    this.selectedAccountId = null;
    this.availableRepos = [];
    this.manageMode = false;
    this.currentBranch = null;
    this.currentPath = null;

    try {
      // Load all accounts and filter by provider
      const allAccounts = await getContext().designMgmt.getGitAccounts();
      this.gitAccounts = allAccounts.filter((acc) => acc.provider === provider);

      // If no accounts exist, show the form immediately
      this.showAccountForm = this.gitAccounts.length === 0;
    } catch (error) {
      log.error('Failed to load git accounts', error as Error);
      toast(`Failed to load accounts: ${(error as Error).message}`, 'error');
      this.gitAccounts = [];
      this.showAccountForm = true;
    } finally {
      this.loadingAccounts = false;
    }
  }

  private async openManageRepoDrawer() {
    if (!this.repoId || !this.gitProvider) {
      toast('No repository connected', 'error');
      return;
    }

    this.manageMode = true;
    this.loadingAccounts = true;
    this.showGitDrawer = true;
    this.hasRepoChanges = false;

    try {
      // Fetch the full repo details
      const { repo } = await getContext().designMgmt.getRepo(this.selectedServer, this.selectedDatabase);
      if (!repo || !repo.account_id) {
        toast('Repository details not found', 'error');
        return;
      }

      // Load all accounts and filter by provider
      const allAccounts = await getContext().designMgmt.getGitAccounts();
      this.gitAccounts = allAccounts.filter((acc) => acc.provider === this.gitProvider);

      // Set the selected account
      this.selectedAccountId = repo.account_id;

      // Load repos for the account
      await this.loadReposForAccount(repo.account_id);

      // Find the sync target for this database to get branch and path
      const target = repo.sync_targets?.find(
        t => t.server_id === this.selectedServer && t.db_name === this.selectedDatabase
      );
      
      if (target) {
        this.currentBranch = target.branch;
        this.currentPath = target.path;
      }

      // Find and select the current repo
      const currentRepo = this.availableRepos.find(r => r.clone_url === repo.url);
      if (currentRepo) {
        this.selectedRepo = currentRepo;
        
        // Load branches
        await this._loadBranchesForRepo(repo.account_id, currentRepo);
        
        // Set the owner if applicable
        if (CcaDesignList.usesOwnerFiltering(this.gitProvider)) {
          const ownerMatch = currentRepo.full_name.split('/')[0];
          this.selectedOwner = ownerMatch;
        }
      }

      this.showAccountForm = false;
    } catch (error) {
      log.error('Failed to load repository details for management', error as Error);
      toast(`Failed to load repository: ${(error as Error).message}`, 'error');
    } finally {
      this.loadingAccounts = false;
    }
  }

  private checkRepoChanges() {
    if (!this.manageMode) {
      this.hasRepoChanges = false;
      return;
    }

    // Get current form values
    const repoSelect = this.shadowRoot?.querySelector('wa-select[name="repo"]') as any;
    const branchSelect = this.shadowRoot?.querySelector('wa-select[name="branch"]') as any;
    const pathInput = this.shadowRoot?.querySelector('wa-input[name="path"]') as any;
    
    const currentRepoUrl = repoSelect?.value;
    const currentBranchValue = branchSelect?.value;
    const currentPathValue = pathInput?.value || '/';

    // Get original values
    const originalRepoUrl = this.availableRepos.find(r => r.clone_url === this.gitUrl)?.clone_url;
    const originalBranch = this.currentBranch;
    const originalPath = this.currentPath || '/';

    // Check if anything changed
    this.hasRepoChanges = 
      currentRepoUrl !== originalRepoUrl ||
      currentBranchValue !== originalBranch ||
      currentPathValue !== originalPath;
  }

  private async handleAccountConnect(event: CustomEvent<FormSubmitEvent>) {
    const data = event.detail.data;

    try {
      const account = await getContext().designMgmt.postGitAccounts({
        provider: this.gitProvider!,
        label: data.label?.trim() || '',
        username: data.username?.trim() || null,
        token: data.token?.trim() || null,
        base_url: data.base_url?.trim() || null,
        // The mode the drawer's picker actually shows (D12). Loose on the wire — see
        // DesignMgmtService.postGitAccounts. Omitting it silently forced every account created
        // here to 'none' with nothing disclosed to the user.
        credential_mode: this.connectCredentialMode
      } as ConnectGitAccountRequest & { credential_mode: CredentialMode });

      log.info('Git account connected successfully', { account });

      if (!account._id) {
        throw new Error('Account created but no ID returned');
      }

      toast(`Connected ${this.gitProvider} account successfully`, 'success');

      // Add the new account to the list
      this.gitAccounts = [...this.gitAccounts, account];

      // Hide the form and show the account selection view
      this.showAccountForm = false;

      // Auto-select the new account
      this.selectedAccountId = account._id;

      // Load repos for the new account (don't let this error prevent the success flow)
      try {
        await this.loadReposForAccount(account._id);
      } catch (repoError) {
        log.error('Failed to load repositories after account connection', repoError as Error);
        toast(`Account connected, but failed to load repositories: ${(repoError as Error).message}`, 'error');
      }
    } catch (error) {
      log.error('Failed to connect git account', error as Error);
      const errorMessage = (error as Error).message || 'Unknown error';

      // Close the drawer so the user can see the error toast
      this.showGitDrawer = false;

      // See `blockedRequestAdvice` (#28).
      toast(`Failed to connect account: ${errorMessage}${blockedRequestAdvice(error)}`, 'error');
    }
  }

  private async handleAccountSelect(accountId: string) {
    this.selectedAccountId = accountId;
    await this.loadReposForAccount(accountId);
  }

  private async _loadBranchesForRepo(accountId: string, repo: RemoteRepo) {
    try {
      this.repoBranches = await getContext().designMgmt.getGitRepoBranches(accountId, repo.clone_url);
    } catch (error) {
      log.error('Failed to load branches', error as Error);
      this.repoBranches = [repo.default_branch];
    }
  }

  /**
   * Runs `fn` through the shared {@link GitTokenPrompt}: on a credential error it asks for the
   * token, stores it under the account's real credential mode, and retries once. Kept as a thin
   * method rather than open-coding `this.tokenPrompt.run(...)` at each of its five call sites.
   */
  private withTokenRetry<T>(accountId: string | null, fn: () => Promise<T>): Promise<T> {
    return this.tokenPrompt.run(accountId, fn);
  }

  private async loadReposForAccount(accountId: string) {
    this.loadingRepos = true;
    this.availableRepos = [];
    this.repoOwners = [];
    this.selectedOwner = null;
    this.selectedRepo = null;
    this.repoBranches = [];

    try {
      const repos = await this.withTokenRetry(accountId, () => getContext().designMgmt.getGitAccountRepos(accountId));
      this.availableRepos = repos;
      
      const account = this.gitAccounts.find(a => a._id === accountId);
      const provider = account?.provider;
      
      // Extract unique owners only for GitHub and Bitbucket (not GitLab)
      if (CcaDesignList.usesOwnerFiltering(provider)) {
        const owners = new Set<string>();
        repos.forEach(repo => {
          if (repo.full_name) {
            const owner = repo.full_name.split('/')[0];
            if (owner) {
              owners.add(owner);
            }
          }
        });
        this.repoOwners = Array.from(owners).sort();
        
        // Auto-select first owner if only one exists
        if (this.repoOwners.length === 1) {
          this.selectedOwner = this.repoOwners[0];
          
          // If only one repo for this owner, auto-select it
          const filteredRepos = repos.filter(r => r.full_name?.split('/')[0] === this.selectedOwner);
          if (filteredRepos.length === 1) {
            this.selectedRepo = filteredRepos[0];
            await this._loadBranchesForRepo(accountId, filteredRepos[0]);
          }
        }
      } else {
        // For GitLab, no owner filtering needed
        this.selectedOwner = null;
        
        // If only one repo, auto-select it
        if (repos.length === 1) {
          this.selectedRepo = repos[0];
          await this._loadBranchesForRepo(accountId, repos[0]);
        }
      }
    } catch (error) {
      toast(`Failed to load repositories: ${(error as Error).message}`, 'error');
    } finally {
      this.loadingRepos = false;
    }
  }

  private async handleOwnerSelect(event: Event) {
    const select = event.target as HTMLSelectElement;
    this.selectedOwner = select.value || null;
    this.selectedRepo = null;
    this.repoBranches = [];
    
    // If only one repo for this owner, auto-select it
    if (this.selectedOwner && this.selectedAccountId) {
      const filteredRepos = this.availableRepos.filter(r => r.full_name?.split('/')[0] === this.selectedOwner);
      if (filteredRepos.length === 1) {
        this.selectedRepo = filteredRepos[0];
        await this._loadBranchesForRepo(this.selectedAccountId, filteredRepos[0]);
      }
    }
    
    // Check for changes in manage mode
    setTimeout(() => this.checkRepoChanges(), 100);
  }

  private async handleRepoSelect(event: Event) {
    const select = event.target as HTMLSelectElement;
    const selectedRepo = this.availableRepos.find(r => r.clone_url === select.value);
    this.selectedRepo = selectedRepo || null;
    if (this.selectedAccountId && selectedRepo) {
      try {
        await this._loadBranchesForRepo(this.selectedAccountId, selectedRepo);
      } catch (error) {
        toast(`Failed to load branches: ${(error as Error).message}`, 'error');
      }
    }
    
    // Check for changes in manage mode
    setTimeout(() => this.checkRepoChanges(), 100);
  }

  private handleBranchSelect(event: Event) {
    const select = event.target as HTMLSelectElement;
    const selectedBranch = select.value;

    const ccaForm = this.shadowRoot?.querySelector('cca-form') as any;
    if (ccaForm) {
      ccaForm.setFieldValue('branch', selectedBranch);
    }
    
    // Check for changes in manage mode
    setTimeout(() => this.checkRepoChanges(), 100);
  }

  /** The confirmation's trailing sentence about selected documents the mode will not touch. */
  private _skippedNote(skipped: TrackedDesignDoc[]): string {
    if (skipped.length === 0) return '';
    const names = skipped.slice(0, 5).map((d) => d.ddoc_id);
    const rest = skipped.length - names.length;
    return (
      ` ${skipped.length} other selected document(s) will not be affected and stay selected:` +
      ` ${names.join(', ')}${rest > 0 ? `, and ${rest} more` : ''}.`
    );
  }

  private prepareDelete(mode: 'couch' | 'git' | 'both') {
    // Built from the same {@link _deleteTargets} the delete itself uses — for 'both' the two sides
    // are the identical `synced` group, so listing either one lists exactly what will be removed.
    const targets = this._deleteTargets(mode);
    const docs = mode === 'git' ? targets.git : targets.couch;
    const location =
      mode === 'couch' ? 'CouchDB' : mode === 'git' ? 'Git repository' : 'both CouchDB and Git';

    this.deleteMessage =
      `Are you sure you want to delete ${docs.length} document(s) from ${location}?` +
      this._skippedNote(this._deleteSkipped(mode));
    this.deleteDocList = docs.map(d => d.ddoc_id);
    this.pendingDeleteMode = mode;
    this.showDeleteConfirm = true;
  }

  private async confirmDelete() {
    this.showDeleteConfirm = false;
    if (!this.pendingDeleteMode) return;

    await this.handleDeleteByMode(this.pendingDeleteMode);
    this.pendingDeleteMode = null;
  }

  private cancelDelete() {
    this.showDeleteConfirm = false;
    this.pendingDeleteMode = null;
  }

  /**
   * Deletes exactly what {@link prepareDelete} listed — both read the same
   * {@link _deleteTargets}, and both toasts count that same group, so the dialog, the commit and
   * the confirmation message can no longer name three different numbers.
   *
   * The repository side goes through {@link withTokenRetry} like every other git-touching call:
   * this is a real GitHub commit since Task 6, and an account in credential mode `none` has no
   * token at all on a freshly-loaded tab.
   */
  private async handleDeleteByMode(mode: 'couch' | 'git' | 'both') {
    const { couch: couchDocs, git: gitDocs } = this._deleteTargets(mode);
    // Read while the selection is still intact — loadDesignDocs() below rebuilds `docs`.
    const skipped = this._deleteSkipped(mode);

    if (gitDocs.length > 0 && !this.repoId) {
      // Refuse the whole operation rather than silently performing only its CouchDB half — the
      // confirmation the user just approved named both sides.
      toast('No git repository is linked to this database — nothing was deleted.', 'error');
      return;
    }

    try {
      if (couchDocs.length > 0) {
        const docsToDelete = couchDocs.map(d => ({ id: d.ddoc_id, rev: d.rev! }));
        await getContext().dbMgmt.deleteDocuments(this.selectedServer, this.selectedDatabase, {
          documents: docsToDelete
        });
        // Sweep the git bookkeeping the CouchDB-side delete would otherwise orphan (issue #6
        // item 2, widened) — but ONLY for documents with no repository counterpart.
        //
        // A *synced* document deleted from CouchDB alone still exists in git, and its `sync:`
        // record is what makes the next "Sync to CouchDB" read it as "newer in git" and restore
        // it — behaviour the README documents deliberately. Dropping that record here would
        // change a documented sync outcome as a side effect of a cleanup, so it is left alone;
        // `deleteRepoDocs` already sweeps it when the repository copy goes too.
        //
        // Only after the delete succeeded: if it threw, the documents are still there and their
        // tracking records are still correct.
        const orphaned = this._partitionSelectedDocs().couchOnly;
        if (orphaned.length > 0) {
          await getContext().designMgmt.forgetSyncState(
            this.selectedDatabase,
            orphaned.map(d => d.ddoc_id)
          );
        }
        toast(`Deleted ${couchDocs.length} document(s) from CouchDB`, 'success');
      }

      if (gitDocs.length > 0 && this.repoId) {
        const repoId = this.repoId;
        const docNames = gitDocs.map(d => d.ddoc_id.replace(/^_design\//, ''));
        await this.withTokenRetry(this.repoAccountId, () =>
          getContext().designMgmt.deleteRepoDocs(repoId, this.selectedDatabase, docNames)
        );
        toast(`Deleted ${gitDocs.length} document(s) from Git`, 'success');
      }

      // Only what this mode acted on leaves the selection. Clearing all of it made a mixed
      // selection look handled when part of it had been skipped (see {@link _deleteSkipped}).
      this.selectedDocs = new Set(skipped.map(docKey));
      await this.loadDesignDocs();
    } catch (error) {
      log.error('Failed to delete documents', error as Error);
      toast(`Failed to delete: ${(error as Error).message}`, 'error');
    }
  }

  private async handleRepoUpdate(event: CustomEvent<FormSubmitEvent>) {
    const data = event.detail.data;
    const repoSelect = this.shadowRoot?.querySelector('wa-select[name="repo"]') as any;
    const selectedRepoUrl = repoSelect?.value;

    if (!selectedRepoUrl) {
      toast('Please select a repository', 'error');
      return;
    }

    // Check if there are any changes
    this.checkRepoChanges();
    if (!this.hasRepoChanges) {
      toast('No changes detected', 'info');
      return;
    }

    // Store the data and show confirmation
    this.pendingUpdateData = {
      data,
      selectedRepoUrl
    };
    this.showUpdateConfirm = true;
  }

  private async confirmRepoUpdate() {
    if (!this.pendingUpdateData) return;

    const { data, selectedRepoUrl } = this.pendingUpdateData;
    const selectedRepo = this.availableRepos.find((r) => r.clone_url === selectedRepoUrl);

    try {
      const result = await getContext().designMgmt.registerRepo(this.selectedServer, this.selectedDatabase, {
        account_id: this.selectedAccountId!,
        name: selectedRepo?.full_name,
        url: selectedRepoUrl,
        branch: data.branch?.trim() || selectedRepo?.default_branch || 'main',
        path: data.path?.trim() || '/',
        mode: 'sync',
        targets: [{ server_id: this.selectedServer, db_name: this.selectedDatabase, branch: data.branch?.trim() || selectedRepo?.default_branch || 'main', path: data.path?.trim() || '/' }]
      });

      this.gitUrl = result.url ?? '';
      this.repoId = result._id ?? null;
      this.repoAccountId = this.selectedAccountId;
      this.gitProvider = selectedRepo ? this.gitProvider : null;
      this.repoName = result.name ?? null;
      this.showGitDrawer = false;
      this.showUpdateConfirm = false;
      this.pendingUpdateData = null;

      toast('Repository updated successfully', 'success');

      await this.getDesignDocsFromRepo(result._id!);
      this.refreshDocs();
    } catch (error) {
      log.error('Failed to update repository', error as Error);
      toast(`Failed to update repository: ${(error as Error).message}`, 'error');
    }
  }

  private async handleRepoRegister(event: CustomEvent<FormSubmitEvent>) {
    const data = event.detail.data;
    const repoSelect = this.shadowRoot?.querySelector('wa-select[name="repo"]') as any;
    const selectedRepoUrl = repoSelect?.value;

    if (!selectedRepoUrl) {
      toast('Please select a repository', 'error');
      return;
    }

    const selectedRepo = this.availableRepos.find((r) => r.clone_url === selectedRepoUrl);

    try {
      // #816: RepoTarget.branch/path are required on the wire — compute them once and
      // reuse for both the top-level (legacy inline-auth path) and per-target fields.
      const branch = data.branch?.trim() || selectedRepo?.default_branch || 'main';
      const path = data.path?.trim() || '/';
      const result = await getContext().designMgmt.registerRepo(this.selectedServer, this.selectedDatabase, {
        account_id: this.selectedAccountId!,
        name: selectedRepo?.full_name,
        url: selectedRepoUrl,
        branch,
        path,
        mode: 'sync',
        targets: [{ server_id: this.selectedServer, db_name: this.selectedDatabase, branch, path }]
      });

      this.gitUrl = result.url ?? '';
      this.repoId = result._id ?? null;
      this.repoAccountId = this.selectedAccountId;
      this.gitProvider = selectedRepo ? this.gitProvider : null;
      this.repoName = result.name ?? null;
      this.showGitDrawer = false;
      const matchingTarget = result.sync_targets?.find(
        t => t.server_id === this.selectedServer && t.db_name === this.selectedDatabase
      );
      this.designRoot = matchingTarget?.path ?? '';
      this.repoBranch = matchingTarget?.branch ?? '';
      toast('Repository registered successfully', 'success');

      await this.getDesignDocsFromRepo(result._id!);
      this.refreshDocs();
    } catch (error) {
      log.error('Failed to register repository', error as Error);
      toast(`Failed to register repository: ${(error as Error).message}`, 'error');
    }
  }

  private async handleUnlinkRepo() {
    if (!this.repoId) {
      toast('No repository to unlink', 'error');
      return;
    }

    try {
      await getContext().designMgmt.deleteRepo(this.repoId);
      this.repoId = null;
      this.repoAccountId = null;
      this.gitUrl = '';
      this.repoName = null;
      this.gitProvider = null;
      this.gitDDocs = [];
      this.showGitDrawer = false;
      this.showUnlinkConfirm = false;

      toast('Repository unlinked successfully', 'success');

      this.refreshDocs();
    } catch (error) {
      log.error('Failed to unlink repository', error as Error);
      toast(`Failed to unlink repository: ${(error as Error).message}`, 'error');
    }
  }

  render() {
    if (this.loading) {
      return html`
        <wa-card>
          <div class="loading">
            <wa-spinner></wa-spinner>
            <span>Loading design documents...</span>
          </div>
        </wa-card>
      `;
    }

    return html`
      <wa-form>
        <div class="wa-stack">
          <div class="form-grid">
            <div class="grid-field">
              <wa-label>Database</wa-label>
              <cca-db-picker
                .databases=${this.databases}
                .value=${this.selectedDatabase}
                .unavailable=${this.databaseListDenied}
                .reason=${this.databaseListDenialReason}
                ?disabled=${!this.selectedServer}
                @cca-db-change=${this.handleDatabaseChange}></cca-db-picker>
            </div>
            
            <div class="grid-field">
              <span class="git-label">Git Repository</span>
              <div class="git-fields">
                ${this._renderGitRepoDisplay()}
              </div>
            </div>
        
          <div class="grid-field">
            <wa-label>Search</wa-label>
            <wa-input
              name="search"
              placeholder="Search design docs…"
              clearable
              ?disabled=${!this.selectedDatabase}
              .value=${this.searchText}
              @input=${(e: Event) => this.setSearchText((e.target as HTMLInputElement).value)}
              @wa-clear=${() => this.setSearchText('')}
            ></wa-input>
          </div>

          ${this.repoId ? html`
            <div class="grid-field">
              <span class="git-label">Design Root</span>
              <div class="git-fields">
                <strong>${this.designRoot}</strong>
              </div>
            </div>
            ` : html`<div style="flex: 1;"></div>`}
          </div>

        ${this._renderConflictBanner()}
        ${this._renderRepoTruncationNotice()}

        <div class="table-wrapper" style="position: relative;">
          ${this._renderTableLoadingOverlay()}
          <cca-data-table
              .columns=${this.tableColumns as unknown as TableColumn[]}
              .rows=${this.filteredDocs}
              empty-message="No design documents found."
              row-key="ddoc_id"
              @cca-row-click=${this.launchDocEditor}
            ></cca-data-table>
          </div>
        </div>
      </wa-form>

      <!-- Git Repository Connection Drawer -->
      <wa-drawer
        label="${this._drawerLabel}"
        ?open=${this.showGitDrawer}
        @wa-after-hide=${(e: Event) => {
            if (e.target === e.currentTarget) {
              this.showGitDrawer = false;
              this.showAccountForm = false;
              this.selectedAccountId = null;
              this.availableRepos = [];
              this.manageMode = false;
              this.currentBranch = null;
              this.currentPath = null;
            }
          }}>
        ${this._renderAccountDrawerContent()}
      </wa-drawer>

      <div class="footer actions">
        <div class="sync-action">
          ${this._renderSyncButtons()}
        </div>
        <div class="doc-actions">
          ${this._renderDocActions()}
        </div>
      </div>

      <!-- Delete Confirmation Dialog -->
      <wa-dialog 
        label="Confirm Deletion" 
        ?open=${this.showDeleteConfirm}
        @wa-after-hide=${() => this.showDeleteConfirm = false}>
        <p>${this.deleteMessage}</p>
        <ul style="margin: 1rem 0; padding-left: 1.5rem;">
          ${this.deleteDocList.map(docId => html`<li>${docId}</li>`)}
        </ul>
        <p style="color: var(--wa-color-danger-60); font-weight: var(--wa-font-weight-semibold); margin-top: 1rem;">
          ⚠️ This action cannot be undone.
        </p>
        <wa-button slot="footer" @click=${this.cancelDelete}>Cancel</wa-button>
        <wa-button slot="footer" appearance="filled" @click=${this.confirmDelete}>
          <wa-icon name="trash"></wa-icon> Confirm Delete
        </wa-button>
      </wa-dialog>

      <!-- Update Repository Confirmation Dialog -->
      <wa-dialog 
        label="Confirm Repository Update" 
        ?open=${this.showUpdateConfirm}
        @wa-after-hide=${() => { 
          this.showUpdateConfirm = false; 
          this.pendingUpdateData = null;
        }}>
        <p>Updating the repository will change the connection settings for this database.</p>
        <p style="color: var(--wa-color-warning-60); font-weight: var(--wa-font-weight-semibold); margin-top: 1rem;">
          ⚠️ This will unlink the current repository and link to the new configuration.
        </p>
        <p style="margin-top: 1rem;">Are you sure you want to continue?</p>
        <wa-button slot="footer" @click=${() => { 
          this.showUpdateConfirm = false; 
          this.pendingUpdateData = null;
        }}>Cancel</wa-button>
        <wa-button slot="footer" appearance="filled" variant="primary" @click=${this.confirmRepoUpdate}>
          <wa-icon name="check"></wa-icon> Update Repository
        </wa-button>
      </wa-dialog>

      <!-- Unlink Repository Confirmation Dialog -->
      <wa-dialog 
        label="Confirm Repository Unlink" 
        ?open=${this.showUnlinkConfirm}
        @wa-after-hide=${() => this.showUnlinkConfirm = false}>
        <p>Unlinking the repository will remove the connection between this database and the Git repository.</p>
        <p style="margin-top: 1rem;">
          <strong>Repository:</strong> ${this.repoName || 'Unknown'}
        </p>
        <p style="color: var(--wa-color-danger-60); font-weight: var(--wa-font-weight-semibold); margin-top: 1rem;">
          ⚠️ Design documents will remain in CouchDB, but sync operations will no longer be available.
        </p>
        <p style="margin-top: 1rem;">Are you sure you want to unlink this repository?</p>
        <wa-button slot="footer" @click=${() => this.showUnlinkConfirm = false}>Cancel</wa-button>
        <wa-button slot="footer" appearance="filled" variant="danger" @click=${this.handleUnlinkRepo}>
          <wa-icon name="link-slash"></wa-icon> Unlink Repository
        </wa-button>
      </wa-dialog>

      <!-- Sync-time token prompt + single retry (shared with view-editor.ts) -->
      ${this.tokenPrompt.render()}

      <!-- Provider Selection Dialog -->
      ${renderProviderDialog(this._getConnectDialogState(), this._getConnectDialogCallbacks())}

      <!-- Connect Account Dialog -->
      ${renderConnectAccountDialog(this._getConnectDialogState(), this._getConnectDialogCallbacks())}

      <!-- Register Repository Dialog -->
    `;
  }

  private handleCreateDesignDoc() {
    if (!this.selectedServer && !this.selectedDatabase) {
      toast('Please select a server and database first', 'error');
      return;
    }

    this.launchDocEditor({
      detail: {
        server_id: this.selectedServer,
        db_name: this.selectedDatabase,
        ddoc_id: '_new'
      }
    } as CustomEvent<TrackedDesignDoc>);
  }

  /**
   * Design Docs → the selected database's Mango index screen (#92).
   *
   * A Mango index *is* a design document — CouchDB stores it as `_design/<ddoc>` with a
   * `language: "query"` body — so "create one" belongs beside "Create New" rather than only
   * behind the Databases list. This is the return direction of #81, which wired
   * doc-browser/doc-query → Design Docs; nothing led the other way.
   *
   * It navigates to the existing `indexes` route (`cca-index-manage`, which hosts
   * `cca-create-index` alongside `cca-index-list`) rather than hosting an index editor here: a
   * second editor for the same document type is exactly the drift #92 is undoing.
   *
   * Requires *both* halves of the context, unlike {@link handleCreateDesignDoc}'s `&&` — the
   * destination is `/databases/:serverId/:dbName/indexes`, and a missing half would navigate to
   * a URL with an empty path segment instead of to an index screen.
   */
  private handleCreateIndex() {
    if (!this.selectedServer || !this.selectedDatabase) {
      toast('Please select a server and database first', 'error');
      return;
    }

    getContext().router.navigate(
      `/databases/${encodeURIComponent(this.selectedServer)}/${encodeURIComponent(this.selectedDatabase)}/indexes`
    );
  }

  private handleSyncToRepo() {
    if (!this.selectedDocs || this.selectedDocs.size === 0) {
      toast('Please select at least one design document to sync', 'info');
      return;
    }
    if (!this.repoId) {
      toast('Please connect to a git repository first', 'info');
      return;
    }

    this.syncingrepo = true;
    const repoId = this.repoId;
    const docs = Array.from(this.selectedDocs);
    void this.withTokenRetry(this.repoAccountId, () =>
      getContext().designMgmt.syncToRepo(repoId, this.selectedDatabase, { docs })
    )
      .then(async (result) => {
        reportSyncToRepoResult(result);
        this.selectedDocs = new Set();
        await this.loadDesignDocs();
        this.requestUpdate();
      })
      .catch((err: any) => {
        toast(`Sync failed: ${err?.message || UNKNOWN_ERROR}`, 'error');
      })
      .finally(() => {
        this.syncingrepo = false;
      });
  }

  private handleSyncToCouchDB() {
    if (!this.selectedDocs || this.selectedDocs.size === 0) {
      toast('Please select at least one design document to sync', 'error');
      return;
    }
    if (!this.repoId) {
      toast('Please connect to a git repository first', 'info');
      return;
    }

    this.syncingcouch = true;
    const repoId = this.repoId;
    const docs = Array.from(this.selectedDocs);
    void this.withTokenRetry(this.repoAccountId, () =>
      getContext().designMgmt.syncToCouch(repoId, this.selectedDatabase, { docs })
    )
      .then(async () => {
        // syncToCouch's signature is frozen at Promise<void> (D6) — it has no counts to report,
        // and a document whose only change was on the CouchDB side is silently refused (see its
        // own doc comment), not applied. "Synced successfully" claimed more than that; this says
        // only what's actually known and points at where the truth lives.
        toast(
          'Sync to CouchDB finished. Documents that only changed in CouchDB were left as-is — check the sync column.',
          'info'
        );
        this.selectedDocs = new Set();
        await this.loadDesignDocs();
        this.requestUpdate();
      })
      .catch((err: any) => toast(`Sync failed: ${err?.message || UNKNOWN_ERROR}`, 'error'))
      .finally(() => {
        this.syncingcouch = false;
      });
  }
}
