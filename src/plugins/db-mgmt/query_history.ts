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

import { customElement, property, state } from "lit/decorators.js";
import { CcaElement } from "../../components/cca-element";
import { html, css } from "lit-element/lit-element.js";
import { getContext } from "../../context";
import { ApiError } from "../../services/api-error";
import { SavedQuerySnapshot, BackendHistoryDoc } from "./types";

@customElement("cca-query-history")
export class CcaQueryHistory extends CcaElement {
  /** Set by the router from the :dbName path param. */
  @property() dbName = "";

  /** Set by the router from the :serverId path param. */
  @property({ type: String }) serverId = "";

  @property({ type: Array }) private history: SavedQuerySnapshot[] = [];

  @state() private _showHistory = false;
  @state() private _loading = false;

  private readonly DEFAULT_SELECTOR = JSON.stringify(
    { _id: { $gt: null } },
    null,
    2,
  );

  private readonly HISTORY_MAX = 20;
  private readonly HISTORY_DOC_PREFIX = "cca_doc_query_history_v1:";

  static override get styles() {
    return css`
      .history-dropdown {
        position: absolute;
        right: 0;
        top: 100%;
        z-index: 100;
        min-width: 22rem;
        max-width: 36rem;
        max-height: 18rem;
        overflow-y: auto;
        border: 1px solid var(--wa-color-neutral-border-normal);
        border-radius: 6px;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
        background: var(--wa-color-surface-raised);
        opacity: 1;
      }
      .history-item {
        padding: 0.5rem 0.75rem;
        border-bottom: 1px solid var(--wa-color-neutral-border-quiet);
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 0.5rem;
      }
      .history-item-button {
        all: unset;
        cursor: pointer;
        display: block;
        flex: 1;
        min-width: 0;
      }
      .history-item-title-row {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        margin-bottom: 0.15rem;
      }
      .history-item-index {
        /* opacity: 0.4; */
        user-select: none;
        font-size: var(--wa-font-size-xs);
      }
      .history-item-title {
        font-size: var(--wa-font-size-xs);
        font-weight: var(--wa-font-weight-bold);
      }
      .history-item-meta {
        font-size: var(--wa-font-size-xs);
        margin-bottom: 0.15rem;
      }
      .history-item-selector {
        font-family: var(--wa-font-family-code);
        font-size: var(--wa-font-size-xs);
        white-space: pre;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .history-item-actions {
        display: flex;
        gap: 0.3rem;
      }
      /* Same row-action-button hover treatment cca-data-table.ts gives db-list.ts's row
       * actions (#112), reimplemented locally: these buttons render in THIS component's
       * own shadow root (no cross-shadow composition boundary like a table's render()
       * column), so the rule can live here directly rather than needing an opt-in class
       * hook from elsewhere. The repeated ".history-item:hover" prefix on the second
       * rule is required, not stylistic — see #110, which shipped once without it and
       * the button-hover state silently never rendered (dropping the prefix makes that
       * selector LESS specific than the row-hover one above, and hovering the button
       * always also satisfies ".history-item:hover" on its own ancestor). */
      .history-item:hover .row-action-button::part(base) {
        color: var(--wa-color-on-normal, var(--wa-color-neutral-on-normal));
        background-color: var(--wa-color-fill-normal, var(--wa-color-neutral-fill-normal));
        border-color: var(--wa-color-border-normal, var(--wa-color-neutral-border-normal));
      }
      .history-item:hover .row-action-button::part(base):hover {
        color: var(--wa-color-on-loud, var(--wa-color-neutral-on-loud));
        background-color: var(--wa-color-fill-loud, var(--wa-color-neutral-fill-loud));
        border-color: transparent;
      }
    `;
  }

  override connectedCallback() {
    super.connectedCallback();
    void this._refreshHistoryFromBackend();
  }

  private async _refreshHistoryFromBackend() {
    this.history = await this.loadHistory();
    this._restoreLatestSnapshotForContext();
    this.dispatchEvent(
      new CustomEvent("cca-query-history-refreshed", {
        detail: {
          history: this.history,
        },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private async loadHistory(): Promise<SavedQuerySnapshot[]> {
    if (!this.serverId) return [];

    const docId = this._historyDocId(this.serverId);
    try {
      const existing = (await getContext().dbMgmt.getDoc(
        this.serverId,
        this.dbName,
        docId,
      )) as BackendHistoryDoc;

      const raw = Array.isArray(existing.entries) ? existing.entries : [];
      return raw
        .map((entry) => this.normalizeSnapshotEntry(this.dbName, entry))
        .filter((entry): entry is SavedQuerySnapshot => entry !== null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        return [];
      }
      return [];
    }
  }

  private normalizeSnapshotEntry(
    dbName: string,
    entry: unknown,
  ): SavedQuerySnapshot | null {
    if (
      typeof entry !== "string" &&
      (typeof entry !== "object" || entry === null)
    ) {
      return null;
    }

    const sortItemsRaw = Array.isArray((entry as any).sortItems)
      ? (entry as any).sortItems
      : [];
    const sortItems = sortItemsRaw
      .filter(
        (s: unknown) =>
          typeof s === "object" &&
          s !== null &&
          typeof (s as any).field === "string" &&
          ((s as any).direction === "asc" || (s as any).direction === "desc"),
      )
      .map((s: any) => ({
        field: s.field,
        direction: s.direction,
      }));

    return {
      // Support legacy history entries that only stored selector JSON text.
      id:
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as any).id === "string"
          ? (entry as any).id
          : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      db_name:
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as any).db_name === "string"
          ? (entry as any).db_name
          : dbName,
      selected_server_id:
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as any).selected_server_id === "string"
          ? (entry as any).selected_server_id
          : "",
      selectorJson:
        typeof entry === "string"
          ? entry
          : typeof entry === "object" &&
              entry !== null &&
              typeof (entry as any).selectorJson === "string"
            ? (entry as any).selectorJson
            : this.DEFAULT_SELECTOR,
      fields:
        typeof entry === "object" &&
        entry !== null &&
        Array.isArray((entry as any).fields)
          ? (entry as any).fields.filter((f: unknown) => typeof f === "string")
          : [],
      sortItems:
        typeof entry === "object" &&
        entry !== null &&
        Array.isArray((entry as any).sortItems)
          ? sortItems
          : [],
      scope:
        typeof entry === "object" &&
        entry !== null &&
        (entry as any).scope === "raw"
          ? "raw"
          : "full",
      savedAt:
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as any).savedAt === "string"
          ? (entry as any).savedAt
          : new Date().toISOString(),
      title:
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as any).title === "string"
          ? (entry as any).title
          : undefined,
    };
  }

  private updateHistoryEntry(id: string, patch: Partial<SavedQuerySnapshot>) {
    this.history = this.history.map((entry) =>
      entry.id === id ? { ...entry, ...patch } : entry,
    );
  }

  private removeHistoryEntry(id: string) {
    this.history = this.history.filter((entry) => entry.id !== id);
  }

  private async removeHistoryEntryFromBackend(id: string) {
    if (!this.serverId) return;
    this._loading = true;

    const docId = this._historyDocId(this.serverId);
    try {
      const existing = (await getContext().dbMgmt.getDoc(
        this.serverId,
        this.dbName,
        docId,
      )) as BackendHistoryDoc;

      const currentEntries = Array.isArray(existing.entries)
        ? existing.entries
        : [];
      const nextEntries = currentEntries.filter((entry) => {
        if (!entry || typeof entry !== "object") return true;
        return (entry as { id?: unknown }).id !== id;
      });

      const body: Record<string, unknown> = {
        _id: docId,
        type: "cca.doc_query_history",
        db_name: this.dbName,
        selected_server_id: this.serverId,
        updated_at: new Date().toISOString(),
        entries: nextEntries,
      };

      if (typeof existing._rev === "string") {
        body._rev = existing._rev;
      }

      await getContext().dbMgmt.saveDocument(this.serverId, this.dbName, {
        id: docId,
        body,
      });
    } catch (err) {
      // If the backend doc does not exist yet, local state is already the source of truth.
      if (!(err instanceof ApiError && err.status === 404)) {
        return;
      }
    }
    this._loading = false;
  }

  private _historyDocId(serverId: string): string {
    return `${this.HISTORY_DOC_PREFIX}${serverId}`;
  }

  private _historyEntriesForSelectedServer(): SavedQuerySnapshot[] {
    return this.history
      .filter((entry) => entry.selected_server_id === this.serverId)
      .slice(0, this.HISTORY_MAX);
  }

  private async _persistHistoryToBackendForContext() {
    if (!this.serverId) return;
    const serverId = this.serverId;
    const docId = this._historyDocId(serverId);
    const entries = this._historyEntriesForSelectedServer().map((entry) => ({
      id: entry.id,
      db_name: entry.db_name,
      selected_server_id: entry.selected_server_id,
      selectorJson: entry.selectorJson,
      fields: entry.fields,
      sortItems: entry.sortItems,
      scope: entry.scope,
      savedAt: entry.savedAt,
      title: entry.title,
    }));

    let currentRev: string | undefined;
    try {
      const existing = (await getContext().dbMgmt.getDoc(
        serverId,
        this.dbName,
        docId,
      )) as BackendHistoryDoc;
      if (typeof existing._rev === "string") {
        currentRev = existing._rev;
      }
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 404)) {
        return;
      }
    }

    const body: Record<string, unknown> = {
      _id: docId,
      type: "cca.doc_query_history",
      db_name: this.dbName,
      selected_server_id: serverId,
      updated_at: new Date().toISOString(),
      entries,
    };
    if (currentRev) {
      body._rev = currentRev;
    }

    try {
      await getContext().dbMgmt.saveDocument(serverId, this.dbName, {
        id: docId,
        body,
      });
    } catch {
      // Keep local history as source of truth when backend sync fails.
    }
  }

  private _defaultTitle(selectorJson: string): string {
    const compact = selectorJson.replace(/\s+/g, " ").trim();
    const preview =
      compact.length > 56 ? `${compact.slice(0, 56)}...` : compact;
    return preview || "Untitled query";
  }

  private async _applySnapshot(
    snapshot: SavedQuerySnapshot,
    resetResults = true,
  ) {
    this._showHistory = false;
    this.dispatchEvent(
      new CustomEvent("cca-query-history-apply-snapshot", {
        detail: {
          snapshot,
        },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _restoreLatestSnapshotForContext() {
    const entry = this.history.find(
      (item) => item.selected_server_id === this.serverId,
    );
    if (!entry) return;
    this._applySnapshot(entry, true);
  }

  async saveHistory(dbName: string, snapshot: SavedQuerySnapshot) {
    const signature = JSON.stringify({
      selected_server_id: snapshot.selected_server_id,
      selectorJson: snapshot.selectorJson,
      fields: snapshot.fields,
      sortItems: snapshot.sortItems,
      scope: snapshot.scope,
    });
    const all = await this.loadHistory();

    const previous = all.find(
      (entry) =>
        JSON.stringify({
          selected_server_id: entry.selected_server_id,
          selectorJson: entry.selectorJson,
          fields: entry.fields,
          sortItems: entry.sortItems,
          scope: entry.scope,
        }) === signature,
    );

    const existing = all.filter(
      (entry) =>
        JSON.stringify({
          selected_server_id: entry.selected_server_id,
          selectorJson: entry.selectorJson,
          fields: entry.fields,
          sortItems: entry.sortItems,
          scope: entry.scope,
        }) !== signature,
    );
    const nextSnapshot: SavedQuerySnapshot = {
      ...snapshot,
      // Keep user-provided title/id when re-saving the same query shape.
      id: previous?.id ?? snapshot.id,
      title: previous?.title ?? snapshot.title,
    };
    const next = [nextSnapshot, ...existing].slice(0, this.HISTORY_MAX);

    this.history = next;
    await this._persistHistoryToBackendForContext();
    this.dispatchEvent(
      new CustomEvent("cca-query-history-refreshed", {
        detail: {
          history: this.history,
        },
        bubbles: true,
        composed: true,
      }),
    );
  }

  render() {
    const historyDropdown = html`<div class="history-dropdown">
      ${this.history.map(
        (entry, i) =>
          html`<div class="history-item">
            <button
              class="history-item-button"
              title=${entry.selectorJson}
              @click=${() => this._applySnapshot(entry)}
            >
              <div class="history-item-title-row">
                <span class="history-item-index">${i + 1}.</span>
                <span class="history-item-title"
                  >${
                    entry.title ?? this._defaultTitle(entry.selectorJson)
                  }</span
                >
              </div>
              <div class="history-item-meta">
                ${new Date(entry.savedAt).toLocaleString()} ·
                ${entry.selected_server_id || "no-server"}
              </div>
              <div class="history-item-selector">
                ${entry.selectorJson.replace(/\n/g, " ")}
              </div>
            </button>
            <div class="history-item-actions">
              <wa-button
                size="s"
                appearance="outlined"
                class="row-action-button"
                @click=${async (e: Event) => {
                  e.stopPropagation();
                  const name = window
                    .prompt(
                      "Rename saved query",
                      entry.title ?? this._defaultTitle(entry.selectorJson),
                    )
                    ?.trim();
                  if (!name) return;
                  this.updateHistoryEntry(entry.id, {
                    title: name,
                  });
                  await this._persistHistoryToBackendForContext();
                }}
                >Rename</wa-button
              >
              <wa-button
                size="s"
                appearance="outlined"
                class="row-action-button"
                @click=${async (e: Event) => {
                  e.stopPropagation();
                  this.removeHistoryEntry(entry.id);
                  await this.removeHistoryEntryFromBackend(entry.id);
                }}
                >Delete</wa-button
              >
            </div>
          </div>`,
      )}
    </div>`;

    const history = html`<div style="position:absolute;">
      <wa-button
        size="s"
        appearance="plain"
        @click=${() => (this._showHistory = !this._showHistory)}
        title="Saved queries"
        >${this._loading ? html`<wa-spinner></wa-spinner>` : "Saved Queries"}</wa-button
      >
      ${this._showHistory ? historyDropdown : ""}
    </div>`;

    return html`
      <div style="display:flex;gap:0.25rem;align-items:center">
        ${this.history.length > 0 ? history : ""}
      </div>
    `;
  }
}
