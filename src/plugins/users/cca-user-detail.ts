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

import { LitElement, html, css } from 'lit';
import { customElement, property, state, query } from 'lit/decorators.js';
// card/input/button/icon/spinner/tab-group/tab/tab-panel come from webawesome.ts's
// barrel (loaded once by cca-shell.ts), not self-imported here — a duplicate
// customElements.define under a differently-hashed dev-server chunk is what threw
// "wa-icon has already been used with this registry" when this plugin lazy-loaded.
import './cca-roles-picker.js';
import './cca-change-password-dialog.js';
import '../../components/cca-monaco-editor.js';
import { getContext } from '../../context.js';
import { toast } from '../../components/cca-toast.js';
import {
  buildCreateDoc,
  buildUpdateDoc,
  collectRoles,
  maskDocForPreview,
  mergeCandidateRoles,
  PASSWORD_MASK,
  validateUsername,
} from './users-doc.js';
import type { CcaChangePasswordDialog } from './cca-change-password-dialog.js';

/** Create/edit a `_users` document with Form and Source tabs. */
@customElement('cca-user-detail')
export class CcaUserDetail extends LitElement {
  static styles = css`
    .field {
      margin-bottom: 1rem;
      max-width: 32rem;
    }
    label {
      display: block;
      font-weight: var(--wa-font-weight-bold);
      margin-bottom: 0.25rem;
    }
    .id {
      font-family: var(--wa-font-family-code, monospace);
      color: var(--wa-color-text-quiet);
      font-size: var(--wa-font-size-s);
    }
    .raw {
      height: 50vh;
      border: 1px solid var(--wa-color-neutral-border-normal);
      overflow: hidden;
    }
    .actions {
      display: flex;
      gap: 0.5rem;
      margin-top: 1rem;
    }
    .error {
      color: var(--wa-color-danger-on-quiet);
      margin-top: 0.5rem;
    }
    .pw-match {
      margin-top: 0.4rem;
      font-size: var(--wa-font-size-s);
    }
    .pw-match.ok {
      color: var(--wa-color-success-on-quiet);
    }
    .pw-match.bad {
      color: var(--wa-color-danger-on-quiet);
    }
  `;

  /** Route param: the CouchDB server id. */
  @property({ type: String }) serverId = '';
  /** Route param: the user `_id`, or "new"/"" for create mode. */
  @property({ type: String }) userId = '';

  @state() private _name = '';
  @state() private _roles: string[] = [];
  @state() private _candidateRoles: string[] = [];
  @state() private _original: Record<string, unknown> | null = null;
  @state() private _stagedPassword = '';
  @state() private _loading = false;
  @state() private _saving = false;
  @state() private _error = '';
  @state() private _activeTab: 'form' | 'raw' = 'form';
  @state() private _pwValue = '';
  @state() private _pw2Value = '';
  /** The Source tab's own editable text — a snapshot taken when the tab is switched to,
   *  then independent of the Form tab until switched to again (#85). */
  @state() private _rawText = '';

  @query('wa-input[data-pw]') private _pw?: HTMLInputElement;
  @query('wa-input[data-pw2]') private _pw2?: HTMLInputElement;
  @query('cca-change-password-dialog') private _pwDialog?: CcaChangePasswordDialog;

  get _isCreateMode(): boolean {
    return !this.userId || this.userId === 'new';
  }

  override connectedCallback() {
    super.connectedCallback();
    if (!this._isCreateMode) void this._load();
    void this._loadCandidateRoles();
  }

  private async _loadCandidateRoles() {
    if (!this.serverId) return;
    const [users, dbRoles] = await Promise.allSettled([
      getContext().users.listUsers(this.serverId),
      getContext().dbMgmt.listDatabaseRoles(this.serverId),
    ]);
    const userRoles = users.status === 'fulfilled' ? collectRoles(users.value) : [];
    const securityRoles = dbRoles.status === 'fulfilled' ? (dbRoles.value.roles ?? []) : [];
    this._candidateRoles = mergeCandidateRoles(userRoles, securityRoles);
  }

  private async _load() {
    if (!this.serverId) {
      toast('No server selected — cannot load the user.', 'error');
      return;
    }
    this._loading = true;
    try {
      const doc = await getContext().users.getUser(this.serverId, this.userId);
      this._original = doc;
      this._name = String(doc.name ?? '');
      this._roles = Array.isArray(doc.roles) ? (doc.roles as string[]) : [];
    } catch (err: unknown) {
      toast(`Failed to load user: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      this._loading = false;
    }
  }

  /** The exact document that will be submitted. */
  private _buildSubmitDoc(): Record<string, unknown> {
    if (this._isCreateMode) {
      return buildCreateDoc({
        name: this._name,
        password: this._pw?.value || undefined,
        roles: this._roles,
      });
    }
    return buildUpdateDoc(this._original ?? {}, {
      roles: this._roles,
      newPassword: this._stagedPassword || undefined,
    });
  }

  private _rawJson(): string {
    return JSON.stringify(maskDocForPreview(this._buildSubmitDoc()), null, 2);
  }

  private async _save() {
    this._error = '';

    if (this._activeTab === 'raw') {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(this._rawText);
      } catch {
        this._error = 'The Source tab does not contain valid JSON.';
        return;
      }
      // Changing _id here would create a different document rather than update this one —
      // CouchDB has no rename, only delete-and-recreate, which this screen does not offer (#85).
      if (!this._isCreateMode && parsed._id !== this.userId) {
        this._error = "The document's _id cannot be changed here — revert it in Source before saving.";
        return;
      }
      // maskDocForPreview only ever puts a "password" key in the Source snapshot when a real
      // one was staged (Change Password dialog) or typed (create mode) — so if it still reads
      // as the mask, the actual value is known and gets restored here rather than either
      // submitted literally as '••••••' or silently dropped, which would discard the change.
      if (parsed.password === PASSWORD_MASK) {
        const staged = this._isCreateMode ? this._pw?.value || '' : this._stagedPassword;
        if (staged) parsed.password = staged;
        else delete parsed.password;
      }
      await this._submit(parsed);
      return;
    }

    if (this._isCreateMode) {
      const nameErr = validateUsername(this._name);
      if (nameErr) {
        this._error = nameErr;
        return;
      }
      const pw = this._pw?.value ?? '';
      const pw2 = this._pw2?.value ?? '';
      if (!pw) {
        this._error = 'A password is required for a new user.';
        return;
      }
      if (pw !== pw2) {
        this._error = 'Passwords do not match.';
        return;
      }
    }
    await this._submit(this._buildSubmitDoc());
  }

  private async _submit(body: Record<string, unknown>) {
    this._saving = true;
    try {
      await getContext().users.saveUser(this.serverId, body);
      toast(this._isCreateMode ? 'User created.' : 'User updated.', 'success');
      getContext().router.navigate(`/users/${encodeURIComponent(this.serverId)}`);
    } catch (err: unknown) {
      this._error = err instanceof Error ? err.message : String(err);
      toast(`Failed to save user: ${this._error}`, 'error');
    } finally {
      this._saving = false;
    }
  }

  private _onPasswordConfirmed(e: CustomEvent<{ password: string }>) {
    this._stagedPassword = e.detail.password;
    toast('New password staged — it will be applied when you Save.', 'info');
  }

  /** Live red/green indicator comparing the password and its repeat. */
  private _renderPwMatch() {
    if (!this._pw2Value) return '';
    const ok = this._pwValue === this._pw2Value;
    return html`<div data-pw-match class="pw-match ${ok ? 'ok' : 'bad'}">
      ${ok ? 'Passwords match' : "Passwords don't match"}
    </div>`;
  }

  private _renderForm() {
    return html`
      <div class="field">
        <label>Username</label>
        ${this._isCreateMode
          ? html`<wa-input
              data-name
              placeholder="e.g. alice"
              .value=${this._name}
              @input=${(e: Event) =>
                (this._name = (e.target as HTMLInputElement).value
                  .toLowerCase()
                  .replace(/[^a-z0-9_-]/g, ''))}
            ></wa-input>`
          : html`<div class="id">${this._name}</div>`}
        <div class="id">
          _id: ${this._isCreateMode ? `org.couchdb.user:${this._name}` : this.userId}
        </div>
      </div>

      <div class="field">
        <label>Roles</label>
        <cca-roles-picker
          .selected=${this._roles}
          .candidates=${this._candidateRoles}
          @roles-change=${(e: CustomEvent<string[]>) => (this._roles = e.detail)}
        ></cca-roles-picker>
      </div>

      <div class="field">
        <label>Password</label>
        ${this._isCreateMode
          ? html`
              <wa-input
                data-pw
                type="password"
                placeholder="Password"
                password-toggle
                @input=${(e: Event) => (this._pwValue = (e.target as HTMLInputElement).value)}
              ></wa-input>
              <wa-input
                data-pw2
                type="password"
                placeholder="Repeat password"
                password-toggle
                style="margin-top:0.5rem"
                @input=${(e: Event) => (this._pw2Value = (e.target as HTMLInputElement).value)}
              ></wa-input>
              ${this._renderPwMatch()}
            `
          : html`
              <wa-button data-change-pw @click=${() => this._pwDialog?.open()}>
                <wa-icon slot="start" name="key"></wa-icon>Change Password
              </wa-button>
              ${this._stagedPassword
                ? html`<span class="id" style="margin-left:0.5rem">New password staged.</span>`
                : ''}
            `}
      </div>
    `;
  }

  render() {
    if (this._loading) return html`<wa-spinner></wa-spinner>`;
    return html`
      <wa-card>
        <h2>${this._isCreateMode ? 'New User' : `Edit ${this._name}`}</h2>
        <wa-tab-group
          .active=${this._activeTab}
          @wa-tab-show=${(e: CustomEvent<{ name: string }>) => {
            const next = e.detail.name === 'raw' ? 'raw' : 'form';
            // Snapshot the current form state into Source only on the way in, so it starts
            // from what Form shows but is then a free-standing edit, not a mirror that
            // would overwrite what the user is typing on every re-render (#85).
            if (next === 'raw' && this._activeTab !== 'raw') {
              this._rawText = this._rawJson();
            }
            this._activeTab = next;
          }}
        >
          <wa-tab panel="form">Form</wa-tab>
          <wa-tab panel="raw">Source</wa-tab>
          <wa-tab-panel name="form">${this._renderForm()}</wa-tab-panel>
          <wa-tab-panel name="raw">
            <div class="raw">
              ${this._activeTab === 'raw'
                ? html`<cca-monaco-editor
                    language="json"
                    .value=${this._rawText}
                    @change=${(e: CustomEvent<{ value: string }>) =>
                      (this._rawText = e.detail.value)}
                  ></cca-monaco-editor>`
                : ''}
            </div>
          </wa-tab-panel>
        </wa-tab-group>

        ${this._error ? html`<div class="error">${this._error}</div>` : ''}

        <div class="actions">
          <wa-button
            data-save
            appearance="filled"
            variant="brand"
            ?disabled=${this._saving || !this.serverId}
            @click=${this._save}
          >
            ${this._saving ? 'Saving…' : 'Save'}
          </wa-button>
          <wa-button
            @click=${() =>
              getContext().router.navigate(`/users/${encodeURIComponent(this.serverId)}`)}
          >
            Cancel
          </wa-button>
        </div>

        <cca-change-password-dialog
          @password-confirmed=${this._onPasswordConfirmed}
        ></cca-change-password-dialog>
      </wa-card>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'cca-user-detail': CcaUserDetail;
  }
}
