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

import { html, css } from 'lit';
import type { PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import '@awesome.me/webawesome/dist/components/input/input.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/spinner/spinner.js';
import '@awesome.me/webawesome/dist/components/dialog/dialog.js';
import '@awesome.me/webawesome/dist/components/tab-group/tab-group.js';
import '@awesome.me/webawesome/dist/components/tab/tab.js';
import '@awesome.me/webawesome/dist/components/tab-panel/tab-panel.js';
import '../../components/cca-data-table.js';
import './cca-config-cors.js';
import './cca-config-compare-picker.js';
import { getContext } from '../../context.js';
import { toast } from '../../components/cca-toast.js';
import { addHeaderActions, clearHeaderActions } from '../../components/cca-header.js';
import type { HeaderAction } from '../../components/cca-header.js';
import { CcaElement } from '../../components/cca-element.js';
import type { TableColumn } from '../../components/cca-data-table.js';
import type { NodeConfig, ConfigRow } from './types.js';

/** Table row view-model: a config entry plus whether it heads its section group. */
type Row = ConfigRow & { _first: boolean };

/** A pending confirm action (delete a key, or restart the node). */
type Confirm = { message: string; run: () => Promise<void> } | null;

/**
 * CouchDB node-configuration editor (Fauxton-equivalent). Server-scoped via the
 * `:serverId` route param — the header's server picker reflects and
 * drives the selection; `$all` (or none) shows a prompt. The Main config tab is
 * a Section/Option/Value table with per-operation immediate persistence; the
 * CORS tab is a friendlier editor over the `cors` keys; the JSON tab shows the
 * raw config.
 *
 * This screen is also the entry point to the node-comparison view (#73): the
 * `code-compare` header action opens a node picker and routes to
 * `/configuration/compare?nodes=…`. It appears only when `_membership` reports two or
 * more nodes — on a stock single-node CouchDB, and for a non-admin who may not read
 * `_membership` at all, there is nothing to compare, so the action is hidden outright.
 */
@customElement('cca-config')
export class CcaConfig extends CcaElement {
  static styles = css`
    .fields {
      display: flex;
      flex-direction: column;
      gap: var(--wa-space-m, 0.75rem);
    }
    label {
      display: block;
      color: var(--wa-color-text-normal);
      font-weight: var(--wa-font-weight-bold, 600);
      margin-bottom: 0.2rem;
      font-size: var(--wa-font-size-s, 0.875rem);
    }
    .dialog-body {
      color: var(--wa-color-text-normal);
    }
    .ro {
      color: var(--wa-color-text-quiet);
      font-family: var(--wa-font-family-code);
    }
    .empty {
      color: var(--wa-color-text-quiet);
    }
    .footer {
      display: flex;
      gap: var(--wa-space-s, 0.5rem);
      justify-content: flex-end;
    }
    .error {
      color: var(--wa-color-danger-60);
      margin-top: var(--wa-space-s, 0.5rem);
    }
    .json-view {
      margin: 0;
      max-height: 60vh;
      overflow: auto;
      padding: var(--wa-space-m, 0.75rem);
      background: var(--wa-color-surface-lowered);
      border: 1px solid var(--wa-color-border-quiet);
      border-radius: var(--wa-border-radius-m, 0.375rem);
      color: var(--wa-color-text-normal);
      font-family: var(--wa-font-family-code);
      font-size: var(--wa-font-size-s, 0.85rem);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .filter-row {
      margin-block: var(--wa-space-s) var(--wa-space-m);
    }
    .filter-row wa-input::part(form-control-label) {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }
  `;

  /** Set by the app shell from the :serverId route param. `$all` = none chosen. */
  @property({ type: String }) serverId = '';

  @state() private _config: NodeConfig = {};
  @state() private _loading = false;
  @state() private _error = '';
  @state() private _activeTab: 'main' | 'cors' | 'json' = 'main';
  /** Client-side row filter. The full config is already loaded — see #827. */
  @state() private _filter = '';

  // Add/edit modal.
  @state() private _modalOpen = false;
  @state() private _isNew = false;
  @state() private _draft: ConfigRow = { section: '', key: '', value: '' };
  @state() private _modalError = '';

  // Shared confirm dialog (delete key / restart node).
  @state() private _confirm: Confirm = null;

  // Compare-configurations node picker.
  @state() private _showPicker = false;

  /**
   * Cluster size from `_membership`, gating the compare action. Not `@state`: it drives the
   * header singleton, not this element's template. Stays 0 while the probe is in flight and
   * for anyone who may not run it, so the action is absent by default and appears only once
   * a real cluster is proven.
   */
  private _nodeCount = 0;

  private get _hasServer(): boolean {
    return !!this.serverId && this.serverId !== '$all';
  }

  override connectedCallback() {
    super.connectedCallback();
    this._updateHeaderActions();
    void this._probeClusterSize();
    if (this._hasServer) {
      void this._load();
    } else {
      void this._autoSelectSingleServer();
    }
  }

  /**
   * Counts cluster nodes so {@link _updateHeaderActions} can decide whether comparing is
   * meaningful. `_membership` is admin-only and answers 401 for members: that rejection is
   * "you don't get this feature", not a failure worth reporting, so it is swallowed without
   * a toast and leaves the count at 0 — the same outcome as a single-node cluster.
   */
  private async _probeClusterSize() {
    try {
      this._nodeCount = (await getContext().membership.listNodes()).length;
    } catch {
      this._nodeCount = 0;
    }
    this._updateHeaderActions();
  }

  /**
   * Republishes the whole action set. The header is a singleton with no per-owner slot, so
   * actions are cleared and re-added wholesale rather than appended to — and because the
   * membership probe resolves after an await, this can be reached once another screen already
   * owns the header (Lit keeps updating a disconnected element), hence the connectivity guard.
   */
  private _updateHeaderActions() {
    if (!this.isConnected) return;
    const actions: HeaderAction[] = [
      { icon: 'plus', tooltip: 'Add Option', action: () => this.openNew() }
    ];
    if (this._nodeCount >= 2) {
      actions.push({
        icon: 'code-compare',
        tooltip: 'Compare nodes',
        action: () => this._openPicker()
      });
    }
    actions.push({
      icon: 'power-off',
      tooltip: 'Restart node',
      variant: 'danger',
      action: () => this._askRestart()
    });
    clearHeaderActions();
    addHeaderActions(actions);
  }

  /**
   * Reached via a legacy `$all` deep link. With exactly one registered server,
   * adopt it as this screen's `serverId` rather than dead-ending on the empty
   * state; the property change drives `_load()` through `_onUpdated`. Written
   * locally because the app-wide selection plumbing is gone (#31).
   */
  private async _autoSelectSingleServer() {
    try {
      const { servers } = await getContext().serverMgmt.listServers();
      if (!this._hasServer && servers.length === 1) {
        this.serverId = servers[0].id;
      }
    } catch (err: unknown) {
      toast(
        `Failed to load servers: ${err instanceof Error ? err.message : String(err)}`,
        'error'
      );
    }
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    clearHeaderActions();
  }

  protected override _onUpdated(changed: PropertyValues) {
    // Reload when the server selection switches the :serverId route segment.
    if (changed.has('serverId')) void this._load();
  }

  /** Loads config for the current server (no-op when none / `$all`). */
  private async _load() {
    if (!this._hasServer) {
      this._config = {};
      return;
    }
    this._loading = true;
    this._error = '';
    try {
      this._config = await getContext().config.getConfig(this.serverId);
    } catch (err: unknown) {
      this._error = err instanceof Error ? err.message : String(err);
      toast(`Failed to load configuration: ${this._error}`, 'error');
    } finally {
      this._loading = false;
    }
  }

  /** Flattens the config map into section-grouped, sorted rows, honoring the filter. */
  private get _rows(): Row[] {
    const q = this._filter.trim().toLowerCase();
    const rows: Row[] = [];
    for (const section of Object.keys(this._config).sort()) {
      const keys = Object.keys(this._config[section])
        .sort()
        .filter(
          (key) =>
            !q ||
            section.toLowerCase().includes(q) ||
            key.toLowerCase().includes(q) ||
            String(this._config[section][key]).toLowerCase().includes(q)
        );
      keys.forEach((key, i) => {
        rows.push({ section, key, value: this._config[section][key], _first: i === 0 });
      });
    }
    return rows;
  }

  /** Opens the modal to add a new option. Public for the header action and tests. */
  openNew() {
    this._isNew = true;
    this._draft = { section: '', key: '', value: '' };
    this._modalError = '';
    this._modalOpen = true;
  }

  private _openEdit(row: ConfigRow) {
    this._isNew = false;
    this._draft = { section: row.section, key: row.key, value: row.value };
    this._modalError = '';
    this._modalOpen = true;
  }

  private _updateDraft(field: keyof ConfigRow, value: string) {
    this._draft = { ...this._draft, [field]: value };
  }

  /** Persists the modal draft (one PUT), then reloads. */
  async saveDraft() {
    const { section, key, value } = this._draft;
    if (!section.trim() || !key.trim()) {
      this._modalError = 'Section and Option are required.';
      return;
    }
    if (!this._hasServer) return;
    try {
      await getContext().config.setConfigValue(this.serverId, section, key, value);
      this._modalOpen = false;
      toast(`Saved ${section}/${key}.`, 'success');
      await this._load();
    } catch (err: unknown) {
      this._modalError = err instanceof Error ? err.message : String(err);
    }
  }

  private _askDelete(row: ConfigRow) {
    this._confirm = {
      message: `Delete configuration ${row.section} / ${row.key}?`,
      run: async () => {
        if (!this._hasServer) return;
        await getContext().config.deleteConfigValue(this.serverId, row.section, row.key);
        toast(`Deleted ${row.section}/${row.key}.`, 'success');
        await this._load();
      }
    };
  }

  private _askRestart() {
    this._confirm = {
      message: 'Restart CouchDB on this server? Connections will briefly drop.',
      run: async () => {
        if (!this._hasServer) return;
        await getContext().config.restartNode(this.serverId);
        toast('Restart requested.', 'success');
      }
    };
  }

  /** Runs the pending confirm action. Public for tests. */
  async runConfirm() {
    const c = this._confirm;
    this._confirm = null;
    if (!c) return;
    try {
      await c.run();
    } catch (err: unknown) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    }
  }

  private get _columns(): TableColumn<Row>[] {
    // Cells render inside cca-data-table's shadow DOM, so this component's CSS
    // classes don't reach them — style inline (with wa tokens) instead.
    const text = 'color:var(--wa-color-text-normal)';
    const code = `font-family:var(--wa-font-family-code);overflow-wrap:anywhere;${text}`;
    return [
      {
        label: 'Section',
        render: (r) =>
          r._first
            ? html`<span style="font-weight:var(--wa-font-weight-bold,600);${text}">${r.section}</span>`
            : ''
      },
      { label: 'Option', render: (r) => html`<span style=${code}>${r.key}</span>` },
      { label: 'Value', render: (r) => html`<span style=${code} data-value>${r.value}</span>` },
      {
        label: '',
        width: '3rem',
        align: 'center',
        render: (r) =>
          html`<wa-button
            data-row-delete
            size="small"
            variant="danger"
            appearance="outlined"
            class="row-action-button"
            @click=${(e: Event) => {
              e.stopPropagation();
              this._askDelete(r);
            }}
            ><wa-icon name="trash-can"></wa-icon
          ></wa-button>`
      }
    ];
  }

  private _renderModal() {
    return html`
      <wa-dialog
        data-edit
        label=${this._isNew ? 'Add option' : 'Edit value'}
        ?open=${this._modalOpen}
        @wa-after-hide=${(e: Event) => {
          if (e.target === e.currentTarget) this._modalOpen = false;
        }}>
        <div class="fields">
          <div>
            <label>Section</label>
            ${this._isNew
              ? html`<wa-input
                  data-field="section"
                  .value=${this._draft.section}
                  @input=${(e: Event) =>
                    this._updateDraft('section', (e.target as HTMLInputElement).value)}></wa-input>`
              : html`<div class="ro" data-ro-section>${this._draft.section}</div>`}
          </div>
          <div>
            <label>Option</label>
            ${this._isNew
              ? html`<wa-input
                  data-field="key"
                  .value=${this._draft.key}
                  @input=${(e: Event) =>
                    this._updateDraft('key', (e.target as HTMLInputElement).value)}></wa-input>`
              : html`<div class="ro" data-ro-key>${this._draft.key}</div>`}
          </div>
          <div>
            <label>Value</label>
            <wa-input
              data-field="value"
              .value=${this._draft.value}
              @input=${(e: Event) =>
                this._updateDraft('value', (e.target as HTMLInputElement).value)}></wa-input>
          </div>
          ${this._modalError ? html`<div class="error">${this._modalError}</div>` : ''}
        </div>
        <div slot="footer" class="footer">
          <wa-button data-modal-cancel @click=${() => (this._modalOpen = false)}>Cancel</wa-button>
          <wa-button data-modal-save variant="brand" appearance="filled" @click=${() => void this.saveDraft()}
            >Save</wa-button
          >
        </div>
      </wa-dialog>
    `;
  }

  private _renderConfirm() {
    return html`
      <wa-dialog
        data-confirm
        label="Please confirm"
        ?open=${this._confirm !== null}
        @wa-after-hide=${(e: Event) => {
          if (e.target === e.currentTarget) this._confirm = null;
        }}>
        <div class="dialog-body">${this._confirm?.message}</div>
        <div slot="footer" class="footer">
          <wa-button data-confirm-cancel @click=${() => (this._confirm = null)}>Cancel</wa-button>
          <wa-button data-confirm-ok variant="danger" appearance="filled" @click=${() => void this.runConfirm()}
            >Confirm</wa-button
          >
        </div>
      </wa-dialog>
    `;
  }

  private _openPicker() {
    this._showPicker = true;
  }

  /**
   * Navigates to the compare screen with the picker's selection verbatim. Nothing is
   * re-ordered or injected: the columns are nodes, and no node is "the current one" — this
   * screen edits the config the server routed us to, not a node we could pull to the front.
   */
  private _onCompareConfirm(nodes: string[]) {
    getContext().router.navigate(`/configuration/compare?nodes=${nodes.join(',')}`);
    this._showPicker = false;
  }

  private _renderComparePicker() {
    return html`
      <cca-config-compare-picker
        ?open=${this._showPicker}
        .preselectedNodes=${[]}
        @compare-confirm=${(e: CustomEvent<{ nodes: string[] }>) =>
          this._onCompareConfirm(e.detail.nodes)}
        @compare-cancel=${() => {
          this._showPicker = false;
        }}></cca-config-compare-picker>
    `;
  }

  render() {
    return html`
      ${!this._hasServer
        ? html`<p class="empty" data-empty>No CouchDB server available.</p>`
        : this._loading
          ? html`<wa-spinner></wa-spinner>`
          : html`
              <wa-tab-group
                .active=${this._activeTab}
                @wa-tab-show=${(e: CustomEvent<{ name: string }>) =>
                  (this._activeTab = e.detail.name as 'main' | 'cors' | 'json')}>
                <wa-tab panel="main">Main config</wa-tab>
                <wa-tab panel="cors">CORS</wa-tab>
                <wa-tab panel="json">JSON</wa-tab>
                <wa-tab-panel name="main">
                  <div class="filter-row">
                    <wa-input
                      data-filter
                      label="Filter configuration"
                      placeholder="Filter…"
                      clearable
                      .value=${this._filter}
                      @input=${(e: Event) => (this._filter = (e.target as HTMLInputElement).value)}
                      @wa-clear=${() => (this._filter = '')}></wa-input>
                  </div>
                  <cca-data-table
                    .columns=${this._columns as unknown as TableColumn[]}
                    .rows=${this._rows as unknown as Record<string, unknown>[]}
                    empty-message=${this._filter.trim()
                      ? 'No matching configuration entries.'
                      : 'No configuration entries.'}
                    @cca-row-click=${(e: CustomEvent<Row>) => this._openEdit(e.detail)}></cca-data-table>
                </wa-tab-panel>
                <wa-tab-panel name="cors">
                  <cca-config-cors
                    .serverId=${this.serverId}
                    .config=${this._config}
                    @cors-changed=${() => void this._load()}></cca-config-cors>
                </wa-tab-panel>
                <wa-tab-panel name="json">
                  <pre class="json-view" data-json-view>${JSON.stringify(this._config, null, 2)}</pre>
                </wa-tab-panel>
              </wa-tab-group>
            `}
      ${this._error ? html`<div class="error">${this._error}</div>` : ''} ${this._renderModal()}
      ${this._renderConfirm()} ${this._renderComparePicker()}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'cca-config': CcaConfig;
  }
}
