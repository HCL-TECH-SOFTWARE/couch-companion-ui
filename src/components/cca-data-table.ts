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
import { CcaElement } from "./cca-element.js";

export interface TableColumn<T = Record<string, unknown>> {
  /** Column header label */
  label: string;
  /** Key to read from each row object, or a render function */
  key?: keyof T & string;
  /** Custom cell renderer — receives the row and returns a lit TemplateResult or string */
  render?: (row: T) => unknown;
  /** Optional CSS width, e.g. "8rem" */
  width?: string;
  /** Optional text alignment for both header and cells */
  align?: "left" | "center" | "right";
  /**
   * Custom header cell renderer — overrides label. The returned template
   * renders inside the table's shadow DOM, out of reach of consumer CSS;
   * interactive sort headers should use the table's .sort-button class.
   */
  headerRender?: () => unknown;
  /**
   * When set, stamped as aria-sort on this column's th so assistive tech
   * announces the active sort. Leave undefined on inactive/unsortable columns.
   */
  ariaSort?: "ascending" | "descending";
}

export type RowTemplate<T> = (row: T) => unknown;

/**
 * Generic dynamic data table.
 *
 * @fires cca-row-click - CustomEvent<T> fired when a row is clicked
 *
 * @example
 * ```ts
 * const columns: TableColumn<Server>[] = [
 *   { label: "Name", key: "name" },
 *   { label: "URL",  key: "url" },
 *   { label: "Status", render: (s) => s.reachable ? "Up" : "Down" },
 * ];
 * html`<cca-data-table .columns=${columns} .rows=${servers}></cca-data-table>`
 * ```
 */

const stylesheet = new CSSStyleSheet();
stylesheet.replaceSync(`
    :host {
      display: block;
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th,
    td {
      text-align: left;
      padding: 0.5rem 0.75rem;
      border-bottom: 1px solid var(--wa-color-border-quiet, #eee);
      font-size: var(--wa-font-size-s);
      color: var(--wa-color-text-normal);
    }
    th {
      font-weight: var(--wa-font-weight-bold);
      color: var(--wa-color-text-quiet);
      font-size: var(--wa-font-size-xs);
      text-transform: uppercase;
      white-space: nowrap;
    }
    /* Opt-in reset for interactive sort headers rendered via headerRender.
       That content lives in this shadow root, so the hook must live here. */
    th .sort-button {
      background: none;
      border: none;
      padding: 0;
      margin: 0;
      font: inherit;
      text-transform: inherit;
      color: inherit;
      cursor: pointer;
      user-select: none;
    }
    th .sort-button:focus-visible {
      outline: var(--wa-focus-ring);
      outline-offset: var(--wa-focus-ring-offset);
    }
    th .sort-button.active {
      color: var(--wa-color-text-link);
    }
    /* Same opt-in, same reason, for a header that pairs its label with a control —
       today the per-column field picker (#79), tomorrow that picker beside a sort
       button. Keeps the two on one baseline instead of relying on the inline
       whitespace between them.

       It also opts out of the uppercasing above, which is right for a column named by
       this app and wrong for one named by the data: these labels are document field
       names, which CouchDB treats as case-sensitive, so "_ID" names no field. */
    th .column-header {
      display: inline-flex;
      align-items: center;
      gap: 0.25rem;
      text-transform: none;
    }
    tr.clickable {
      cursor: pointer;
    }
    tr.clickable:hover {
      background: var(--wa-color-fill-quiet);
    }
    tr.selected {
      background: var(--wa-color-brand-fill-quiet);
    }
    tr.expanded {
      background: var(--wa-color-brand-fill-quiet);
    }
    /* Opt-in hover treatment for action-column buttons (#106): a column's render()
     * output composes into THIS shadow root, not the caller's own (see the render()
     * method's per-column mapping below) — so a caller's own stylesheet can never
     * reach these buttons, and the rule has to live here instead. Callers opt in via
     * the row-action-button class and set a fixed base appearance themselves (typically
     * outlined); hovering anywhere in the row nudges it toward filled-outlined, hovering
     * the button itself goes further to accent. The color/background/border
     * declarations below are copied from wa-button's own internal appearance rules for
     * those two states, using the same variant-scoped custom properties (--wa-color-
     * fill-normal etc.), so a danger-variant button (e.g. a delete action) keeps its
     * own color family instead of being forced neutral.
     */
    tr:hover .row-action-button::part(base) {
      color: var(--wa-color-on-normal, var(--wa-color-neutral-on-normal));
      background-color: var(--wa-color-fill-normal, var(--wa-color-neutral-fill-normal));
      border-color: var(--wa-color-border-normal, var(--wa-color-neutral-border-normal));
    }
    /* Hovering the button also satisfies "tr:hover" on its own ancestor row (:hover
     * propagates up from a hovered descendant), so this selector repeats that same
     * "tr:hover .row-action-button" prefix rather than dropping it — dropping it would
     * make this rule LESS specific than the one above (one fewer type selector: no
     * "tr"), and the row-hover rule would always win the cascade whenever both match,
     * which is every time a button is actually hovered. This was shipped broken once
     * already; the repeated prefix is what makes it win instead of tie. */
    tr:hover .row-action-button::part(base):hover {
      color: var(--wa-color-on-loud, var(--wa-color-neutral-on-loud));
      background-color: var(--wa-color-fill-loud, var(--wa-color-neutral-fill-loud));
      border-color: transparent;
    }
    tr.detail-row td {
      padding: 0;
      background: var(--wa-color-surface-raised);
      border-bottom: 2px solid var(--wa-color-border-quiet);
    }
    .empty {
      text-align: center;
      padding: 2rem;
      color: var(--wa-color-text-quiet);
      font-size: var(--wa-font-size-s);
      color: var(--wa-color-text-normal, #1f2a35);
    }
    .loading {
      text-align: center;
      padding: 2rem;
      color: var(--wa-color-text-quiet);
      font-size: var(--wa-font-size-s);
    }
  `);

export class CcaDataTable extends CcaElement {
  static override get styles() {
    return [stylesheet];
  }

  // Plain flag — avoids the CcaElement base class bug where `_initialized`
  // (@state) is set inside updated(), triggering Lit's "change-in-update" warning.
  private _firstUpdateDone = false;

  override updated(changed: Map<string, unknown>) {
    if (!this._firstUpdateDone) {
      this._firstUpdateDone = true;
      void Promise.resolve().then(() => super.updated(changed));
      return;
    }
    super.updated(changed);
  }

  /** Column definitions */
  @property({ type: Array }) columns: TableColumn[] = [];

  /** Row data */
  @property({ type: Array }) rows: Record<string, unknown>[] = [];

  /** Message shown when rows is empty */
  @property({ attribute: "empty-message" }) emptyMessage = "No data.";

  /** When true shows a loading placeholder instead of the table */
  @property({ type: Boolean }) loading = false;

  /** Key of the property to use as a unique row identifier for selection tracking */
  @property({ attribute: "row-key" }) rowKey?: string;

  /** Currently selected row value (matched against rowKey) */
  @property() selectedKey?: string;

  /** Currently expanded row key — shows the expandedRowTemplate inline below the row */
  @property() expandedKey?: string;

  /** Render function for the expanded detail content; receives the row object */
  @property({ attribute: false }) expandedRowTemplate?: RowTemplate<
    Record<string, unknown>
  >;

  private _cell(row: Record<string, unknown>, col: TableColumn) {
    if (col.render) return col.render(row);
    if (col.key) return (row as any)[col.key] ?? "—";
    return "";
  }

  private _rowKey(row: Record<string, unknown>): string | undefined {
    return this.rowKey ? String((row as any)[this.rowKey]) : undefined;
  }

  private _handleRowClick(row: Record<string, unknown>) {
    this.dispatchEvent(
      new CustomEvent<Record<string, unknown>>("cca-row-click", {
        detail: row,
        bubbles: true,
        composed: true,
      }),
    );
  }

  override render() {
    if (this.loading) {
      return html`<div class="loading">Loading...</div>`;
    }

    if (this.rows.length === 0) {
      return html`<div class="empty">${this.emptyMessage}</div>`;
    }

    const isClickable =
      this.hasAttribute("@cca-row-click") ||
      this.listenerCount > 0 ||
      !!this.rowKey;

    return html`
      <table>
        <thead>
          <tr>
            ${this.columns.map(
              (col) => html`
                <th
                  aria-sort=${col.ariaSort ?? nothing}
                  style=${[
                    col.width ? `width:${col.width}` : "",
                    col.align ? `text-align:${col.align}` : "",
                  ]
                    .filter(Boolean)
                    .join(";")}
                >
                  ${col.headerRender ? col.headerRender() : col.label}
                </th>
              `,
            )}
          </tr>
        </thead>
        <tbody>
          ${this.rows.map((row) => {
            const key = this._rowKey(row);
            const selected = key !== undefined && key === this.selectedKey;
            const expanded = key !== undefined && key === this.expandedKey;
            return html`
              <tr
                class="${selected ? "selected" : ""} ${
                  expanded ? "expanded" : ""
                } clickable"
                @click=${() => this._handleRowClick(row)}
              >
                ${this.columns.map(
                  (col) =>
                    html`<td
                      style=${col.align ? `text-align:${col.align}` : ""}
                    >
                      ${this._cell(row, col)}
                    </td>`,
                )}
              </tr>
              ${
                expanded && this.expandedRowTemplate
                  ? html`<tr class="detail-row">
                      <td colspan=${this.columns.length}>
                        ${this.expandedRowTemplate(row)}
                      </td>
                    </tr>`
                  : nothing
              }
            `;
          })}
        </tbody>
      </table>
    `;
  }

  // Helper used above — avoids false negatives from the attribute check
  private get listenerCount() {
    return 0;
  }
}

customElements.define("cca-data-table", CcaDataTable);
