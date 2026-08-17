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
import '@awesome.me/webawesome/dist/components/checkbox/checkbox.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/spinner/spinner.js';
import { getContext } from '../../context.js';
import { toast } from '../../components/cca-toast.js';
import type { ClusterNode } from '../../services/membership-service.js';

const MIN_NODES = 2;
const MAX_NODES = 4;

/**
 * Node-picker dialog for the "Compare configuration" feature (#73). Loads the
 * cluster's nodes itself from `GET /_membership` (cached after first load) and
 * lets the user check 2-4 of them. Reusable: launched from the config header,
 * or from the compare screen itself to change the selection.
 *
 * A stock CouchDB is a single node, so finding fewer than two is the normal
 * case and not an error — there is simply nothing to compare against, which is
 * what the `data-too-few` message says. It is also why the picker never offers
 * a way to "add" a node: membership is a property of the cluster, not of this
 * UI. A genuine failure is `_membership` being admin-only (401 for non-admins);
 * that rejects, and is surfaced as a toast rather than as an empty cluster.
 *
 * Emits:
 * - `compare-confirm` `{ nodes: string[] }` — checked node names, in list order.
 * - `compare-cancel` — no detail.
 */
@customElement('cca-config-compare-picker')
export class CcaConfigComparePicker extends LitElement {
  static styles = css`
    .hint {
      color: var(--wa-color-text-quiet);
      font-size: var(--wa-font-size-s, 0.875rem);
      margin-block-end: var(--wa-space-m, 0.75rem);
    }
    .list {
      display: flex;
      flex-direction: column;
      gap: var(--wa-space-s, 0.5rem);
    }
    .count {
      color: var(--wa-color-text-quiet);
      font-size: var(--wa-font-size-s, 0.875rem);
      margin-block-start: var(--wa-space-m, 0.75rem);
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
  @property({ attribute: false }) preselectedNodes: string[] = [];

  @state() private _nodes: ClusterNode[] = [];
  @state() private _loading = false;
  @state() private _checked = new Set<string>();

  private _loaded = false;

  override updated(changed: Map<string, unknown>) {
    if (changed.has('open') && this.open) {
      if (this._loaded) {
        this._applyPreselected();
      } else {
        void this._load();
      }
    }
  }

  /** Loads the cluster's node list once; cached for subsequent opens. */
  private async _load() {
    this._loading = true;
    try {
      this._nodes = await getContext().membership.listNodes();
      this._loaded = true;
      this._applyPreselected();
    } catch (err: unknown) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      this._loading = false;
    }
  }

  private _applyPreselected() {
    const known = new Set(this._nodes.map((n) => n.name));
    this._checked = new Set(this.preselectedNodes.filter((name) => known.has(name)));
  }

  private _toggle(name: string, isChecked: boolean) {
    const next = new Set(this._checked);
    if (isChecked) next.add(name);
    else next.delete(name);
    this._checked = next;
  }

  private get _confirmEnabled(): boolean {
    return this._checked.size >= MIN_NODES && this._checked.size <= MAX_NODES;
  }

  private _confirm() {
    if (!this._confirmEnabled) return;
    const nodes = this._nodes.filter((n) => this._checked.has(n.name)).map((n) => n.name);
    this.dispatchEvent(
      new CustomEvent('compare-confirm', {
        detail: { nodes },
        bubbles: true,
        composed: true
      })
    );
    this.open = false;
  }

  private _cancel() {
    this.dispatchEvent(new CustomEvent('compare-cancel', { bubbles: true, composed: true }));
    this.open = false;
  }

  private _renderBody() {
    if (this._loading) return html`<wa-spinner></wa-spinner>`;

    if (this._nodes.length < MIN_NODES) {
      return html`<p class="hint" data-too-few>
        Need at least 2 nodes to compare. This CouchDB is a single node.
      </p>`;
    }

    return html`
      <div class="list">
        ${this._nodes.map((n) => {
          const isChecked = this._checked.has(n.name);
          const disableUnchecked = !isChecked && this._checked.size >= MAX_NODES;
          return html`
            <wa-checkbox
              data-node=${n.name}
              .checked=${isChecked}
              ?disabled=${disableUnchecked}
              @change=${(e: Event) => this._toggle(n.name, (e.target as HTMLInputElement).checked)}
              >${n.name}</wa-checkbox
            >
          `;
        })}
      </div>
      <p class="count" data-count>${this._checked.size} of ${MAX_NODES} selected</p>
    `;
  }

  render() {
    return html`
      <wa-dialog
        label="Compare configuration across nodes"
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
            ?disabled=${!this._confirmEnabled}
            @click=${() => this._confirm()}
            >Compare</wa-button
          >
        </div>
      </wa-dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'cca-config-compare-picker': CcaConfigComparePicker;
  }
}
