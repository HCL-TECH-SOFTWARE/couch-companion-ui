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

import { LitElement, html, css } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import "@awesome.me/webawesome/dist/components/icon/icon.js";

export interface HttpHeaderRow {
  enabled: boolean;
  key: string;
  value: string;
}

export interface HttpHeadersChangeDetail {
  headers: HttpHeaderRow[];
}

type HeaderValueDictionary = Record<string, string[]>;
type AuthMode = "none" | "basic" | "bearer" | "custom";

/**
 * Collapsible HTTP header editor with auth-mode helpers.
 * In guided modes, headers are generated automatically.
 * Manual row editing is enabled only in Custom mode.
 * Emits `cca-headers-change` with `{ headers }` whenever rows change.
 *
 * Design note (#635): kept bespoke rather than migrated to `cca-data-table`.
 * This is an editable form grid, and the table is only part of it (auth-mode
 * select, credential helpers, add-row footer live outside any table).
 * `cca-data-table` is a read-only display with clickable-row semantics that
 * don't fit here. Colors are driven purely by `--wa-color-*` tokens (no
 * hardcoded fallbacks) so the component is correct in light and `wa-dark`.
 */
@customElement("cca-http-headers-table")
export class CcaHttpHeadersTable extends LitElement {
  static styles = css`
    :host {
      display: block;
    }
    .title {
      margin: 0;
      font-size: var(--wa-font-size-s);
      font-weight: var(--wa-font-weight-bold);
      color: var(--wa-color-text-normal);
    }
    .section {
      border: 1px solid var(--wa-color-border-quiet);
      border-radius: var(--wa-border-radius-m);
      background: var(--wa-color-surface-default);
      overflow: hidden;
    }
    .section-header {
      width: 100%;
      border: 0;
      background: var(--wa-color-fill-quiet);
      padding: 0.75rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 0.75rem;
      cursor: pointer;
      text-align: left;
    }
    .summary {
      font-size: var(--wa-font-size-xs);
      color: var(--wa-color-text-quiet);
    }
    .section-body {
      padding: 0.75rem;
      display: grid;
      gap: 0.75rem;
    }
    .mode-row {
      display: grid;
      gap: 0.375rem;
    }
    .mode-row label {
      font-size: var(--wa-font-size-xs);
      font-weight: var(--wa-font-weight-bold);
      color: var(--wa-color-text-quiet);
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }
    .mode-row select {
      width: 100%;
      min-height: 2rem;
      padding: 0.4375rem 0.625rem;
      border: 1px solid var(--wa-color-border-quiet);
      border-radius: var(--wa-border-radius-m);
      font-size: var(--wa-font-size-s);
      background: var(--wa-color-surface-default);
      color: var(--wa-color-text-normal);
      box-sizing: border-box;
    }
    .mode-row select:focus {
      outline: none;
      border-color: var(--wa-color-brand-fill-loud);
      box-shadow: 0 0 0 2px
        color-mix(
          in srgb,
          var(--wa-color-brand-fill-loud) 20%,
          transparent
        );
    }
    table {
      width: 100%;
      border-collapse: collapse;
      border: 1px solid var(--wa-color-border-quiet);
      border-radius: var(--wa-border-radius-m);
      overflow: hidden;
      background: var(--wa-color-surface-default);
    }
    thead th {
      text-align: left;
      padding: 0.5rem 0.75rem;
      font-size: var(--wa-font-size-xs);
      font-weight: var(--wa-font-weight-bold);
      text-transform: uppercase;
      letter-spacing: 0.03em;
      color: var(--wa-color-text-quiet);
      background: var(--wa-color-fill-quiet);
      border-bottom: 1px solid var(--wa-color-border-quiet);
    }
    th.enable-col,
    td.enable-col {
      width: 2.5rem;
      text-align: center;
      padding-left: 0.5rem;
      padding-right: 0.5rem;
    }
    th.key-col {
      width: 40%;
    }
    th.value-col {
      width: 60%;
    }
    tbody td {
      padding: 0.625rem 0.75rem;
      border-bottom: 1px solid var(--wa-color-border-quiet);
      vertical-align: middle;
    }
    tbody tr:last-child td {
      border-bottom: 0;
    }
    input[type="text"] {
      width: 100%;
      min-height: 2rem;
      padding: 0.4375rem 0.625rem;
      border: 1px solid var(--wa-color-border-quiet);
      border-radius: var(--wa-border-radius-m);
      font-size: var(--wa-font-size-s);
      background: var(--wa-color-surface-default);
      color: var(--wa-color-text-normal);
      box-sizing: border-box;
    }
    input[type="checkbox"] {
      width: 1rem;
      height: 1rem;
      cursor: pointer;
    }
    input[type="text"]:focus {
      outline: none;
      border-color: var(--wa-color-brand-fill-loud);
      box-shadow: 0 0 0 2px
        color-mix(
          in srgb,
          var(--wa-color-brand-fill-loud) 20%,
          transparent
        );
    }
    .add-row {
      margin-top: 0.625rem;
      display: grid;
      grid-template-columns: 1fr 1fr auto;
      gap: 0.5rem;
      align-items: start;
    }
    .add-row button,
    .remove-btn {
      border: 1px solid var(--wa-color-border-quiet);
      background: var(--wa-color-surface-default);
      color: var(--wa-color-text-normal);
      border-radius: var(--wa-border-radius-m);
      min-height: 2rem;
      padding: 0.375rem 0.625rem;
      font-size: var(--wa-font-size-s);
      cursor: pointer;
    }
    .remove-col {
      width: 3rem;
      text-align: right;
    }
    .remove-btn {
      border: 0;
      background: transparent;
      color: var(--wa-color-text-quiet);
      min-height: auto;
      padding: 0.25rem;
      font-size: var(--wa-font-size-m);
      line-height: var(--wa-line-height-condensed);
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .remove-btn:hover {
      color: var(--wa-color-danger-fill-loud);
    }
    .add-row button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .helper {
      border: 1px solid var(--wa-color-border-quiet);
      border-radius: var(--wa-border-radius-m);
      padding: 0.75rem;
      background: var(--wa-color-surface-lowered);
      display: grid;
      gap: 0.5rem;
    }
    .helper-title {
      margin: 0;
      font-size: var(--wa-font-size-xs);
      font-weight: var(--wa-font-weight-bold);
      color: var(--wa-color-text-quiet);
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }
    .helper-fields {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 0.5rem;
    }
    .hint {
      margin: 0;
      font-size: var(--wa-font-size-xs);
      color: var(--wa-color-text-quiet);
    }
  `;

  @property({ type: Array }) headers: HttpHeaderRow[] = [
    { enabled: true, key: "Authorization", value: "Bearer " },
  ];

  @property({ type: String }) title = "HTTP Headers";

  /**
   * Render only the editable key/value grid, hiding the built-in auth-mode
   * selector and Basic/Bearer helpers. Use when a parent (e.g.
   * `cca-repl-auth-panel`) already owns auth-mode selection and just needs the
   * headers grid. Without this, the component re-derives its own mode from the
   * seeded headers, so empty headers land on "none" and the grid stays hidden.
   */
  @property({ type: Boolean, attribute: "grid-only" }) gridOnly = false;

  @state() private expanded = true;
  @state() private authMode: AuthMode = "bearer";
  @state() private draftKey = "";
  @state() private draftValue = "";
  @state() private bearerToken = "";
  @state() private basicAuthUsername = "";
  @state() private basicAuthPassword = "";

  private readonly keySuggestions = [
    "Authorization",
    "Accept",
    "If-Match",
    "If-None-Match",
    "X-Correlation-Id",
    "X-Requested-With",
  ];

  private readonly headerValueSuggestions: HeaderValueDictionary = {
    authorization: ["Bearer ", "Basic ", "Digest ", "Negotiate "],
    accept: [
      "application/json",
      "application/problem+json",
      "application/xml",
      "text/plain",
      "*/*",
    ],
    "accept-encoding": [
      "gzip",
      "br",
      "deflate",
      "identity",
      "gzip, deflate, br",
    ],
    "accept-language": ["en", "en-US", "en-GB", "de", "fr", "es"],
    "cache-control": [
      "no-cache",
      "no-store",
      "max-age=0",
      "public, max-age=3600",
      "private, max-age=600",
    ],
    pragma: ["no-cache"],
    connection: ["keep-alive", "close"],
    "if-match": ["*", '"etag-value"'],
    "if-none-match": ["*", '"etag-value"'],
    "if-modified-since": ["Thu, 01 Jan 1970 00:00:00 GMT"],
    "if-unmodified-since": ["Thu, 01 Jan 1970 00:00:00 GMT"],
    prefer: ["return=minimal", "return=representation"],
    "transfer-encoding": ["chunked"],
    "user-agent": ["CouchCompanion/1.0", "PostmanRuntime/7.x"],
    "x-requested-with": ["XMLHttpRequest"],
    "x-correlation-id": ["req-1234567890"],
  };

  private readonly defaultValueSuggestions = [
    "application/json",
    "text/plain",
    "*/*",
  ];

  private sanitizeHeaders(rows: HttpHeaderRow[]): HttpHeaderRow[] {
    return rows.filter(
      (row) => this.normalizeHeaderKey(row.key) !== "content-type",
    );
  }

  private parseModeFromHeaders(rows: HttpHeaderRow[]): AuthMode {
    const active = this.sanitizeHeaders(rows).filter(
      (row) => row.enabled && row.key.trim() && row.value.trim(),
    );
    if (active.length === 0) return "none";
    if (active.length !== 1) return "custom";

    const only = active[0];
    if (this.normalizeHeaderKey(only.key) !== "authorization") {
      return "custom";
    }

    const value = only.value.trim();
    if (value.toLowerCase().startsWith("bearer")) {
      return "bearer";
    }
    if (value.toLowerCase().startsWith("basic")) {
      return "basic";
    }
    return "custom";
  }

  private initializeFromHeaders() {
    this.headers = this.sanitizeHeaders(this.headers);
    const nextMode = this.parseModeFromHeaders(this.headers);

    const selected = this.headers.find(
      (row) =>
        row.enabled && this.normalizeHeaderKey(row.key) === "authorization",
    );
    const authValue = selected?.value?.trim() ?? "";

    if (nextMode === "bearer") {
      this.bearerToken = authValue.replace(/^Bearer\s*/i, "");
    }

    if (nextMode === "basic") {
      const encoded = authValue.replace(/^Basic\s*/i, "").trim();
      if (encoded) {
        try {
          const decoded = atob(encoded);
          const [username, ...rest] = decoded.split(":");
          this.basicAuthUsername = username ?? "";
          this.basicAuthPassword = rest.join(":");
        } catch {
          this.basicAuthUsername = "";
          this.basicAuthPassword = "";
        }
      }
    }

    this.authMode = nextMode;
  }

  protected firstUpdated() {
    if (this.gridOnly) {
      // Parent owns the mode: pin to the custom grid and skip mode derivation.
      this.headers = this.sanitizeHeaders(this.headers);
      if (this.headers.length === 0) {
        this.headers = [{ enabled: true, key: "", value: "" }];
      }
      this.authMode = "custom";
      return;
    }
    this.initializeFromHeaders();
  }

  private generatedHeadersForMode(): HttpHeaderRow[] {
    if (this.authMode === "none") {
      return [];
    }

    if (this.authMode === "bearer") {
      return [
        {
          enabled: true,
          key: "Authorization",
          value: this.bearerToken.trim()
            ? `Bearer ${this.bearerToken.trim()}`
            : "Bearer ",
        },
      ];
    }

    if (this.authMode === "basic") {
      if (!this.basicAuthUsername.trim()) {
        return [];
      }
      const encoded = btoa(
        `${this.basicAuthUsername.trim()}:${this.basicAuthPassword.trim()}`,
      );
      return [
        {
          enabled: true,
          key: "Authorization",
          value: `Basic ${encoded}`,
        },
      ];
    }

    return this.sanitizeHeaders(this.headers);
  }

  private normalizeHeaderKey(key: string): string {
    return key.trim().toLowerCase();
  }

  private valueSuggestionsForKey(headerKey: string): string[] {
    const normalized = this.normalizeHeaderKey(headerKey);
    return (
      this.headerValueSuggestions[normalized] ?? this.defaultValueSuggestions
    );
  }

  private rowValueDatalistId(index: number): string {
    return `cca-http-header-value-options-${index}`;
  }

  private draftValueDatalistId(): string {
    return "cca-http-header-value-options-draft";
  }

  private emitHeadersChange() {
    if (this.authMode !== "custom") {
      this.headers = this.generatedHeadersForMode();
    } else {
      this.headers = this.sanitizeHeaders(this.headers);
    }

    this.dispatchEvent(
      new CustomEvent<HttpHeadersChangeDetail>("cca-headers-change", {
        detail: { headers: this.headers },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private updateRow(index: number, patch: Partial<HttpHeaderRow>) {
    this.headers = this.headers.map((row, i) =>
      i === index ? { ...row, ...patch } : row,
    );
    this.emitHeadersChange();
  }

  private removeRow(index: number) {
    this.headers = this.headers.filter((_, i) => i !== index);
    this.emitHeadersChange();
  }

  private addRow() {
    if (this.authMode !== "custom") {
      return;
    }
    const key = this.draftKey.trim();
    const value = this.draftValue.trim();
    if (!key && !value) {
      return;
    }
    this.headers = [...this.headers, { enabled: true, key, value }];
    this.draftKey = "";
    this.draftValue = "";
    this.emitHeadersChange();
  }

  private onAuthModeChange(value: string) {
    if (
      value !== "none" &&
      value !== "basic" &&
      value !== "bearer" &&
      value !== "custom"
    ) {
      return;
    }

    this.authMode = value;
    if (this.authMode === "custom") {
      this.headers = this.sanitizeHeaders(this.headers);
      if (this.headers.length === 0) {
        this.headers = [{ enabled: true, key: "", value: "" }];
      }
    }
    this.emitHeadersChange();
  }

  private helperSummary() {
    if (this.authMode === "none") return "No auth header";
    if (this.authMode === "bearer") return "Authorization: Bearer";
    if (this.authMode === "basic") return "Authorization: Basic";
    return "Custom headers";
  }

  private renderModeSelector() {
    return html`
      <div class="mode-row">
        <label>Auth Mode</label>
        <select
          .value=${this.authMode}
          @change=${(e: Event) =>
            this.onAuthModeChange((e.target as HTMLSelectElement).value)}
        >
          <option value="none">None</option>
          <option value="basic">Basic</option>
          <option value="bearer">Bearer</option>
          <option value="custom">Custom</option>
        </select>
      </div>
    `;
  }

  private renderBearerHelper() {
    return html`
      <div class="helper">
        <p class="helper-title">Bearer Token</p>
        <input
          type="text"
          placeholder="Paste token"
          .value=${this.bearerToken}
          @input=${(e: Event) => {
            this.bearerToken = (e.target as HTMLInputElement).value;
            this.emitHeadersChange();
          }}
        />
      </div>
    `;
  }

  private renderBasicHelper() {
    return html`
      <div class="helper">
        <p class="helper-title">Basic Credentials</p>
        <div class="helper-fields">
          <input
            type="text"
            placeholder="Username"
            .value=${this.basicAuthUsername}
            @input=${(e: Event) => {
              this.basicAuthUsername = (e.target as HTMLInputElement).value;
              this.emitHeadersChange();
            }}
          />
          <input
            type="password"
            placeholder="Password"
            .value=${this.basicAuthPassword}
            @input=${(e: Event) => {
              this.basicAuthPassword = (e.target as HTMLInputElement).value;
              this.emitHeadersChange();
            }}
          />
        </div>
      </div>
    `;
  }

  private renderEditor() {
    const customRows = this.sanitizeHeaders(this.headers);
    return html`
      <table aria-label="HTTP headers">
        <thead>
          <tr>
            <th class="enable-col"></th>
            <th class="key-col">HTTP Header</th>
            <th class="value-col">Value</th>
            <th class="remove-col"></th>
          </tr>
        </thead>
        <tbody>
          ${customRows.map(
            (row, i) => html`
              <tr>
                <td class="enable-col">
                  <input
                    type="checkbox"
                    .checked=${row.enabled}
                    aria-label=${`Enable ${row.key || "header"} row`}
                    @change=${(e: Event) =>
                      this.updateRow(i, {
                        enabled: (e.target as HTMLInputElement).checked,
                      })}
                  />
                </td>
                <td>
                  <input
                    type="text"
                    .value=${row.key}
                    list="cca-http-header-key-options"
                    placeholder="Header name"
                    @input=${(e: Event) =>
                      this.updateRow(i, {
                        key: (e.target as HTMLInputElement).value,
                      })}
                  />
                </td>
                <td>
                  <input
                    type="text"
                    .value=${row.value}
                    list=${this.rowValueDatalistId(i)}
                    placeholder="Header value"
                    @input=${(e: Event) =>
                      this.updateRow(i, {
                        value: (e.target as HTMLInputElement).value,
                      })}
                  />
                  <datalist id=${this.rowValueDatalistId(i)}>
                    ${this.valueSuggestionsForKey(row.key).map(
                      (value) => html`<option value=${value}></option>`,
                    )}
                  </datalist>
                </td>
                <td class="remove-col">
                  <button
                    class="remove-btn"
                    type="button"
                    aria-label="Remove row"
                    @click=${() => this.removeRow(i)}
                  >
                    <wa-icon name="trash-can" label="Remove row"></wa-icon>
                  </button>
                </td>
              </tr>
            `,
          )}
        </tbody>
      </table>

      <div class="add-row">
        <input
          type="text"
          .value=${this.draftKey}
          list="cca-http-header-key-options"
          placeholder="Add header key"
          @input=${(e: Event) => {
            this.draftKey = (e.target as HTMLInputElement).value;
          }}
        />
        <input
          type="text"
          .value=${this.draftValue}
          list=${this.draftValueDatalistId()}
          placeholder="Add header value"
          @input=${(e: Event) => {
            this.draftValue = (e.target as HTMLInputElement).value;
          }}
        />
        <button
          type="button"
          ?disabled=${!this.draftKey.trim() && !this.draftValue.trim()}
          @click=${this.addRow}
        >
          Add Row
        </button>
      </div>
    `;
  }

  private renderDatalists() {
    return html`
      <datalist id="cca-http-header-key-options">
        ${this.keySuggestions.map(
          (value) => html`<option value=${value}></option>`,
        )}
      </datalist>
      <datalist id=${this.draftValueDatalistId()}>
        ${this.valueSuggestionsForKey(this.draftKey).map(
          (value) => html`<option value=${value}></option>`,
        )}
      </datalist>
    `;
  }

  private renderHint() {
    return html`
      <p class="hint">
        Content-Type is fixed by the replication request flow and is not
        editable here.
      </p>
    `;
  }

  private renderBody() {
    return html`
      <div class="section-body">
        ${this.gridOnly ? html`` : this.renderModeSelector()}
        ${this.authMode === "bearer" ? this.renderBearerHelper() : html``}
        ${this.authMode === "basic" ? this.renderBasicHelper() : html``}
        ${this.authMode === "custom" ? this.renderEditor() : html``}
        ${this.renderDatalists()} ${this.renderHint()}
      </div>
    `;
  }

  render() {
    // Grid-only: parent owns the mode, so drop the card/header/collapse chrome
    // and render just the editable grid.
    if (this.gridOnly) {
      return this.renderBody();
    }

    return html`
      <section class="section">
        <button
          type="button"
          class="section-header"
          @click=${() => {
            this.expanded = !this.expanded;
          }}
          aria-expanded=${this.expanded ? "true" : "false"}
        >
          <h3 class="title">${this.title}</h3>
          <span class="summary"
            >${this.helperSummary()}${this.expanded
              ? " - Hide"
              : " - Show"}</span
          >
        </button>
        ${this.expanded ? this.renderBody() : html``}
      </section>
    `;
  }
}
