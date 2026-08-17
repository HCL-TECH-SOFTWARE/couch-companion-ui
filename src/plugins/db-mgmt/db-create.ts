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
import { CcaElement } from '../../components/cca-element.js';
import { getContext } from '../../context.js';
import { toast } from '../../components/cca-toast.js';
import { SINGLE_SERVER_ID } from '../../services/single-server.js';
import type { DatabaseAccess } from './types.js';
import { ApiError } from '../../services/api-error.js';
import './db-permissions.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/spinner/spinner.js';
import '@awesome.me/webawesome/dist/components/input/input.js';
import '@awesome.me/webawesome/dist/components/checkbox/checkbox.js';

/**
 * Single-server database creation form (spec D3): name, partitioned flag, and optional
 * initial permissions. The multi-server co-create table and its replication toggles are
 * gone — there is exactly one server, so `createDatabase` always receives a one-element
 * `servers` array addressed at {@link SINGLE_SERVER_ID}.
 */
@customElement('cca-db-create')
export class CcaDbCreate extends CcaElement {
  /** When true, fires cca-db-created / cca-db-cancel instead of navigating. */
  @property({ type: Boolean }) embedded = false;

  @state() private _dbName = '';
  @state() private _partitioned = false;
  @state() private _access: DatabaseAccess = {
    admin: { name: [], roles: ['_admin'] },
    member: { name: [], roles: ['_admin'] }
  };
  @state() private _error = '';
  @state() private _submitting = false;

  static override get styles() {
    return css`
      :host {
        display: block;
      }
      .container {
        max-width: 50rem;
        color: var(--wa-color-text-normal, #1f2a35);
      }
      .grid-row {
        display: grid;
        grid-template-columns: 16rem 1fr;
        align-items: center;
        gap: 0.75rem;
        margin-bottom: 0.75rem;
      }
      .label-strong {
        font-weight: var(--wa-font-weight-semibold);
      }
      .db-input-row {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        flex-wrap: wrap;
      }
      .db-name-input {
        width: 32rem;
        max-width: 100%;
      }
      .checkbox-label {
        display: flex;
        align-items: center;
        gap: 0.4rem;
        cursor: pointer;
        font-size: var(--wa-font-size-s);
      }
      .permissions-section {
        margin: 0.75rem auto 0;
        padding-top: 1.25rem;
        width: 100%;
        display: flex;
        flex-direction: column;
        align-items: stretch;
      }
      .permissions-title {
        font-size: var(--wa-font-size-xs);
        font-weight: var(--wa-font-weight-semibold);
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--wa-color-text-quiet);
        margin-bottom: 0.5rem;
      }
      .button-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.75rem;
        margin-top: 0.75rem;
      }
      .button-row-right {
        display: flex;
        align-items: center;
        gap: 0.75rem;
      }
      .error-message {
        color: var(--wa-color-danger-on-quiet);
        font-size: var(--wa-font-size-s);
        white-space: nowrap;
      }
    `;
  }

  private async _handleCreate() {
    this._error = '';
    const dbName = this._dbName.trim().toLowerCase();
    if (!dbName) {
      this._error = 'Database name is required.';
      return;
    }
    this._submitting = true;
    try {
      await getContext().dbMgmt.createDatabase({
        db_name: dbName,
        setup_replication: false,
        servers: [
          {
            server_id: SINGLE_SERVER_ID,
            partitioned: this._partitioned,
            access: this._access
          }
        ]
      });

      toast('Database created', 'success');
      if (this.embedded) {
        this.dispatchEvent(
          new CustomEvent('cca-db-created', { bubbles: true, composed: true })
        );
      } else {
        getContext().router.navigate('/databases/$all');
      }
    } catch (err) {
      if (err instanceof ApiError) {
        this._error = (err.body as { detail?: string } | undefined)?.detail ?? String(err);
      } else {
        this._error = String((err as Error).message ?? err);
      }
    } finally {
      this._submitting = false;
    }
  }

  private _cancel() {
    if (this.embedded) {
      this.dispatchEvent(
        new CustomEvent('cca-db-cancel', { bubbles: true, composed: true })
      );
    } else {
      getContext().router.navigate('/databases/$all');
    }
  }

  override render() {
    return html`
      <div class="container">
        <div class="grid-row">
          <span class="label-strong">Database Name</span>
          <div class="db-input-row">
            <wa-input
              class="db-name-input"
              .value=${this._dbName}
              @input=${(e: Event) =>
                (this._dbName = (e.target as HTMLInputElement).value)}
              placeholder="e.g. users"
            ></wa-input>
            <label class="checkbox-label">
              <wa-checkbox
                .checked=${this._partitioned}
                @click=${(e: Event) => {
                  e.preventDefault();
                  this._partitioned = !this._partitioned;
                }}
              ></wa-checkbox>
              partitioned
            </label>
          </div>
        </div>

        <div class="permissions-section">
          <div class="permissions-title">Permissions</div>
          <cca-db-permissions
            .access=${this._access}
            @cca-permissions-change=${(e: CustomEvent) => {
              this._access = e.detail.access;
            }}
          ></cca-db-permissions>
        </div>

        <div class="button-row">
          <wa-button appearance="plain" @click=${() => this._cancel()}
            >Cancel</wa-button
          >
          <div class="button-row-right">
            ${this._error
              ? html`<div class="error-message">${this._error}</div>`
              : ''}
            <wa-button
              @click=${() => this._handleCreate()}
              ?disabled=${this._submitting || !this._dbName.trim()}
            >
              ${this._submitting
                ? html`<wa-spinner
                    style="font-size:var(--wa-font-size-m)"
                  ></wa-spinner>`
                : 'Create'}
            </wa-button>
          </div>
        </div>
      </div>
    `;
  }
}
