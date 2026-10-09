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

import { html, css, LitElement, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import "@awesome.me/webawesome/dist/components/button/button.js";
import "@awesome.me/webawesome/dist/components/input/input.js";
import "./repl-auth-panel.js";
import "./repl-db-browser.js";
import type { CcaReplDbBrowser, ReplDbBrowsePickDetail } from "./repl-db-browser.ts";
import type { ReplAuthChangeDetail } from "./repl-auth-panel.ts";
import type { ReplEndpointChangeDetail, ReplEndpointKind } from "./types.js";

/**
 * One replication endpoint — source or target — as three fields in the order a
 * pull setup is thought through: which server, how to authenticate against it,
 * which database. Used twice by `cca-repl-editor`; `kind` only changes labels
 * and the event payload, never behavior, so source and target cannot drift
 * apart again.
 */
@customElement("cca-repl-endpoint")
export class CcaReplEndpoint extends LitElement {
  static styles = css`
    :host {
      display: block;
    }

    .section-body {
      padding: 0.9rem;
      display: grid;
      gap: 0.9rem;
    }

    .row {
      display: grid;
      grid-template-columns: 1fr auto 1fr;
      gap: 1rem;
      align-items: start;
    }

    /* Mirror a field's label row so the auth control lines up with the
       inputs instead of dropping to the bottom of the helper text. */
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

    .db-cell {
      display: flex;
      gap: 0.5rem;
      align-items: start;
    }

    .db-cell wa-input {
      flex: 1;
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

  @property({ type: String }) kind: ReplEndpointKind = "source";
  @property({ type: String }) serverUrl = "";
  @property({ type: String }) database = "";
  @property({ attribute: false }) auth: Record<string, string> = {};
  /**
   * Cleaned headers for this endpoint's browser-side requests (Browse). The editor decides
   * what is safe to send — stored headers must not follow an edited URL to another origin —
   * so this stays distinct from `auth`, which only feeds the auth panel.
   */
  @property({ attribute: false }) requestAuth: Record<string, string> = {};
  @property({ type: String }) hint = "";

  private get kindLabel(): string {
    return this.kind === "source" ? "Source" : "Target";
  }

  private emitChange(detail: Omit<ReplEndpointChangeDetail, "kind">) {
    this.dispatchEvent(
      new CustomEvent<ReplEndpointChangeDetail>("cca-endpoint-change", {
        detail: { kind: this.kind, ...detail },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private openBrowser() {
    void this.shadowRoot?.querySelector<CcaReplDbBrowser>("cca-repl-db-browser")?.show();
  }

  private renderClearButton() {
    if (!this.database) return nothing;
    return html`<wa-button
      data-clear-database
      type="button"
      size="s"
      appearance="plain"
      @click=${() => this.emitChange({ database: "" })}
      >Clear</wa-button
    >`;
  }

  render() {
    return html`
      <div class="section-body">
        <div class="row">
          <label>
            ${this.kindLabel} Server
            <wa-input
              data-server-url
              type="url"
              .value=${this.serverUrl}
              placeholder="https://host:port"
              @input=${(e: Event) =>
                this.emitChange({ serverUrl: (e.target as HTMLInputElement).value || "" })}
            ></wa-input>
            <div class="helper-label">Current value: ${this.serverUrl || "None"}</div>
          </label>

          <div class="auth-cell">
            <span class="auth-cell-spacer" aria-hidden="true">&nbsp;</span>
            <cca-repl-auth-panel
              title="${this.kindLabel} Authentication"
              .auth=${this.auth}
              @cca-auth-change=${(e: CustomEvent<ReplAuthChangeDetail>) =>
                this.emitChange({ auth: e.detail.auth })}
            ></cca-repl-auth-panel>
          </div>

          <label>
            ${this.kindLabel} Database
            <div class="db-cell">
              <wa-input
                data-database
                type="text"
                .value=${this.database}
                placeholder="Database name"
                @input=${(e: Event) =>
                  this.emitChange({ database: (e.target as HTMLInputElement).value || "" })}
              ></wa-input>
              <wa-button
                data-browse-dbs
                type="button"
                ?disabled=${!this.serverUrl.trim()}
                @click=${this.openBrowser}
                >Browse…</wa-button
              >
            </div>
            <div class="helper-label">
              Current value: ${this.database || "None"} ${this.renderClearButton()}
            </div>
          </label>

          ${this.hint ? html`<p class="hint">${this.hint}</p>` : nothing}
        </div>
        <cca-repl-db-browser
          .endpoint=${{ serverUrl: this.serverUrl, headers: this.requestAuth }}
          @cca-db-browse-pick=${(e: CustomEvent<ReplDbBrowsePickDetail>) =>
            this.emitChange({ database: e.detail.database })}
        ></cca-repl-db-browser>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "cca-repl-endpoint": CcaReplEndpoint;
  }
}
