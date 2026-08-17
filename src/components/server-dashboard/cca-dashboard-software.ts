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

import { html, css, type PropertyValues } from 'lit';
import { property, state } from 'lit/decorators.js';
import { CcaElement } from '../cca-element.js';
import { WELCOME_REQUEST, WELCOME_DATA, type WelcomeData } from './events.js';

/**
 * Version, vendor, build and feature list — the CouchDB *software*, split out of the
 * Server tile (#41), which was carrying ten fields and a badge cluster and so towered
 * over the rest of the grid. What stayed behind describes the *instance and
 * connection*: URL, username, UUID, reachability. The server's stored display name
 * went with the split — the URL identifies it and the name only repeated it.
 *
 * Deliberately shares `WELCOME_REQUEST` / `WELCOME_DATA` with that tile rather than
 * introducing its own event pair: both render the same `GET /` document, and the
 * service coalesces in-flight welcome fetches per `serverId`, so a second subscriber
 * costs no extra request.
 */
export class CcaDashboardSoftware extends CcaElement {
  static styles = css`
    :host {
      display: block;
      block-size: 100%;
    }
    /* Labelled field list: muted term in the first column, value in the second. */
    .fields {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: var(--wa-space-2xs) var(--wa-space-m);
      margin: 0;
    }
    .fields dt {
      color: var(--wa-color-text-quiet);
      font-size: var(--wa-font-size-s);
    }
    .fields dd {
      margin: 0;
      min-width: 0;
      overflow-wrap: anywhere;
    }
  `;

  @property({ attribute: 'server-id' }) serverId = '';
  @state() private _data: WelcomeData | null = null;
  @state() private _error = '';

  static override get eventSubscriptions() {
    return {
      [WELCOME_DATA]: function (this: CcaDashboardSoftware, _el: HTMLElement, ev: Event) {
        const detail = (ev as CustomEvent<WelcomeData>).detail;
        if (detail.serverId !== this.serverId) return;
        this._error = detail.error ?? '';
        this._data = detail.error ? null : detail;
      }
    };
  }

  // cca's router auto-applies event-detail keys onto matching component properties
  // (via onEventRouter → _applyData) BEFORE our handler runs. Suppress it: otherwise
  // an incoming payload's `serverId` overwrites this tile's own and the handler's
  // serverId filter never fires.
  protected override _applyData(): void {}

  protected override updated(changed: PropertyValues): void {
    if (changed.has('serverId') && this.serverId) {
      this.publish(WELCOME_REQUEST, { serverId: this.serverId });
    }
  }

  override render() {
    return html`
      <wa-card appearance="filled-outlined" style="block-size: 100%">
        <div class="wa-stack">
          <div class="wa-cluster wa-gap-xs">
            <h3 class="wa-heading-l" id="software-info">
              <wa-icon name="cube" class="wa-color-text-quiet"></wa-icon> Software
            </h3>
            <wa-tooltip for="software-info" without-arrow>
              Version, vendor, build and advertised features, from GET / on the server.
            </wa-tooltip>
          </div>
          ${this._body()}
        </div>
      </wa-card>
    `;
  }

  private _body() {
    if (this._error) {
      return html`<p class="wa-color-text-quiet">Error: ${this._error}</p>`;
    }
    if (!this._data) {
      return html`<wa-spinner></wa-spinner>`;
    }
    const d = this._data;
    return html`
      <dl class="fields">
        <dt>Version</dt>
        <dd>${d.version ? `CouchDB ${d.version}` : '—'}</dd>

        <dt>Vendor</dt>
        <dd>${d.vendor ?? '—'}</dd>

        <dt>Build</dt>
        <dd>${d.gitSha ?? '—'}</dd>

        <dt>Features</dt>
        <dd>${this._features(d.features)}</dd>
      </dl>
    `;
  }

  /**
   * Three distinct states, and they must not collapse into one another: we never asked / could not
   * reach the server (`undefined` → em dash), the server answered and reports no features (`[]` →
   * "none"), and the server listed some.
   */
  private _features(features?: string[]) {
    if (!features) {
      return '—';
    }
    if (features.length === 0) {
      return 'none';
    }
    return html`<div class="wa-cluster wa-gap-2xs">
      ${features.map((f) => html`<wa-badge variant="neutral">${f}</wa-badge>`)}
    </div>`;
  }
}

customElements.define('cca-dashboard-software', CcaDashboardSoftware);
