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

import { html, css } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { CcaElement } from "../../components/cca-element.js";
import { getContext } from "../../context.js";
import { toast } from "../../components/cca-toast.js";
import "../../components/cca-monaco-editor.js";
import type {
  ExplainQueryRequest,
  ExplainResponse,
  IndexCandidate,
} from "./types.js";
import "@awesome.me/webawesome/dist/components/badge/badge.js";
import "@awesome.me/webawesome/dist/components/spinner/spinner.js";

@customElement("cca-explain-query")
export class CcaExplainQuery extends CcaElement {
  static override get styles() {
    return css`
      :host {
        display: block;
      }
      .container {
        padding: 1rem;
        margin-top: 1rem;
        color: var(--wa-color-text-normal, #1f2a35);
      }
      .controls {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 0.75rem;
        flex-wrap: wrap;
      }
      .view-toggle {
        display: flex;
        border: 1px solid var(--wa-color-neutral-border-quiet);
        border-radius: 8px;
        overflow: hidden;
      }
      .toggle-button {
        border-radius: 0;
        border: none;
      }
      .loading-indicator {
        display: inline-flex;
        align-items: center;
      }
      .error {
        margin-top: 0.75rem;
        color: #c81919;
      }
      .no-response {
        margin-top: 0.75rem;
        opacity: 0.7;
      }
      .json-editor-container {
        border: 1px solid var(--wa-color-neutral-border-normal);
        border-radius: 8px;
        overflow: hidden;
        background: var(--wa-color-surface-default, #fff);
      }
      .editor-full {
        width: 100%;
        height: 100%;
      }
      .parsed-view {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
        margin-top: 0.75rem;
      }
      .section {
        display: flex;
        flex-direction: column;
        gap: 0.45rem;
      }
      .section-title {
        margin: 0;
        font-size: var(--wa-font-size-xl);
        font-weight: var(--wa-font-weight-bold);
      }
      .section-top {
        margin-top: 1rem;
      }
      .index-card {
        border: 1px solid var(--wa-color-neutral-border-quiet);
        border-radius: 6px;
        overflow: hidden;
      }
      .index-card-content {
        display: grid;
        grid-template-columns: minmax(0, 2fr) 7.5rem minmax(0, 2fr) minmax(
            0,
            2fr
          );
        gap: 0.75rem;
        padding: 0.65rem 0.75rem;
        align-items: start;
      }
      .card-min-width {
        min-width: 0;
      }
      .index-name {
        font-size: var(--wa-font-size-s);
        word-break: break-word;
      }
      .index-ddoc {
        font-size: var(--wa-font-size-s);
        opacity: 0.75;
        word-break: break-word;
      }
      .fields-wrap {
        display: flex;
        flex-wrap: wrap;
        gap: 0.5rem 0.75rem;
        min-width: 0;
      }
      .field-item {
        font-size: var(--wa-font-size-m);
      }
      .no-fields {
        opacity: 0.7;
      }
      .reasons-wrap {
        display: flex;
        flex-wrap: wrap;
        gap: 0.35rem;
        min-width: 0;
      }
      .reason-item {
        color: #c81919;
        word-break: break-word;
      }
      .empty-section {
        border: 1px solid var(--wa-color-neutral-border-quiet);
        border-radius: 6px;
        padding: 0.75rem;
        opacity: 0.7;
      }

      .condition-box {
        border: 2px solid #d4a574;
        border-radius: 6px;
        padding: 1rem;
        background: #faf8f3;
        margin-bottom: 1rem;
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
      }

      .condition-header {
        display: flex;
        align-items: flex-start;
        gap: 0.75rem;
      }

      .condition-icon {
        font-size: var(--wa-font-size-s);
        flex-shrink: 0;
        margin-top: 0.1rem;
      }

      .condition-title {
        font-weight: var(--wa-font-weight-normal);
        font-size: var(--wa-font-size-s);
        color: #333;
      }

      .condition-description {
        font-size: var(--wa-font-size-s);
        color: #555;
        /* line-height: 1.5; */
      }

      .condition-button {
        align-self: flex-start;
        padding: 0.5rem 1rem;
        border: 1px solid #333;
        background: #fff;
        border-radius: 3px;
        cursor: pointer;
        font-size: var(--wa-font-size-s);
        font-weight: var(--wa-font-weight-normal);
        transition: all 0.15s ease-in-out;
      }

      .condition-button:hover {
        background: #f5f5f5;
      }

      .summary-box {
        border: 1px solid var(--wa-color-neutral-border-quiet);
        border-radius: 6px;
        padding: 0.75rem;
        background: none;
        font-size: var(--wa-font-size-s);
        /* line-height: 1.6; */
        color: var(--wa-color-text-normal, #333);
      }

      .summary-line {
        display: flex;
        gap: 0.5rem;
        margin: 0.25rem 0;
      }

      .summary-label {
        font-weight: var(--wa-font-weight-normal);
        color: #666;
      }

      .summary-value {
        font-family: var(--wa-font-family-code);
        color: #333;
      }
    `;
  }

  @property({ attribute: false }) mangoQuery: ExplainQueryRequest | null = null;
  @property({ type: String }) serverId = "";
  @property({ type: String }) dbName = "";
  @property({ type: Boolean }) simpleView = false;

  @state() private _loading = false;
  @state() private _error = "";
  @state() private _response: ExplainResponse | null = null;
  @state() private _view: "parsed" | "json" = "parsed";

  private _reasonLabel(value: string | undefined): string {
    if (!value) return "unknown_reason";
    return value;
  }

  private _fieldList(
    fields: Array<Record<string, "asc" | "desc" | string>> | undefined,
  ): Array<{ field: string; direction: string }> {
    if (!Array.isArray(fields)) return [];
    return fields
      .map((entry) => {
        const [field, direction] = Object.entries(entry)[0] ?? [];
        if (!field) return null;
        return {
          field,
          direction: typeof direction === "string" ? direction : "",
        };
      })
      .filter(
        (entry): entry is { field: string; direction: string } =>
          entry !== null,
      );
  }

  private _indexCard(
    typeLabel: string,
    indexName: string,
    ddoc: string,
    fields: Array<{ field: string; direction: string }>,
    reasons: string[],
  ) {
    return html`
      <div class="index-card">
        <div class="index-card-content">
          <div class="card-min-width">
            <div class="index-name">
              <strong>${typeLabel}:</strong> ${indexName}
            </div>
            <div class="index-ddoc">${ddoc}</div>
          </div>
          <div>
            <wa-badge variant="brand">global</wa-badge>
          </div>
          <div class="fields-wrap">
            ${
              fields.length > 0
                ? fields.map(
                    (item) =>
                      html`<span class="field-item"
                        >${item.field} ${item.direction}</span
                      >`,
                  )
                : html`<span class="no-fields">No indexed fields</span>`
            }
          </div>
          <div class="reasons-wrap">
            ${
              reasons.length > 0
                ? reasons.map(
                    (reason) =>
                      html`<span class="reason-item">${reason}</span>`,
                  )
                : html``
            }
          </div>
        </div>
      </div>
    `;
  }

  private _selectedIndexSection(resp: ExplainResponse) {
    const selectedFields = this._fieldList(resp.index?.def?.fields);
    return html`
      <section class="section">
        <h4 class="section-title">Selected Index</h4>
        ${this._indexCard(
          resp.index?.type ?? "unknown",
          resp.index?.name ?? "unknown",
          resp.index?.ddoc ?? "",
          selectedFields,
          [],
        )}
      </section>
    `;
  }

  private _conditionSection(resp: ExplainResponse) {
    if (!resp.condition) return null;

    const condition = resp.condition;
    const iconMap: Record<string, string> = {
      warning: "⚠",
      info: "ℹ",
      error: "✕",
    };

    return html`
      <div class="condition-box">
        <div class="condition-header">
          <span class="condition-icon">${iconMap[condition.type] || "•"}</span>
          <div>
            <div class="condition-title">${condition.title}</div>
            <div class="condition-description">${condition.description}</div>
          </div>
        </div>
        ${
          condition.actionLabel
            ? html`<button
                class="condition-button"
                @click=${() => condition.actionCallback?.()}
              >
                ${condition.actionLabel}
              </button>`
            : ""
        }
      </div>
    `;
  }

  private _summarySection(resp: ExplainResponse) {
    return html`
      <div>_explain Summary</div>
      <div class="summary-box">
        <div class="summary-line">
          <span class="summary-label">index:</span>
          <span class="summary-value">${resp.index?.name ?? "unknown"}</span>
          <span class="summary-label">(${resp.index?.type ?? "unknown"})</span>
        </div>
        <div class="summary-line">
          <span class="summary-label">covering:</span>
          <span class="summary-value">${resp.covering ? "yes" : "no"}</span>
          ${
            resp.mrargs
              ? html`
                  <span class="summary-label">·</span>
                  <span class="summary-label">direction:</span>
                  <span class="summary-value"
                    >${resp.mrargs["direction"] ?? "unknown"}</span
                  >
                `
              : ""
          }
        </div>
        ${
          resp.fields && resp.fields.length > 0
            ? html`
                <div class="summary-line">
                  <span class="summary-label">fields scanned:</span>
                  <span class="summary-value">${resp.fields.join(", ")}</span>
                </div>
              `
            : ""
        }
      </div>
    `;
  }

  private _candidateSection(title: string, candidates: IndexCandidate[]) {
    const populateCandidates = candidates.map((candidate) => {
      const idx = candidate.index;
      const reasons = (candidate.analysis?.reasons ?? []).map((r) =>
        this._reasonLabel(r?.name),
      );
      return this._indexCard(
        idx?.type ?? "unknown",
        idx?.name ?? "unknown",
        idx?.ddoc ?? "",
        this._fieldList(idx?.def?.fields),
        reasons,
      );
    });

    return html`
      <section class="section section-top">
        <h4 class="section-title">${title}</h4>
        ${
          candidates.length === 0
            ? html`<div class="empty-section">None</div>`
            : populateCandidates
        }
      </section>
    `;
  }

  async runExplain() {
    if (!this.serverId) {
      toast("Select a server first.", "info");
      return;
    }
    if (!this.dbName) {
      toast("Database name is required.", "info");
      return;
    }
    if (!this.mangoQuery || typeof this.mangoQuery.selector !== "object") {
      toast("Mango query selector is required.", "info");
      return;
    }

    this._loading = true;
    this._error = "";
    try {
      this._response = await getContext().dbMgmt.explainQuery(
        this.serverId,
        this.dbName,
        this.mangoQuery,
      );
      this._view = "parsed";
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this._error = message;
      toast(`Explain query failed: ${message}`, "error");
    } finally {
      this._loading = false;
    }
  }

  private _editorHeight(value: string): number {
    const lineCount = value.split("\n").length;
    return Math.min(Math.max(lineCount * 22 + 24, 180), 640);
  }

  override render() {
    return html`
      <div class="container">
        <div class="controls">
          ${!this.simpleView ? this._showControls() : ""}
          ${
            this._loading
              ? html`<span class="loading-indicator"
                  ><wa-spinner></wa-spinner
                ></span>`
              : ""
          }
        </div>

        ${this._error ? html`<div class="error">${this._error}</div>` : ""}
        ${
          !this._response
            ? this._noResponseMessage()
            : this._view === "json"
              ? this._renderRawJson()
              : this.simpleView
                ? html`${this._conditionSection(this._response)}
                  ${this._summarySection(this._response)}`
                : this._renderCandidates()
        }
      </div>
    `;
  }

  private _renderCandidates() {
    if (!this._response) return null;

    return html`<div class="parsed-view">
      ${this._selectedIndexSection(this._response)}
      ${this._candidateSection("Suitable Indexes", this._response.index_candidates?.filter((c) => c.analysis?.usable === true) ?? [])}
      ${this._candidateSection("Unsuitable Indexes", this._response.index_candidates?.filter((c) => c.analysis?.usable !== true) ?? [])}
    </div>`;
  }

  private _renderRawJson() {
    return html` <div
      class="json-editor-container"
      style="height:${this._editorHeight(
        JSON.stringify(this._response, null, 2),
      )}px"
    >
      <cca-monaco-editor
        .value=${JSON.stringify(this._response, null, 2)}
        .language=${"json"}
        ?readOnly=${true}
        class="editor-full"
      ></cca-monaco-editor>
    </div>`;
  }

  private _noResponseMessage() {
    return html`<div class="no-response">
      Click Run Explain from the query panel to analyze selected and candidate
      indexes.
    </div>`;
  }

  private _showControls() {
    return html` <div class="view-toggle">
      <wa-button
        size="s"
        appearance=${this._view === "parsed" ? "filled" : "plain"}
        class="toggle-button"
        @click=${() => (this._view = "parsed")}
        >Parsed</wa-button
      >
      <wa-button
        size="s"
        appearance=${this._view === "json" ? "filled" : "plain"}
        class="toggle-button"
        @click=${() => (this._view = "json")}
        >JSON</wa-button
      >
    </div>`;
  }
}
