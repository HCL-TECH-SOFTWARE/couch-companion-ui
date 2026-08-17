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
import { describeDbAccessError } from "../../services/db-enumeration.js";
import type { TableColumn } from "../../components/cca-data-table.js";
import type { BulkDeleteDocumentRequest } from "./types.js";
import {
  addHeaderActions,
  clearHeaderActions,
  clearHeaderTitle,
  setHeaderTitle,
} from "../../components/cca-header.js";

import {
  DOC_BROWSER_PAGE_SIZE_KEY,
  getPageSize,
  setPageSize,
} from "../../services/page-size-preference.js";
import {
  formatCellValue,
  resolveColumns,
} from "../../services/derived-columns.js";
import { attachmentColumn } from "../../components/cca-attachment-count.js";
import {
  IndexOffer,
  indexOfferStyles,
  type SortItem,
} from "./index-offer.js";

import "../../components/cca-data-table.js";
import "../../components/cca-monaco-editor.js";
import "../../components/cca-header-bar.js";
import "../../components/cca-page-controls.js";
import "../../components/cca-column-picker.js";
import "@awesome.me/webawesome/dist/components/button/button.js";
import "@awesome.me/webawesome/dist/components/badge/badge.js";
import "@awesome.me/webawesome/dist/components/callout/callout.js";
import "@awesome.me/webawesome/dist/components/checkbox/checkbox.js";
import "@awesome.me/webawesome/dist/components/dialog/dialog.js";
import "@awesome.me/webawesome/dist/components/drawer/drawer.js";
import "@awesome.me/webawesome/dist/components/icon/icon.js";

/**
 * A loaded document. `_id` and `_rev` are named because selection and delete are built
 * on them; the index signature is the rest of the document, which is what the table
 * derives its columns from since #79 — before that the row really was these two fields
 * and nothing else, because the fetch asked for nothing else.
 */
interface DocRow {
  _id: string;
  _rev: string;
  [field: string]: unknown;
}

@customElement("cca-doc-browser")
export class CcaDocBrowser extends CcaElement {
  static override get styles() {
    return [
      indexOfferStyles,
      css`
      :host {
        display: block;
      }
      .icon-bar {
        position: fixed;
        right: 0;
        top: 31%;
        transform: translateY(-50%);
        z-index: 100;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 0.25rem;
        padding: 0.35rem;
        background: var(--wa-color-surface-raised);
        border: 1px solid var(--wa-color-neutral-border-quiet);
        border-right: none;
        border-radius: 8px 0 0 8px;
        box-shadow: -3px 0 10px rgba(0, 0, 0, 0.08);
      }
      .icon-bar-divider {
        width: 1.5rem;
        height: 1px;
        background: var(--wa-color-neutral-border-quiet);
        margin: 0.1rem 0;
      }
      .badge-margin {
        margin-left: 0.5rem;
      }
      .selection-bar {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        margin-bottom: 0.5rem;
      }
      .selection-count {
        font-size: var(--wa-font-size-s);
        color: var(--wa-color-text-quiet);
      }
      .load-error {
        margin-bottom: 1rem;
      }
      .table-container {
        overflow-x: auto;
      }
      .editor-item {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        color: var(--wa-color-text-normal, #1f2a35);
      }
      .editor-header {
        display: flex;
        align-items: center;
        gap: 0.5rem;
      }
      .editor-title {
        font-weight: var(--wa-font-weight-bold);
        font-size: var(--wa-font-size-m);
      }
      /* The title is a real button so it is reachable by keyboard; the reset
         keeps it looking like the heading it reads as. */
      button.editor-title {
        background: none;
        border: none;
        padding: 0;
        color: inherit;
        text-align: left;
        cursor: pointer;
      }
      button.editor-title:focus-visible {
        outline: var(--wa-focus-ring);
        outline-offset: var(--wa-focus-ring-offset);
      }
      .editor-title.unaddressable {
        color: var(--wa-color-text-quiet);
      }
      .editor-container {
        border: 1px solid var(--wa-color-neutral-border-normal);
        border-radius: 8px;
        overflow: hidden;
        background: var(--wa-color-surface-default, #fff);
      }
      .editor-fill {
        width: 100%;
        height: 100%;
      }
      .drawer-content {
        display: flex;
        flex-direction: column;
        gap: 1.5rem;
        padding: 0.25rem 0;
      }
      .drawer-section {
        display: flex;
        flex-direction: column;
      }
      .drawer-section-label {
        font-size: var(--wa-font-size-xs);
        font-weight: var(--wa-font-weight-bold);
        opacity: 0.55;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        margin-bottom: 0.5rem;
      }
      .drawer-button-group {
        display: flex;
        border: 1px solid var(--wa-color-neutral-border-quiet);
        border-radius: 4px;
        overflow: hidden;
      }
      .drawer-button {
        border-radius: 0;
        border: none;
        flex: 1;
      }
      .sort-mode {
        margin-bottom: 0.75rem;
      }
      /* The field name, and the two endpoint names, are literals the user can look up —
         so they are set in the code face rather than left to read as prose. */
      .sort-mode-literal {
        font-family: var(--wa-font-family-code);
      }
      .sort-mode-clear {
        margin-left: 0.5rem;
      }
    `,
    ];
  }
  /** Set by the router from the :dbName path param. */
  @property() dbName = "";

  /** Set by the router from the :serverId path param. */
  @property({ type: String }) serverId = "";

  @state() private _selectedDocs: Set<string> = new Set();
  @state() private _docs: DocRow[] = [];
  @state() private _loading = false;
  /**
   * Why the last load was refused, phrased by {@link describeDbAccessError}, or `""` when
   * the documents loaded. Non-empty replaces the results area: an empty table under a
   * toast is the dead end `db-list` probes ahead specifically to avoid (#58).
   */
  @state() private _loadError = "";
  /** Documents awaiting the delete confirmation, or `null` when the dialog is closed. */
  @state() private _pendingDelete: DocRow[] | null = null;
  @state() private _totalCount: number | null = null;
  @state() private _hasMore = false;
  @state() private _page = 0;
  /**
   * Which body the results area shows. It used to be named `_scope` and was forwarded to
   * the service as one — `"raw"` meaning "skip `include_docs`" — which is why the table
   * could only ever show `_id` and `_rev`. #79 needs whole documents in both views to
   * derive columns from, so the fetch no longer varies and this is a view mode only.
   */
  @state() private _view: "table" | "json" = "table";
  @state() private _docsValues: string[] = [];
  /**
   * Which field each column shows, once a picker has been used; `null` while the columns
   * are whatever the loaded documents carry. See {@link resolveColumns} for why a choice,
   * once made, is not re-derived on the next page.
   */
  @state() private _columnFields: string[] | null = null;
  @state() private _drawerOpen = false;
  /** Documents per page, remembered across reloads in `localStorage` (#80). */
  @state() private _pageSize = getPageSize(DOC_BROWSER_PAGE_SIZE_KEY);
  /** Documents skipped before the first page. Not persisted — it is a position, not a preference. */
  @state() private _skip = 0;
  /**
   * Which column the list is ordered by, or `null` for "the order `_all_docs` gives" (#82).
   *
   * This one field decides which CouchDB endpoint {@link _load} calls, because `_all_docs`
   * cannot order by a document field at all — it only ever knows document id order. So a
   * sort is not a modifier on the existing request; it is a different request, against
   * `_find` and a Mango index. {@link renderSortMode} is what tells the user so.
   */
  @state() private _sort: SortItem | null = null;
  /**
   * The last sort that CouchDB actually served, so declining the offer to create an index
   * can put the list back to something that works. A header click has already changed what
   * the screen claims to show by the time the rejection arrives.
   */
  private _lastGoodSort: SortItem | null = null;
  /**
   * `_bookmarks[n]` holds the token needed to fetch page n; `_bookmarks[0]` is always
   * undefined (the first page needs none).
   *
   * The tokens are in whichever currency the current data source mints — an `_all_docs`
   * `startkey` token (db-mgmt-service's {@link encodePageToken}) with no sort, a real
   * CouchDB `_find` bookmark with one. The two are not interchangeable, which is why
   * every sort change goes through {@link _restart} and throws the whole array away
   * rather than trying to translate page 2 from one model into the other.
   */
  private _bookmarks: (string | undefined)[] = [undefined];

  /**
   * The "no index for this sort" offer (#78), shared with `doc-query` rather than copied
   * (#82). A header click on a field no index covers is refused by CouchDB exactly the way
   * the Mango screen's Sort panel is, so it gets exactly the same answer.
   */
  readonly indexOffer = new IndexOffer(this);

  override connectedCallback() {
    super.connectedCallback();
    clearHeaderActions();
    setHeaderTitle("Document");
    addHeaderActions([
      {
        icon: "file-lines",
        tooltip: "New Document",
        action: () => {
          this._newDoc();
        },
      },
      {
        icon: "filter",
        tooltip: "Mango Query",
        action: () => {
          getContext().router.navigate(
            `/databases/${encodeURIComponent(this.serverId || "$all")}/${encodeURIComponent(this.dbName)}/query`,
          );
        },
      },
      {
        icon: "list-check",
        tooltip: "Manage Indexes",
        action: () => {
          getContext().router.navigate(
            `/databases/${encodeURIComponent(this.serverId || "$all")}/${encodeURIComponent(this.dbName)}/indexes`,
          );
        },
      },
      {
        // Same icon and wording db-list's own row action uses for this destination, so
        // the two entry points read as one thing (#81).
        icon: "pen-nib",
        tooltip: "Design Documents",
        action: () => {
          this._openDesignDocs();
        },
      },
    ]);
    this._load();
  }

  /**
   * Throws away everything that describes *where in the list* we are.
   *
   * Every control that changes what the list contains — view mode, page size, skip,
   * a completed delete — has to do this, because a page-2 bookmark was minted by a
   * differently-shaped query and means nothing to the new one.
   */
  private _resetPaging() {
    this._page = 0;
    this._bookmarks = [undefined];
    this._docs = [];
    this._docsValues = [];
    this._totalCount = null;
    this._hasMore = false;
  }

  /** Forgets where we were and fetches page one — what every reshaping control does. */
  private _restart() {
    this._resetPaging();
    if (this.serverId) this._load();
  }

  /**
   * Switches between the table and the column of JSON editors. Both are rendered from the
   * same loaded page — the fetch is identical — so this no longer restarts paging.
   */
  private _onViewChange(view: "table" | "json") {
    this._view = view;
  }

  private _onPageSizeChange(pageSize: number) {
    if (pageSize === this._pageSize) return;
    this._pageSize = pageSize;
    setPageSize(DOC_BROWSER_PAGE_SIZE_KEY, pageSize);
    this._restart();
  }

  private _onSkipChange(skip: number) {
    if (skip === this._skip) return;
    this._skip = skip;
    this._restart();
  }

  /**
   * What a click on `field`'s header means: unsorted → ascending → descending → unsorted.
   *
   * The third click is what gets back to `_all_docs`, and it is the reason the cycle has
   * three states rather than two: turning sorting *off* has to be reachable from the same
   * control that turned it on, since it also changes which endpoint the list comes from.
   * Clicking a different column starts that column's own cycle at ascending.
   */
  private static _nextSort(current: SortItem | null, field: string): SortItem | null {
    if (current?.field !== field) return { field, direction: "asc" };
    return current.direction === "asc" ? { field, direction: "desc" } : null;
  }

  /**
   * Sorts by one column, and throws away where in the list we were.
   *
   * Paging cannot survive this. A page-2 token is either an `_all_docs` `startkey` or a
   * `_find` bookmark, minted by whichever query was running before the click, and the
   * query after the click is the other one — or the same one cut a different way. There is
   * no translation between the two page models, so {@link _restart} goes back to page 1
   * rather than pretending there is.
   */
  private _toggleSort(field: string) {
    this._sort = CcaDocBrowser._nextSort(this._sort, field);
    this._restart();
  }

  /** Back to `_all_docs` order — the mode banner's own way out. */
  private _clearSort() {
    if (!this._sort) return;
    this._sort = null;
    this._restart();
  }

  /**
   * Puts the list back to the last sort CouchDB served, after the user declines to create
   * the index the clicked column would have needed. Without this the screen would sit on a
   * sort it has already been told it cannot run.
   */
  private _revertSort() {
    this._sort = this._lastGoodSort;
    this._restart();
  }

  /**
   * `aria-sort` for one column: the active one announces its direction, every other column
   * announces nothing at all.
   *
   * `cca-data-table` stamps this straight onto the `th` and omits the attribute entirely
   * when it is undefined, which is what the ARIA contract asks for — "none" on every
   * unsorted column would claim they are all sortable-but-unsorted, and the selection and
   * attachment columns are not sortable at all.
   */
  private _ariaSortFor(field: string): "ascending" | "descending" | undefined {
    if (this._sort?.field !== field) return undefined;
    return this._sort.direction === "asc" ? "ascending" : "descending";
  }

  /**
   * One page of the document list, from whichever of CouchDB's two list endpoints the
   * current sort requires (#82).
   *
   * With no sort this is `_all_docs`, exactly as it always was. With one it is `_find`,
   * because `_all_docs` cannot order by a document field — it knows only document id
   * order, and no parameter changes that. The switch is deliberately visible in the UI
   * ({@link renderSortMode}): the two endpoints do not return the same list, and the
   * differences were measured against CouchDB 3.5.2 rather than assumed —
   *
   *   - `_find` omits documents that lack the sort field entirely (a doc with no `age`
   *     is absent from a sort by `age`; one with `age: null` is present)
   *   - `_find` omits design documents, which `_all_docs` includes
   *   - `_find` reports no total, so the header's document count goes away with it
   *
   * Both endpoints get the same explicit `limit` and the same `skip`, so the footer from
   * #80 keeps working in both modes.
   */
  private _load() {
    this._loading = true;
    this._loadError = "";
    // Snapshotted so the response is interpreted under the sort that was actually sent,
    // not whatever a second header click set while the request was in flight.
    const sort = this._sort;
    const limit = this._pageSize;
    const fetch = sort ? this._findPage(sort, limit) : this._allDocsPage(limit);
    fetch
      .then((resp) => {
        const raw = resp.documents ?? [];
        this._docs = raw.map((d) => d as unknown as DocRow);
        // Pass serialised strings to the per-document viewers. Kept index-for-index
        // with `_docs`: the JSON view reads a document's id and revision from `_docs[i]`
        // rather than re-parsing `_docsValues[i]` to guess at them (#58).
        this._docsValues = raw.map((d) => JSON.stringify(d, null, 2));
        // The two endpoints need OPPOSITE "is there another page" rules, and each is wrong
        // for the other — which is why this branches instead of picking one.
        //
        // `_all_docs` returns exactly `limit` rows whenever the remaining count from this
        // startkey is exactly the page size too, so a length check alone can't tell "more"
        // from "exactly done" — trust the service's own bookmark instead (it's only set
        // when a lookahead row proved another page exists).
        //
        // `_find` is the reverse: CouchDB hands back a bookmark on EVERY response —
        // verified on 3.5.2 against the last page and against a page past the end, which
        // returns zero documents and still carries one — so `!!resp.bookmark` would leave
        // Next stuck on forever. Row count is the correct signal there. This is the same
        // split doc-query.ts documents at its own `_hasMore`; the two are not to be
        // harmonized, and this is why.
        this._hasMore = sort ? raw.length === limit : !!resp.bookmark;
        // Store the token for the NEXT page only when there may be more results.
        const nextBm = resp.bookmark ?? "";
        if (
          this._hasMore &&
          nextBm &&
          nextBm !== this._bookmarks[this._page + 1]
        ) {
          this._bookmarks = [
            ...this._bookmarks.slice(0, this._page + 1),
            nextBm,
          ];
        }
        // `_find` reports no total at all, so this simply does not fire in sort mode and
        // the header's badge stays away. That is the honest outcome rather than a gap:
        // `_all_docs`' total counts design documents and documents without the sort field,
        // neither of which a sorted list contains.
        if (resp.total_count != null) {
          this._totalCount = resp.total_count;
        }
        this._lastGoodSort = sort;
        this._loading = false;
      })
      .catch((err) => {
        this._loading = false;
        // A sort no index can serve is not a broken database — it is a missing index, and
        // the offer to create it is the one #78 already built for `doc-query`, shared
        // rather than copied. Declining puts the list back to the sort that last worked.
        if (
          sort &&
          this.indexOffer.offerIfNoUsableIndex(
            err,
            [sort],
            () => this._load(),
            () => this._revertSort(),
          )
        ) {
          return;
        }
        // CouchDB refuses in three ways that look alike and mean opposite things — 401
        // "this read needs credentials this database accepts", 403 "you are not a member
        // of this database", 404 "no such database" — and `db-enumeration` is the single
        // place that tells them apart, so this screen does not invent its own wording
        // (D9, #58). The scope is what makes the 401 true here: `_all_docs` is a
        // per-database read, not the admin-only server listing the copy would otherwise
        // describe (#66). Never pre-gate on `isAdmin`: react to the response received.
        this._loadError = describeDbAccessError(err, this.dbName, "database");
        this._docs = [];
        this._docsValues = [];
        this._hasMore = false;
      });
  }

  /**
   * The unsorted page: `_all_docs?include_docs=true`, exactly what this screen has always
   * asked for.
   *
   * Always whole documents. This costs a page of document bodies where the table used to
   * cost a page of `{_id, _rev}` pairs, and that is the price of the table's columns: with
   * `scope: "raw"` no field beyond those two is fetched, so no field beyond those two can
   * be shown (#79). The page size is the user's, and bounded — five choices up to 100
   * (#80) — so the bound on what this fetches is a hundred documents, not a database.
   */
  private _allDocsPage(limit: number) {
    return getContext().dbMgmt.listDocuments(this.serverId, this.dbName, {
      limit,
      skip: this._skip,
      bookmark: this._bookmarks[this._page],
      scope: "full",
    });
  }

  /**
   * The sorted page: `_find` over a Mango index, because `_all_docs` cannot order by a
   * document field (#82).
   *
   * The selector is "every document" — the same one the Mango screen opens on. Ordering is
   * the sort's job; the selector only has to avoid excluding anything itself. `limit` is
   * always explicit, since `_find` silently truncates at 25 without one, which would make a
   * 50- or 100-per-page choice look like the end of the results.
   */
  private _findPage(sort: SortItem, limit: number) {
    return getContext().dbMgmt.queryDocuments(this.serverId, this.dbName, {
      selector: { _id: { $gt: null } },
      sort: [{ [sort.field]: sort.direction }],
      limit,
      skip: this._skip,
      bookmark: this._bookmarks[this._page],
      scope: "full",
    });
  }

  private _prevPage() {
    if (this._page === 0) return;
    this._page--;
    this._load();
  }

  private _nextPage() {
    this._page++;
    this._load();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    clearHeaderActions();
    clearHeaderTitle();
  }

  private _onRowClick(e: CustomEvent<DocRow>) {
    this._openDoc(e.detail._id);
  }

  private _openDoc(docId: string) {
    getContext().router.navigate(
      `/databases/${encodeURIComponent(this.serverId || "$all")}/${encodeURIComponent(this.dbName)}/documents/${encodeURIComponent(docId)}`,
    );
  }

  private _newDoc() {
    getContext().router.navigate(
      `/databases/${encodeURIComponent(this.serverId || "$all")}/${encodeURIComponent(this.dbName)}/documents/new`,
    );
  }

  /**
   * Opens the design documents of the database being browsed (#81).
   *
   * `cca-design-list` already exists and already narrows itself to `?database=`, so this
   * is the same pair `db-list`'s row action and `repo-overview`'s target pills navigate
   * with — not a filtered `_all_docs` range over `_design/` invented here. The server is
   * named because design-list ignores `?database=` while `:serverId` is `$all`.
   */
  private _openDesignDocs() {
    getContext().router.navigate(
      `/design-docs/${encodeURIComponent(this.serverId || "$all")}` +
        `?database=${encodeURIComponent(this.dbName)}`,
    );
  }

  /**
   * The documents bulk actions operate on.
   *
   * Today that is every loaded document: there is no filter box yet, so the predicate is a
   * constant. It is kept as the seam that box will plug into — without it every selection
   * helper below would have to grow a filter argument the day the box lands.
   */
  private get filteredDocs(): DocRow[] {
    if (!this.serverId || !this.dbName) {
      return [];
    }
    return this._docs.filter(() => true);
  }

  /** Selection key. A revision is part of the identity because deletes need both. */
  private _docKey(doc: DocRow): string {
    return `${doc._id}|${doc._rev}`;
  }

  private handleSelectAll(event: Event) {
    const checkbox = event.target as HTMLInputElement;
    const next = new Set(this._selectedDocs);
    for (const d of this.filteredDocs) {
      if (checkbox.checked) next.add(this._docKey(d));
      else next.delete(this._docKey(d));
    }
    this._selectedDocs = next;
  }

  private handleDocCheckboxChange(event: Event, doc: DocRow) {
    const checkbox = event.target as HTMLInputElement;
    const next = new Set(this._selectedDocs);
    if (checkbox.checked) next.add(this._docKey(doc));
    else next.delete(this._docKey(doc));
    this._selectedDocs = next;
  }

  /**
   * Asks before deleting, in a `wa-dialog`.
   *
   * The confirmation used to be `window.confirm` — the one blocking browser dialog on a
   * screen that otherwise talks in `wa-dialog`, unstyleable and unthemed (#58).
   */
  private deleteDocuments(docs: DocRow[]) {
    if (this._selectedDocs.size === 0) {
      toast("No documents selected for deletion.", "info");
      return;
    }
    this._pendingDelete = docs.filter((d) =>
      this._selectedDocs.has(this._docKey(d)),
    );
  }

  /** Carries out the deletion the dialog just confirmed. */
  private _confirmDelete() {
    const docsToDelete = this._pendingDelete ?? [];
    this._pendingDelete = null;
    if (docsToDelete.length === 0) return;

    const toDelete = docsToDelete.map((d) => ({ id: d._id, rev: d._rev }));
    const request: BulkDeleteDocumentRequest = { documents: toDelete };
    this._selectedDocs = new Set();

    getContext()
      .dbMgmt.deleteDocuments(this.serverId, this.dbName, request)
      .then((resp) => {
        const deletedCount = resp.deleted;
        if (deletedCount > 0) {
          toast(`${deletedCount} document(s) deleted successfully.`, "success");
        }
        if (resp.errors.length > 0) {
          toast(`${resp.errors.length} document(s) failed to delete.`, "error");
        }
        // Reload documents after deletion to reflect changes.
        this._restart();
      })
      .catch((err) => {
        toast(
          `Failed to delete document(s): ${err?.message ?? err}`,
          "error",
        );
      });
  }

  private _editorHeight(value: string): number {
    const lineCount = value.split("\n").length;
    return Math.min(Math.max(lineCount * 22 + 24, 180), 640);
  }

  /**
   * Select-all, the running count, and bulk delete — rendered once, above whichever body is
   * showing.
   *
   * It used to live inside the metadata table's header cell, which put the only way to
   * select documents in the only view that renders a table: JSON view showed no checkboxes
   * at all, so bulk delete was unreachable there while its button sat in a header nobody
   * could see (#58). Above the body it belongs to both views.
   */
  private renderSelectionBar() {
    const docs = this.filteredDocs;
    if (docs.length === 0) return nothing;
    const selected = docs.filter((d) =>
      this._selectedDocs.has(this._docKey(d)),
    ).length;
    return html`
      <div class="selection-bar">
        <wa-checkbox
          data-select-all
          aria-label="Select all documents on this page"
          .checked=${selected === docs.length}
          .indeterminate=${selected > 0 && selected < docs.length}
          @change=${(e: Event) => this.handleSelectAll(e)}
        ></wa-checkbox>
        <span class="selection-count">
          ${this._selectedDocs.size > 0
            ? `${this._selectedDocs.size} selected`
            : "Select documents to delete"}
        </span>
        ${this.renderDeleteButton()}
      </div>
    `;
  }

  private renderDeleteButton() {
    return html`
      <wa-button
        data-bulk-delete
        size="s"
        variant="danger"
        appearance="filled"
        ?disabled=${this._selectedDocs.size === 0}
        @click=${() => this.deleteDocuments(this.filteredDocs)}
      >
        <wa-icon
          name="trash-can"
          variant="solid"
          label="Delete selected documents"
        ></wa-icon>
      </wa-button>
    `;
  }

  /** One document's selection checkbox — the table's cell and the JSON view's row share it. */
  private renderRowCheckbox(doc: DocRow) {
    return html`
      <wa-checkbox
        aria-label="Select document ${doc._id ?? ""}"
        .checked=${this._selectedDocs.has(this._docKey(doc))}
        @change=${(e: Event) => this.handleDocCheckboxChange(e, doc)}
        @click=${(e: Event) => e.stopPropagation()}
      ></wa-checkbox>
    `;
  }

  /**
   * One column per field the loaded documents carry, after the selection column (#79).
   *
   * This used to be `Document ID` and `Revision`, fixed — a table that showed the same
   * two things about every database. The field list comes from the documents themselves,
   * so it answers what is *in* this database, and each header can be swapped to another
   * field by its own picker.
   *
   * Only the derived field columns carry `ariaSort` and only one of them at a time (#82).
   * The selection column and the attachment indicator get neither it nor a sort button:
   * neither is a document field, so neither is something `_find` could order by.
   *
   * The attachment indicator is a column of its own between the two (#84), present only
   * when this page has an attachment to point at. `_attachments` is *not* among the
   * derived fields — {@link resolveColumns} leaves it out — because a column of raw stub
   * JSON says nothing a paperclip does not say better.
   */
  private get _columns(): TableColumn<DocRow>[] {
    const { fields, available } = resolveColumns(this._docs, this._columnFields);
    return [
      {
        label: "",
        render: (d) => this.renderRowCheckbox(d),
        width: "3rem",
      },
      ...attachmentColumn(this._docs),
      ...fields.map((field, index) => ({
        label: field,
        key: field,
        ariaSort: this._ariaSortFor(field),
        headerRender: () => this.renderColumnHeader(field, available, index),
        render: (d: DocRow) => formatCellValue(d[field]),
      })),
    ];
  }

  /**
   * A column header: a button that sorts by the field, and the picker that swaps the column
   * for another field.
   *
   * The two are different questions — "order the list by this" and "show me that field
   * here" — so they stay two controls in one cell rather than one overloaded target, the
   * same split `doc-query`'s headers make between adding a field to the projection and
   * swapping the column.
   *
   * The button's accessible name is the field name alone, following the W3C sortable-table
   * pattern: the *state* is carried by `aria-sort` on the `th` this renders into, so
   * spelling the direction into the name as well would announce it twice and disagree with
   * itself the moment one of them was updated without the other. The arrow is decorative
   * for the same reason and is hidden from assistive tech; the `title` is the mouse user's
   * equivalent hint.
   *
   * `.sort-button` and `.column-header` are `cca-data-table`'s own classes, defined in its
   * shadow root, because that is where `headerRender()` output lands — a stylesheet here
   * cannot reach this markup.
   */
  private renderColumnHeader(field: string, available: string[], index: number) {
    const active = this._sort?.field === field ? this._sort.direction : null;
    return html`<span class="column-header"
      ><button
        type="button"
        class=${active ? "sort-button active" : "sort-button"}
        data-sort-header=${field}
        title=${CcaDocBrowser._sortHint(this._sort, field)}
        @click=${(e: Event) => {
          e.stopPropagation();
          this._toggleSort(field);
        }}
      >
        ${field}<span aria-hidden="true"
          >${CcaDocBrowser._sortArrow(active)}</span
        > </button
      ><cca-column-picker
        .field=${field}
        .fields=${available}
        @cca-column-field-change=${(e: CustomEvent<{ field: string }>) =>
          this._setColumnField(index, e.detail.field)}
      ></cca-column-picker
    ></span>`;
  }

  /** The decorative direction arrow, or nothing while this column is not the sorted one. */
  private static _sortArrow(direction: "asc" | "desc" | null): string {
    if (direction === null) return "";
    return direction === "asc" ? " ↑" : " ↓";
  }

  /** What the next click on this header will do, for the `title` tooltip. */
  private static _sortHint(current: SortItem | null, field: string): string {
    const next = CcaDocBrowser._nextSort(current, field);
    if (next === null) return `Stop sorting by ${field}`;
    const order = next.direction === "asc" ? "ascending" : "descending";
    return `Sort by ${field}, ${order}`;
  }

  /**
   * Points one column at a different field. The first such choice freezes the whole
   * column list — see {@link resolveColumns} — so the swap is not undone by the next
   * page's own derived fields.
   */
  private _setColumnField(index: number, field: string) {
    const { fields } = resolveColumns(this._docs, this._columnFields);
    if (fields[index] === field) return;
    const next = [...fields];
    next[index] = field;
    this._columnFields = next;
  }

  override render() {
    return html`
      <!-- Vertical icon bar (right edge) -->
      <div class="icon-bar">
        ${!this._drawerOpen ? this.renderTooltip() : ""}
        <wa-button
          size="s"
          appearance="plain"
          title=${this._drawerOpen ? "Close options" : "Open options"}
          @click=${() => (this._drawerOpen = !this._drawerOpen)}
          ><wa-icon name="sliders" variant="solid"></wa-icon
        ></wa-button>
      </div>

      <!-- Header bar -->
      <cca-header-bar
        .title=${html`
          ${this.dbName}
          ${
            this._totalCount != null
              ? html`<wa-badge variant="neutral" class="badge-margin"
                  >${this._totalCount.toLocaleString()} docs</wa-badge
                >`
              : ""
          }
        `}
        @cca-header-back=${() => getContext().router.back("/databases/$all")}
      ></cca-header-bar>

      <!-- Document view -->
      ${this._loadError ? this.renderLoadError() : this.renderResults()}

      <!-- Options drawer -->
      ${this.renderOptionsDrawer()} ${this.renderDeleteConfirm()}

      <!-- Shared with doc-query: "this sort needs an index, shall I create it?" (#78) -->
      ${this.indexOffer.render(this.dbName, this.serverId)}
    `;
  }

  /**
   * What this screen becomes when CouchDB refuses the read: the reason, and the one way
   * forward that still works. The table is deliberately absent — its "No documents found."
   * would be a lie, since the refusal says nothing about whether documents exist. Mirrors
   * `db-list`'s handling of the same three refusals (#58).
   */
  private renderLoadError() {
    return html`
      <wa-callout
        variant="neutral"
        appearance="outlined"
        class="load-error"
        data-load-error
        role="alert"
      >
        <wa-icon slot="icon" name="circle-info"></wa-icon>
        ${this._loadError}
      </wa-callout>
      <wa-button
        data-back-to-databases
        @click=${() => getContext().router.navigate("/databases/$all")}
        >Back to databases</wa-button
      >
    `;
  }

  /**
   * The results area: the selection bar, one body, one footer.
   *
   * The body is the only thing that varies — a table of the documents' own fields or a
   * column of JSON editors. There used to be a second axis, "how the next document is
   * reached" (pages or infinite scroll), written out as four near-verbatim renderers;
   * that is how the selection column came to exist in two of them and not the other two
   * (#58). #80 retired infinite scroll — once the page size is the user's to choose,
   * it is a second navigation model for the same rows — which collapses the 2×2 to
   * one path through one shared footer.
   */
  private renderResults() {
    const body =
      this._view === "table" ? this.renderTable() : this.renderEditors();
    return html`
      ${this.renderSortMode()} ${this.renderSelectionBar()} ${body}
      ${this.renderPageControls()}
    `;
  }

  /**
   * Says out loud that a sorted list is a different query, not the same list re-ordered
   * (#82).
   *
   * Switching data source underneath the user without a word would be the wrong kind of
   * clever: the rows really do change, not just their order. `_find` leaves out every
   * document that has no value for the sort field, and every design document, and reports
   * no total — so the count badge in the header disappears at the same moment. Someone
   * looking for a document that has quietly dropped out of the list deserves to be able
   * to see why, and to get back in one click.
   *
   * Measured against CouchDB 3.5.2 rather than assumed; see {@link _load}.
   */
  private renderSortMode() {
    if (!this._sort) return nothing;
    const { field, direction } = this._sort;
    const order = direction === "asc" ? "ascending" : "descending";
    return html`
      <wa-callout
        variant="brand"
        appearance="outlined"
        class="sort-mode"
        data-sort-mode
        role="status"
      >
        <wa-icon
          slot="icon"
          name=${direction === "asc" ? "arrow-down-a-z" : "arrow-down-z-a"}
          variant="solid"
        ></wa-icon>
        Sorted by <span class="sort-mode-literal">${field}</span> (${order}).
        This list comes from a Mango index via
        <span class="sort-mode-literal">_find</span>, not from
        <span class="sort-mode-literal">_all_docs</span>, so documents with no
        <span class="sort-mode-literal">${field}</span> field — and design
        documents — are not listed, and no total is available.
        <wa-button
          size="s"
          appearance="outlined"
          class="sort-mode-clear"
          data-clear-sort
          @click=${() => this._clearSort()}
          >Clear sort</wa-button
        >
      </wa-callout>
    `;
  }

  /**
   * The table, in a container that scrolls sideways.
   *
   * Two hardcoded columns always fit; one column per field the documents carry does not,
   * and without this a wide document takes the whole page with it (#79). Same treatment
   * `doc-query` has always given the same table.
   */
  private renderTable() {
    return html`
      <div class="table-container">
        <cca-data-table
          .columns=${this._columns as any[]}
          .rows=${this._docs}
          .loading=${this._loading}
          empty-message=${this.serverId
            ? "No documents found."
            : "Select a server to view documents."}
          @cca-row-click=${this._onRowClick}
        ></cca-data-table>
      </div>
    `;
  }

  private renderEditors() {
    // `_docsValues` is kept index-for-index with `_docs` by `_load()`, so the
    // id and revision come from the document itself rather than from re-parsing its JSON.
    return this._docs.map((doc, i) =>
      this.renderEditorItem(doc, this._docsValues[i] ?? ""),
    );
  }

  private renderEditorItem(doc: DocRow, value: string) {
    const height = this._editorHeight(value);
    return html`
      <div class="editor-item">
        <div class="editor-header">
          ${this.renderRowCheckbox(doc)} ${this.renderEditorTitle(doc)}
        </div>
        <div class="editor-container" style="height:${height}px">
          <cca-monaco-editor
            .value=${value}
            .language=${"json"}
            ?readOnly=${true}
            class="editor-fill"
          ></cca-monaco-editor>
        </div>
      </div>
    `;
  }

  /**
   * The document's own `_id`, which is also its address.
   *
   * This used to re-parse the JSON looking for a title and fall back to the literal string
   * "Unnamed index" — copied from `index-list`, hence the wording in a *document* browser —
   * and then navigate to a document with that id, which does not exist (#58). A document
   * with no `_id` has no address, so it gets no link rather than a broken one.
   */
  private renderEditorTitle(doc: DocRow) {
    const id = doc._id?.trim();
    if (!id) {
      return html`<span class="editor-title unaddressable"
        >(document without an _id)</span
      >`;
    }
    return html`<button
      type="button"
      class="editor-title"
      @click=${() => this._openDoc(id)}
    >
      ${id}
    </button>`;
  }

  /** `1–25 of 812`, counted from the skip offset, or `""` when nothing is loaded. */
  private get _rangeLabel(): string {
    if (this._docs.length === 0) return "";
    const start = this._skip + this._page * this._pageSize + 1;
    const end = start + this._docs.length - 1;
    const total =
      this._totalCount != null ? ` of ${this._totalCount.toLocaleString()}` : "";
    return `${start.toLocaleString()}–${end.toLocaleString()}${total}`;
  }

  /**
   * Page size, skip and previous/next — the shared footer, so this screen and
   * `doc-query` cannot drift apart again (#80).
   *
   * Previous/next are *hidden* when there is no such page rather than greyed out,
   * matching what #57 landed on `index-list`.
   */
  private renderPageControls() {
    return html`
      <cca-page-controls
        .pageSize=${this._pageSize}
        .skip=${this._skip}
        .hasPrev=${this._page > 0}
        .hasNext=${this._hasMore}
        .loading=${this._loading}
        .rangeLabel=${this._rangeLabel}
        @cca-page-size-change=${(e: CustomEvent) =>
          this._onPageSizeChange(e.detail.pageSize)}
        @cca-skip-change=${(e: CustomEvent) => this._onSkipChange(e.detail.skip)}
        @cca-page-prev=${() => this._prevPage()}
        @cca-page-next=${() => this._nextPage()}
      ></cca-page-controls>
    `;
  }

  private renderDeleteConfirm() {
    const count = this._pendingDelete?.length ?? 0;
    return html`
      <wa-dialog
        data-delete-dialog
        label="Delete documents"
        ?open=${this._pendingDelete !== null}
        @wa-after-hide=${(e: Event) => {
          if (e.target === e.currentTarget) this._pendingDelete = null;
        }}
      >
        <p style="margin-top:0">
          Delete ${count} selected document(s)? This cannot be undone.
        </p>
        <div
          slot="footer"
          style="display:flex;gap:0.5rem;justify-content:flex-end"
        >
          <wa-button
            data-delete-cancel
            @click=${() => (this._pendingDelete = null)}
            >Cancel</wa-button
          >
          <wa-button
            data-delete-confirm
            variant="danger"
            @click=${() => this._confirmDelete()}
            >Delete</wa-button
          >
        </div>
      </wa-dialog>
    `;
  }

  private renderOptionsDrawer() {
    return html`
      <wa-drawer
        ?open=${this._drawerOpen}
        placement="end"
        label="Options"
        style="--size:18rem"
        @wa-hide=${() => (this._drawerOpen = false)}
      >
        <div class="drawer-content">
          <div class="drawer-section">
            <div class="drawer-section-label">View Mode</div>
            <div class="drawer-button-group">
              <wa-button
                appearance=${this._view === "table" ? "filled" : "plain"}
                class="drawer-button"
                @click=${() => this._onViewChange("table")}
                >Table</wa-button
              ><wa-button
                appearance=${this._view === "json" ? "filled" : "plain"}
                class="drawer-button"
                @click=${() => this._onViewChange("json")}
                >JSON</wa-button
              >
            </div>
          </div>
        </div>
      </wa-drawer>
    `;
  }

  /**
   * The icon bar's view switch. It used to carry a second pair — Pagination and
   * Virtual scroll — retired with infinite scroll itself in #80; page size now lives
   * in the footer, where the pages it sizes are.
   */
  private renderTooltip() {
    return html`
      <wa-button
        size="s"
        appearance=${this._view === "table" ? "filled" : "plain"}
        title="Table view"
        @click=${() => this._onViewChange("table")}
        ><wa-icon name="table" variant="solid"></wa-icon
      ></wa-button>
      <wa-button
        size="s"
        appearance=${this._view === "json" ? "filled" : "plain"}
        title="JSON view"
        @click=${() => this._onViewChange("json")}
        ><wa-icon name="code" variant="solid"></wa-icon
      ></wa-button>
      <div class="icon-bar-divider"></div>
    `;
  }
}
