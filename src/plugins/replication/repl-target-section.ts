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

import { html, css, LitElement } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import './repl-auth-panel.js';
import type { ReplAuthChangeDetail } from './repl-auth-panel.ts';

@customElement('cca-repl-target-section')
export class CcaReplTargetSection extends LitElement {
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
       select/input instead of dropping to the bottom of the helper text. */
    .auth-cell {
      display: grid;
      gap: 0.35rem;
    }

    .auth-cell-spacer {
      font-size: var(--wa-font-size-s);
      font-weight: var(--wa-font-weight-semibold);
    }

    label {
      font-size: var(--wa-font-size-s);
      font-weight: var(--wa-font-weight-semibold);
      color: var(--wa-color-text-quiet);
      display: grid;
      gap: 0.35rem;
    }

    wa-input {
      width: 100%;
    }

    .helper-label {
      margin-top: 0.25rem;
      font-size: var(--wa-font-size-xs);
      color: var(--wa-color-text-quiet);
    }

    .hint {
      grid-column: 1 / -1;
      margin: 0;
      font-size: var(--wa-font-size-xs);
      color: var(--wa-color-text-quiet);
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

  @property({ type: String }) targetServerUrl = '';
  @property({ type: String }) targetDb = '';
  @property({ attribute: false }) auth: Record<string, string> = {};

  render() {
    return html`
      <div class="section-body">
        <div class="row">
          <label>
            Target URL
            <wa-input
              type="url"
              .value=${this.targetServerUrl}
              placeholder="https://host:port"
              @input=${(e: Event) => {
                  const target = e.target as HTMLInputElement;
                  this.dispatchEvent(
                    new CustomEvent('cca-target-server-url-change', {
                      detail: { targetServerUrl: target.value || '' },
                      bubbles: true,
                      composed: true
                    })
                  );
                }}></wa-input>
            <div class="helper-label">Current value: ${this.targetServerUrl || 'None'}</div>
          </label>
          <label>
            Target Database
            <wa-input
              type="text"
              .value=${this.targetDb}
              placeholder="Select database"
              @input=${(e: Event) => {
                  const target = e.target as HTMLInputElement;
                  this.dispatchEvent(
                    new CustomEvent('cca-target-db-change', {
                      detail: { targetDb: target.value || '' },
                      bubbles: true,
                      composed: true
                    })
                  );
                }}></wa-input>
            <div class="helper-label">Current value: ${this.targetDb || 'Select database'}</div>
          </label>

          <div class="auth-cell">
            <span class="auth-cell-spacer" aria-hidden="true">&nbsp;</span>
            <cca-repl-auth-panel
              title="Target Authentication"
              .auth=${this.auth}
              @cca-auth-change=${(e: CustomEvent<ReplAuthChangeDetail>) => {
                  this.dispatchEvent(
                    new CustomEvent('cca-target-auth-change', {
                      detail: { auth: e.detail.auth },
                      bubbles: true,
                      composed: true
                    })
                  );
                }}></cca-repl-auth-panel>
          </div>

          <p class="hint">
            A target on this server still needs a full URL and credentials —
            CouchDB 3 removed local endpoints, so even a same-server
            replication is written as one.
          </p>
        </div>
      </div>
    `;
  }
}
