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
import { customElement, property } from 'lit/decorators.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import type { CompareColumn, CompareRow } from './compare-model.js';

/**
 * Presentational multi-node config compare grid. Hand-rolls a `<table>`
 * (one column per cluster node) from the `CompareColumn`/`CompareRow` model
 * built by `buildCompareModel`. Purely props-in/events-out: no `getContext()`,
 * no data loading — the parent owns loading the configs and performing writes.
 *
 * Emits:
 * - `cell-edit` `{ section, key, node, value }` when a value cell is clicked.
 * - `cell-copy` `{ section, key, sourceNode, value }` when the per-cell
 *   "copy to other nodes" affordance is clicked (only rendered for defined values).
 */
@customElement('cca-config-compare-table')
export class CcaConfigCompareTable extends LitElement {
  static styles = css`
    :host {
      display: block;
    }
    .scroll {
      overflow-x: auto;
      border: var(--wa-border-width-s, 1px) solid var(--wa-color-surface-border);
      border-radius: var(--wa-border-radius-m);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: var(--wa-font-size-s, 0.875rem);
    }
    thead th {
      text-align: left;
      padding: var(--wa-space-s, 0.5rem) var(--wa-space-m, 0.75rem);
      font-size: var(--wa-font-size-2xs, 0.75rem);
      font-weight: var(--wa-font-weight-bold);
      text-transform: uppercase;
      letter-spacing: 0.03em;
      color: var(--wa-color-text-quiet);
      background: var(--wa-color-surface-raised);
      border-bottom: var(--wa-border-width-s, 1px) solid var(--wa-color-surface-border);
      white-space: nowrap;
    }
    .col-header {
      display: flex;
      align-items: center;
      gap: var(--wa-space-2xs, 0.25rem);
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .dot.up {
      background: var(--wa-color-success-fill-loud, var(--wa-color-brand-fill-loud));
    }
    .dot.down {
      background: var(--wa-color-danger-fill-loud);
    }
    .error-icon {
      color: var(--wa-color-danger-fill-loud);
    }
    tbody td {
      padding: var(--wa-space-s, 0.5rem) var(--wa-space-m, 0.75rem);
      border-bottom: var(--wa-border-width-s, 1px) solid var(--wa-color-border-quiet);
      color: var(--wa-color-text-normal);
      vertical-align: middle;
    }
    tbody tr:last-child td {
      border-bottom: 0;
    }
    .section-label {
      color: var(--wa-color-text-quiet);
      font-weight: var(--wa-font-weight-bold);
      white-space: nowrap;
    }
    .key-cell {
      font-family: var(--wa-font-family-code, monospace);
      white-space: nowrap;
    }
    .value-cell {
      font-family: var(--wa-font-family-code, monospace);
      cursor: pointer;
      display: table-cell;
    }
    .value-cell:focus-visible {
      outline: var(--wa-border-width-m, 2px) solid var(--wa-color-brand-fill-loud);
      outline-offset: -2px;
    }
    .value {
      word-break: break-all;
    }
    .muted {
      color: var(--wa-color-text-quiet);
    }
    .copy-btn {
      margin-inline-start: var(--wa-space-2xs, 0.25rem);
      visibility: hidden;
    }
    .value-cell:hover .copy-btn,
    .value-cell:focus-within .copy-btn {
      visibility: visible;
    }
    tr.differs td {
      background: var(--wa-color-warning-fill-quiet);
    }
    tr.differs td:first-child {
      box-shadow: inset 3px 0 0 0
        var(--wa-color-warning-fill-loud, var(--wa-color-warning-fill-quiet));
    }
    .empty-row td {
      text-align: center;
      padding: var(--wa-space-xl, 2rem);
    }
    .empty-row p {
      margin: 0;
      color: var(--wa-color-text-quiet);
    }
  `;

  @property({ attribute: false }) columns: CompareColumn[] = [];
  @property({ attribute: false }) rows: CompareRow[] = [];
  @property({ type: Boolean }) showOnlyDiffs = false;

  private get _visibleRows(): CompareRow[] {
    return this.showOnlyDiffs ? this.rows.filter((r) => r.differs) : this.rows;
  }

  private emitEdit(row: CompareRow, column: CompareColumn, value: string | undefined) {
    this.dispatchEvent(
      new CustomEvent('cell-edit', {
        detail: { section: row.section, key: row.key, node: column.id, value },
        bubbles: true,
        composed: true
      })
    );
  }

  private emitCopy(row: CompareRow, column: CompareColumn, value: string) {
    this.dispatchEvent(
      new CustomEvent('cell-copy', {
        detail: { section: row.section, key: row.key, sourceNode: column.id, value },
        bubbles: true,
        composed: true
      })
    );
  }

  private renderColumnHeader(column: CompareColumn) {
    return html`
      <th>
        <div class="col-header">
          <span
            class="dot ${column.reachable ? 'up' : 'down'}"
            title=${column.reachable ? 'Connected' : 'Not connected'}
          ></span>
          <span title=${column.id}>${column.name}</span>
          ${column.error
            ? html`<wa-icon
                class="error-icon"
                name="triangle-exclamation"
                title="Failed to load this node's configuration"
                data-error
              ></wa-icon>`
            : ''}
        </div>
      </th>
    `;
  }

  private renderValueCell(row: CompareRow, column: CompareColumn) {
    const value = row.values[column.id];
    const defined = value !== undefined;
    return html`
      <td
        class="value-cell"
        data-cell=${column.id}
        role="button"
        tabindex="0"
        @click=${() => this.emitEdit(row, column, value)}
        @keydown=${(e: KeyboardEvent) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            this.emitEdit(row, column, value);
          }
        }}
      >
        ${defined
          ? html`<span class="value" data-value>${value}</span>`
          : html`<span class="muted" data-empty-value>—</span>`}
        ${defined
          ? html`<wa-button
              class="copy-btn"
              appearance="plain"
              size="s"
              data-copy
              title="Copy to other nodes"
              @click=${(e: Event) => {
                e.stopPropagation();
                this.emitCopy(row, column, value);
              }}
              ><wa-icon name="copy"></wa-icon
            ></wa-button>`
          : ''}
      </td>
    `;
  }

  private renderRow(row: CompareRow, index: number, visibleRows: CompareRow[]) {
    const showSection = index === 0 || visibleRows[index - 1].section !== row.section;
    return html`
      <tr data-row data-differs=${row.differs} class=${row.differs ? 'differs' : ''}>
        <td>
          ${showSection ? html`<span class="section-label" data-section>${row.section}</span>` : ''}
        </td>
        <td class="key-cell">${row.key}</td>
        ${this.columns.map((column) => this.renderValueCell(row, column))}
      </tr>
    `;
  }

  render() {
    const visibleRows = this._visibleRows;
    const columnCount = 2 + this.columns.length;

    return html`
      <div class="scroll">
        <table>
          <thead>
            <tr>
              <th>Section</th>
              <th>Option</th>
              ${this.columns.map((column) => this.renderColumnHeader(column))}
            </tr>
          </thead>
          <tbody>
            ${visibleRows.length === 0
              ? html`
                  <tr class="empty-row">
                    <td colspan=${columnCount}>
                      <p data-empty>
                        ${this.showOnlyDiffs ? 'No differences' : 'No configuration'}
                      </p>
                    </td>
                  </tr>
                `
              : visibleRows.map((row, index) => this.renderRow(row, index, visibleRows))}
          </tbody>
        </table>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'cca-config-compare-table': CcaConfigCompareTable;
  }
}
