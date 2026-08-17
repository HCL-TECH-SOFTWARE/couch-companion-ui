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
import { customElement, state } from 'lit/decorators.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/input/input.js';
import '@awesome.me/webawesome/dist/components/dialog/dialog.js';
import '@awesome.me/webawesome/dist/components/spinner/spinner.js';
import './cca-config-compare-table.js';
import './cca-config-compare-picker.js';
import { getContext } from '../../context.js';
import { toast } from '../../components/cca-toast.js';
import {
  addHeaderActions,
  clearHeaderActions,
  setHeaderTitle,
  clearHeaderTitle
} from '../../components/cca-header.js';
import { buildCompareModel } from './compare-model.js';
import type { CompareColumn, CompareModel } from './compare-model.js';
import type { NodeConfig } from './types.js';

/** A cell the user is editing on a single cluster node. */
interface EditState {
  node: string;
  section: string;
  key: string;
  value: string;
}

/** A pending "copy this value to the other nodes" reconcile. */
interface CopyState {
  section: string;
  key: string;
  sourceNode: string;
  value: string;
}

/** `cell-edit` detail emitted by `<cca-config-compare-table>`. */
interface CellEditDetail {
  section: string;
  key: string;
  node: string;
  value: string | undefined;
}

const EMPTY_MODEL: CompareModel = { columns: [], rows: [], differingCount: 0, totalCount: 0 };

/**
 * Route component for the "Compare configuration" feature (mounted at
 * `#/configuration/compare?nodes=couchdb@a,couchdb@b`). It compares the nodes of
 * the one configured CouchDB cluster, so every id here — the query param, the
 * column ids, the edit/copy targets — is an Erlang node name (`couchdb@host`).
 *
 * It orchestrates load → diff → render → edit → reconcile: it reads each node's
 * own `NodeConfig`, diffs them with `buildCompareModel`, renders the
 * presentational `<cca-config-compare-table>`, and owns the edit modal, the
 * copy-to-others reconcile flow, and the change-nodes picker.
 *
 * Reads are deliberately node-addressed (`_node/<name>/_config`) rather than
 * `_node/_local/_config`: `_local` is answered by whichever node received the
 * request, so columns built on it come back identical and the screen shows
 * agreement that may not exist — the exact divergence this feature is for (#73).
 *
 * Per-node config loads are `Promise.allSettled` so one down node degrades to an
 * `error` column instead of failing the screen.
 */
@customElement('cca-config-compare')
export class CcaConfigCompare extends LitElement {
  static styles = css`
    :host {
      display: block;
    }
    .summary {
      color: var(--wa-color-text-quiet);
      font-size: var(--wa-font-size-s, 0.875rem);
      margin: 0 0 var(--wa-space-m, 0.75rem);
    }
    .prompt {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: var(--wa-space-m, 0.75rem);
      color: var(--wa-color-text-normal);
      padding: var(--wa-space-xl, 2rem) 0;
    }
    .prompt p {
      margin: 0;
      color: var(--wa-color-text-quiet);
    }
    wa-spinner {
      display: block;
      margin: var(--wa-space-xl, 2rem) auto;
      font-size: var(--wa-font-size-2xl, 2rem);
    }
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
    .ro {
      color: var(--wa-color-text-quiet);
      font-family: var(--wa-font-family-code);
    }
    .dialog-body {
      color: var(--wa-color-text-normal);
    }
    .dialog-body code {
      font-family: var(--wa-font-family-code);
      overflow-wrap: anywhere;
    }
    .targets {
      color: var(--wa-color-text-quiet);
    }
    .error {
      color: var(--wa-color-danger-60, var(--wa-color-danger-fill-loud));
      margin-top: var(--wa-space-s, 0.5rem);
    }
    .footer {
      display: flex;
      gap: var(--wa-space-s, 0.5rem);
      justify-content: flex-end;
    }
  `;

  @state() private _nodes: string[] = [];
  @state() private _columns: CompareColumn[] = [];
  @state() private _model: CompareModel = EMPTY_MODEL;
  @state() private _loading = false;
  @state() private _showOnlyDiffs = false;
  @state() private _showPicker = false;

  @state() private _edit: EditState | null = null;
  @state() private _editError = '';
  @state() private _copy: CopyState | null = null;

  private _configs: Record<string, NodeConfig> = {};
  private _unsubscribe: (() => void) | null = null;

  override connectedCallback() {
    super.connectedCallback();
    this._nodes = this._readNodes();
    this._setupHeader();
    this._unsubscribe = getContext().router.subscribe(() => this._onRouteChange());
    void this._load();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._unsubscribe?.();
    this._unsubscribe = null;
    clearHeaderActions();
    clearHeaderTitle();
  }

  /** Re-reads the node names from the URL and reloads if the selection changed. */
  private _onRouteChange() {
    const nodes = this._readNodes();
    if (nodes.join(',') !== this._nodes.join(',')) {
      this._nodes = nodes;
      void this._load();
    }
  }

  /** Parses `?nodes=couchdb@a,couchdb@b` into a trimmed, non-empty node-name list. */
  private _readNodes(): string[] {
    const raw = getContext().router.currentQuery().get('nodes') ?? '';
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  private _setupHeader() {
    clearHeaderActions();
    setHeaderTitle('Compare configuration');
    addHeaderActions([
      {
        icon: this._showOnlyDiffs ? 'bars-staggered' : 'filter',
        tooltip: this._showOnlyDiffs ? 'Show all options' : 'Show only differences',
        action: () => this.toggleDiffs()
      },
      {
        icon: 'code-compare',
        tooltip: 'Change nodes',
        action: () => this._openPicker()
      }
    ]);
  }

  /** Loads node metadata and each node's own config, then rebuilds the diff model. */
  private async _load() {
    const nodes = this._nodes;
    if (nodes.length < 2) {
      this._columns = [];
      this._configs = {};
      this._model = EMPTY_MODEL;
      this._loading = false;
      return;
    }

    this._loading = true;
    // Node metadata is best-effort: `_membership` is admin-only and rejects for everyone else,
    // which just falls back to "not connected" rather than losing the comparison.
    const reachablePromise: Promise<Set<string>> = getContext()
      .membership.listNodes()
      .then((list) => new Set(list.filter((n) => n.reachable).map((n) => n.name)))
      .catch(() => new Set<string>());

    // allSettled so one down node can't reject the whole screen.
    const results = await Promise.allSettled(
      nodes.map((node) => getContext().config.getNodeConfig(node))
    );
    const reachable = await reachablePromise;

    const configs: Record<string, NodeConfig> = {};
    const columns: CompareColumn[] = nodes.map((node, i) => {
      const result = results[i];
      if (result.status === 'fulfilled') configs[node] = result.value;
      return {
        id: node,
        name: node,
        reachable: reachable.has(node),
        error: result.status === 'rejected'
      };
    });

    this._columns = columns;
    this._configs = configs;
    this._model = buildCompareModel(columns, configs);
    this._loading = false;
  }

  /** Rebuilds the diff model from the current columns and configs. */
  private _rebuild() {
    this._model = buildCompareModel(this._columns, this._configs);
  }

  /** Reloads one node's config and clears its error column state on success. */
  private async _reloadNode(node: string) {
    try {
      const config = await getContext().config.getNodeConfig(node);
      this._configs = { ...this._configs, [node]: config };
      this._columns = this._columns.map((c) => (c.id === node ? { ...c, error: false } : c));
      this._rebuild();
    } catch (err: unknown) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    }
  }

  /** Toggles the "show only differences" filter. Public for the header action and tests. */
  toggleDiffs() {
    this._showOnlyDiffs = !this._showOnlyDiffs;
    this._setupHeader();
  }

  private _openPicker() {
    this._showPicker = true;
  }

  /**
   * Navigates to the picked selection. The node names go in unencoded: `@` is legal in a
   * fragment query, and the router parses the hash itself rather than via `URL`.
   */
  private _onPickerConfirm(nodes: string[]) {
    this._showPicker = false;
    getContext().router.navigate(`/configuration/compare?nodes=${nodes.join(',')}`);
  }

  // --- Edit modal ---------------------------------------------------------

  private _openEdit(detail: CellEditDetail) {
    this._edit = {
      node: detail.node,
      section: detail.section,
      key: detail.key,
      value: detail.value ?? ''
    };
    this._editError = '';
  }

  private _updateEditValue(value: string) {
    if (this._edit) this._edit = { ...this._edit, value };
  }

  /** Persists the edited value on that node, then reloads it. Public for tests. */
  async saveEdit() {
    const edit = this._edit;
    if (!edit) return;
    try {
      await getContext().config.setNodeConfigValue(edit.node, edit.section, edit.key, edit.value);
      this._edit = null;
      toast(`Saved ${edit.section}/${edit.key}.`, 'success');
      await this._reloadNode(edit.node);
    } catch (err: unknown) {
      this._editError = err instanceof Error ? err.message : String(err);
    }
  }

  // --- Reconcile (copy to others) -----------------------------------------

  private get _copyTargets(): CompareColumn[] {
    const copy = this._copy;
    if (!copy) return [];
    return this._columns.filter((c) => c.id !== copy.sourceNode);
  }

  /** Writes the copied value to every other column sequentially. Public for tests. */
  async confirmCopy() {
    const copy = this._copy;
    if (!copy) return;
    const targets = this._copyTargets;
    this._copy = null;

    let applied = 0;
    let failed = 0;
    const touched = new Set<string>();
    for (const target of targets) {
      try {
        await getContext().config.setNodeConfigValue(target.id, copy.section, copy.key, copy.value);
        applied++;
        touched.add(target.id);
      } catch {
        failed++;
      }
    }

    for (const node of touched) {
      try {
        this._configs = { ...this._configs, [node]: await getContext().config.getNodeConfig(node) };
        this._columns = this._columns.map((c) => (c.id === node ? { ...c, error: false } : c));
      } catch {
        // Leave the stale config in place; the row simply won't reflect the write.
      }
    }
    this._rebuild();

    if (failed === 0) {
      toast(`Applied to ${applied} node${applied === 1 ? '' : 's'}.`, 'success');
    } else {
      toast(`Applied to ${applied}, ${failed} failed.`, 'error');
    }
  }

  // --- Render -------------------------------------------------------------

  private _renderEditDialog() {
    const edit = this._edit;
    return html`
      <wa-dialog
        data-edit-dialog
        label="Edit value"
        ?open=${edit !== null}
        @wa-after-hide=${(e: Event) => {
          if (e.target === e.currentTarget) this._edit = null;
        }}>
        <div class="fields">
          <div>
            <label>Section</label>
            <div class="ro" data-ro-section>${edit?.section}</div>
          </div>
          <div>
            <label>Option</label>
            <div class="ro" data-ro-key>${edit?.key}</div>
          </div>
          <div>
            <label>Value</label>
            <wa-input
              data-value-input
              .value=${edit?.value ?? ''}
              @input=${(e: Event) => this._updateEditValue((e.target as HTMLInputElement).value)}></wa-input>
          </div>
          ${this._editError ? html`<div class="error" data-edit-error>${this._editError}</div>` : ''}
        </div>
        <div slot="footer" class="footer">
          <wa-button data-edit-cancel @click=${() => (this._edit = null)}>Cancel</wa-button>
          <wa-button
            data-edit-save
            variant="brand"
            appearance="filled"
            @click=${() => void this.saveEdit()}
            >Save</wa-button
          >
        </div>
      </wa-dialog>
    `;
  }

  private _renderCopyDialog() {
    const copy = this._copy;
    const targetNames = this._copyTargets.map((c) => c.name).join(', ');
    return html`
      <wa-dialog
        data-copy-dialog
        label="Copy value to other nodes"
        ?open=${copy !== null}
        @wa-after-hide=${(e: Event) => {
          if (e.target === e.currentTarget) this._copy = null;
        }}>
        <div class="dialog-body">
          <p>
            Set <code>${copy?.section}/${copy?.key}</code> to
            <code>${copy?.value}</code> on:
          </p>
          <p class="targets" data-copy-targets>${targetNames}</p>
        </div>
        <div slot="footer" class="footer">
          <wa-button data-copy-cancel @click=${() => (this._copy = null)}>Cancel</wa-button>
          <wa-button
            data-copy-confirm
            variant="brand"
            appearance="filled"
            @click=${() => void this.confirmCopy()}
            >Apply</wa-button
          >
        </div>
      </wa-dialog>
    `;
  }

  private _renderPicker() {
    return html`
      <cca-config-compare-picker
        ?open=${this._showPicker}
        .preselectedNodes=${this._nodes}
        @compare-confirm=${(e: CustomEvent<{ nodes: string[] }>) =>
          this._onPickerConfirm(e.detail.nodes)}
        @compare-cancel=${() => (this._showPicker = false)}></cca-config-compare-picker>
    `;
  }

  render() {
    return html`
      ${this._loading
        ? html`<wa-spinner></wa-spinner>`
        : this._nodes.length < 2
          ? html`
              <div class="prompt" data-prompt>
                <p>Select 2–4 nodes to compare.</p>
                <wa-button variant="brand" appearance="filled" @click=${() => this._openPicker()}
                  >Select nodes</wa-button
                >
              </div>
            `
          : html`
              <p class="summary" data-summary>
                Differs: ${this._model.differingCount} / Total: ${this._model.totalCount}
              </p>
              <cca-config-compare-table
                .columns=${this._model.columns}
                .rows=${this._model.rows}
                .showOnlyDiffs=${this._showOnlyDiffs}
                @cell-edit=${(e: CustomEvent<CellEditDetail>) => this._openEdit(e.detail)}
                @cell-copy=${(e: CustomEvent<CopyState>) => (this._copy = e.detail)}></cca-config-compare-table>
            `}
      ${this._renderEditDialog()} ${this._renderCopyDialog()} ${this._renderPicker()}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'cca-config-compare': CcaConfigCompare;
  }
}
