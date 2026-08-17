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

import { html, css, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { CcaElement } from "../cca-element.js";
import {
  REPLICATIONS_REQUEST,
  REPLICATIONS_DATA,
  type ReplicationsData,
} from "./events.js";

export class CcaDashboardReplications extends CcaElement {
  static styles = css`
    :host {
      display: block;
      block-size: 100%;
    }
    h3 a {
      color: inherit;
      text-decoration: none;
    }
    h3 a:hover {
      text-decoration: underline;
    }
  `;

  @property({ attribute: "server-id" }) serverId = "";
  @state() private _data: ReplicationsData | null = null;
  @state() private _error = "";

  static override get eventSubscriptions() {
    return {
      [REPLICATIONS_DATA]: function (
        this: CcaDashboardReplications,
        _el: HTMLElement,
        ev: Event,
      ) {
        const detail = (ev as CustomEvent<ReplicationsData>).detail;
        if (detail.serverId !== this.serverId) return;
        this._error = detail.error ?? "";
        this._data = detail.error ? null : detail;
      },
    };
  }

  // cca's router auto-applies event-detail keys onto matching component
  // properties (via onEventRouter → _applyData) BEFORE our handler runs.
  // Suppress it: otherwise an incoming payload's `serverId` overwrites this
  // tile's own `serverId` and the handler's serverId filter never fires.
  protected override _applyData(): void {}

  protected override updated(changed: PropertyValues): void {
    if (changed.has("serverId") && this.serverId) {
      this.publish(REPLICATIONS_REQUEST, { serverId: this.serverId });
    }
  }

  override render() {
    return html`
      <wa-card appearance="filled-outlined" style="block-size: 100%">
        <div class="wa-stack">
          <div class="wa-cluster wa-gap-xs">
            <h3 class="wa-heading-l" id="repl-info">
              <wa-icon name="right-left" class="wa-color-text-quiet"></wa-icon>
              <a href="#/replications/${encodeURIComponent(this.serverId)}">Replications</a>
            </h3>
            <wa-tooltip for="repl-info" without-arrow>
              Replications configured on this server.
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
      <div class="wa-stack wa-gap-xs">
        <div class="wa-split">
          <span class="wa-caption-s">Continuous</span>
          <wa-format-number value=${d.continuousCount ?? 0}></wa-format-number>
        </div>
        <wa-divider></wa-divider>
        <div class="wa-split">
          <span class="wa-caption-s">Total</span>
          <wa-format-number value=${d.totalCount ?? 0}></wa-format-number>
        </div>
      </div>
    `;
  }
}

customElements.define("cca-dashboard-replications", CcaDashboardReplications);
