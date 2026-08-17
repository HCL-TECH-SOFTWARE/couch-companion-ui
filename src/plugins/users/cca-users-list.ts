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
import { customElement, property, state, query } from 'lit/decorators.js';
// button/icon/dialog/input come from webawesome.ts's barrel (loaded once by
// cca-shell.ts), not self-imported here — see cca-user-detail.ts for why. wa-tag is
// NOT in that barrel, so it keeps its own explicit import below.
import '@awesome.me/webawesome/dist/components/tag/tag.js';
import '../../components/cca-data-table.js';
import { CcaElement } from '../../components/cca-element.js';
import { getContext } from '../../context.js';
import { toast } from '../../components/cca-toast.js';
import { addHeaderActions, clearHeaderActions } from '../../components/cca-header.js';
import type { TableColumn } from '../../components/cca-data-table.js';
import type { UserDoc } from './types.js';

/** Lists `_users` documents for a chosen server with open/create/delete.
 * Server selection happens in the header's picker; this component only reads
 * the route-derived server id (#759). */
@customElement('cca-users-list')
export class CcaUsersList extends CcaElement {
  static styles = css`
    .roles {
      display: flex;
      flex-wrap: wrap;
      gap: 0.3rem;
    }
    .actions-cell {
      display: flex;
      gap: 0.4rem;
    }
  `;

  /** Route param: a concrete server id, or "$all" when none is selected yet. */
  @property({ type: String }) serverId = '';

  @state() private _selectedServerId = '';
  @state() private _users: UserDoc[] = [];
  @state() private _loading = false;
  @state() private _deleteId = '';
  @state() private _search = '';

  @query('wa-dialog[data-confirm-delete]') private _deleteDialog?: HTMLElement & { open: boolean };

  override connectedCallback() {
    super.connectedCallback();
    clearHeaderActions();
    addHeaderActions([
      {
        icon: 'user-plus',
        tooltip: 'New User',
        action: () => this._newUser(),
      },
    ]);
    void this._loadServers();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    clearHeaderActions();
  }

  private async _loadServers() {
    try {
      const { servers } = await getContext().serverMgmt.listServers();
      if (this.serverId && this.serverId !== '$all') {
        this._selectedServerId = this.serverId;
      } else if (servers.length === 1) {
        // Reached via a legacy `$all` deep link. There is exactly one server,
        // so adopt it here instead of routing a selection through the app (the
        // selection plumbing and its header picker are gone, #31).
        this._selectedServerId = servers[0].id;
      }
      if (this._selectedServerId) {
        void this._loadUsers();
      }
      // No concrete server to fall back on: the empty state below explains it.
    } catch (err: unknown) {
      toast(`Failed to load servers: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  }

  private async _loadUsers() {
    if (!this._selectedServerId) return;
    this._loading = true;
    try {
      this._users = await getContext().users.listUsers(this._selectedServerId);
    } catch (err: unknown) {
      toast(`Failed to load users: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      this._loading = false;
    }
  }

  private _newUser() {
    if (!this._selectedServerId) {
      toast('Select a server first.', 'info');
      return;
    }
    getContext().router.navigate(`/users/${encodeURIComponent(this._selectedServerId)}/new`);
  }

  private _openUser(userId: string) {
    getContext().router.navigate(
      `/users/${encodeURIComponent(this._selectedServerId)}/${encodeURIComponent(userId)}`,
    );
  }

  private _askDelete(userId: string) {
    this._deleteId = userId;
    void this.updateComplete.then(() => {
      if (this._deleteDialog) this._deleteDialog.open = true;
    });
  }

  /** Public for tests: perform the delete and reload. */
  async confirmDelete(userId: string) {
    if (this._deleteDialog) this._deleteDialog.open = false;
    try {
      const rev = this._users.find((u) => u._id === userId)?._rev ?? '';
      await getContext().users.deleteUser(this._selectedServerId, userId, rev);
      toast('User deleted.', 'success');
      await this._loadUsers();
    } catch (err: unknown) {
      toast(`Failed to delete user: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  }

  private get _filteredUsers(): UserDoc[] {
    const q = this._search.trim().toLowerCase();
    if (!q) return this._users;
    return this._users.filter(
      (u) =>
        (u.name ?? '').toLowerCase().includes(q) ||
        (u.roles ?? []).some((r) => r.toLowerCase().includes(q)),
    );
  }

  private get _columns(): TableColumn<UserDoc>[] {
    return [
      { label: 'Username', key: 'name' },
      {
        label: 'Roles',
        render: (u) =>
          (u.roles?.length ?? 0) === 0
            ? '—'
            : html`<div class="roles">
                ${u.roles.map((r) => html`<wa-tag pill size="small">${r}</wa-tag>`)}
              </div>`,
      },
      {
        label: 'Actions',
        width: '9rem',
        render: (u) => html`<div class="actions-cell">
          <wa-button
            size="s"
            appearance="outlined"
            class="row-action-button"
            @click=${(e: Event) => {
              e.stopPropagation();
              this._openUser(u._id);
            }}
            ><wa-icon name="pen-to-square"></wa-icon
          ></wa-button>
          <wa-button
            size="s"
            variant="danger"
            appearance="outlined"
            class="row-action-button"
            @click=${(e: Event) => {
              e.stopPropagation();
              this._askDelete(u._id);
            }}
            ><wa-icon name="trash-can"></wa-icon
          ></wa-button>
        </div>`,
      },
    ];
  }

  render() {
    return html`
      <wa-input
        placeholder="Search users…"
        .value=${this._search}
        @input=${(e: Event) => (this._search = (e.target as HTMLInputElement).value)}
        @wa-clear=${() => (this._search = '')}
        style="margin-bottom:1rem;display:block"
        clearable
      ></wa-input>

      <cca-data-table
        .columns=${this._columns as any[]}
        .rows=${this._filteredUsers}
        .loading=${this._loading}
        row-key="_id"
        empty-message=${this._selectedServerId
          ? 'No users found.'
          : 'No CouchDB server available.'}
        @cca-row-click=${(e: CustomEvent<UserDoc>) => this._openUser(e.detail._id)}
      ></cca-data-table>

      <wa-dialog data-confirm-delete label="Delete user?">
        <p>Delete <strong>${this._deleteId}</strong>? This cannot be undone.</p>
        <div slot="footer" style="display:flex;gap:0.5rem;justify-content:flex-end">
          <wa-button @click=${() => this._deleteDialog && (this._deleteDialog.open = false)}
            >Cancel</wa-button
          >
          <wa-button variant="danger" appearance="filled" @click=${() => void this.confirmDelete(this._deleteId)}
            >Delete</wa-button
          >
        </div>
      </wa-dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'cca-users-list': CcaUsersList;
  }
}
