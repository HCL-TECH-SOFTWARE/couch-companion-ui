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

import { html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { ifDefined } from 'lit/directives/if-defined.js';
import { CcaElement } from '../../components/cca-element.js';
import { getContext } from '../../context.js';
import { toast } from '../../components/cca-toast.js';
import { getLogger } from '../../services/log-service.js';
import type { GitRepo, RepoTarget, AccountWithRepos } from './types.js';
import {
  flattenReposToTargets,
  type RepoTargetRow
} from '../../services/repo-targets.js';
import type { TableColumn } from '../../components/cca-data-table.js';

import {
  addHeaderActions,
  clearHeaderActions,
  clearHeaderTitle,
  setHeaderTitle
} from '../../components/cca-header.js';
import {
  renderProviderDialog,
  renderConnectAccountDialog,
  renderCredentialModePicker,
  type ConnectGitDialogState,
  type ConnectGitDialogCallbacks
} from './connect-git-account-flow.js';
import type { CredentialMode } from '../../services/git/git-credential-store.js';
import type { ConnectGitAccountRequest } from '../../services/design-mgmt-service.js';
import { blockedRequestAdvice } from './git-sync-ui.js';
import { requiredGitOrigins } from '../../services/csp-policy.js';
import '../../components/cca-data-table.js';
import '../../components/cca-csp-check.js';

const log = getLogger('plugins/design-mgmt/repo-overview');

const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/** Maps a repo's sync_status onto a badge variant. */
const SYNC_VARIANT: Record<
  string,
  'brand' | 'neutral' | 'success' | 'warning' | 'danger'
> = {
  idle: 'success',
  syncing: 'brand',
  error: 'danger',
  conflict: 'warning'
};

/**
 * What a credential mode *is*, said as a place — the phrasing `tokenPromptMessage`
 * (`git-sync-ui.ts`) already uses when it tells a user a new token "replaces the copy held in …".
 * A mode change is exactly that plus a deletion, and the deletion is the half the user cannot see
 * for themselves, so every message below names the store being emptied (I9-6).
 *
 * Deliberately *not* `CREDENTIAL_MODE_COPY.label` — those are the names of the choices in the
 * picker ("This browser"), which read as nonsense inside a sentence about where a token is held.
 * The picker itself is reused verbatim (I9-5); this is the sentence around it.
 */
const CREDENTIAL_STORE_NAME: Record<CredentialMode, string> = {
  none: 'memory, for this browser tab only',
  indexeddb: 'this browser profile',
  couchdb: 'the couchcompanion database, where every server admin can read it'
};

/** What saving is about to do, shown beside the picker as soon as the selection differs. */
const credentialMoveWarning = (from: CredentialMode, to: CredentialMode): string => {
  if (to === 'none') {
    return (
      `Saving deletes this account's access token from ${CREDENTIAL_STORE_NAME[from]}. ` +
      'It is not saved anywhere afterwards, and every new browser tab asks for it again.'
    );
  }
  if (from === 'none') {
    return (
      `Saving stores this account's access token in ${CREDENTIAL_STORE_NAME[to]}, where it stays ` +
      'until you change this again. The token has to be entered first if this tab does not have it.'
    );
  }
  return (
    `Saving moves this account's access token to ${CREDENTIAL_STORE_NAME[to]}, and deletes the ` +
    `copy held in ${CREDENTIAL_STORE_NAME[from]}.`
  );
};

/** What saving just did. Same sentence, past tense — the toast has to name the emptied store too. */
const credentialMoveConfirmation = (
  label: string,
  from: CredentialMode,
  to: CredentialMode
): string => {
  if (to === 'none') {
    return (
      `Access token for "${label}" deleted from ${CREDENTIAL_STORE_NAME[from]}. It is no longer ` +
      'saved anywhere — every new browser tab will ask for it.'
    );
  }
  if (from === 'none') {
    return `Access token for "${label}" is now stored in ${CREDENTIAL_STORE_NAME[to]}.`;
  }
  return (
    `Access token for "${label}" moved to ${CREDENTIAL_STORE_NAME[to]}; the copy in ` +
    `${CREDENTIAL_STORE_NAME[from]} was deleted.`
  );
};

/**
 * Why the drawer has to ask. The account was storing nothing, and the session cache this tab would
 * have moved is empty, so there is literally no token to relocate — not an error, just the one
 * case the service cannot complete on its own.
 */
const tokenNeededMessage = (label: string, to: CredentialMode): string =>
  `"${label}" does not store its access token and this browser tab does not have one, so there is ` +
  `nothing to move. Enter the token to continue — it is then kept in ${CREDENTIAL_STORE_NAME[to]}.`;

/**
 * Fleet-wide view of every registered git repository (#692).
 *
 * `design-list` answers "which repo backs *this* database?" one (server, database) pair at a time.
 * This answers the question an operator actually asks: which repositories exist, which databases
 * they are registered against, which branch and design root each target tracks, and whether they
 * are in sync. Read-oriented by design. Registration stays in `design-list`, which owns the
 * connected-git-account flow, and there is no repo-level "Sync Now" because both sync operations
 * need a database *and* a document set — a repo spanning four targets has no single thing to sync.
 * Instead each target is a pill that navigates to `design-list` for that server and database (#798).
 */
@customElement('cca-repo-overview')
export class CcaRepoOverview extends CcaElement {
  static styles = css`
    .target-wrapper {
      display: flex;
      align-items: center;
      gap: var(--wa-space-xs);
    }

    .repo-name-sub {
      display: inline-flex;
      align-items: center;
      gap: var(--wa-space-xs);
      padding-left: var(--wa-space-m);
      font-size: var(--wa-font-size-s);
      color: var(--wa-color-text-quiet);
    }

    .target {
      cursor: pointer;
    }

    .repo-name {
      display: inline-flex;
      align-items: center;
      gap: var(--wa-space-xs);
      color: var(--wa-color-text-link);
      text-decoration: underline;
    }

    .accounts-container {
      display: flex;
      flex-direction: column;
      gap: var(--wa-space-m);
    }

    .account-summary {
      display: flex;
      align-items: center;
      justify-content: space-between;
      width: 100%;
    }

    .account-info {
      display: flex;
      align-items: center;
      gap: var(--wa-space-s);
    }

    .account-label {
      font-weight: var(--wa-font-weight-semibold);
      font-size: var(--wa-font-size-l);
    }

    .account-provider {
      color: var(--wa-color-text-quiet);
    }

    .account-actions {
      display: flex;
      align-items: center;
      gap: var(--wa-space-xs);
    }

    .account-edit-form {
      display: flex;
      flex-direction: column;
      gap: var(--wa-space-m);
    }

    .account-facts {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: var(--wa-space-xs) var(--wa-space-m);
    }

    .fact-label {
      color: var(--wa-color-text-quiet);
    }

    .edit-note {
      margin: 0;
      font-size: var(--wa-font-size-s);
      color: var(--wa-color-text-quiet);
    }

    .edit-warning {
      margin: 0;
      color: var(--wa-color-warning-on-loud);
    }

    .no-repos {
      padding: var(--wa-space-xl);
      text-align: center;
      color: var(--wa-color-text-quiet);
      font-style: italic;
    }

    .target-wrapper {
      display: flex;
      align-items: center;
      gap: var(--wa-space-xs);
    }
  `;

  @state() private repos: GitRepo[] = [];
  @state() private serverNames: Record<string, string> = {};
  @state() private loading = true;
  @state() private filterValue = '';

  @state() private accountsWithRepos: AccountWithRepos[] = [];
  @state() private showDeleteAccountConfirm = false;
  @state() private accountToDelete: string | null = null;
  @state() private showDeleteRepoConfirm = false;
  @state() private repoToDelete: { id: string; name: string } | null = null;

  @state() private showUnlinkConfirm = false;
  @state() private unlinkTarget: { repoId: string; target: RepoTarget } | null =
    null;

  /**
   * The account-edit drawer (#9). `editAccountId` rather than a copy of the account: the list
   * reloads underneath this drawer, and a stale copy would let a save write a label the user never
   * saw. `editNeedsToken` is set only by a `token_required` answer — it is never true on open.
   */
  @state() private showEditAccountDrawer = false;
  @state() private editAccountId: string | null = null;
  @state() private editLabel = '';
  @state() private editCredentialMode: CredentialMode = 'none';
  @state() private editToken = '';
  @state() private editNeedsToken = false;
  @state() private savingAccount = false;

  @state() private showProviderDialog = false;
  @state() private showConnectAccountDialog = false;
  @state() private connectProvider: 'github' | 'gitlab' | 'bitbucket' | null =
    null;
  @state() private connectLabel = '';
  @state() private connectUsername = '';
  @state() private connectToken = '';
  @state() private connectBaseUrl = '';
  @state() private connectingAccount = false;
  @state() private connectCredentialMode: CredentialMode = 'none';

  private static readonly SEARCH_DEBOUNCE_MS = 250;
  private _searchDebounce: ReturnType<typeof setTimeout> | undefined;

  /** Fetch generation — a response only applies if still the latest reload (mirrors #810/#821). */
  private _loadSeq = 0;

  /**
   * Every read this screen makes (`listRepos`, `getGitAccounts`) goes through `couchcompanion`,
   * which is admin-only by CouchDB's own default security (D9) — a non-admin gets a guaranteed 403
   * from both, not a degraded view. So the whole screen, not just its write actions, is admin-only.
   */
  private get isAdmin(): boolean {
    return getContext().auth.isAdmin;
  }

  override connectedCallback() {
    clearHeaderActions();
    if (this.isAdmin) {
      addHeaderActions([
        {
          icon: 'code-branch',
          tooltip: 'Connect Git Account',
          variant: 'neutral',
          action: () => this._openProviderDialog()
        },
        {
          icon: 'arrows-rotate',
          tooltip: 'Refresh',
          action: () => this._reloadNow()
        }
      ]);
    }
    setHeaderTitle('Version Control');
    super.connectedCallback();
    if (this.isAdmin) {
      void this.load();
    } else {
      this.loading = false;
    }
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    clearHeaderActions();
    clearHeaderTitle();
    clearTimeout(this._searchDebounce);
    this._searchDebounce = undefined;
  }

  /**
   * Keystroke-triggered reloads wait out the debounce window before hitting the server-side
   * `filter` param on GET /api/design-docs/repos/all.
   */
  private _scheduleSearch() {
    clearTimeout(this._searchDebounce);
    this._searchDebounce = setTimeout(() => {
      this._searchDebounce = undefined;
      void this.load();
    }, CcaRepoOverview.SEARCH_DEBOUNCE_MS);
  }

  /** Discrete reload triggers (clear, manual refresh) reload at once, dropping any pending keystroke reload. */
  private _reloadNow() {
    clearTimeout(this._searchDebounce);
    this._searchDebounce = undefined;
    void this.load();
  }

  /**
   * Connect-account flow currently lives in `design-list`.
   * In repo-overview we launch the same flow locally (no redirect).
   */
  private _openProviderDialog() {
    this.showProviderDialog = true;
  }

  private _selectProviderForConnect(provider: 'github' | 'gitlab' | 'bitbucket') {
    this.connectProvider = provider;
    this.showProviderDialog = false;
    this.showConnectAccountDialog = true;
  }

  private _resetConnectAccountForm() {
    this.showConnectAccountDialog = false;
    this.connectProvider = null;
    this.connectLabel = '';
    this.connectUsername = '';
    this.connectToken = '';
    this.connectBaseUrl = '';
    this.connectingAccount = false;
    this.connectCredentialMode = 'none';
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

  private _getConnectDialogCallbacks(): ConnectGitDialogCallbacks {
    return {
      onRequestClose: () => this._resetConnectAccountForm(),
      onSelectProvider: (provider) => this._selectProviderForConnect(provider),
      onConnectClick: () => this._connectGitAccount(),
      onCancelClick: () => this._resetConnectAccountForm(),
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

  private async _connectGitAccount() {
    if (!this.connectProvider) return;

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
        provider: this.connectProvider,
        label,
        username: this.connectProvider === 'bitbucket' ? username : null,
        token,
        base_url: this.connectBaseUrl.trim() || null,
        // credential_mode rides loosely on the wire (D6 froze ConnectGitAccountRequest before
        // D12's three-way choice existed) — see DesignMgmtService.postGitAccounts's own comment.
        credential_mode: this.connectCredentialMode
      } as ConnectGitAccountRequest & { credential_mode: CredentialMode });

      toast(`Connected ${this.providerName(this.connectProvider)} account successfully`, 'success');
      this._resetConnectAccountForm();
      await this.load();
    } catch (error) {
      log.error('Failed to connect git account', error as Error);
      // A request the browser never sent says "Failed to fetch" and leaves the network tab empty;
      // `blockedRequestAdvice` adds where to look, but only when the policy is CouchDB's (#28).
      toast(`Failed to connect account: ${errorMessage(error)}${blockedRequestAdvice(error)}`, 'error');
    } finally {
      this.connectingAccount = false;
    }
  }

  private async load() {
    const seq = ++this._loadSeq;
    this.loading = true;
    try {
      // Server names are only for display; a failure there must not cost us the repo list, so the
      // two are settled independently and target pills fall back to the raw server id.
      const [reposResult, serversResult, accountsResult] =
        await Promise.allSettled([
          getContext().designMgmt.listRepos(
            this.filterValue.trim() || undefined
          ),
          getContext().serverMgmt.listServers(),
          getContext().designMgmt.getGitAccounts()
        ]);

      if (reposResult.status === 'rejected') throw reposResult.reason;
      if (seq === this._loadSeq) {
        this.repos = reposResult.value.repos;
      }

      if (serversResult.status === 'fulfilled') {
        if (seq === this._loadSeq) {
          this.serverNames = Object.fromEntries(
            serversResult.value.servers.map((s) => [s.id, s.name])
          );
        }
      } else {
        log.error('Failed to load server names', serversResult.reason as Error);
      }

      if (accountsResult.status === 'fulfilled') {
        if (seq === this._loadSeq) {
          const accounts = accountsResult.value;
          this.accountsWithRepos = accounts.map((account) => ({
            ...account,
            repos: this.repos.filter((repo) => repo.account_id === account._id)
          }));
        }
      } else {
        log.error(
          'Failed to load git accounts',
          accountsResult.reason as Error
        );
        // Don't fail the whole page if accounts fail to load
        if (seq === this._loadSeq) {
          this.accountsWithRepos = [];
        }
      }
    } catch (err) {
      // Leave whatever is already on screen; a failed refresh should not blank the table.
      log.error('Failed to load repositories', err as Error);
      if (seq === this._loadSeq)
        toast(`Failed to load repositories: ${errorMessage(err)}`, 'error');
    } finally {
      if (seq === this._loadSeq) this.loading = false;
    }
  }

  /** Falls back to the raw id when the server list is unavailable or the server is gone. */
  private serverLabel(serverId: string): string {
    return this.serverNames[serverId] ?? serverId;
  }

  private providerName(provider: string): string {
    const names: Record<string, string> = {
      github: 'GitHub',
      gitlab: 'GitLab',
      bitbucket: 'Bitbucket'
    };
    return names[provider] ?? provider;
  }

  private openTarget(target: RepoTarget) {
    // design-list preselects the database from the ?database= query param (#798).
    getContext().router.navigate(
      `/design-docs/${encodeURIComponent(target.server_id)}?database=${encodeURIComponent(target.db_name)}`
    );
  }

  render() {
    if (!this.isAdmin) {
      return html`
        <wa-callout variant="neutral" appearance="outlined" data-admin-only>
          <wa-icon slot="icon" name="circle-info"></wa-icon>
          Version control is available to server administrators only —
          <code>couchcompanion</code> is admin-only by CouchDB's own default security. Sign in as
          a server administrator to connect Git accounts and manage repositories.
        </wa-callout>
      `;
    }
    return html`
      <wa-input
        name="repo-search"
        placeholder="Search repositories…"
        clearable
        maxlength="256"
        .value=${this.filterValue}
        @input=${(e: Event) => {
          const value = (e.target as HTMLInputElement).value;
          // WA's clear button fires wa-clear (handled below) and then a
          // composed input for the same, already-applied value.
          if (value === this.filterValue) return;
          this.filterValue = value;
          this._scheduleSearch();
        }}
        @wa-clear=${() => {
          this.filterValue = '';
          this._reloadNow();
        }}
        style="margin-bottom:1rem;display:block"
      ></wa-input>
      <cca-csp-check
        .origins=${requiredGitOrigins(this.accountsWithRepos)}
        .subject=${'git sync'}
        .blockedSymptom=${'git sync fails with "Failed to fetch" and nothing appears in the network tab'}
        .emptyMessage=${'No git accounts are connected yet, so there is nothing for the policy to allow.'}
        view-tester
      ></cca-csp-check>
      ${this._renderContent()} ${this._renderDeleteAccountDialog()}
      ${this._renderEditAccountDrawer()} ${this._renderDeleteRepoDialog()}
      ${this._renderUnlinkTargetDialog()}
      ${renderProviderDialog(this._getConnectDialogState(), this._getConnectDialogCallbacks())}
      ${renderConnectAccountDialog(this._getConnectDialogState(), this._getConnectDialogCallbacks())}
    `;
  }

  private _renderContent() {
    if (this.loading) {
      return html`
        <div
          style="display: flex; justify-content: center; padding: var(--wa-space-xl);"
        >
          <wa-spinner></wa-spinner>
        </div>
      `;
    }

    if (this.accountsWithRepos.length === 0) {
      return html`
        <wa-card>
          <p>
            No Git accounts connected. Connect one from a database's Design Docs
            page.
          </p>
        </wa-card>
      `;
    }

    return html`
      <div class="accounts-container">
        ${this.accountsWithRepos
          .sort((a, b) => {
            // Accounts with repos come first, then accounts without repos
            if (a.repos.length === 0 && b.repos.length > 0) return 1;
            if (a.repos.length > 0 && b.repos.length === 0) return -1;
            return 0;
          })
          .map((account) => this._renderAccountAccordion(account))}
      </div>
    `;
  }

  private _renderAccountAccordion(account: AccountWithRepos) {
    const canDelete = account.repos.length === 0;

    return html`
      <wa-details class="account-accordion" ?open=${account.repos.length > 0}>
        <div slot="summary" class="account-summary">
          <div class="account-info">
            <wa-icon
              name=${account.provider}
              family="brands"
              style="font-size: var(--wa-font-size-larger);"
            ></wa-icon>
            <span class="account-label">${account.label}</span>
            <span class="account-provider"
              >(${this.providerName(account.provider)})</span
            >
            <wa-badge appearance="outlined" pill>
              ${account.repos.length}
              ${account.repos.length === 1 ? 'repo' : 'repos'}
            </wa-badge>
          </div>
          <div class="account-actions">
            ${this._renderEditAccountButton(account)}
            ${this._renderDeleteAccountButton(canDelete, account)}
          </div>
        </div>
        ${this._renderAccountContent(account)}
      </wa-details>
    `;
  }

  /**
   * Sits in the accordion's action slot beside Disconnect, and unlike Disconnect is never disabled:
   * an account with repositories is exactly the one whose token storage is worth changing.
   * `stopPropagation` keeps the click off `wa-details`, which would otherwise toggle the accordion.
   */
  private _renderEditAccountButton(account: AccountWithRepos) {
    return html`
      <wa-tooltip for=${this._tooltipTargetId('edit-account', account._id)}
        >Edit Git account</wa-tooltip
      >
      <wa-button
        id=${this._tooltipTargetId('edit-account', account._id)}
        data-edit-account=${account._id}
        appearance="filled-outlined"
        @click=${(e: Event) => {
          e.stopPropagation();
          this._openAccountEditor(account);
        }}
      >
        <wa-icon name="pen-to-square" size="xs"></wa-icon>
      </wa-button>
    `;
  }

  private _renderDeleteAccountButton(
    canDelete: boolean,
    account: AccountWithRepos
  ) {
    if (!canDelete) {
      return html`
        <wa-tooltip for=${this._tooltipTargetId('disconnect-account-disabled', account._id)}
          >Cannot disconnect: ${account.repos.length} repository(ies) are using this account.<br />
            Unlink all registered repositories first.</wa-tooltip>
            <wa-button
              id=${this._tooltipTargetId('disconnect-account-disabled', account._id)}
              variant="danger"
              appearance="outlined"
              disabled
            >
              <wa-icon name="trash" size="s"></wa-icon>
            </wa-button>
      `;
    }
    return html`
    <wa-tooltip for=${this._tooltipTargetId('disconnect-account', account._id)}
      >Disconnect Git account</wa-tooltip>
      <wa-button
        id=${this._tooltipTargetId('disconnect-account', account._id)}
        variant="danger"
        appearance="filled-outlined"
        @click=${(e: Event) => {
          e.stopPropagation();
          this.confirmDeleteAccount(account._id);
        }}
      >
        <wa-icon name="trash" size="xs"></wa-icon>
      </wa-button>
    `;
  }

  private _renderAccountContent(account: AccountWithRepos) {
    if (account.repos.length === 0) {
      return html`
        <div class="no-repos">
          <p>No repositories using this account. </br>
          <a
            href="/design-docs/$all"
            @click=${(e: Event) => {
              e.preventDefault();
              e.stopPropagation();
              getContext().router.navigate('/design-docs/$all');
            }}
            >Register a repository</a
          ></p>
        </div>
      `;
    }
    return html`
      <cca-data-table
        row-key="key"
        .columns=${this._getTargetColumns() as unknown as TableColumn[]}
        .rows=${flattenReposToTargets(account.repos) as unknown as Record<string, unknown>[]}
        .loading=${false}
        empty-message="No repositories"
      ></cca-data-table>
    `;
  }

  private _tooltipTargetId(prefix: string, rawId: string): string {
    return `${prefix}-${rawId.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
  }

  private _getTargetColumns(): TableColumn<RepoTargetRow>[] {
    return [
      {
        label: 'Repository',
        width: '25%',
        render: (row) => html`
          <a
            class="repo-name"
            href=${ifDefined(row.repo.url)}
            target="_blank"
            rel="noopener noreferrer"
            @click=${(e: Event) => e.stopPropagation()}
          >
            <span>${row.repo.name}</span>
          </a>
        `
      },
      {
        label: 'Branch',
        width: '10%',
        render: (row) => html`${row.target.branch}`
      },
      {
        label: 'Design Root',
        width: '15%',
        render: (row) => html`${row.target.path}`
      },
      {
        label: 'Target',
        width: '25%',
        render: (row) => html`
          <div class="target-wrapper">
            <wa-badge
              class="target"
              appearance="outlined"
              pill
              @click=${(e: Event) => {
                e.stopPropagation();
                this.openTarget(row.target);
              }}
              >${this.serverLabel(row.target.server_id)} /
              ${row.target.db_name}</wa-badge
            >
            <wa-tooltip for=${this._tooltipTargetId('unlink-target', row.key)}
              >Unlink target</wa-tooltip
            >
            <wa-button
              id=${this._tooltipTargetId('unlink-target', row.key)}
              class="row-action-button"
              appearance="outlined"
              size="xs"
              @click=${(e: Event) => {
                e.stopPropagation();
                this.confirmUnlinkTarget(row.repo._id!, row.target);
              }}
            >
              <wa-icon name="link-slash"></wa-icon>
            </wa-button>
          </div>
        `
      },
      {
        label: 'Sync status',
        width: '12%',
        render: (row) => html`
          <wa-badge
            variant=${SYNC_VARIANT[row.repo.sync_status ?? ''] ?? 'neutral'}
            appearance="accent"
            pill
          >
            ${row.repo.sync_status}
          </wa-badge>
        `
      },
      {
        label: 'Last sync',
        width: '13%',
        render: (row) =>
          html`${row.repo.last_sync ? new Date(row.repo.last_sync).toLocaleString() : '—'}`
      }
    ];
  }

  private confirmDeleteAccount(accountId: string) {
    this.accountToDelete = accountId;
    this.showDeleteAccountConfirm = true;
  }

  private async handleDeleteAccount() {
    if (!this.accountToDelete) return;

    try {
      await getContext().designMgmt.deleteGitAccount(this.accountToDelete);

      // Remove from local state
      this.accountsWithRepos = this.accountsWithRepos.filter(
        (a) => a._id !== this.accountToDelete
      );

      this.showDeleteAccountConfirm = false;
      this.accountToDelete = null;

      toast('Git account disconnected successfully', 'success');
    } catch (error) {
      log.error('Failed to delete git account', error as Error);
      toast(`Failed to disconnect account: ${errorMessage(error)}`, 'error');
    }
  }

  private _renderDeleteAccountDialog() {
    return html`
      <wa-dialog
        label="Disconnect Git Account"
        ?open=${this.showDeleteAccountConfirm}
        @wa-request-close=${() => {
          this.showDeleteAccountConfirm = false;
          this.accountToDelete = null;
        }}
      >
        <p>Are you sure you want to disconnect this Git account?</p>
        <p style="color: var(--wa-color-warning-on-loud);">
          <wa-icon name="triangle-exclamation"></wa-icon>
          This will permanently remove the account connection.
        </p>
        <div
          slot="footer"
          style="display: flex; gap: 0.5rem; justify-content: flex-end;"
        >
          <wa-button
            appearance="outlined"
            @click=${() => {
              this.showDeleteAccountConfirm = false;
              this.accountToDelete = null;
            }}
          >
            Cancel
          </wa-button>
          <wa-button variant="danger" @click=${this.handleDeleteAccount}>
            Disconnect Account
          </wa-button>
        </div>
      </wa-dialog>
    `;
  }

  // ---------------------------------------------------------------------------
  // Editing an account (#9) — its label, and where its access token is kept (D12).
  // ---------------------------------------------------------------------------

  /** Re-read from the list every time, so a reload underneath the drawer wins over a stale copy. */
  private get _editingAccount(): AccountWithRepos | null {
    return (
      this.accountsWithRepos.find((a) => a._id === this.editAccountId) ?? null
    );
  }

  private _openAccountEditor(account: AccountWithRepos) {
    this.editAccountId = account._id;
    this.editLabel = account.label;
    this.editCredentialMode = account.credential_mode ?? 'none';
    this.editToken = '';
    this.editNeedsToken = false;
    this.savingAccount = false;
    this.showEditAccountDrawer = true;
  }

  private _closeAccountEditor() {
    this.showEditAccountDrawer = false;
    this.editAccountId = null;
    this.editLabel = '';
    this.editCredentialMode = 'none';
    // Clearing the token on close is the point: the drawer holds a live PAT for as long as it is
    // open and not one keystroke longer.
    this.editToken = '';
    this.editNeedsToken = false;
    this.savingAccount = false;
  }

  /** Applies a saved change to the in-memory list, so the screen updates without a full reload. */
  private _applyAccountUpdate(
    accountId: string,
    patch: Partial<AccountWithRepos>
  ) {
    this.accountsWithRepos = this.accountsWithRepos.map((account) =>
      account._id === accountId ? { ...account, ...patch } : account
    );
  }

  /**
   * Rename first, then move the token: the rename is the reversible half, and doing it first means
   * a `token_required` answer leaves the drawer open on an account already carrying its new name
   * rather than replaying the rename on every retry (`_editingAccount` is re-read, so the second
   * pass sees the label as unchanged).
   */
  private async _saveAccountEdits() {
    const account = this._editingAccount;
    if (!account) return;

    const label = this.editLabel.trim();
    if (!label) {
      toast('Account label is required', 'error');
      return;
    }

    const storedMode = account.credential_mode ?? 'none';
    const done: string[] = [];
    this.savingAccount = true;
    try {
      if (label !== account.label) {
        const renamed = await getContext().designMgmt.renameGitAccount(
          account._id,
          label
        );
        this._applyAccountUpdate(account._id, { label: renamed.label });
        done.push(`Renamed to "${label}".`);
      }

      if (this.editCredentialMode !== storedMode) {
        const token = this.editToken.trim();
        const result = await getContext().designMgmt.changeCredentialMode(
          account._id,
          this.editCredentialMode,
          token || undefined
        );

        // Nothing was moved, so nothing may be reported as moved. The drawer stays open and grows
        // a token field; any rename above already happened and is already on screen.
        if (result.status === 'token_required') {
          this.editNeedsToken = true;
          return;
        }

        this._applyAccountUpdate(account._id, { credential_mode: result.to });
        done.push(credentialMoveConfirmation(label, result.from, result.to));
      }

      if (done.length > 0) toast(done.join(' '), 'success');
      this._closeAccountEditor();
    } catch (error) {
      log.error('Failed to update git account', error as Error);
      toast(`Failed to update account: ${errorMessage(error)}`, 'error');
    } finally {
      this.savingAccount = false;
    }
  }

  private _renderEditAccountDrawer() {
    const account = this._editingAccount;
    return html`
      <wa-drawer
        data-account-edit
        label="Edit Git Account"
        ?open=${this.showEditAccountDrawer}
        @wa-request-close=${() => this._closeAccountEditor()}
      >
        ${account ? this._renderEditAccountForm(account) : nothing}
        <div
          slot="footer"
          style="display: flex; gap: 0.5rem; justify-content: flex-end;"
        >
          <wa-button appearance="outlined" @click=${() => this._closeAccountEditor()}>
            Cancel
          </wa-button>
          <wa-button
            data-save-account
            variant="brand"
            ?disabled=${this.savingAccount}
            @click=${() => void this._saveAccountEdits()}
          >
            ${this.savingAccount ? 'Saving…' : 'Save changes'}
          </wa-button>
        </div>
      </wa-drawer>
    `;
  }

  /**
   * The credential picker is the connect flow's, reused rather than restated (I9-5): its options
   * and their cautions are the single source the README's credential table is generated from, and
   * a second wording here would drift from what the app promises. It reads only `credentialMode`
   * and `onCredentialModeChange` out of the state/callback pair it is handed, so the connect
   * flow's own pair stands in for the rest, unused.
   */
  private _renderEditAccountForm(account: AccountWithRepos) {
    const storedMode = account.credential_mode ?? 'none';
    return html`
      <div class="account-edit-form">
        <wa-input
          name="account-label"
          label="Account Label"
          placeholder="e.g., work-github"
          .value=${this.editLabel}
          @input=${(e: Event) => {
            this.editLabel = (e.target as HTMLInputElement).value;
          }}
        ></wa-input>

        ${this._renderAccountFacts(account)}

        ${renderCredentialModePicker(
          { ...this._getConnectDialogState(), credentialMode: this.editCredentialMode },
          {
            ...this._getConnectDialogCallbacks(),
            onCredentialModeChange: (mode) => {
              this.editCredentialMode = mode;
            }
          }
        )}
        ${this.editCredentialMode === storedMode
          ? nothing
          : html`
              <p class="edit-warning">
                <wa-icon name="triangle-exclamation"></wa-icon>
                ${credentialMoveWarning(storedMode, this.editCredentialMode)}
              </p>
            `}
        ${this._renderTokenField(account)}
      </div>
    `;
  }

  /**
   * Only ever holds what the user just typed. No token is rendered back: the service cannot hand
   * one over (`maskAccount` is an allow-list), and this drawer must not become the place a PAT is
   * displayed.
   */
  private _renderTokenField(account: AccountWithRepos) {
    if (!this.editNeedsToken) return nothing;
    return html`
      <div>
        <wa-input
          name="account-token"
          label="Access Token"
          type="password"
          .value=${this.editToken}
          @input=${(e: Event) => {
            this.editToken = (e.target as HTMLInputElement).value;
          }}
        ></wa-input>
        <p class="edit-note">
          ${tokenNeededMessage(account.label, this.editCredentialMode)}
        </p>
      </div>
    `;
  }

  private _renderAccountFacts(account: AccountWithRepos) {
    return html`
      <div class="account-facts">
        <span class="fact-label">Provider</span>
        <span>${this.providerName(account.provider)}</span>
        <span class="fact-label">Username</span>
        <span>${account.username || '—'}</span>
        <span class="fact-label">Base URL</span>
        <span>${account.base_url || 'Provider default'}</span>
      </div>
      <p class="edit-note">
        Provider and base URL are fixed. An access token is issued for one host, and every
        repository registered under this account is identified by that host — repointing the
        account here would silently orphan all of them. Moving an account to another host is a
        separate operation that has to re-verify the token against it first.
      </p>
    `;
  }

  private confirmDeleteRepo(repoId: string, repoName: string) {
    this.repoToDelete = { id: repoId, name: repoName };
    this.showDeleteRepoConfirm = true;
  }

  private async handleDeleteRepo() {
    if (!this.repoToDelete) return;

    try {
      await getContext().designMgmt.deleteRepo(this.repoToDelete.id);

      // Remove from local state
      this.accountsWithRepos = this.accountsWithRepos.map((account) => ({
        ...account,
        repos: account.repos.filter((r) => r._id !== this.repoToDelete!.id)
      }));
      this.repos = this.repos.filter((r) => r._id !== this.repoToDelete!.id);

      this.showDeleteRepoConfirm = false;
      this.repoToDelete = null;

      toast('Repository deleted successfully', 'success');
    } catch (error) {
      log.error('Failed to delete repository', error as Error);
      toast(`Failed to delete repository: ${errorMessage(error)}`, 'error');
    }
  }

  private _renderDeleteRepoDialog() {
    return html`
      <wa-dialog
        label="Delete Repository"
        ?open=${this.showDeleteRepoConfirm}
        @wa-request-close=${() => {
          this.showDeleteRepoConfirm = false;
          this.repoToDelete = null;
        }}
      >
        <p>Delete repository <strong>${this.repoToDelete?.name}</strong>?</p>
        <p style="color: var(--wa-color-warning-on-loud);">
          <wa-icon name="triangle-exclamation"></wa-icon>
          This will remove all sync connections for this repository.
        </p>
        <div
          slot="footer"
          style="display: flex; gap: 0.5rem; justify-content: flex-end;"
        >
          <wa-button
            appearance="outlined"
            @click=${() => {
              this.showDeleteRepoConfirm = false;
              this.repoToDelete = null;
            }}
          >
            Cancel
          </wa-button>
          <wa-button variant="danger" @click=${this.handleDeleteRepo}>
            Delete Repository
          </wa-button>
        </div>
      </wa-dialog>
    `;
  }

  private confirmUnlinkTarget(repoId: string, target: RepoTarget) {
    this.unlinkTarget = { repoId, target };
    this.showUnlinkConfirm = true;
  }

  private async handleUnlinkTarget() {
    if (!this.unlinkTarget) return;

    const { repoId, target } = this.unlinkTarget;

    try {
      const result = await getContext().designMgmt.unlinkRepo(
        repoId,
        target.server_id,
        target.db_name
      );

      // Nothing was linked, so nothing was removed (issue #6 item 1). Reported plainly rather
      // than as a success — "Target unlinked (2 connections remain)" for a target that was never
      // linked is a confirmation of something that did not happen — and not as an error either:
      // the user wanted this database not linked to this repository, and it isn't. The local
      // listing is deliberately left alone; the branch below would filter out a repository whose
      // targets are all gone, dropping a repository the service explicitly kept.
      if (result.action === 'not_linked') {
        this.showUnlinkConfirm = false;
        this.unlinkTarget = null;
        toast(
          `${target.server_id} / ${target.db_name} is not linked to this repository — nothing to do.`,
          'info'
        );
        return;
      }

      // Update local state
      if (result.action === 'repo_deleted') {
        this.accountsWithRepos = this.accountsWithRepos.map((account) => ({
          ...account,
          repos: account.repos.filter((r) => r._id !== repoId)
        }));
        this.repos = this.repos.filter((r) => r._id !== repoId);
      } else {
        this.accountsWithRepos = this.accountsWithRepos.map((account) => ({
          ...account,
          repos: account.repos
            .map((repo) => {
              if (repo._id === repoId) {
                return {
                  ...repo,
                  sync_targets: repo.sync_targets?.filter(
                    (t) =>
                      !(
                        t.server_id === target.server_id &&
                        t.db_name === target.db_name
                      )
                  )
                };
              }
              return repo;
            })
            .filter((repo) => (repo.sync_targets?.length ?? 0) > 0)
        }));
      }

      this.showUnlinkConfirm = false;
      this.unlinkTarget = null;

      const message =
        result.action === 'repo_deleted'
          ? 'Repository unlinked and deleted (was last connection)'
          : `Target unlinked (${result.remaining_targets} connections remain)`;

      toast(message, 'success');
    } catch (error) {
      log.error('Failed to unlink target', error as Error);
      toast(`Failed to unlink: ${errorMessage(error)}`, 'error');
    }
  }

  private _renderUnlinkTargetDialog() {
    return html`
      <wa-dialog
        label="Unlink Repository Target"
        ?open=${this.showUnlinkConfirm}
        @wa-request-close=${() => {
          this.showUnlinkConfirm = false;
          this.unlinkTarget = null;
        }}
      >
        <p>
          Unlink
          <strong
            >${this.unlinkTarget?.target.server_id} /
            ${this.unlinkTarget?.target.db_name}</strong
          >?
        </p>
        <p style="color: var(--wa-color-warning-on-loud);">
          <wa-icon name="triangle-exclamation"></wa-icon>
          This will remove the sync connection for this database.
          ${this._shouldWarnAboutLastTarget() ? 'This is the last target - the repository will be deleted.' : ''}
        </p>
        <div
          slot="footer"
          style="display: flex; gap: 0.5rem; justify-content: flex-end;"
        >
          <wa-button
            appearance="outlined"
            @click=${() => {
              this.showUnlinkConfirm = false;
              this.unlinkTarget = null;
            }}
          >
            Cancel
          </wa-button>
          <wa-button variant="danger" @click=${this.handleUnlinkTarget}>
            Unlink
          </wa-button>
        </div>
      </wa-dialog>
    `;
  }

  private _shouldWarnAboutLastTarget(): boolean {
    if (!this.unlinkTarget) return false;
    const repo = this.repos.find((r) => r._id === this.unlinkTarget!.repoId);
    return (repo?.sync_targets?.length ?? 0) === 1;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'cca-repo-overview': CcaRepoOverview;
  }
}
