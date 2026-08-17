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
import { customElement, property, query, state } from "lit/decorators.js";
import { getContext } from "../../context";
import { SavedQuerySnapshot } from "../db-mgmt/types";
import { CcaQueryHistory } from "../db-mgmt/query_history.js";
import "../db-mgmt/query_history.js";
import "../../components/cca-mango.js";
import { CcaMango } from "../../components/cca-mango.js";

@customElement("cca-repl-selector-section")
export class CcaReplSelectorSection extends LitElement {
  static styles = css`
    :host {
      display: block;
    }

    .section-body {
      padding: 0.9rem;
      display: grid;
      gap: 0.9rem;
    }

    .selector-row {
      display: grid;
      grid-template-columns: 1fr 1fr auto;
      gap: 1rem;
      align-items: end;
    }

    .selector-row-action {
      display: flex;
      align-items: flex-end;
    }

    .actions {
      display: flex;
      gap: 0.75rem;
      margin-top: 0.2rem;
      flex-wrap: wrap;
    }

    label {
      font-size: var(--wa-font-size-s);
      font-weight: var(--wa-font-weight-semibold);
      color: var(--wa-color-text-quiet);
      display: grid;
      gap: 0.35rem;
    }

    wa-select,
    wa-input,
    wa-textarea {
      width: 100%;
    }

    wa-textarea::part(textarea) {
      font-family: var(--wa-font-family-code);
    }

    .hint {
      margin: 0;
      font-size: var(--wa-font-size-s);
      color: var(--wa-color-text-quiet);
    }

    @media (max-width: 820px) {
      .selector-row {
        grid-template-columns: 1fr;
      }
    }

    .modal-backdrop {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
      animation: fadeIn 0.2s ease-in-out;
    }

    @keyframes fadeIn {
      from {
        opacity: 0;
      }
      to {
        opacity: 1;
      }
    }

    .mango-editor-container {
      background: white;
      border: 1px solid #e0e0e0;
      border-radius: 8px;
      overflow: hidden;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
      width: 90%;
      max-width: 1200px;
      height: 90vh;
      display: flex;
      flex-direction: column;
      animation: slideUp 0.3s ease-out;
    }

    @keyframes slideUp {
      from {
        transform: translateY(20px);
        opacity: 0;
      }
      to {
        transform: translateY(0);
        opacity: 1;
      }
    }

    .mango-editor-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 1rem;
      border-bottom: 1px solid #e0e0e0;
      background: #f9f9f9;
    }

    .mango-editor-title {
      font-size: var(--wa-font-size-m);
      font-weight: var(--wa-font-weight-bold);
      color: #333;
    }

    .mango-editor-close {
      background: none;
      border: none;
      font-size: var(--wa-font-size-s);
      cursor: pointer;
      color: #999;
      padding: 0;
      width: 32px;
      height: 32px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 4px;
      transition: all 0.15s ease-in-out;
    }

    .mango-editor-close:hover {
      background: #e0e0e0;
      color: #333;
    }

    .mango-editor-content {
      flex: 1;
      overflow: hidden;
    }

    cca-mango {
      display: flex;
      width: 100%;
      height: 100%;
    }
  `;

  @property({ type: String }) selectorJson = "";
  @property({ type: String }) serverId = "";
  @property({ type: String }) dbName = "";

  @state() private _showMangoEditor = false;
  @state() private _loading = false;
  @state() private _previewResults: Record<string, unknown>[] = [];
  @state() private _selectorPlaceholder = "";
  @state() private _query = "";

  @query("cca-query-history") private _queryHistoryEl!: CcaQueryHistory;
  @query("cca-mango") private _mangoEl!: CcaMango;

  render() {
    return html`
      <div class="section-body">
        <label>
          Selector (Mango Query)
          <wa-textarea
            .value=${this.selectorJson}
            placeholder='e.g.: {"type":"invoice"}'
            @input=${(e: Event) => {
              const target = e.target as HTMLTextAreaElement;
              this.dispatchEvent(
                new CustomEvent("cca-selector-json-change", {
                  detail: { selectorJson: target.value || "" },
                  bubbles: true,
                  composed: true,
                }),
              );
            }}
          ></wa-textarea>
        </label>
        <wa-button variant="brand" @click=${() => this.openMangoEditor()}
          >Open Mango Editor</wa-button
        >
      </div>
      ${this._showMangoEditor ? this.renderMangoEditorModal() : ""}
    `;
  }

  private renderMangoEditorModal() {
    return html`
      <div
        class="modal-backdrop"
        @click=${(e: MouseEvent) => {
          // Close modal only when clicking the backdrop, not the modal itself
          if (e.target === e.currentTarget) {
            this.openMangoEditor();
          }
        }}
      >
        <div class="mango-editor-container">
          <div class="mango-editor-header">
            <div class="mango-editor-title">Mango Query Editor</div>
            <div>
              <cca-query-history
                .serverId=${this.serverId}
                .dbName=${this.dbName}
                @cca-query-history-apply-snapshot=${async (e: CustomEvent) => {
                  const snapshot: SavedQuerySnapshot = e.detail.snapshot;
                  const selectorJson = snapshot.selectorJson ?? "{}";
                  this._selectorPlaceholder = selectorJson;
                  await this.updateComplete;
                  // Reinitialize the mango builder after history changes _selectorJson
                  this._mangoEl.reinitializeFromQuery();
                }}
              ></cca-query-history>
            </div>

            <div class="actions">
              <wa-button
                size="s"
                variant="brand"
                ?disabled=${!this.serverId || this._loading}
                @click=${() => this._runPreview()}
              >
                ${this._loading ? html`<wa-spinner></wa-spinner>` : "Run Preview (Max 10 Docs)"}
              </wa-button>

              <wa-button
                size="s"
                variant="brand"
                ?disabled=${!this.serverId || this._loading}
                @click=${() => this.applySelector()}
              >
                ${this._loading ? html`<wa-spinner></wa-spinner>` : "Apply Selector"}
              </wa-button>

              <wa-button
                size="s"
                @click=${() => this.openMangoEditor()}
                title="Close"
              >
                <wa-icon name="close"></wa-icon>
              </wa-button>
            </div>
          </div>
          <div class="mango-editor-content">
            <cca-mango
              .dbName=${this.dbName}
              .serverId=${this.serverId}
              .query=${this._parseSelector()}
              .showOperatorHelp=${true}
              .previewResults=${this._previewResults}
              @cca-mango-change=${(e: CustomEvent) => {
                this._selectorPlaceholder = JSON.stringify(
                  e.detail.query,
                  null,
                  2,
                );
              }}
            ></cca-mango>
          </div>
        </div>
      </div>
    `;
  }

  private openMangoEditor() {
    this._showMangoEditor = !this._showMangoEditor;
  }

  private _parseSelector(): Record<string, any> {
    try {
      return JSON.parse(this._selectorPlaceholder);
    } catch {
      return {};
    }
  }

  private _notifyTabChange() {
    const event = new CustomEvent("request-tab-change", {
      detail: { panel: "preview" },
      bubbles: true,
      composed: true, // Allows the event to pass through Shadow DOM boundaries
    });
    window.dispatchEvent(event);
  }

  private _runPreview() {
    try {
      let sel: Record<string, unknown>;
      try {
        sel = JSON.parse(this._selectorPlaceholder) as any;
        if (sel?.selector) {
          sel = sel.selector as Record<string, unknown>;
        }
      } catch {
        return;
      }
      getContext()
        .dbMgmt.queryDocuments(this.serverId, this.dbName, {
          selector: { selector: sel },
          fields: undefined,
          sort: undefined,
          limit: 10,
          bookmark: undefined,
          scope: "full",
        })
        .then((resp) => {
          const docs = (resp.documents ?? []) as Record<string, unknown>[];
          this._previewResults = docs;
          const snapshot = this._buildSnapshot(this._selectorPlaceholder);
          this.saveHistory(this.dbName, snapshot);
        })
        .catch((err) => {});
    } catch {
      return;
    }
    this._notifyTabChange();
  }

  private async saveHistory(dbName: string, snapshot: SavedQuerySnapshot) {
    await this._queryHistoryEl.saveHistory(dbName, snapshot);
  }

  private _buildSnapshot(selectorJson: string): SavedQuerySnapshot {
    return {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      db_name: this.dbName,
      selected_server_id: this.serverId,
      selectorJson,
      fields: [],
      sortItems: [],
      scope: "full",
      savedAt: new Date().toISOString(),
      title: this._defaultTitle(selectorJson),
    };
  }

  private _defaultTitle(selectorJson: string): string {
    const compact = selectorJson.replace(/\s+/g, " ").trim();
    const preview =
      compact.length > 56 ? `${compact.slice(0, 56)}...` : compact;
    return preview || "Untitled query";
  }

  private applySelector() {
    const selector =
      JSON.parse(this._selectorPlaceholder).selector ??
      this._selectorPlaceholder;

    this.selectorJson = JSON.stringify(selector, null, 2);
    this.openMangoEditor();
  }
}
