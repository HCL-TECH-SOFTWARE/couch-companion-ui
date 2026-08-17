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
  TASKS_REQUEST,
  TASKS_DATA,
  type TasksData,
} from "./events.js";

export class CcaDashboardTasks extends CcaElement {
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
  @state() private _data: TasksData | null = null;
  @state() private _error = "";

  static override get eventSubscriptions() {
    return {
      [TASKS_DATA]: function (
        this: CcaDashboardTasks,
        _el: HTMLElement,
        ev: Event,
      ) {
        const detail = (ev as CustomEvent<TasksData>).detail;
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
      this.publish(TASKS_REQUEST, { serverId: this.serverId });
    }
  }

  override render() {
    return html`
      <wa-card appearance="filled-outlined" style="block-size: 100%">
        <div class="wa-stack">
          <div class="wa-cluster wa-gap-xs">
            <h3 class="wa-heading-l" id="tasks-info">
              <wa-icon name="bars-progress" class="wa-color-text-quiet"></wa-icon>
              <a href="#/active-tasks/${encodeURIComponent(this.serverId)}">Active Tasks</a>
            </h3>
            <wa-tooltip for="tasks-info" without-arrow>
              Running CouchDB tasks grouped by type.
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
    const entries = Object.entries(this._data.byType ?? {});
    if (entries.length === 0) {
      return html`<p class="wa-color-text-quiet">No active tasks.</p>`;
    }
    return html`
      <div class="wa-stack wa-gap-xs">
        ${entries.map(
          ([type, count], i) => html`
            ${i > 0 ? html`<wa-divider></wa-divider>` : ""}
            <div class="wa-split">
              <span class="wa-caption-s">${type}</span>
              <wa-format-number value=${count}></wa-format-number>
            </div>
          `,
        )}
      </div>
    `;
  }
}

customElements.define("cca-dashboard-tasks", CcaDashboardTasks);
