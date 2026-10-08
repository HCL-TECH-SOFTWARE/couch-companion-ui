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

import { html, css, LitElement } from "lit";
import { customElement, property, state, query } from "lit/decorators.js";
import "@awesome.me/webawesome/dist/components/dialog/dialog.js";
import "@awesome.me/webawesome/dist/components/button/button.js";
import "@awesome.me/webawesome/dist/components/spinner/spinner.js";
import { getContext } from "../../context.js";
import type { DatabaseInfo } from "../server-mgmt/types.ts";
import type { ReplEndpointRequest } from "./types.ts";
import {
  CORS_HELP_URL,
  COUCHDB_CORS_DOCS_URL,
  describeEndpointFailure,
} from "./endpoint-errors.js";

export interface ReplDbBrowsePickDetail {
  database: string;
}

/**
 * Dialog listing the databases of the endpoint's server, so one can be picked
 * instead of typed. Loads on every `show()`; failures are explained rather than
 * dumped (see `describeEndpointFailure`). Emits `cca-db-browse-pick`.
 */
@customElement("cca-repl-db-browser")
export class CcaReplDbBrowser extends LitElement {
  static styles = css`
    .db-list {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      gap: var(--wa-space-2xs);
    }
    .db-list li {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: var(--wa-space-s);
    }
    .count {
      color: var(--wa-color-text-quiet);
      font-variant-numeric: tabular-nums;
    }
    .hint,
    .help-links {
      margin: 0;
      font-size: var(--wa-font-size-s);
      color: var(--wa-color-text-quiet);
    }
    .failure {
      display: grid;
      gap: var(--wa-space-s);
    }
    .failure p {
      margin: 0;
    }
    wa-spinner {
      display: block;
      margin: var(--wa-space-l) auto;
      font-size: var(--wa-font-size-2xl);
    }
    .dialog-actions {
      display: flex;
      gap: var(--wa-space-s);
      justify-content: flex-end;
      margin-top: var(--wa-space-m);
    }
  `;

  @property({ attribute: false }) endpoint: ReplEndpointRequest = {
    serverUrl: "",
    headers: {},
  };

  @state() private phase: "loading" | "list" | "error" = "loading";
  @state() private databases: DatabaseInfo[] = [];
  @state() private failure = { title: "", detail: "", corsRelated: false };

  /** Identifies the latest `show()`; an older request finishing late must not overwrite it. */
  private loadSeq = 0;

  @query("wa-dialog") private dialog?: HTMLElement & { open: boolean };

  /** Opens the dialog and (re)loads the entered server's database list. */
  async show(): Promise<void> {
    if (this.dialog) this.dialog.open = true;
    this.phase = "loading";
    const seq = ++this.loadSeq;
    try {
      const databases = await getContext().replication.listDatabases(this.endpoint);
      if (seq !== this.loadSeq) return;
      this.databases = databases;
      this.phase = "list";
    } catch (err) {
      if (seq !== this.loadSeq) return;
      this.failure = describeEndpointFailure(err);
      this.phase = "error";
    }
  }

  private close() {
    if (this.dialog) this.dialog.open = false;
  }

  private pick(database: string) {
    this.dispatchEvent(
      new CustomEvent<ReplDbBrowsePickDetail>("cca-db-browse-pick", {
        detail: { database },
        bubbles: true,
        composed: true,
      }),
    );
    this.close();
  }

  private renderRow(db: DatabaseInfo) {
    const name = db.db_name ?? "";
    return html`<li>
      <wa-button appearance="plain" data-db=${name} @click=${() => this.pick(name)}
        >${name}</wa-button
      >
      <span class="count">${db.doc_count ?? "—"}</span>
    </li>`;
  }

  private renderList() {
    if (this.databases.length === 0) {
      return html`<p class="hint">This server has no databases.</p>`;
    }
    return html`<ul class="db-list">
      ${this.databases.map((db) => this.renderRow(db))}
    </ul>`;
  }

  private renderError() {
    return html`<div class="failure">
      <strong>${this.failure.title}</strong>
      <p>${this.failure.detail}</p>
      <p class="help-links">
        <a href=${CORS_HELP_URL} target="_blank" rel="noopener noreferrer">How to fix this</a>
        ·
        <a href=${COUCHDB_CORS_DOCS_URL} target="_blank" rel="noopener noreferrer"
          >CouchDB CORS documentation</a
        >
      </p>
    </div>`;
  }

  private renderBody() {
    if (this.phase === "loading") {
      return html`<wa-spinner aria-label="Loading databases"></wa-spinner>`;
    }
    return this.phase === "list" ? this.renderList() : this.renderError();
  }

  render() {
    return html`
      <wa-dialog label="Browse Databases (${this.endpoint.serverUrl})" style="--width: 36rem">
        ${this.renderBody()}
        <div class="dialog-actions">
          <wa-button data-close type="button" @click=${this.close}>Close</wa-button>
        </div>
      </wa-dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "cca-repl-db-browser": CcaReplDbBrowser;
  }
}
