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

import { html, css, LitElement, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '../../components/cca-db-picker.js';
import './repl-auth-panel.js';
import type { CcaDbChangeDetail } from '../../components/cca-db-picker.js';
import type { Server } from './types.js';
import type { ReplAuthChangeDetail } from './repl-auth-panel.ts';

@customElement('cca-repl-source-section')
export class CcaReplSourceSection extends LitElement {
  static styles = css`
    :host {
      display: block;
    }

    details {
      border: 1px solid var(--wa-color-surface-border);
      border-radius: 8px;
      background: var(--wa-color-surface-raised);
      overflow: hidden;
    }

    summary {
      list-style: none;
      cursor: pointer;
      padding: 0.65rem 0.9rem;
      font-size: var(--wa-font-size-s);
      font-weight: var(--wa-font-weight-bold);
      color: var(--wa-color-text-normal);
      border-bottom: 1px solid transparent;
      background: var(--wa-color-surface-raised);
    }

    details[open] > summary {
      border-bottom-color: var(--wa-color-surface-border);
    }

    details > summary::-webkit-details-marker {
      display: none;
    }

    .section-body {
      padding: 0.9rem;
      display: grid;
      gap: 0.9rem;
    }

    .row {
      display: grid;
      grid-template-columns: 1fr 1fr auto;
      gap: 1rem;
      align-items: start;
    }

    /* Mirror a field's label row so the auth control lines up with the
       selects instead of dropping to the bottom of the taller helper text. */
    .auth-cell {
      display: grid;
      gap: 0.35rem;
    }

    .auth-cell-spacer {
      font-size: var(--wa-font-size-s);
      font-weight: var(--wa-font-weight-semibold);
    }

    label,
    .static-field {
      font-size: var(--wa-font-size-s);
      font-weight: var(--wa-font-weight-semibold);
      color: var(--wa-color-text-quiet);
      display: grid;
      gap: 0.35rem;
    }

    .static-value {
      font-size: var(--wa-font-size-m);
      font-weight: var(--wa-font-weight-bold);
      color: var(--wa-color-text-normal);
    }

    .helper-label {
      margin-top: 0.25rem;
      font-size: var(--wa-font-size-xs);
      color: var(--wa-color-text-quiet);
    }

    /* Sits on the helper line, so it must not drag that line's height around. */
    .helper-label wa-button {
      margin-inline-start: var(--wa-space-xs);
      vertical-align: baseline;
    }

    @media (max-width: 820px) {
      .row {
        grid-template-columns: 1fr;
      }
      .auth-cell-spacer {
        display: none;
      }
    }
  `;

  @property({ attribute: false }) servers: Server[] = [];
  @property({ attribute: false }) databases: string[] = [];
  /**
   * The host could not fetch {@link databases} — offer free text instead of a dropdown that
   * can never fill. Forwarded verbatim to `cca-db-picker`; see `repl-editor`'s
   * `loadDatabases`, which is the only thing that decides this.
   */
  @property({ type: Boolean }) databasesUnavailable = false;
  /** Why {@link databasesUnavailable} is set; shown under the free-text field. */
  @property({ type: String }) databasesReason = '';
  @property({ type: String }) sourceServer = '';
  @property({ type: String }) sourceDb = '';
  @property({ attribute: false }) auth: Record<string, string> = {};

  private selectedServerLabel(serverId: string): string {
    if (!serverId) return 'None';
    const server = this.servers.find((item) => item.id === serverId);
    return server ? `${server.name} (${server.id})` : serverId;
  }

  /**
   * The one way a source database leaves this section. `cca-db-picker` speaks `cca-db-change`
   * / `{ database }`; `repl-editor` has always listened for `cca-source-db-change` /
   * `{ sourceDb }`, and keeping that name means the editor needs no change at all.
   */
  private emitSourceDb(sourceDb: string) {
    this.dispatchEvent(
      new CustomEvent('cca-source-db-change', {
        detail: { sourceDb },
        bubbles: true,
        composed: true
      })
    );
  }

  /**
   * Un-choosing a database. The `wa-select` this section used to render carried a blank
   * `<wa-option value="">Select database</wa-option>` as its first entry, and that blank row
   * was the only way back to "no source database" once one had been picked — a real state, and
   * the one a half-finished replication sits in.
   *
   * `cca-db-picker` does not render that option: it uses a placeholder, and its free-text half
   * has no options at all. `wa-select`'s own `with-clear` would only cover the dropdown half,
   * and only by changing a component three screens share. An explicit button, rendered here,
   * covers both halves of the picker and reads the same in each.
   */
  private renderClearButton() {
    if (!this.sourceDb) return nothing;
    return html`<wa-button
      data-clear-source-db
      type="button"
      size="s"
      appearance="plain"
      @click=${() => this.emitSourceDb('')}
      >Clear</wa-button
    >`;
  }

  render() {
    return html`
      <div class="section-body">
        <div class="row">
          <div class="static-field">
            Source Server
            <div class="static-value">${this.selectedServerLabel(this.sourceServer)}</div>
            <div class="helper-label">
              This deployment manages one CouchDB server, so replication always
              reads from it.
            </div>
          </div>
          <label>
            Source Database
            <cca-db-picker
              .databases=${this.databases}
              .value=${this.sourceDb}
              .unavailable=${this.databasesUnavailable}
              .reason=${this.databasesReason}
              @cca-db-change=${(e: CustomEvent<CcaDbChangeDetail>) =>
                  this.emitSourceDb(e.detail.database)}></cca-db-picker>
            <div class="helper-label">
              Current selected database: ${this.sourceDb || 'None'}
              ${this.renderClearButton()}
            </div>
          </label>

          <div class="auth-cell">
            <span class="auth-cell-spacer" aria-hidden="true">&nbsp;</span>
            <cca-repl-auth-panel
              title="Source Authentication"
              .auth=${this.auth}
              @cca-auth-change=${(e: CustomEvent<ReplAuthChangeDetail>) => {
                  this.dispatchEvent(
                    new CustomEvent('cca-source-auth-change', {
                      detail: { auth: e.detail.auth },
                      bubbles: true,
                      composed: true
                    })
                  );
                }}></cca-repl-auth-panel>
          </div>
        </div>
      </div>
    `;
  }
}
