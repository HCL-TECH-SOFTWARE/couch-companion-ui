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
import { customElement, property, query, state } from "lit/decorators.js";
import { CcaElement } from "../../components/cca-element.js";
import { getContext } from "../../context.js";
import { toast } from "../../components/cca-toast.js";
import type { TableColumn } from "../../components/cca-data-table.js";
import "../../components/cca-header-bar.js";
import type {
  DatabaseServerInfo,
  ExplainQueryRequest,
  SavedQuerySnapshot,
} from "./types.js";
import "../../components/cca-data-table.js";
import "../../components/cca-monaco-editor.js";
import "../../components/cca-page-controls.js";
import "../../components/cca-column-picker.js";
import "./explain-query.js";
import "@awesome.me/webawesome/dist/components/button/button.js";
import "@awesome.me/webawesome/dist/components/badge/badge.js";
import "@awesome.me/webawesome/dist/components/spinner/spinner.js";
import "@awesome.me/webawesome/dist/components/radio/radio.js";
import "@awesome.me/webawesome/dist/components/radio-group/radio-group.js";
import "@awesome.me/webawesome/dist/components/dialog/dialog.js";
import {
  IndexOffer,
  indexOfferStyles,
  type SortItem,
} from "./index-offer.js";
import { ApiError } from "../../services/api-error.js";
import {
  clearHeaderTitle,
  setHeaderTitle,
} from "../../components/cca-header.js";
import "../../components/cca-mango.js";
import type { CcaMango } from "../../components/cca-mango.js";
import { CcaQueryHistory } from "./query_history.js";
import {
  DOC_QUERY_PAGE_SIZE_KEY,
  getPageSize,
  setPageSize,
} from "../../services/page-size-preference.js";
import {
  formatCellValue,
  resolveColumns,
} from "../../services/derived-columns.js";
import { attachmentColumn } from "../../components/cca-attachment-count.js";
import "@awesome.me/webawesome/dist/components/icon/icon.js";

const DEFAULT_SELECTOR = JSON.stringify({ _id: { $gt: null } }, null, 2);

/** How many documents "Run Preview" samples, whatever the page size is set to. */
const PREVIEW_SIZE = 10;

@customElement("cca-doc-query")
export class CcaDocQuery extends CcaElement {
  /** Set by the router from the :dbName path param. */
  @property() dbName = "";

  /** Set by the router from the :serverId path param. */
  @property({ type: String }) serverId = "";

  @state() private _servers: DatabaseServerInfo[] = [];
  @state() private _scope: "raw" | "full" = "full";

  @state() private _selectorJson = DEFAULT_SELECTOR;
  @state() private _history: SavedQuerySnapshot[] = [];
  @state() private _fields: string[] = [];
  @state() private _sortItems: SortItem[] = [];
  @state() private _previewResults: Record<string, unknown>[] = [];
  @state() private _results: Record<string, unknown>[] = [];
  @state() private _loading = false;
  @state() private _hasMore = false;
  @state() private _page = 0;
  @state() private _view: "table" | "json" = "table";
  @state() private _ran = false;
  @state() private _availableFields: string[] = [];
  /**
   * Which field each result column shows, once a picker has been used; `null` while the
   * columns are whatever the returned documents carry (#79). Cleared with the results:
   * a new query may project an entirely different set of fields.
   */
  @state() private _columnFields: string[] | null = null;
  /** Documents per page, remembered across reloads in `localStorage` (#80). */
  @state() private _pageSize = getPageSize(DOC_QUERY_PAGE_SIZE_KEY);
  /** Documents skipped before the first page. Not persisted — it is a position, not a preference. */
  @state() private _skip = 0;

  /**
   * The "no index for this sort" offer (#78) — its dialog, its state and its pre-population,
   * shared with `doc-browser`'s sortable headers since #82 rather than copied there.
   */
  readonly indexOffer = new IndexOffer(this);

  @query("cca-query-history") private _queryHistoryEl!: CcaQueryHistory;
  @query("cca-mango") private _mangoEl!: CcaMango;

  // _bookmarks[n] is the bookmark needed to fetch page n.
  private _bookmarks: (string | undefined)[] = [undefined];

  static override get styles() {
    return [
      indexOfferStyles,
      css`
      :host {
        display: block;
      }
      .content-container {
        padding: 1rem;
        display: flex;
        flex-direction: column;
        gap: 1rem;
        overflow: auto;
      }
      .sidebar {
        flex: 0 1 auto;
        overflow-y: auto;
        display: grid;
        grid-template-columns: 1fr 1fr 1fr;
      }
      .sidebar-section {
        margin-bottom: 0.75rem;
      }
      .section-label {
        font-size: var(--wa-font-size-s);
        font-weight: var(--wa-font-weight-bold);
        margin-bottom: 0.35rem;
        opacity: 1;
        color: var(--wa-color-text-normal, #1f2a35);
      }
      .section-label-collapsible {
        cursor: pointer;
        user-select: none;
        display: flex;
        align-items: center;
        gap: 0.3rem;
      }
      .collapse-icon {
        font-size: var(--wa-font-size-3xs);
      }
      .section-label-count {
        font-weight: var(--wa-font-weight-normal);
        opacity: 0.6;
      }
      .editor-container {
        height: 180px;
      }
      .button-row {
        display: flex;
        gap: 0.4rem;
        align-items: center;
      }
      .button-row-end {
        display: flex;
        justify-content: flex-end;
        gap: 0.5rem;
        margin-top: 0.75rem;
      }
      .tag-list {
        display: flex;
        flex-wrap: wrap;
        gap: 0.35rem;
        margin-bottom: 0.4rem;
      }
      .tag {
        display: inline-flex;
        align-items: center;
        gap: 0.25rem;
        background: var(--wa-color-neutral-fill-normal);
        border-radius: 4px;
        padding: 0.15rem 0.45rem;
        font-size: var(--wa-font-size-s);
      }
      .tag-close-btn {
        background: none;
        border: none;
        cursor: pointer;
        padding: 0;
        line-height: var(--wa-line-height-condensed);
        font-size: var(--wa-font-size-s);
        opacity: 0.55;
      }
      .sort-direction-btn {
        background: none;
        border: 1px solid var(--wa-color-neutral-border-normal);
        border-radius: 3px;
        cursor: pointer;
        padding: 0 0.25rem;
        line-height: var(--wa-line-height-normal);
        font-size: var(--wa-font-size-xs);
        opacity: 0.75;
      }
      .field-input {
        flex: 1;
        padding: 0.35rem 0.5rem;
        border: 1px solid var(--wa-color-neutral-border-normal);
        border-radius: 4px;
        font-size: var(--wa-font-size-s);
        background: var(--wa-color-surface-default);
        color: inherit;
      }
      .datalist {
        width: 100%;
      }
      .mango-editor-panel {
        flex: 0 0 auto;
        min-width: 0;
        display: flex;
        flex-direction: column;
        overflow-y: auto;
      }
      .results-section {
        flex: 1 1 auto;
        min-width: 0;
        display: flex;
        flex-direction: column;
        overflow: auto;
      }
      .results-container {
        padding: 1rem;
        margin-top: 1rem;
      }
      .results-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 0.5rem;
      }
      .view-toggle-group wa-radio-group::part(form-control-label) {
        position: absolute;
        width: 1px;
        height: 1px;
        overflow: hidden;
        clip-path: inset(50%);
        white-space: nowrap;
      }
      .table-container {
        overflow-x: auto;
        overflow-y: auto;
        max-height: 60vh;
      }
      .json-view-item {
        border: 1px solid var(--wa-color-neutral-border-quiet);
        border-radius: 4px;
        height: 220px;
        margin-bottom: 0.5rem;
      }
      .empty-state {
        text-align: center;
        padding: 3rem;
        font-size: var(--wa-font-size-m);
        opacity: 0.45;
        width: 100%;
        flex: 1;
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .server-select {
        display: block;
        margin-bottom: 1rem;
        max-width: 24rem;
      }
      cca-mango {
        display: flex;
        width: 100%;
      }
    `,
    ];
  }

  private async saveHistory(dbName: string, snapshot: SavedQuerySnapshot) {
    await this._queryHistoryEl.saveHistory(dbName, snapshot);
  }

  override connectedCallback() {
    super.connectedCallback();
    setHeaderTitle(`Mango Query`);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    clearHeaderTitle();
  }

  private _defaultTitle(selectorJson: string): string {
    const compact = selectorJson.replace(/\s+/g, " ").trim();
    const preview =
      compact.length > 56 ? `${compact.slice(0, 56)}...` : compact;
    return preview || "Untitled query";
  }

  private _buildSnapshot(selectorJson: string): SavedQuerySnapshot {
    return {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      db_name: this.dbName,
      selected_server_id: this.serverId,
      selectorJson,
      fields: [...this._fields],
      sortItems: this._sortItems.map((s) => ({ ...s })),
      scope: this._scope,
      savedAt: new Date().toISOString(),
      title: this._defaultTitle(selectorJson),
    };
  }

  private async _applySnapshot(
    snapshot: SavedQuerySnapshot,
    resetResults = true,
  ) {
    this._selectorJson = snapshot.selectorJson;
    this._fields = [...snapshot.fields];
    this._availableFields = [...snapshot.fields];
    this._sortItems = snapshot.sortItems.map((s) => ({ ...s }));
    this._scope = snapshot.scope;
    if (resetResults) {
      this._resetResults();
    }
  }

  private _resetResults() {
    this._results = [];
    this._hasMore = false;
    this._page = 0;
    this._bookmarks = [undefined];
    this._ran = false;
    this._columnFields = null;
  }

  /**
   * The bare selector the editor currently holds, or `null` after complaining that it
   * is not JSON.
   *
   * `_selectorJson` holds whatever `cca-mango` last emitted, which is the *whole*
   * Mango query — selector plus its siblings — so the one redundant `selector` layer
   * is unwrapped here. Every run/page entry point used to carry its own copy of this
   * try/parse/unwrap block; they are one now, so a fix reaches all of them.
   */
  private _parseSelector(): Record<string, unknown> | null {
    try {
      const parsed = JSON.parse(this._selectorJson) as Record<string, unknown>;
      const inner = parsed?.selector as Record<string, unknown> | undefined;
      return inner ? inner : parsed;
    } catch {
      toast("Invalid JSON selector", "error");
      return null;
    }
  }

  private _runQuery() {
    const selector = this._parseSelector();
    if (!selector) return;
    this._resetResults();
    this._fetchPage({ page: 0, selector, persistOnSuccess: true });
  }

  private _runPreview() {
    const selector = this._parseSelector();
    if (!selector) return;
    this._fetchPage({
      page: 0,
      selector,
      persistOnSuccess: true,
      preview: true,
    });
    this._notifyTabChange();
  }

  private _onPageSizeChange(pageSize: number) {
    if (pageSize === this._pageSize) return;
    this._pageSize = pageSize;
    setPageSize(DOC_QUERY_PAGE_SIZE_KEY, pageSize);
    this._rerunFromFirstPage();
  }

  private _onSkipChange(skip: number) {
    if (skip === this._skip) return;
    this._skip = skip;
    this._rerunFromFirstPage();
  }

  /**
   * Re-runs from page 1 after the shape of a page changed. Bookmarks minted under the
   * old page size point at row boundaries the new one does not have, so they go.
   * Nothing is re-run until a query has been run once — there is nothing to page yet.
   */
  private _rerunFromFirstPage() {
    if (!this._ran) return;
    const selector = this._parseSelector();
    if (!selector) return;
    this._bookmarks = [undefined];
    this._fetchPage({ page: 0, selector });
  }

  /**
   * One request, one page. The selector is always passed in, from
   * {@link _parseSelector} — the single place that turns the editor's text into one.
   *
   * `preview` is what tells a preview from a page, not the limit it happens to use:
   * "10" became a real page size in #80, and comparing against it would have routed
   * every page of a 10-per-page query into the preview panel.
   */
  private _fetchPage(opts: {
    page: number;
    selector: Record<string, unknown>;
    bookmark?: string;
    persistOnSuccess?: boolean;
    preview?: boolean;
  }) {
    if (!this.serverId) return;
    const {
      page,
      selector: sel,
      bookmark,
      persistOnSuccess = false,
      preview = false,
    } = opts;
    // Always explicit: `_find` silently truncates at 25 documents when `limit` is
    // omitted, so a 50- or 100-per-page choice would come back short and look like
    // the end of the results (db-mgmt-service.ts, FIND_DEFAULT_LIMIT).
    const limit = preview ? PREVIEW_SIZE : this._pageSize;
    // Snapshotted before the request so the failure path reports the sort that was actually
    // sent, not whatever the Sort panel holds by the time the rejection comes back.
    const sortItems = this._sortItems.map((s) => ({ ...s }));
    this._loading = true;
    getContext()
      .dbMgmt.queryDocuments(this.serverId, this.dbName, {
        selector: { selector: sel },
        fields: this._fields.length > 0 ? this._fields : undefined,
        sort: this._toMangoSort(sortItems),
        limit,
        skip: preview ? undefined : this._skip,
        bookmark,
        scope: this._scope,
      })
      .then((resp) => {
        const docs = (resp.documents ?? []) as Record<string, unknown>[];
        if (preview) {
          this._previewResults = docs;
        } else {
          this._results = docs;
          // This screen pages Mango `_find`, which returns a bookmark on
          // EVERY response including the last page — unlike `_all_docs`
          // (see doc-browser.ts), so `!!resp.bookmark` would leave "more"
          // stuck on forever here. The row-count check is the correct
          // signal for `_find`; do not "harmonize" this with doc-browser.
          this._hasMore = docs.length === limit;
          this._page = page;
          const nextBm = resp.bookmark ?? "";
          if (this._hasMore && nextBm && nextBm !== this._bookmarks[page + 1]) {
            this._bookmarks = [...this._bookmarks.slice(0, page + 1), nextBm];
          }
        }
        this._loading = false;
        this._ran = true;
        if (persistOnSuccess) {
          const snapshot = this._buildSnapshot(this._selectorJson);
          this.saveHistory(this.dbName, snapshot);
        }
      })
      .catch((err) => {
        this._handleQueryError(err, sortItems, () => this._fetchPage(opts));
      });
  }

  private async _fetchFields() {
    if (!this.serverId) return;
    const sel = this._parseSelector();
    if (!sel) return;
    const sortItems = this._sortItems.map((s) => ({ ...s }));
    try {
      const resp = await getContext().dbMgmt.queryDocuments(
        this.serverId,
        this.dbName,
        {
          selector: sel,
          fields: this._fields.length > 0 ? this._fields : undefined,
          sort: this._toMangoSort(sortItems),
          limit: 100,
          bookmark: undefined,
          scope: this._scope,
        },
      );
      const docs = (resp.documents ?? []) as Record<string, unknown>[];
      this._availableFields = this._extractFieldNames(docs);
    } catch (err) {
      this._handleQueryError(err, sortItems, () => void this._fetchFields());
    }
  }

  /** `_sortItems`' `{field, direction}` pairs as `_find`'s single-key objects, or nothing. */
  private _toMangoSort(
    sortItems: SortItem[],
  ): Array<Record<string, string>> | undefined {
    if (sortItems.length === 0) return undefined;
    return sortItems.map((s) => ({ [s.field]: s.direction }));
  }

  /**
   * Where every rejected `_find` on this screen lands — one place, so the no-usable-index
   * offer cannot reach only half of them. (Both catch blocks previously carried their own
   * copy of the same toast.)
   *
   * `sort` is the sort that request carried and `retry` re-issues that same request, both
   * supplied by the caller: this is what lets the offer describe the query that actually
   * failed and run it again afterwards, without this method knowing which caller it serves.
   *
   * Everything the offer does not take keeps the bare toast it always had — including a
   * no-usable-index rejection on a query with no sort, which CouchDB does not currently
   * produce (a sortless query is answered 200 with a `warning`), and where there would be no
   * sort fields to build an index from anyway. {@link IndexOffer.offerIfNoUsableIndex} owns
   * both of those conditions and says whether it took the failure.
   */
  private _handleQueryError(err: unknown, sort: SortItem[], retry: () => void) {
    this._loading = false;
    if (this.indexOffer.offerIfNoUsableIndex(err, sort, retry)) return;
    const msg =
      err instanceof ApiError
        ? ((err.body as any)?.detail ?? err.message)
        : String(err);
    toast(`Query failed: ${msg}`, "error");
  }

  private _prevPage() {
    if (this._page === 0) return;
    this._goToPage(this._page - 1);
  }

  private _nextPage() {
    this._goToPage(this._page + 1);
  }

  private _goToPage(page: number) {
    const selector = this._parseSelector();
    if (!selector) return;
    this._fetchPage({ page, bookmark: this._bookmarks[page], selector });
  }

  /**
   * One column per field the results carry — the pattern #79 lifted into `doc-browser`,
   * now sharing that screen's derivation ({@link resolveColumns}) so the two agree on
   * what a page of documents turns into, and on what a picker may switch a column to.
   *
   * The field list used to be `Object.keys(this._results[0])`: the *first* row's keys,
   * which in a heterogeneous result silently hides every field that row happens to lack.
   *
   * Leaves `ariaSort` unset — #82 wires header-click sorting; nothing here sorts yet.
   *
   * The attachment indicator leads, on the same terms `doc-browser` gives it (#84), and
   * `_attachments` itself is not among the derived fields. A query with a `fields`
   * projection gets no column at all: `_find` returns exactly the fields asked for, so no
   * row carries the stubs and there is nothing truthful to count. That is the right
   * outcome — a "0" on a document that has three attachments would be worse than silence.
   */
  private get _columns(): TableColumn<Record<string, unknown>>[] {
    const { fields, available } = resolveColumns(
      this._results,
      this._columnFields,
    );
    return [
      ...attachmentColumn(this._results),
      ...fields.map((field, index) => ({
        label: field,
        key: field,
        headerRender: () => this.renderColumnHeader(field, available, index),
        render: (row: Record<string, unknown>) => formatCellValue(row[field]),
      })),
    ];
  }

  /**
   * A result column's header: the field name, which adds that field to the query's
   * projection when clicked, and the picker that swaps the column for another field.
   *
   * The two are different questions — "fetch me this field" and "show me that field
   * here" — so they stay two controls rather than one overloaded header.
   */
  private renderColumnHeader(field: string, available: string[], index: number) {
    const already = this._fields.includes(field);
    return html`<span class="column-header"
      ><span
        data-add-field
        @click=${(e: Event) => {
          e.stopPropagation();
          if (!already) {
            this._fields = [...this._fields, field];
          }
        }}
        title=${already ? "Already in fields" : "Click to add to fields"}
        style="cursor:${already ? "default" : "pointer"};opacity:${
          already ? "0.5" : "1"
        };text-decoration:${already ? "none" : "underline dotted"}"
        >${field}</span
      >
      <cca-column-picker
        .field=${field}
        .fields=${available}
        @cca-column-field-change=${(e: CustomEvent<{ field: string }>) =>
          this._setColumnField(index, e.detail.field)}
      ></cca-column-picker
    ></span>`;
  }

  /**
   * Points one column at a different field. The first such choice freezes the whole
   * column list — see {@link resolveColumns} — so the swap survives the next page.
   */
  private _setColumnField(index: number, field: string) {
    const { fields } = resolveColumns(this._results, this._columnFields);
    if (fields[index] === field) return;
    const next = [...fields];
    next[index] = field;
    this._columnFields = next;
  }

  /**
   * `cca-mango-change`'s `query.sort` is an array of single-key
   * `{field: direction}` objects (cca-mango's own on-the-wire Mango shape).
   * `_sortItems` — the array `_fetchPage`/`_fetchFields` actually forward as
   * `sort` — uses `{field, direction}` objects instead. Convert between the
   * two so the live Sort panel reaches `_find`.
   */
  private _toSortItems(
    sort: unknown,
  ): Array<{ field: string; direction: "asc" | "desc" }> {
    if (!Array.isArray(sort)) return [];
    return sort.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      return Object.entries(entry as Record<string, unknown>).map(
        ([field, direction]) => ({
          field,
          direction: direction === "desc" ? ("desc" as const) : ("asc" as const),
        }),
      );
    });
  }

  private _extractFieldNames(results: Record<string, unknown>[]): string[] {
    // Extract field names from results (or first document if available)
    if (results.length > 0) {
      const uniqueKeys = new Set<string>();
      for (const doc of results) {
        const keys = Object.keys(doc);
        keys.forEach((k) => uniqueKeys.add(k));
      }
      const keys = Array.from(uniqueKeys);
      return keys;
    }
    // Fallback to fields used in query
    if (this._fields.length > 0) {
      return this._fields;
    }
    return [];
  }

  /**
   * Opens the design documents of the database being queried (#81).
   *
   * The same route and query-param pair `doc-browser`, `db-list` and `repo-overview` all
   * navigate with; `cca-design-list` reads `?database=` on arrival and narrows to it, and
   * ignores it while `:serverId` is `$all`, so the server is named.
   */
  private _openDesignDocs() {
    getContext().router.navigate(
      `/design-docs/${encodeURIComponent(this.serverId || "$all")}` +
        `?database=${encodeURIComponent(this.dbName)}`,
    );
  }

  private _openDoc(docId: unknown) {
    if (typeof docId !== "string") return;
    getContext().router.navigate(
      `/databases/${encodeURIComponent(this.serverId || "$all")}/${encodeURIComponent(this.dbName)}/documents/${encodeURIComponent(docId)}`,
    );
  }

  _notifyTabChange() {
    const event = new CustomEvent("request-tab-change", {
      detail: { panel: "preview" },
      bubbles: true,
      composed: true, // Allows the event to pass through Shadow DOM boundaries
    });
    window.dispatchEvent(event);
  }

  override render() {
    return html`
      <!-- Header bar -->
      <cca-header-bar
        .title=${this.dbName}
        @cca-header-back=${() =>
          getContext().router.back(
            `/databases/${encodeURIComponent(this.serverId)}/${encodeURIComponent(this.dbName)}/documents`,
          )}
      >
        <wa-button
          slot="right"
          size="s"
          appearance="outlined"
          title="Design Documents"
          data-design-docs
          @click=${() => this._openDesignDocs()}
          ><wa-icon name="pen-nib" variant="solid"></wa-icon
        ></wa-button>
      </cca-header-bar>
      <div class="content-container">
        <div class="sidebar">
          <div
            class="section-label"
            style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.75rem"
          >
            <cca-query-history
              .dbName=${this.dbName}
              .serverId=${this.serverId}
              .history=${this._history}
              @cca-query-history-apply-snapshot=${async (e: CustomEvent) => {
                const snapshot = e.detail.snapshot as SavedQuerySnapshot;
                this._applySnapshot(snapshot, true);
                await this.updateComplete;
                // Reinitialize the mango builder after history changes _selectorJson
                this._mangoEl.reinitializeFromQuery();
              }}
              @cca-query-history-refreshed=${async (e: CustomEvent) => {
                this._history = e.detail.history;
                await this.updateComplete;
              }}
            ></cca-query-history>
          </div>
          <div></div>
          <div class="button-row-end">
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
              @click=${() => this._runQuery()}
            >
              ${this._loading ? html`<wa-spinner></wa-spinner>` : "Run Query ▶"}
            </wa-button>
          </div>
        </div>
        <!-- Selector editor via cca-mango -->
        <div class="mango-editor-panel">
          <cca-mango
            .dbName=${this.dbName}
            .serverId=${this.serverId}
            .query=${JSON.parse(this._selectorJson)}
            .availableFieldNames=${this._availableFields}
            .previewResults=${this._previewResults}
            .showOperatorHelp=${true}
            .showFieldNames=${true}
            .showSortFields=${true}
            .selectedFieldNames=${new Set(this._fields)}
            @cca-mango-change=${(e: CustomEvent) => {
              this._selectorJson = JSON.stringify(e.detail.query, null, 2);
              this._sortItems = this._toSortItems(e.detail.query?.sort);
            }}
            @cca-mango-retrieve-fields=${async (e: CustomEvent) => {
              await this._fetchFields();
              e.detail.resolve(true);
            }}
            @cca-mango-selected-fields-change=${(e: CustomEvent) => {
              this._fields = e.detail.selectedFields;
            }}
          ></cca-mango>
        </div>
        <!-- Results -->
        ${this.renderResults()}
      </div>
      ${this.indexOffer.render(this.dbName, this.serverId)}
    `;
  }

  /** `1–25`, counted from the skip offset. `_find` reports no total, so none is shown. */
  private get _rangeLabel(): string {
    if (this._results.length === 0) return "No results";
    const start = this._skip + this._page * this._pageSize + 1;
    const end = start + this._results.length - 1;
    return `${start.toLocaleString()}–${end.toLocaleString()}`;
  }

  private renderResults() {
    const results = html`
      <!-- Results header: view toggle + count -->
      <div class="results-container">
        <div class="results-header">
          <wa-radio-group
            class="view-toggle-group"
            label="Result view"
            .value=${this._view}
            @input=${(e: CustomEvent) => {
              const next = e.detail?.value;
              if (next === "table" || next === "json") {
                this._view = next;
              }
            }}
            @click=${(e: Event) => {
              const path = e.composedPath();
              if (
                path.some(
                  (item) =>
                    item instanceof HTMLElement && item.id === "view-json",
                )
              ) {
                this._view = "json";
                return;
              }
              if (
                path.some(
                  (item) =>
                    item instanceof HTMLElement && item.id === "view-table",
                )
              ) {
                this._view = "table";
              }
            }}
          >
            <wa-radio
              id="view-table"
              value="table"
              role="radio"
              aria-checked=${this._view === "table" ? "true" : "false"}
              @click=${() => {
                this._view = "table";
              }}
              >Table</wa-radio
            >
            <wa-radio
              id="view-json"
              value="json"
              role="radio"
              aria-checked=${this._view === "json" ? "true" : "false"}
              @click=${() => {
                this._view = "json";
              }}
              >JSON</wa-radio
            >
          </wa-radio-group>
        </div>
        <!-- Table view -->
        ${
          this._view === "table"
            ? this.renderResultTable()
            : this.renderResultRaw()
        }
        <!-- Page size, skip, range and previous/next — the footer doc-browser wears too (#80) -->
        <cca-page-controls
          .pageSize=${this._pageSize}
          .skip=${this._skip}
          .hasPrev=${this._page > 0}
          .hasNext=${this._hasMore}
          .loading=${this._loading}
          .rangeLabel=${this._rangeLabel}
          @cca-page-size-change=${(e: CustomEvent) =>
            this._onPageSizeChange(e.detail.pageSize)}
          @cca-skip-change=${(e: CustomEvent) =>
            this._onSkipChange(e.detail.skip)}
          @cca-page-prev=${() => this._prevPage()}
          @cca-page-next=${() => this._nextPage()}
        ></cca-page-controls>
      </div>
    `;

    return html`
      <!-- Results -->
      <div class="results-section">
        ${
          this._ran
            ? results
            : !this._loading
              ? html`<div class="empty-state">
                  Enter a selector and click Run Query
                </div>`
              : ""
        }
      </div>
    `;
  }

  private renderResultTable() {
    return html`
      <div class="table-container">
        <cca-data-table
          .columns=${this._columns as any[]}
          .rows=${this._results}
          .loading=${this._loading}
          empty-message="No documents matched the query."
          @cca-row-click=${(e: CustomEvent<Record<string, unknown>>) =>
            this._openDoc(e.detail["_id"])}
          style="cursor:pointer"
        ></cca-data-table>
      </div>
    `;
  }

  private renderResultRaw() {
    return html`
      ${this._results.map(
        (r) =>
          html`<div class="json-view-item">
            <cca-monaco-editor
              .value=${JSON.stringify(r, null, 2)}
              .language=${"json"}
              ?readOnly=${true}
            ></cca-monaco-editor>
          </div>`,
      )}
    `;
  }
}
