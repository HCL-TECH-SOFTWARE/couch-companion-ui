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

import { html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { CcaElement } from "../../components/cca-element.js";
import { getContext } from "../../context.js";
import { toast } from "../../components/cca-toast.js";
import { ApiError } from "../../services/api-error.js";
import {
  describeDbAccessError,
  isEnumerationDenied,
} from "../../services/db-enumeration.js";
import { SINGLE_SERVER_ID } from "../../services/single-server.js";
import {
  indexTargetsByDatabase,
  targetKey,
  type RepoTargetRow,
} from "../../services/repo-targets.js";
import { getLogger } from "../../services/log-service.js";
import type { DatabaseOverview } from "./types.js";
import type { ListDatabasesParams } from "../../services/db-mgmt-service.js";
import {
  addHeaderActions,
  clearHeaderActions,
  clearHeaderTitle,
  setHeaderTitle,
} from "../../components/cca-header.js";

const log = getLogger("plugins/db-mgmt/db-list");
import type { TableColumn } from "../../components/cca-data-table.js";
import "../../components/cca-data-table.js";
import "../../components/cca-db-picker.js";
import "@awesome.me/webawesome/dist/components/button/button.js";
import "@awesome.me/webawesome/dist/components/callout/callout.js";
import "@awesome.me/webawesome/dist/components/dialog/dialog.js";
import "@awesome.me/webawesome/dist/components/input/input.js";
import "@awesome.me/webawesome/dist/components/checkbox/checkbox.js";
import "@awesome.me/webawesome/dist/components/radio/radio.js";
import "@awesome.me/webawesome/dist/components/radio-group/radio-group.js";
import "@awesome.me/webawesome/dist/components/drawer/drawer.js";

function formatBytes(bytes?: number): string {
  if (bytes == null) return "—";
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

@customElement("cca-db-list")
export class CcaDbList extends CcaElement {
  private _serverId = "$all";

  /** Set by the router from the :serverId path param (`$all` means global). */
  @property({ type: String })
  get serverId() {
    return this._serverId;
  }

  set serverId(value: string) {
    const next = value?.trim() || "$all";
    const old = this._serverId;
    if (old === next) return;
    this._serverId = next;
    this.requestUpdate("serverId", old);
    if (this.isConnected) this._reloadNow();
  }

  @state() private databases: DatabaseOverview[] = [];
  @state() private loading = true;
  @state() private search = "";
  /**
   * `server_name` is deliberately absent: the column it sorted is gone (#44), and this
   * product manages exactly one server, so the key sorted nothing anyway.
   */
  @state() private sortBy: "db_name" | "doc_count" | "size_bytes" = "db_name";
  @state() private sortOrder: "asc" | "desc" = "asc";
  @state() private _confirmDeleteDb: DatabaseOverview | null = null;
  @state() private _deleteTargetServerIds: Set<string> = new Set();
  @state() private _deleting = false;
  @state() private _selectedDb: DatabaseOverview | null = null;
  @state() private _selectedServerId = "";
  @state() private _browseDb: DatabaseOverview | null = null;
  @state() private _browseServerId = "";
  @state() private _selectedActionLabel = "";

  /**
   * Non-null when CouchDB refused to *enumerate* the databases; holds the explanation to show.
   * A refusal is not a fault — the databases exist and a member's own screens answer 200 — so
   * this drives a degraded "open one by name" screen rather than an error (#5).
   */
  @state() private _enumerationDenied: string | null = null;

  /**
   * Which repository tracks which database, indexed by {@link targetKey} — the whole Version
   * Control column, fetched once (see {@link _loadRepoTargets}) rather than per row.
   *
   * `null` is "this browser has no version-control information", and renders **no column at all**
   * rather than an empty one: an empty cell means "this database is not under version control",
   * which would be a claim we are in no position to make. An empty map is the opposite state and
   * a real one — repositories were readable, and none of them tracks anything.
   */
  @state() private _repoTargets: Map<string, RepoTargetRow> | null = null;

  /** Why the last open-by-name attempt did not open, shown beside the field. */
  @state() private _openError = "";

  /** An open-by-name probe is in flight. */
  @state() private _opening = false;

  private replicationLabel = "Replicate Database";
  private permissionsLabel = "Permissions";

  private static readonly SEARCH_DEBOUNCE_MS = 250;
  private _searchDebounce: ReturnType<typeof setTimeout> | undefined;

  /** Reload generation — responses apply only if still the latest (#810 pattern). */
  private _loadSeq = 0;

  private _openBrowse(db: DatabaseOverview) {
    if (db.servers.length === 1) {
      getContext().router.navigate(
        `/databases/${encodeURIComponent(db.servers[0].server_id)}/${encodeURIComponent(db.db_name)}/documents`,
      );
      return;
    }
    this._browseServerId = db.servers[0]?.server_id ?? "";
    this._browseDb = db;
  }

  /**
   * Opens the design-document list already narrowed to this database (#44).
   *
   * `/design-docs/:serverId` with `?database=` is the pair `cca-design-list` reads on arrival —
   * the same one `repo-overview`'s target pills navigate with — rather than a URL invented here.
   * The server has to be named: design-list ignores `?database=` while `:serverId` is `$all`, so
   * the row's own server id is used, falling back to {@link _openServerId} for the single server
   * this product manages when a row carries none.
   */
  private _openDesignDocs(db: DatabaseOverview) {
    const serverId = db.servers[0]?.server_id ?? this._openServerId;
    getContext().router.navigate(
      `/design-docs/${encodeURIComponent(serverId)}` +
        `?database=${encodeURIComponent(db.db_name)}`,
    );
  }

  /** Same route doc-browser.ts's own "Manage Indexes" action already uses (#106). */
  private _openManageIndexes(db: DatabaseOverview) {
    const serverId = db.servers[0]?.server_id ?? this._openServerId;
    getContext().router.navigate(
      `/databases/${encodeURIComponent(serverId)}/${encodeURIComponent(db.db_name)}/indexes`,
    );
  }

  private _sortHeader(label: string, field: typeof this.sortBy) {
    return () => {
      const active = this.sortBy === field;
      const indicator = active ? (this.sortOrder === "asc" ? " ↑" : " ↓") : "";
      return html`<span
        style="cursor:pointer;user-select:none;${
          active ? "color:var(--wa-color-text-link)" : ""
        }"
        @click=${(e: Event) => {
          e.stopPropagation();
          if (this.sortBy === field) {
            this.sortOrder = this.sortOrder === "asc" ? "desc" : "asc";
          } else {
            this.sortBy = field;
            this.sortOrder = "asc";
          }
          this._reloadNow();
        }}
        >${label}${indicator}</span
      >`;
    };
  }

  private get _columns(): TableColumn<DatabaseOverview>[] {
    return [
      {
        label: "Database",
        key: "db_name",
        headerRender: this._sortHeader("Database", "db_name"),
        render: (db) =>
          html`<span
            style="cursor:pointer;color:var(--wa-color-text-link);text-decoration:underline"
            @click=${(e: Event) => {
              e.stopPropagation();
              this._openBrowse(db);
            }}
            >${db.db_name}</span
          >`,
      },
      {
        label: "Doc Count",
        headerRender: this._sortHeader("Doc Count", "doc_count"),
        render: (db) =>
          db.servers.reduce((sum, s) => sum + s.doc_count, 0).toLocaleString(),
      },
      {
        label: "Size",
        headerRender: this._sortHeader("Size", "size_bytes"),
        render: (db) => {
          const total = db.servers.reduce(
            (sum, s) => sum + (s.size_bytes ?? 0),
            0,
          );
          return formatBytes(total);
        },
      },
      ...(this._repoTargets ? [this._versionControlColumn()] : []),
      {
        label: "Actions",
        width: "13rem",
        render: (db) =>
          html`<div style="display:flex;gap:0.375rem">
            <wa-button
              title="Design Documents"
              size="s"
              appearance="outlined"
              class="row-action-button"
              data-design-docs
              @click=${(e: Event) => {
                e.stopPropagation();
                this._openDesignDocs(db);
              }}
              ><wa-icon name="pen-nib"></wa-icon
            ></wa-button>
            <wa-button
              title="Manage Indexes"
              size="s"
              appearance="outlined"
              class="row-action-button"
              data-manage-indexes
              @click=${(e: Event) => {
                e.stopPropagation();
                this._openManageIndexes(db);
              }}
              ><wa-icon name="list-check"></wa-icon
            ></wa-button>
            <wa-button
              title="Permissions"
              size="s"
              appearance="outlined"
              class="row-action-button"
              @click=${(e: Event) => {
                e.stopPropagation();
                this._selectedServerId = db.servers[0]?.server_id ?? "";
                this._selectedDb = db;
                this._selectedActionLabel = this.permissionsLabel;
              }}
              ><wa-icon name="user-shield"></wa-icon
            ></wa-button>
            <wa-button
              title="Replication"
              size="s"
              appearance="outlined"
              class="row-action-button"
              @click=${(e: Event) => {
                e.stopPropagation();
                this._selectedServerId = db.servers[0]?.server_id ?? "";
                this._selectedDb = db;
                this._selectedActionLabel = this.replicationLabel;
              }}
              ><wa-icon name="arrows-rotate"></wa-icon
            ></wa-button>
            <wa-button
              title="Delete Database"
              size="s"
              variant="danger"
              appearance="outlined"
              class="row-action-button"
              @click=${(e: Event) => {
                e.stopPropagation();
                this._deleteTargetServerIds = new Set(
                  db.servers.length === 1 ? [db.servers[0].server_id] : [],
                );
                this._confirmDeleteDb = db;
              }}
              ><wa-icon
                name="trash-can"
                variant="solid"
                label="Delete item"
              ></wa-icon
            ></wa-button>
          </div>`,
      },
    ];
  }

  /**
   * The repository tracking this row's database, or `null`.
   *
   * A target names a (server, database) pair, and a row can span several servers, so every server
   * the row lists is tried and the first hit wins — the row is one database as far as this screen
   * is concerned, and it either is or isn't tracked. A row carrying no server at all falls back to
   * {@link _openServerId}, the same substitution the row actions already make.
   */
  private _repoTargetFor(db: DatabaseOverview): RepoTargetRow | null {
    if (!this._repoTargets) return null;
    const serverIds = db.servers.length
      ? db.servers.map((s) => s.server_id)
      : [this._openServerId];
    for (const serverId of serverIds) {
      const row = this._repoTargets.get(targetKey(serverId, db.db_name));
      if (row) return row;
    }
    return null;
  }

  /**
   * Standing on a database, whether it is under version control and where (#34) — the answer
   * `/version-control` gives repository-first, given database-first.
   *
   * An untracked database renders an empty cell rather than the word "None": there is nothing to
   * report about it, and every row that says so is noise on the way to the rows that don't.
   *
   * A real anchor, and a real `#/` href — this app routes on the location hash (see
   * `Router.setHash`), so a bare `/version-control` would be a URL that only works when the click
   * handler beside it runs: middle-click, "open in new tab" and "copy link address" would all
   * hand out a broken one. The handler stays for the in-app path, where re-resolving the route
   * beats a hash write the router has to reason about after the fact.
   */
  private _versionControlColumn(): TableColumn<DatabaseOverview> {
    return {
      label: "Version Control",
      width: "11rem",
      render: (db) => {
        const tracked = this._repoTargetFor(db);
        if (!tracked) return nothing;
        const label = tracked.repo.name ?? tracked.repo.url ?? "Repository";
        return html`<a
          href="#/version-control"
          data-version-control
          title="Tracked by ${label}, branch ${tracked.target.branch}"
          style="display:inline-flex;flex-direction:column;color:var(--wa-color-text-link)"
          @click=${(e: Event) => {
            e.preventDefault();
            e.stopPropagation();
            getContext().router.navigate("/version-control");
          }}
          ><span data-version-control-repo>${label}</span
          ><span
            data-version-control-branch
            style="font-size:var(--wa-font-size-smaller);color:var(--wa-color-text-quiet)"
            >${tracked.target.branch}</span
          ></a
        >`;
      },
    };
  }

  private async _doDelete() {
    if (!this._confirmDeleteDb || this._deleteTargetServerIds.size === 0)
      return;
    const { db_name } = this._confirmDeleteDb;
    const serverIds = [...this._deleteTargetServerIds];
    this._deleting = true;
    try {
      await Promise.all(
        serverIds.map((sid) =>
          getContext().dbMgmt.deleteDatabase(db_name, sid),
        ),
      );
      toast(`Database "${db_name}" deleted.`, "success");
      this._confirmDeleteDb = null;
      this._reloadNow();
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? ((err.body as { detail?: string })?.detail ?? err.message)
          : String(err);
      toast(`Failed to delete database: ${msg}`, "error");
    } finally {
      this._deleting = false;
    }
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    clearHeaderActions();
    clearHeaderTitle();
    clearTimeout(this._searchDebounce);
    this._searchDebounce = undefined;
  }

  override connectedCallback() {
    clearHeaderActions();
    addHeaderActions([
      {
        icon: "circle-plus",
        tooltip: "Create Database",
        action: () => {
          getContext().router.navigate("/databases/$all/create");
        },
      },
    ]);
    setHeaderTitle("Databases");
    super.connectedCallback();
    this._loadDatabases();
    void this._loadRepoTargets();
  }

  /**
   * The one lookup behind the whole Version Control column: every registered repository, read
   * once per mount and indexed by the database each of its sync targets tracks. Never per row,
   * and deliberately not repeated by {@link _reloadNow} — searching or sorting the database list
   * cannot change which repository tracks a database, and neither can deleting one, which never
   * touches `couchcompanion`.
   *
   * Deliberately separate from {@link _loadDatabases}: a refusal here must cost this screen the
   * column and nothing else. Repositories live in `couchcompanion`, which is admin-only under
   * CouchDB's own default security, so a non-admin is refused as a matter of course (measured:
   * `GET /couchcompanion/_all_docs` answers 403 `forbidden` to an authenticated non-admin, while
   * `GET /_all_dbs` answers 401) — a fact about their account, not a fault worth a toast, and
   * certainly not one that should turn a working database list into an error (D9).
   *
   * Nothing is pre-gated on `isAdmin`. The call is made and the answer actually received decides,
   * because an operator who has opened `couchcompanion` to members is entitled to have that
   * respected — the same reason `db-enumeration.ts` gives for never pre-gating the list itself.
   */
  private async _loadRepoTargets() {
    try {
      const { repos } = await getContext().designMgmt.listRepos();
      this._repoTargets = indexTargetsByDatabase(repos);
    } catch (err) {
      this._repoTargets = null;
      if (isEnumerationDenied(err)) {
        log.debug(
          "Version Control column omitted: reading the repositories was refused",
        );
      } else {
        log.error("Failed to load version-control targets", err as Error);
      }
    }
  }

  /** Keystroke-triggered reloads wait out the debounce window (#821). */
  private _scheduleSearch() {
    clearTimeout(this._searchDebounce);
    this._searchDebounce = setTimeout(() => {
      this._searchDebounce = undefined;
      this._loadDatabases();
    }, CcaDbList.SEARCH_DEBOUNCE_MS);
  }

  /**
   * Discrete reload triggers (clear, sort, post-delete) reload at once,
   * dropping any pending keystroke reload.
   */
  private _reloadNow() {
    clearTimeout(this._searchDebounce);
    this._searchDebounce = undefined;
    this._loadDatabases();
  }

  private async _loadDatabases() {
    const seq = ++this._loadSeq;
    this.loading = true;
    try {
      const params: ListDatabasesParams = {
        sort_by: this.sortBy,
        sort_order: this.sortOrder,
      };
      const sid = this.serverId?.trim();
      const q = this.search.trim();
      if (q) {
        params.filter_name = "db_name";
        params.filter_value = q;
      }
      const dbs = await getContext().dbMgmt.listDatabases(params);
      if (seq !== this._loadSeq) return; // superseded by a newer reload — drop
      // The list is being served again (permissions changed, or `admin_only_all_dbs` was
      // turned off) — a refusal recorded earlier must not outlive it.
      this._enumerationDenied = null;
      if (sid && sid !== "$all") {
        this.databases = dbs.filter((db) =>
          db.servers.some((s) => s.server_id === sid),
        );
      } else {
        this.databases = dbs;
      }
    } catch (err) {
      if (seq === this._loadSeq) {
        // 401/403 means `GET /_all_dbs` is admin-only here, which is CouchDB's own default —
        // not a failure to report. Everything else still is.
        if (isEnumerationDenied(err)) {
          this._enumerationDenied = describeDbAccessError(err);
          this.databases = [];
        } else {
          log.error("Failed to load databases", err as Error);
          toast(
            `Failed to load databases: ${err instanceof Error ? err.message : String(err)}`,
            "error",
          );
        }
      }
    } finally {
      if (seq === this._loadSeq) this.loading = false;
    }
  }

  /**
   * The server a typed database name is opened on. `$all` is the route's "no server chosen"
   * placeholder rather than an addressable id, and this product manages exactly one CouchDB,
   * so it resolves to {@link SINGLE_SERVER_ID} — the id every service call already carries.
   */
  private get _openServerId(): string {
    const sid = this.serverId?.trim();
    return sid && sid !== "$all" ? sid : SINGLE_SERVER_ID;
  }

  /**
   * Opens the typed database, but only after `GET /{db}` says it can be opened.
   *
   * The probe is the whole point: navigating on faith lands on `doc-browser`, which answers a
   * name the user cannot open with a vague toast over an empty table — a dead end reached from
   * the screen that exists to avoid one. Here the three refusals CouchDB distinguishes (403 not
   * a member, 404 no such database, anything else) are named beside the field the user typed in.
   *
   * The name is read from the picker rather than tracked per keystroke: `cca-db-change` fires on
   * `change`, i.e. on blur as well as Enter, and navigating away because someone tabbed out of a
   * field is not a thing this screen should do.
   */
  private async _openByName() {
    if (this._opening) return;
    const dbName = (
      this.shadowRoot?.querySelector("cca-db-picker")?.value ?? ""
    ).trim();
    if (!dbName) return;
    const serverId = this._openServerId;
    this._openError = "";
    this._opening = true;
    try {
      await getContext().dbMgmt.getDatabaseInfo(serverId, dbName);
      getContext().router.navigate(
        `/databases/${encodeURIComponent(serverId)}/${encodeURIComponent(dbName)}/documents`,
      );
    } catch (err) {
      // The probe was `GET /{db}` — one database, not the server-wide listing — so a 401
      // here is "this database will not open for you", not "listing is admin-only" (#66).
      this._openError = describeDbAccessError(err, dbName, "database");
    } finally {
      this._opening = false;
    }
  }

  /**
   * What this screen becomes when the database list is refused: the reason, and the one way
   * forward that still works. The table is deliberately absent — its "No databases found."
   * would be a lie, since the databases are there and only the listing was refused.
   */
  private _renderEnumerationDenied(reason: string) {
    return html`
      <wa-callout
        variant="neutral"
        appearance="outlined"
        data-enumeration-denied
        style="margin-bottom:1rem"
      >
        <wa-icon slot="icon" name="circle-info"></wa-icon>
        ${reason}
      </wa-callout>
      <div
        data-open-by-name
        style="display:flex;gap:0.5rem;align-items:flex-start"
      >
        <cca-db-picker
          unavailable
          placeholder="Database name"
          style="flex:1"
          @keydown=${(e: KeyboardEvent) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            this._openByName();
          }}
        ></cca-db-picker>
        <wa-button
          data-open-db
          variant="brand"
          ?loading=${this._opening}
          @click=${() => this._openByName()}
          >Open</wa-button
        >
      </div>
      ${this._openError
        ? html`<p
            data-open-error
            role="alert"
            style="color:var(--wa-color-danger-on-quiet)"
          >
            ${this._openError}
          </p>`
        : nothing}
    `;
  }

  private _renderList() {
    return html`
      <wa-input
        placeholder="Search databases…"
        .value=${this.search}
        @input=${(e: Event) => {
          const value = (e.target as HTMLInputElement).value;
          // WA's clear button fires wa-clear (handled below) and then a
          // composed input for the same, already-applied value — don't
          // schedule a second reload when nothing changed.
          if (value === this.search) return;
          this.search = value;
          this._scheduleSearch();
        }}
        @wa-clear=${() => {
          this.search = "";
          this._reloadNow();
        }}
        style="margin-bottom:1rem;display:block"
        clearable
      ></wa-input>
      <cca-data-table
        .columns=${this._columns as any[]}
        .rows=${this.databases}
        .loading=${this.loading}
        empty-message="No databases found."
      ></cca-data-table>
    `;
  }

  override render() {
    return html`
      ${this._enumerationDenied !== null
        ? this._renderEnumerationDenied(this._enumerationDenied)
        : this._renderList()}

      <!-- Source server picker drawer -->
      <wa-drawer
        label=${this._selectedActionLabel}
        ?open=${this._selectedDb !== null}
        @wa-after-hide=${(e: Event) => {
          if (e.target === e.currentTarget) this._selectedDb = null;
        }}
      >
        <p>
          Select the server for
          <strong>${this._selectedDb?.db_name}</strong>:
        </p>
        <wa-radio-group
          .value=${this._selectedServerId}
          @change=${(e: Event) =>
            (this._selectedServerId = (e.target as HTMLInputElement).value)}
        >
          ${(this._selectedDb?.servers ?? []).map(
            (s) =>
              html`<wa-radio value=${s.server_id}>${s.server_name}</wa-radio>`,
          )}
        </wa-radio-group>
        <div
          slot="footer"
          style="display:flex;gap:0.5rem;justify-content:flex-end"
        >
          <wa-button @click=${() => (this._selectedDb = null)}
            >Cancel</wa-button
          >
          <wa-button
            variant="brand"
            ?disabled=${!this._selectedServerId}
            @click=${() => {
              if (!this._selectedDb || !this._selectedServerId) return;
              const url =
                this._selectedActionLabel === this.replicationLabel
                  ? `/replications/${encodeURIComponent(this._selectedServerId)}/create` +
                    `?source_db=${encodeURIComponent(this._selectedDb.db_name)}` +
                    `&source_server_id=${encodeURIComponent(this._selectedServerId)}`
                  : `/databases/${encodeURIComponent(this._selectedServerId)}/${encodeURIComponent(this._selectedDb.db_name)}/access`;

              this._selectedDb = null;
              getContext().router.navigate(url);
            }}
            >Continue</wa-button
          >
        </div>
      </wa-drawer>

      <!-- Delete confirmation drawer -->
      <wa-drawer
        label="Delete Database"
        ?open=${this._confirmDeleteDb !== null}
        @wa-after-hide=${(e: Event) => {
          if (e.target === e.currentTarget && !this._deleting)
            this._confirmDeleteDb = null;
        }}
      >
        <p>
          Select servers to delete
          <strong>${this._confirmDeleteDb?.db_name}</strong> from:
        </p>
        <div style="display:flex;flex-direction:column;gap:0.5rem">
          ${(this._confirmDeleteDb?.servers ?? []).map(
            (s) =>
              html`<wa-checkbox
                ?checked=${this._deleteTargetServerIds.has(s.server_id)}
                @click=${(e: Event) => {
                  e.preventDefault();
                  const next = new Set(this._deleteTargetServerIds);
                  if (next.has(s.server_id)) next.delete(s.server_id);
                  else next.add(s.server_id);
                  this._deleteTargetServerIds = next;
                }}
                >${s.server_name}</wa-checkbox
              >`,
          )}
        </div>
        <div
          slot="footer"
          style="display:flex;gap:0.5rem;justify-content:flex-end"
        >
          <wa-button @click=${() => (this._confirmDeleteDb = null)}
            >Cancel</wa-button
          >
          <wa-button
            variant="danger"
            ?loading=${this._deleting}
            ?disabled=${this._deleteTargetServerIds.size === 0}
            @click=${() => this._doDelete()}
            >Delete</wa-button
          >
        </div>
      </wa-drawer>

      <!-- Browse — server picker modal -->
      <wa-dialog
        label="Browse ${this._browseDb?.db_name ?? ""}"
        ?open=${this._browseDb !== null}
        @wa-after-hide=${(e: Event) => {
          if (e.target === e.currentTarget) this._browseDb = null;
        }}
      >
        <p style="margin-top:0">Select a server to browse documents on:</p>
        <wa-radio-group .value=${this._browseServerId}>
          ${(this._browseDb?.servers ?? []).map(
            (s) =>
              html`<wa-radio
                value=${s.server_id}
                ?checked=${s.server_id === this._browseServerId}
                @click=${() => (this._browseServerId = s.server_id)}
                >${s.server_name}
                <span style="font-size:var(--wa-font-size-smaller);opacity:0.7">
                  — ${s.doc_count.toLocaleString()}
                  docs${s.partitioned ? " · partitioned" : ""}</span
                ></wa-radio
              >`,
          )}
        </wa-radio-group>
        <div
          slot="footer"
          style="display:flex;gap:0.5rem;justify-content:flex-end"
        >
          <wa-button @click=${() => (this._browseDb = null)}>Cancel</wa-button>
          <wa-button
            variant="brand"
            ?disabled=${!this._browseServerId}
            @click=${() => {
              if (!this._browseDb || !this._browseServerId) return;
              const db = this._browseDb;
              const sid = this._browseServerId;
              this._browseDb = null;
              getContext().router.navigate(
                `/databases/${encodeURIComponent(sid)}/${encodeURIComponent(db.db_name)}/documents`,
              );
            }}
            >Browse</wa-button
          >
        </div>
      </wa-dialog>
    `;
  }
}
