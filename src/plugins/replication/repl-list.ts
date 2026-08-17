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

import { css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { CcaElement } from "../../components/cca-element.js";
import { getContext } from "../../context.js";
import { toast } from "../../components/cca-toast.js";
import { getLogger } from "../../services/log-service.js";
import type { ReplicatorDoc } from "./types.js";
import type { TableColumn } from "../../components/cca-data-table.js";
import {
  addHeaderActions,
  clearHeaderActions,
  clearHeaderTitle,
  setHeaderTitle,
} from "../../components/cca-header.js";
import "../../components/cca-data-table.js";
import "@awesome.me/webawesome/dist/components/button/button.js";
import "@awesome.me/webawesome/dist/components/icon/icon.js";
import "@awesome.me/webawesome/dist/components/dialog/dialog.js";
import "@awesome.me/webawesome/dist/components/input/input.js";

const log = getLogger("plugins/replication/repl-list");

/**
 * `ApiError.message` is already the problem-details `detail` (see `ApiClient.requestWithHeaders`),
 * so there is nothing to unwrap from `.body`.
 */
const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

@customElement("cca-repl-list")
export class CcaReplList extends CcaElement {
  static styles = css`
    .search-row {
      display: flex;
      gap: 0.5rem;
      margin-block-end: 0.75rem;
    }
    .search-row wa-input {
      flex: 1;
      max-width: 24rem;
    }
    .state-pill {
      display: inline-block;
      font-size: var(--wa-font-size-2xs);
      font-weight: var(--wa-font-weight-semibold);
      padding: var(--wa-space-3xs) var(--wa-space-xs);
      border-radius: var(--wa-border-radius-pill);
    }
    .scheduler-error {
      margin-block-start: 0.25rem;
      max-width: 20rem;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: var(--wa-font-size-xs);
      color: var(--wa-color-danger-on-quiet);
    }
  `;

  /** Set by the router from the :serverId path param. */
  @property({ type: String }) serverId = "";

  @state() private replications: ReplicatorDoc[] = [];
  @state() private loading = true;
  @state() private _confirmDelete: ReplicatorDoc | null = null;
  @state() private _deleting = false;
  @state() private filterValue = "";

  private static readonly SEARCH_DEBOUNCE_MS = 250;
  private _searchDebounce: ReturnType<typeof setTimeout> | undefined;
  /** Fetch generation — a response applies only if still the latest (#810/#828 lineage). */
  private _loadSeq = 0;

  /** Keystroke-triggered reloads wait out the debounce window (#822). */
  private _scheduleSearch() {
    clearTimeout(this._searchDebounce);
    this._searchDebounce = setTimeout(() => {
      this._searchDebounce = undefined;
      void this.load();
    }, CcaReplList.SEARCH_DEBOUNCE_MS);
  }

  /** Discrete triggers (clear, serverId change) reload at once, dropping any pending keystroke reload. */
  private _reloadNow() {
    clearTimeout(this._searchDebounce);
    this._searchDebounce = undefined;
    void this.load();
  }

  override connectedCallback() {
    clearHeaderActions();
    addHeaderActions([
      {
        icon: "circle-plus",
        tooltip: "New Replication",
        action: () => {
          getContext().router.navigate(
            `/replications/${encodeURIComponent(this.serverId || "$all")}/create`,
          );
        },
      },
    ]);
    setHeaderTitle("Replications");
    super.connectedCallback();
    void this.load();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    clearHeaderActions();
    clearHeaderTitle();
    clearTimeout(this._searchDebounce);
    this._searchDebounce = undefined;
  }

  /** React to route changes (:serverId). Guards against the initial-mount double-load — see #822. */
  updated(changed: Map<string, unknown>) {
    if (changed.has("serverId") && changed.get("serverId") !== undefined) {
      this._reloadNow();
    }
  }

  private async load() {
    const seq = ++this._loadSeq;
    this.loading = true;
    try {
      const filter = this.filterValue.trim();
      const docs = await getContext().replication.listReplications(
        filter ? { filter } : {},
      );
      if (seq !== this._loadSeq) return;
      this.replications = docs;
    } catch (err) {
      if (seq !== this._loadSeq) return;
      // Leave whatever is already on screen; a failed refresh should not blank the table.
      log.error("Failed to load replications", err as Error);
      toast(`Failed to load replications: ${errorMessage(err)}`, "error");
    } finally {
      if (seq === this._loadSeq) {
        this.loading = false;
      }
    }
  }

  private extractUrl(source: string | { url: string } | undefined): string {
    if (!source) return "—";
    return typeof source === "string" ? source : source.url;
  }

  /**
   * Live scheduler state (`running` | `crashing` | `pending` | `completed` | `failed`, or "—"
   * when the scheduler has no entry for this document — see #822's annotation contract), with a
   * crashing/failed job's `scheduler_error` surfaced inline underneath.
   *
   * Token names are spelled out per branch rather than assembled from a variable — an
   * interpolated name can't be checked against the theme by `cca/no-undefined-wa-token`, and a
   * typo would then be a silent no-op (see idp-logs.ts's `renderLevel`, #718).
   */
  private _renderState(r: ReplicatorDoc) {
    const state = r.replication_state ?? "—";
    const isBad = state === "crashing" || state === "failed";
    const pillStyle = isBad
      ? "background: var(--wa-color-danger-fill-quiet); color: var(--wa-color-danger-on-quiet);"
      : "";
    return html`
      <span class="state-pill" style=${pillStyle}>${state}</span>
      ${r.scheduler_error
        ? html`<div class="scheduler-error" title=${r.scheduler_error}>
            ${r.scheduler_error}
          </div>`
        : ""}
    `;
  }

  private _openEditor(r: ReplicatorDoc) {
    getContext().router.navigate(
      `/replications/${encodeURIComponent(r.cca_server_id || this.serverId || "$all")}` +
        `/edit/${encodeURIComponent(r.replicator_doc_id ?? "")}`,
    );
  }

  private async _doDelete() {
    const r = this._confirmDelete;
    if (!r) return;

    // replicator_doc_id is optional on ReplicatorDoc because repl-editor builds partial
    // documents locally; without it there is no document to address. cca_server_id is always
    // present on a loaded row, but deleteReplication's serverId parameter is unused server-side
    // (single-server product) — it doesn't gate the guard.
    const { cca_server_id: serverId, replicator_doc_id: replId } = r;
    if (!replId) {
      this._confirmDelete = null;
      toast(
        "Cannot delete: this replication is missing its server or document id.",
        "error",
      );
      return;
    }

    this._deleting = true;
    try {
      // Raw ids — ReplicationService encodes the path segments.
      await getContext().replication.deleteReplication(
        serverId ?? this.serverId,
        replId,
      );
      this._confirmDelete = null;
      toast("Replication deleted", "success");
      await this.load();
    } catch (err) {
      log.error("Failed to delete replication", err as Error);
      this._confirmDelete = null;
      toast(`Failed to delete replication: ${errorMessage(err)}`, "error");
    } finally {
      this._deleting = false;
    }
  }

  private get _columns(): TableColumn<ReplicatorDoc>[] {
    return [
      { label: "Source", render: (r) => this.extractUrl(r.source) },
      { label: "Target", render: (r) => this.extractUrl(r.target) },
      {
        label: "Type",
        render: (r) => (r.continuous ? "Continuous" : "One-time"),
      },
      { label: "State", render: (r) => this._renderState(r) },
      {
        label: "Actions",
        width: "6rem",
        render: (r) =>
          html`<wa-button
            title="Delete replication"
            size="s"
            variant="danger"
            appearance="outlined"
            class="row-action-button"
            @click=${(e: Event) => {
              e.stopPropagation();
              this._confirmDelete = r;
            }}
            ><wa-icon
              name="trash-can"
              variant="solid"
              label="Delete replication"
            ></wa-icon
          ></wa-button>`,
      },
    ];
  }

  override render() {
    return html`
      <div class="search-row">
        <wa-input
          placeholder="Search…"
          clearable
          .value=${this.filterValue}
          @input=${(e: Event) => {
            const value = (e.target as HTMLInputElement).value;
            // WA's clear button fires wa-clear (handled below) and then a
            // composed input for the same, already-applied value — don't
            // schedule a second reload when nothing changed.
            if (value === this.filterValue) return;
            this.filterValue = value;
            this._scheduleSearch();
          }}
          @wa-clear=${() => {
            this.filterValue = "";
            this._reloadNow();
          }}></wa-input>
      </div>

      <cca-data-table
        .columns=${this._columns as any[]}
        .rows=${this.replications}
        .loading=${this.loading}
        empty-message="No replications found."
        @cca-row-click=${(e: CustomEvent<ReplicatorDoc>) =>
          this._openEditor(e.detail)}
      ></cca-data-table>

      <wa-dialog
        label="Delete Replication"
        ?open=${this._confirmDelete !== null}
        @wa-after-hide=${(e: Event) => {
          if (e.target === e.currentTarget && !this._deleting)
            this._confirmDelete = null;
        }}
      >
        <p style="margin-top:0">
          Delete this replication? This cannot be undone.
        </p>
        <div
          slot="footer"
          style="display:flex;gap:0.5rem;justify-content:flex-end"
        >
          <wa-button @click=${() => (this._confirmDelete = null)}
            >Cancel</wa-button
          >
          <wa-button
            variant="danger"
            ?loading=${this._deleting}
            @click=${() => this._doDelete()}
            >Delete</wa-button
          >
        </div>
      </wa-dialog>
    `;
  }
}
