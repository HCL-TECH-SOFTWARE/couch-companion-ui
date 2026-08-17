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

/**
 * "CouchDB will not run this sort without an index — here is the index that would serve it."
 *
 * Built for `doc-query` in #78 and lifted here whole by #82, which needs the identical
 * interaction on `doc-browser`'s sortable column headers. The alternative was a second
 * copy of the detection, the dialog and the pre-population, which is exactly the
 * divergence #56 set out to stop: the two document lists had already drifted apart once
 * over their page footers (#80) and their column derivation (#79).
 *
 * A {@link ReactiveController} rather than a component, on the model of
 * `GitTokenPrompt` (`git-sync-ui.ts`): the dialog renders into the *host's* shadow root,
 * so a host keeps one flat template and one set of `data-` hooks, and the create-index
 * form stays a direct child of the screen that owns the database it would write to.
 */

import { html, css, type TemplateResult, type ReactiveController, type ReactiveControllerHost } from "lit";
import { ApiError } from "../../services/api-error.js";
import "./create-index.js";
import type { CcaCreateIndex } from "./create-index.js";
import "@awesome.me/webawesome/dist/components/button/button.js";
import "@awesome.me/webawesome/dist/components/dialog/dialog.js";

/** One sort term, in the shape the screens and `cca-create-index.populateFromSort` share. */
export type SortItem = { field: string; direction: "asc" | "desc" };

/**
 * CouchDB's `error` code for a sort that no index can serve.
 *
 * Verified against CouchDB 3.5.2: `POST /{db}/_find` with a sort no index covers answers
 * `400 {"error":"no_usable_index","reason":"No index exists for this sort, try indexing by
 * the sort fields."}`.
 *
 * Matching the CODE — not the 400, and not the reason text — is the whole point. Every other
 * `_find` rejection the same server produces carries its own code under the same status
 * (`invalid_selector_json`, `invalid_operator`, `unsupported_mixed_sort`,
 * `invalid_non_neg_integer`), and creating an index fixes none of them; `unsupported_mixed_sort`
 * is the near neighbour a status-only check would wrongly offer to fix, and no index of any
 * shape would help, because CouchDB simply will not sort two fields in opposite directions.
 *
 * A selector with no usable index but NO sort cannot reach here at all: CouchDB answers that
 * one `200` with a `warning` in the body, so it is not an error and never opens the dialog.
 */
const NO_USABLE_INDEX = "no_usable_index";

/** Whether a rejected `_find` failed for want of an index on its sort — see {@link NO_USABLE_INDEX}. */
export function isNoUsableIndex(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    (err.body as { error?: unknown } | null)?.error === NO_USABLE_INDEX
  );
}

/**
 * The offer's own styling, for hosts to spread into their `static styles`.
 *
 * {@link IndexOffer.render} composes into the host's shadow root, so these rules have to
 * reach it there — the same reason `cca-data-table` carries `.sort-button` in its own
 * sheet rather than expecting a caller's.
 */
export const indexOfferStyles = css`
  .no-index-explanation {
    margin: 0 0 0.75rem 0;
    font-size: var(--wa-font-size-s);
    line-height: var(--wa-line-height-normal);
  }
  .no-index-sort {
    font-family: var(--wa-font-family-code);
  }
  .no-index-footer {
    display: flex;
    gap: 0.5rem;
    justify-content: flex-end;
  }
`;

/**
 * The offer that replaces a dead-end toast when `_find` rejects a sort for want of an index.
 *
 * Hosts render {@link render} once, unconditionally, and route their rejected `_find`s
 * through {@link offerIfNoUsableIndex}, which answers whether it took the failure — so each
 * screen keeps its own handling of everything else (a toast on `doc-query`, an inline
 * access-error callout on `doc-browser`) instead of having one imposed on it.
 */
export class IndexOffer implements ReactiveController {
  /** Whether the offer is showing. */
  private _open = false;

  /**
   * The sort CouchDB refused to run, as sent — not whatever the screen's sort state holds
   * by now, which a Sort panel or a second header click may have moved on from while the
   * request was in flight. This is what the offer describes and what the form is filled from.
   */
  private _failedSort: SortItem[] = [];

  /**
   * Re-issues the exact request that failed, once an index for it exists. Captured at the
   * failure, so a page fetch and a field-sampling fetch each retry themselves without the
   * host having to remember which one it was.
   */
  private _retry: (() => void) | null = null;

  /**
   * What to do when the user declines. `doc-query` needs nothing — the query simply did not
   * run. `doc-browser` puts its list back to the sort that last worked, because its header
   * click already changed what the screen claims to be showing.
   */
  private _onDismiss: (() => void) | null = null;

  constructor(
    private readonly host: ReactiveControllerHost & { renderRoot: ParentNode },
  ) {
    host.addController(this);
  }

  hostConnected(): void {
    /* nothing to do — the offer only exists after a request has been refused */
  }

  /** Leaving the screen abandons the offer; a stale retry would fetch into a dead element. */
  hostDisconnected(): void {
    this._open = false;
    this._retry = null;
    this._onDismiss = null;
  }

  /** Whether the offer is showing. */
  get isOpen(): boolean {
    return this._open;
  }

  /** The sort that failed, as sent. Exposed so hosts and tests can assert on it. */
  get failedSort(): readonly SortItem[] {
    return this._failedSort;
  }

  /**
   * Takes the failure if — and only if — it is a sort CouchDB could not serve for want of
   * an index, and answers whether it did. Everything else is left to the caller.
   *
   * A no-usable-index rejection of a query carrying NO sort is deliberately not taken: CouchDB
   * does not currently produce one (a sortless query is answered 200 with a `warning`), and an
   * offer built from an empty sort would have no fields to index.
   */
  offerIfNoUsableIndex(
    err: unknown,
    sort: readonly SortItem[],
    retry: () => void,
    onDismiss?: () => void,
  ): boolean {
    if (!isNoUsableIndex(err) || sort.length === 0) return false;
    void this._show(sort, retry, onDismiss);
    return true;
  }

  /**
   * Opens the offer and hands the failed sort to the create-index form, after a render — the
   * form is only built while the dialog is open, so it does not exist before this awaits.
   *
   * The form is *populated*, never submitted: creating the index stays the user's explicit
   * choice, made through create-index's own Create → preview → Confirm path (#57).
   */
  private async _show(
    sort: readonly SortItem[],
    retry: () => void,
    onDismiss?: () => void,
  ): Promise<void> {
    this._failedSort = sort.map((s) => ({ ...s }));
    this._retry = retry;
    this._onDismiss = onDismiss ?? null;
    this._open = true;
    this.host.requestUpdate();
    await this.host.updateComplete;
    this._form()?.populateFromSort(this._failedSort);
  }

  /** The create-index form, which exists only while the offer is open. */
  private _form(): CcaCreateIndex | null {
    return this.host.renderRoot.querySelector<CcaCreateIndex>(
      "cca-create-index[data-no-index-form]",
    );
  }

  /** Closes without creating anything and without retrying. */
  private _close(): void {
    this._open = false;
    this._retry = null;
    this._onDismiss = null;
    this.host.requestUpdate();
  }

  /**
   * "Not now": closes, then lets the host put itself back the way it was. The callback is read
   * before closing, because closing clears it.
   */
  private _dismiss(): void {
    const onDismiss = this._onDismiss;
    this._close();
    onDismiss?.();
  }

  /**
   * The index the user asked for now exists, so the request that could not be sorted without it
   * runs again. `retry` is read before closing, for the same reason — and closing is what
   * `wa-after-hide` re-enters as the dialog goes away.
   */
  private _onCreated(): void {
    const retry = this._retry;
    this._close();
    retry?.();
  }

  /**
   * The dialog itself. Hosts render this once, unconditionally, anywhere in their template,
   * and spread {@link indexOfferStyles} into their own styles.
   *
   * Nothing is created by opening it. The form's own Create → editable-preview → Confirm path
   * is untouched and is the only thing that writes: creating an index on the user's database is
   * their explicit choice, and it stays two deliberate clicks away. "Not now" leaves the
   * database exactly as it was.
   *
   * The body is rendered only while open, so a host does not carry a second Monaco editor
   * (create-index embeds one) for a dialog most sessions never see.
   */
  render(dbName: string, serverId: string): TemplateResult {
    return html`
      <wa-dialog
        data-no-index-dialog
        label="No index for this sort"
        ?open=${this._open}
        @wa-after-hide=${(e: Event) => {
          if (e.target === e.currentTarget) this._dismiss();
        }}
      >
        ${this._open ? this._renderBody(dbName, serverId) : ""}
        <div slot="footer" class="no-index-footer">
          <wa-button data-no-index-dismiss @click=${() => this._dismiss()}>
            Not now
          </wa-button>
        </div>
      </wa-dialog>
    `;
  }

  /** The offer's body — built only while it is open; see {@link render}. */
  private _renderBody(dbName: string, serverId: string): TemplateResult {
    const sortText = this._failedSort
      .map((s) => `${s.field} (${s.direction})`)
      .join(", ");
    return html`
      <p class="no-index-explanation">
        CouchDB would not run this query: sorting by
        <span class="no-index-sort">${sortText}</span> needs a Mango index
        covering those fields, in that order, and this database has none.
      </p>
      <p class="no-index-explanation">
        Below is the index that would serve it. Review it and press Create to
        confirm — nothing is written to
        <span class="no-index-sort">${dbName}</span> until you do.
      </p>
      <cca-create-index
        data-no-index-form
        .dbName=${dbName}
        .serverId=${serverId}
        @index-created=${() => this._onCreated()}
      ></cca-create-index>
    `;
  }
}
