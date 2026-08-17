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

export class CcaDashboardWelcome extends CcaElement {
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
    /* #796: reachability recolors the card so a fleet grid reads at a glance.
       Quiet fill/border tokens keep normal text readable and follow dark mode. */
    wa-card.reachable {
      background-color: var(--wa-color-success-fill-quiet);
      border-color: var(--wa-color-success-border-quiet);
    }
    wa-card.unreachable {
      background-color: var(--wa-color-danger-fill-quiet);
      border-color: var(--wa-color-danger-border-quiet);
    }
  `;

  @property({ attribute: 'server-id' }) serverId = '';
  @state() private _data: WelcomeData | null = null;
  @state() private _error = '';

  static override get eventSubscriptions() {
    return {
      [WELCOME_DATA]: function (this: CcaDashboardWelcome, _el: HTMLElement, ev: Event) {
        const detail = (ev as CustomEvent<WelcomeData>).detail;
        if (detail.serverId !== this.serverId) return;
        this._error = detail.error ?? '';
        this._data = detail.error ? null : detail;
      }
    };
  }

  // cca's router auto-applies event-detail keys onto matching component
  // properties (via onEventRouter → _applyData) BEFORE our handler runs.
  // Suppress it: otherwise an incoming payload's `serverId` overwrites this
  // tile's own `serverId` and the handler's serverId filter never fires.
  protected override _applyData(): void {}

  protected override updated(changed: PropertyValues): void {
    if (changed.has('serverId') && this.serverId) {
      this.publish(WELCOME_REQUEST, { serverId: this.serverId });
    }
  }

  override render() {
    return html`
      <wa-card appearance="filled-outlined" class=${this._tone()} style="block-size: 100%">
        <div class="wa-stack">
          <div class="wa-cluster wa-gap-xs">
            <h3 class="wa-heading-l" id="welcome-info">
              <wa-icon name="circle-info" class="wa-color-text-quiet"></wa-icon> Server
            </h3>
            <wa-tooltip for="welcome-info" without-arrow> CouchDB welcome details from GET / on the server. </wa-tooltip>
          </div>
          ${this._body()}
        </div>
      </wa-card>
    `;
  }

  /** Card tint from reachability: three-state, neutral until the record actually arrives. */
  private _tone(): string {
    if (this._data?.reachable === true) return 'reachable';
    if (this._data?.reachable === false) return 'unreachable';
    return '';
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
      ${d.liveError
        ? html`<wa-callout variant="warning" appearance="outlined" size="small">
            <wa-icon slot="icon" name="triangle-exclamation"></wa-icon>
            Could not read this server's live details: ${d.liveError}
          </wa-callout>`
        : ''}
      <dl class="fields">
        <dt>URL</dt>
        <dd>${d.url ? html`<a class="wa-text-truncate" href=${d.url} target="_blank" rel="noreferrer">${d.url}</a>` : '—'}</dd>

        <dt>Username</dt>
        <dd>${d.username ?? '—'}</dd>

        <dt>UUID</dt>
        <dd>${d.uuid ?? '—'}</dd>

        <dt>Status</dt>
        <dd>
          <wa-badge variant=${d.reachable ? 'success' : 'danger'}> ${d.reachable ? 'Reachable' : 'Unreachable'} </wa-badge>
        </dd>

        <dt>Last checked</dt>
        <dd>${d.lastChecked ? new Date(d.lastChecked).toLocaleString() : '—'}</dd>
      </dl>
    `;
  }
}

customElements.define('cca-dashboard-welcome', CcaDashboardWelcome);
