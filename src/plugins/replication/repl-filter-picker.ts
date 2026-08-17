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

import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import '@awesome.me/webawesome/dist/components/dialog/dialog.js';
import '@awesome.me/webawesome/dist/components/select/select.js';
import '@awesome.me/webawesome/dist/components/option/option.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/spinner/spinner.js';
import { getContext } from '../../context.js';
import { toast } from '../../components/cca-toast.js';

/**
 * Dialog that picks a CouchDB replication filter from the SOURCE database's
 * design documents: choose a design doc, then one of its `filters` entries.
 *
 * Emits:
 * - `cca-filter-picked` `{ designDoc, filterName }` — designDoc WITHOUT the
 *   `_design/` prefix (the CouchDB `filter` field format is `ddoc/fn`).
 * - `cca-filter-pick-cancel` — dialog dismissed without a pick.
 */
@customElement('cca-repl-filter-picker')
export class CcaReplFilterPicker extends LitElement {
  static styles = css`
    :host {
      display: contents;
    }
    .field {
      display: grid;
      gap: var(--wa-space-2xs, 0.35rem);
      margin-block-end: var(--wa-space-m, 0.75rem);
      font-size: var(--wa-font-size-s, 0.875rem);
      color: var(--wa-color-text-quiet);
    }
    wa-select {
      width: 100%;
    }
    .hint {
      color: var(--wa-color-text-quiet);
      font-size: var(--wa-font-size-s, 0.875rem);
      margin: 0;
    }
    .footer {
      display: flex;
      gap: var(--wa-space-s, 0.5rem);
      justify-content: flex-end;
    }
    wa-spinner {
      display: block;
      margin: var(--wa-space-l, 1.5rem) auto;
      font-size: var(--wa-font-size-2xl, 2rem);
    }
  `;

  @property({ type: Boolean, reflect: true }) open = false;
  @property({ type: String }) serverId = '';
  @property({ type: String }) dbName = '';

  @state() private _ddocs: string[] = [];
  @state() private _loadingDdocs = false;
  @state() private _selectedDdoc = '';
  /** null until a design doc has been chosen and its filters fetched. */
  @state() private _filters: string[] | null = null;
  @state() private _loadingFilters = false;
  @state() private _selectedFilter = '';

  override updated(changed: Map<string, unknown>) {
    if (changed.has('open') && this.open) {
      this._selectedDdoc = '';
      this._selectedFilter = '';
      this._filters = null;
      void this._loadDdocs();
    }
  }

  private async _loadDdocs() {
    this._loadingDdocs = true;
    try {
      const docs = await getContext().designMgmt.listDesignDocs(this.serverId, this.dbName);
      this._ddocs = docs.map((d) => d.ddoc_id);
    } catch (err) {
      this._ddocs = [];
      toast(err instanceof Error ? err.message : 'Failed to load design documents', 'error');
    } finally {
      this._loadingDdocs = false;
    }
  }

  private async _selectDdoc(ddocId: string) {
    this._selectedDdoc = ddocId;
    this._selectedFilter = '';
    this._filters = null;
    if (!ddocId) return;
    this._loadingFilters = true;
    try {
      const ddoc = await getContext().designMgmt.getDesignDoc(this.serverId, this.dbName, ddocId);
      this._filters = Object.keys((ddoc.filters as Record<string, unknown> | undefined) ?? {});
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to load design document', 'error');
    } finally {
      this._loadingFilters = false;
    }
  }

  private _confirm() {
    if (!this._selectedDdoc || !this._selectedFilter) return;
    this.dispatchEvent(
      new CustomEvent('cca-filter-picked', {
        detail: {
          designDoc: this._selectedDdoc.replace(/^_design\//, ''),
          filterName: this._selectedFilter
        },
        bubbles: true,
        composed: true
      })
    );
    this.open = false;
  }

  private _cancel() {
    this.dispatchEvent(new CustomEvent('cca-filter-pick-cancel', { bubbles: true, composed: true }));
    this.open = false;
  }

  private _renderBody() {
    if (this._loadingDdocs) return html`<wa-spinner></wa-spinner>`;

    if (this._ddocs.length === 0) {
      return html`<p class="hint" data-no-ddocs>This database has no design documents.</p>`;
    }

    return html`
      <label class="field">
        Design document
        <wa-select
          data-ddoc-select
          .value=${this._selectedDdoc}
          @change=${(e: Event) => void this._selectDdoc((e.target as HTMLSelectElement).value || '')}>
          ${this._ddocs.map(
            (id) => html`<wa-option data-ddoc value=${id}>${id.replace(/^_design\//, '')}</wa-option>`
          )}
        </wa-select>
      </label>
      ${this._loadingFilters ? html`<wa-spinner></wa-spinner>` : this._renderFilterField()}
    `;
  }

  private _renderFilterField() {
    if (this._filters === null) {
      return html`<p class="hint">Choose a design document to list its filter functions.</p>`;
    }
    if (this._filters.length === 0) {
      return html`<p class="hint" data-no-filters>This design document defines no filter functions.</p>`;
    }
    return html`
      <label class="field">
        Filter function
        <wa-select
          data-filter-select
          .value=${this._selectedFilter}
          @change=${(e: Event) => {
            this._selectedFilter = (e.target as HTMLSelectElement).value || '';
          }}>
          ${this._filters.map((name) => html`<wa-option data-filter value=${name}>${name}</wa-option>`)}
        </wa-select>
      </label>
    `;
  }

  render() {
    return html`
      <wa-dialog
        label="Pick replication filter"
        ?open=${this.open}
        @wa-after-hide=${(e: Event) => {
          if (e.target === e.currentTarget && this.open) this._cancel();
        }}>
        ${this._renderBody()}
        <div slot="footer" class="footer">
          <wa-button data-cancel @click=${() => this._cancel()}>Cancel</wa-button>
          <wa-button
            data-confirm
            variant="brand"
            appearance="filled"
            ?disabled=${!this._selectedDdoc || !this._selectedFilter}
            @click=${() => this._confirm()}
            >Use Filter</wa-button
          >
        </div>
      </wa-dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'cca-repl-filter-picker': CcaReplFilterPicker;
  }
}
