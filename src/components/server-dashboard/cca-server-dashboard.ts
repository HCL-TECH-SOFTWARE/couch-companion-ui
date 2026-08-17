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
import { property, state } from 'lit/decorators.js';
import { CcaElement } from '../cca-element.js';
import { ALL_REQUEST_EVENTS, WELCOME_DATA, type WelcomeData } from './events.js';
import './cca-dashboard-welcome.js';
import './cca-dashboard-software.js';
import './cca-dashboard-storage.js';
import './cca-dashboard-replications.js';
import './cca-dashboard-tasks.js';
import './cca-dashboard-idp.js';
import { addHeaderActions, clearHeaderActions, setHeaderTitle, clearHeaderTitle } from '../cca-header.js';

export class CcaServerDashboard extends CcaElement {
  static styles = css`
    :host {
      display: block;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: var(--wa-space-l);
    }
  `;

  @property() serverId = '';
  @state() private _name = '';

  // Refresh lives in the shared cca-header (not the page body): register it
  // on connect and clear it on disconnect, mirroring how db-list drives the
  // header. Edit/Remove have no meaning with one server and no stored
  // credentials (spec D2/D3) and are gone; so is Back, now that this screen is
  // the home page and the server list it pointed at no longer exists.
  override connectedCallback() {
    super.connectedCallback();
    clearHeaderActions();
    addHeaderActions([
      { icon: 'rotate', tooltip: 'Refresh', action: () => this._refresh() }
    ]);
    setHeaderTitle(this._headerTitle());
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    clearHeaderActions();
    clearHeaderTitle();
  }

  /** Header title for this page — `Server <name>`, or plain "Server" before the name loads. */
  private _headerTitle(): string {
    return this._name ? `Server ${this._name}` : 'Server';
  }

  // `serverId` now appears in event payloads (e.g. WELCOME_DATA), so — like the
  // tiles — suppress cca's auto-apply (onEventRouter → _applyData), which would
  // otherwise overwrite this host's own `serverId` before our handler runs.
  protected override _applyData(): void {}
  static override get eventSubscriptions() {
    return {
      [WELCOME_DATA]: function (this: CcaServerDashboard, _el: HTMLElement, ev: Event) {
        const d = (ev as CustomEvent<WelcomeData>).detail;
        if (d.serverId === this.serverId && d.name) {
          this._name = d.name;
          setHeaderTitle(this._headerTitle());
        }
      }
    };
  }

  private _refresh() {
    for (const name of ALL_REQUEST_EVENTS) {
      this.publish(name, { serverId: this.serverId });
    }
  }

  override render() {
    return html`
      <div class="grid">
        <cca-dashboard-welcome server-id=${this.serverId}></cca-dashboard-welcome>
        <cca-dashboard-software server-id=${this.serverId}></cca-dashboard-software>
        <cca-dashboard-storage server-id=${this.serverId}></cca-dashboard-storage>
        <cca-dashboard-replications server-id=${this.serverId}></cca-dashboard-replications>
        <cca-dashboard-tasks server-id=${this.serverId}></cca-dashboard-tasks>
        <cca-dashboard-idp server-id=${this.serverId}></cca-dashboard-idp>
      </div>
    `;
  }
}

customElements.define('cca-server-dashboard', CcaServerDashboard);
