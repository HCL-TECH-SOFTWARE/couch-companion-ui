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

import { html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { CcaElement } from "../../components/cca-element.js";
import { getContext } from "../../context.js";
import { toast } from "../../components/cca-toast.js";
import { getLogger } from "../../services/log-service.js";
import "../../components/cca-monaco-editor.js";
import "@awesome.me/webawesome/dist/components/button/button.js";
import "@awesome.me/webawesome/dist/components/checkbox/checkbox.js";
import "@awesome.me/webawesome/dist/components/tab-group/tab-group.js";
import "@awesome.me/webawesome/dist/components/tab/tab.js";
import "@awesome.me/webawesome/dist/components/tab-panel/tab-panel.js";
import {
  BulkDeleteDocumentRequest,
  DatabaseServerInfo,
  IndexInfo,
} from "./types.js";

const log = getLogger("plugins/db-mgmt/index-list");

const PAGE_SIZE = 25;

@customElement("cca-index-list")
export class CcaIndexList extends CcaElement {
  static override get styles() {
    return css`
      :host {
        display: block;
      }
      .container {
        padding: 1rem;
        color: var(--wa-color-text-normal, #1f2a35);
      }
      .items-container {
        display: flex;
        flex-direction: column;
        gap: 1rem;
      }
      .empty-message {
        opacity: 0.75;
      }
      .index-item {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
      }
      .index-name {
        font-weight: var(--wa-font-weight-bold);
        font-size: var(--wa-font-size-m);
      }
      .index-name-clickable {
        cursor: pointer;
        color: var(--wa-color-text-link);
        text-decoration: underline;
      }
      .index-name-clickable:hover {
        color: var(--wa-color-text-link);
      }
      .editor-container {
        border: 1px solid var(--wa-color-neutral-border-normal);
        border-radius: 8px;
        overflow: hidden;
        background: var(--wa-color-surface-default, #fff);
      }
      .editor-full {
        width: 100%;
        height: 100%;
      }
      .pagination-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-top: 1rem;
        gap: 1rem;
      }
      .total-count {
        margin: 0;
      }
      .button-group {
        display: flex;
        gap: 0.5rem;
      }
      .index-form {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        padding: 0.75rem 0.25rem;
      }
      .index-form-row {
        display: flex;
        gap: 0.5rem;
        align-items: baseline;
      }
      .index-form-label {
        font-weight: var(--wa-font-weight-bold);
        font-size: var(--wa-font-size-s);
        min-width: 9rem;
      }
      .index-form-fields {
        margin: 0;
        padding-left: 1.25rem;
        font-family: var(--wa-font-family-code);
        font-size: var(--wa-font-size-xs);
      }
      .index-form-direction {
        opacity: 0.65;
      }
      .index-form-pre {
        margin: 0;
        font-family: var(--wa-font-family-code);
        font-size: var(--wa-font-size-xs);
        white-space: pre-wrap;
        word-break: break-word;
      }
    `;
  }

  @property() dbName = "";
  @property() serverId = "";
  @state() private _servers: DatabaseServerInfo[] = [];
  @state() private _selectedServerId = "";
  @state() private _serversLoading = true;
  @state() private _loading = false;
  @state() private _totalCount: number | null = null;
  @state() private _page = 0;
  @state() private _skip = 0;
  @state() private _docsValues: string[] = [];
  @state() private _selectedIndexes: Set<string> = new Set();
  @state() private _indexes: IndexInfo[] = [];
  @state() private _editingIndexDdoc: string | null = null;
  /** Per-row Form/Source tab choice, keyed by ddoc. Defaults to "form" when absent (#57/#92). */
  @state() private _itemTabs: Map<string, "form" | "source"> = new Map();

  override connectedCallback() {
    super.connectedCallback();
    if (this.serverId) {
      this._selectedServerId = this.serverId;
      this._load();
    }
  }

  override willUpdate(changed: Map<string, unknown>) {
    if (changed.has("serverId") && this.serverId !== this._selectedServerId) {
      this._selectedServerId = this.serverId;
      this._page = 0;
      this._skip = 0;
      if (this._selectedServerId) {
        this._load();
      }
      return;
    }
    if (changed.has("dbName") && this._selectedServerId) {
      this._page = 0;
      this._skip = 0;
      this._load();
    }
  }

  private _load() {
    if (!this._selectedServerId || !this.dbName) {
      this._docsValues = [];
      this._totalCount = 0;
      this._loading = false;
      return;
    }
    this._loading = true;
    getContext()
      .dbMgmt.listIndexes(this._selectedServerId, this.dbName, {
        limit: PAGE_SIZE,
        skip: this._skip,
      })
      .then(
        (resp) => {
          this._loading = false;
          this._totalCount = resp.total_count ?? null;
          // TODO: implement pagination and set this accordingly
          this._indexes = resp.indexes;
          this._docsValues = resp.indexes.map((d) =>
            JSON.stringify(d, null, 2),
          );
        },
        (err) => {
          log.error(
            `Failed to load documents for ${this.dbName} on server ${this._selectedServerId}: ${err?.message ?? err}`,
          );
          toast(`Failed to load documents: ${err?.message ?? err}`, "error");
          this._loading = false;
        },
      );
  }

  refresh() {
    this._load();
  }

  private _prevPage() {
    if (this._page === 0) return;
    this._page--;
    this._skip = this._page * PAGE_SIZE;
    this._load();
  }

  private _nextPage() {
    this._page++;
    this._skip = this._page * PAGE_SIZE;
    this._load();
  }

  private _editorHeight(value: string): number {
    const lineCount = value.split("\n").length;
    return Math.min(Math.max(lineCount * 22 + 24, 180), 640);
  }

  private _editorName(value: string): string {
    try {
      const parsed = JSON.parse(value) as { name?: string; ddoc?: string };
      return parsed.name?.trim() || parsed.ddoc?.trim() || "Unnamed index";
    } catch {
      return "Unnamed index";
    }
  }

  private _itemTab(ddoc: string): "form" | "source" {
    return this._itemTabs.get(ddoc) ?? "form";
  }

  private _setItemTab(ddoc: string, tab: "form" | "source") {
    const next = new Map(this._itemTabs);
    next.set(ddoc, tab);
    this._itemTabs = next;
  }

  private _onIndexNameClick(e: Event) {
    const target = e.currentTarget as HTMLElement;
    const ddoc = target.getAttribute("data-ddoc");
    if (ddoc) {
      const index = this._indexes.find((idx) => `${idx.ddoc}` === ddoc);
      if (index) {
        this._editIndex(index);
      }
      this.dispatchEvent(
        new CustomEvent("cca-index-scroll-top", {
          detail: { index },
          bubbles: true,
          composed: true,
        }),
      );
    }
  }

  private _editIndex(index: IndexInfo) {
    this._editingIndexDdoc = `${index.ddoc}`;
    this.dispatchEvent(
      new CustomEvent("cca-index-edit-requested", {
        detail: { index },
        bubbles: true,
        composed: true,
      }),
    );
  }

  public async completeIndexEdit(): Promise<void> {
    if (this._editingIndexDdoc) {
      const indexToDelete = this._indexes.find(
        (idx) => `${idx.ddoc}` === this._editingIndexDdoc,
      );
      if (indexToDelete) {
        this._selectedIndexes.clear();
        this._selectedIndexes.add(this._editingIndexDdoc);
        await this.deleteIndexes([indexToDelete]);
        this._editingIndexDdoc = null;
      } else {
        // Index not found in list, just clear the state
        this._editingIndexDdoc = null;
      }
    }
  }

  public cancelIndexEdit(): void {
    this._editingIndexDdoc = null;
  }

  private _toggleSelectAll(checked: boolean) {
    if (checked) {
      this._indexes.forEach((index) => {
        this._selectedIndexes.add(`${index.ddoc}`);
      });
    } else {
      this._selectedIndexes.clear();
    }
    this.requestUpdate();
  }

  private _toggleSelectIndex(ddoc: string, checked: boolean) {
    if (checked) {
      this._selectedIndexes.add(ddoc);
    } else {
      this._selectedIndexes.delete(ddoc);
    }
    this.requestUpdate();
  }

  private get _allSelected(): boolean {
    return (
      this._indexes.length > 0 &&
      this._indexes.every((index) => this._selectedIndexes.has(`${index.ddoc}`))
    );
  }

  private get _anySelected(): boolean {
    return this._selectedIndexes.size > 0;
  }

  private get filteredDocs() {
    if (!this._selectedServerId || !this.dbName) {
      return [];
    }

    return this._indexes.filter((index) => {
      return this._selectedServerId && this.dbName;
    });
  }

  private renderDeleteButton() {
    return html`
      <wa-button
        variant="danger"
        appearance="filled"
        ?disabled=${!this._anySelected}
        @click=${() => this.deleteIndexes(this.filteredDocs)}
      >
        <wa-icon name="trash-can" variant="solid" label="Delete item"></wa-icon>
        Delete (${this._selectedIndexes.size})
      </wa-button>
    `;
  }

  private deleteIndexes(indexes: IndexInfo[]): Promise<void> {
    if (!this._selectedServerId || !this.dbName) {
      toast("No server or database selected for deletion.", "error");
      return Promise.reject(new Error("No server or database selected"));
    }
    this._loading = true;
    const docsToDelete =
      this._selectedIndexes.size > 0
        ? indexes.filter((d) => this._selectedIndexes.has(`${d.ddoc}`))
        : indexes;

    // BulkDeleteDocumentRequest's {id, rev} shape is repurposed for indexes (they have no
    // CouchDB document/revision of their own): `id` carries the design-doc id (e.g.
    // "_design/abc") and `rev` carries the index *name* — both segments dbMgmt.deleteIndexes
    // needs to build DELETE /{db}/_index/{ddoc}/json/{name}.
    const toDelete = docsToDelete.map((d) => ({ id: d.ddoc, rev: d.name }));
    const request: BulkDeleteDocumentRequest = { documents: toDelete };
    return getContext()
      .dbMgmt.deleteIndexes(this._selectedServerId, this.dbName, request)
      .then(
        () => {
          toast(
            `Deleted ${toDelete.length} index(es) successfully.`,
            "success",
          );
          this._selectedIndexes.clear();
          this._load();
        },
        (err) => {
          log.error(
            `Failed to delete indexes for ${this.dbName} on server ${this._selectedServerId}: ${err?.message ?? err}`,
          );
          toast(`Failed to delete indexes: ${err?.message ?? err}`, "error");
          this._loading = false;
          throw err;
        },
      );
  }

  override render() {
    return html`
      <div class="container">
        ${this.renderHeader()}
        ${this._loading ? html`<p>Loading indexes...</p>` : this.renderList()}
      </div>
    `;
  }

  /**
   * Structured, read-only summary of an index definition — the "Form" tab default view
   * (#57/#92), mirroring the Form/Source split #85 built for `cca-user-detail.ts`.
   */
  private _renderIndexForm(v: IndexInfo) {
    const def = (v.def ?? {}) as {
      fields?: unknown[];
      partial_filter_selector?: Record<string, unknown>;
    };
    const fields = Array.isArray(def.fields) ? def.fields : [];
    const partialFilter = def.partial_filter_selector;
    return html`
      <div class="index-form">
        <div class="index-form-row">
          <span class="index-form-label">Name</span><span>${v.name || "—"}</span>
        </div>
        <div class="index-form-row">
          <span class="index-form-label">Type</span><span>${v.type || "json"}</span>
        </div>
        ${
          v.ddoc
            ? html`<div class="index-form-row">
                <span class="index-form-label">Design doc</span><span>${v.ddoc}</span>
              </div>`
            : ""
        }
        <div class="index-form-row">
          <span class="index-form-label">Fields</span>
          <ol class="index-form-fields">
            ${fields.map((f) => {
              const name =
                typeof f === "string" ? f : Object.keys(f as object)[0] || "";
              const dir =
                typeof f === "string"
                  ? "asc"
                  : (Object.values(f as object)[0] as string) || "asc";
              return html`<li>
                ${name} <span class="index-form-direction">(${dir})</span>
              </li>`;
            })}
          </ol>
        </div>
        ${
          partialFilter && Object.keys(partialFilter).length > 0
            ? html`<div class="index-form-row">
                <span class="index-form-label">Partial filter selector</span>
                <pre class="index-form-pre">
${JSON.stringify(partialFilter, null, 2)}</pre
                >
              </div>`
            : ""
        }
      </div>
    `;
  }

  /** The Source tab's raw, read-only JSON view — only rendered while that tab is active,
   *  so a page of indexes doesn't mount a Monaco instance per row up front (#57/#92). */
  private _renderIndexSource(indexJson: string) {
    return html`<div
      class="editor-container"
      style="height:${this._editorHeight(indexJson)}px"
    >
      <cca-monaco-editor
        .value=${indexJson}
        .language=${"json"}
        ?readOnly=${true}
        class="editor-full"
      ></cca-monaco-editor>
    </div>`;
  }

  private renderList() {
    const values = Array.from(this._indexes).map(
      (v) =>
        html` ${(() => {
          const indexJson = JSON.stringify(v, null, 2);
          const ddoc = `${v.ddoc}`;
          const isSelected = this._selectedIndexes.has(ddoc);
          const activeTab = this._itemTab(ddoc);
          return html`
            <div class="index-item">
              <div style="display:flex;align-items:center;gap:0.5rem">
                <wa-checkbox
                  .checked=${isSelected}
                  @change=${(e: any) =>
                    this._toggleSelectIndex(ddoc, e.target.checked)}
                ></wa-checkbox>
                <div
                  class="index-name index-name-clickable"
                  data-ddoc=${ddoc}
                  @click=${(e: Event) => this._onIndexNameClick(e)}
                  title="Click to edit (creates new index and deletes old one)"
                >
                  ${this._editorName(indexJson)}
                </div>
              </div>
              <wa-tab-group
                .active=${activeTab}
                @wa-tab-show=${(e: CustomEvent<{ name: string }>) =>
                  this._setItemTab(
                    ddoc,
                    e.detail.name === "source" ? "source" : "form",
                  )}
              >
                <wa-tab panel="form">Form</wa-tab>
                <wa-tab panel="source">Source</wa-tab>
                <wa-tab-panel name="form">
                  ${this._renderIndexForm(v)}
                </wa-tab-panel>
                <wa-tab-panel name="source">
                  ${
                    activeTab === "source"
                      ? this._renderIndexSource(indexJson)
                      : ""
                  }
                </wa-tab-panel>
              </wa-tab-group>
            </div>
          `;
        })()}`,
    );

    return html` <div class="items-container">
      ${
        this._indexes.length === 0
          ? html`<p class="empty-message">No indexes found.</p>`
          : values
      }
    </div>`;
  }

  /** True once we know there is a page before the current one. */
  private get _hasPrevPage(): boolean {
    return this._page > 0;
  }

  /**
   * True unless we positively know this is the last page. Mirrors the disabled-state
   * condition the buttons used to gate on — only now it hides the button instead of
   * greying it out (#57).
   */
  private get _hasNextPage(): boolean {
    return (
      this._totalCount === null ||
      (this._page + 1) * PAGE_SIZE < this._totalCount
    );
  }

  private renderHeader() {
    return html`
      <div class="pagination-row">
        <div style="display:flex;align-items:center;gap:1rem">
          <wa-checkbox
            .checked=${this._allSelected}
            .indeterminate=${this._anySelected && !this._allSelected}
            @change=${(e: any) => this._toggleSelectAll(e.target.checked)}
          ></wa-checkbox>
          ${this.renderDeleteButton()}
        </div>
        <p class="total-count">Total indexes: ${this._totalCount ?? "N/A"}</p>
        <div class="button-group">
          ${
            this._hasPrevPage
              ? html`<wa-button
                  size="s"
                  ?disabled=${this._loading}
                  @click=${() => this._prevPage()}
                  >← Previous</wa-button
                >`
              : nothing
          }
          ${
            this._hasNextPage
              ? html`<wa-button
                  size="s"
                  ?disabled=${this._loading}
                  @click=${() => this._nextPage()}
                  >Next →</wa-button
                >`
              : nothing
          }
        </div>
      </div>
    `;
  }
}
