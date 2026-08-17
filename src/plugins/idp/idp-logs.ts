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

import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import { getContext } from "../../context.js";
import { toast } from "../../components/cca-toast.js";
import {
  addHeaderActions,
  clearHeaderActions,
} from "../../components/cca-header.js";
import type { IdpLogEntry } from "./types.js";
import type { TableColumn } from "../../components/cca-data-table.js";
import "../../components/cca-data-table.js";
import "@awesome.me/webawesome/dist/components/divider/divider.js";

@customElement("cca-idp-logs")
export class CcaIdpLogs extends LitElement {
  static styles = css`
    :host {
      display: block;
      color: var(--wa-color-text-normal);
    }
    .page-header {
      display: flex;
      align-items: center;
      gap: var(--wa-space-m);
      margin-bottom: var(--wa-space-m);
    }
    h2 {
      margin: 0;
      font-size: var(--wa-font-size-l);
      flex: 1;
    }
  `;

  @state() private logs: IdpLogEntry[] = [];
  @state() private loading = true;

  async connectedCallback() {
    super.connectedCallback();
    this.updateHeaderActions();
    await this.load();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    clearHeaderActions();
  }

  private updateHeaderActions() {
    clearHeaderActions();
    addHeaderActions([
      {
        icon: "arrow-left",
        tooltip: "Back",
        label: "Back",
        variant: "neutral",
        action: () => getContext().router.back("/idp"),
      },
      {
        icon: "arrows-rotate",
        tooltip: "Refresh",
        label: "Refresh",
        variant: "brand",
        action: () => this.load(),
      },
    ]);
  }

  private async load() {
    this.loading = true;
    try {
      this.logs = await getContext().idp.getLogs();
    } catch {
      toast("Failed to load activity logs.", "error");
    } finally {
      this.loading = false;
    }
  }

  /**
   * Themed status pill — mirrors the quiet-fill / on-quiet-text WA pattern.
   *
   * The token names are spelled out per branch rather than assembled from a `palette`
   * variable. A name built by interpolation cannot be resolved against the theme, so a typo
   * in it renders as a silent no-op — see cca/no-undefined-wa-token and #718.
   */
  private renderLevel(level: string) {
    const [fill, text] =
      level === "error"
        ? ["var(--wa-color-danger-fill-quiet)", "var(--wa-color-danger-on-quiet)"]
        : level === "warn"
          ? ["var(--wa-color-warning-fill-quiet)", "var(--wa-color-warning-on-quiet)"]
          : ["var(--wa-color-brand-fill-quiet)", "var(--wa-color-brand-on-quiet)"];
    const style = `
      display: inline-block;
      font-size: var(--wa-font-size-2xs);
      font-weight: var(--wa-font-weight-semibold);
      padding: var(--wa-space-3xs) var(--wa-space-xs);
      border-radius: var(--wa-border-radius-pill);
      background: ${fill};
      color: ${text};
    `;
    return html`<span style=${style}>${level}</span>`;
  }

  private get _columns(): TableColumn<IdpLogEntry>[] {
    return [
      {
        label: "Time",
        render: (log) => new Date(log.timestamp).toLocaleString(),
      },
      { label: "Level", render: (log) => this.renderLevel(log.level) },
      {
        label: "Event",
        render: (log) =>
          html`<span style="font-family: var(--wa-font-family-code)"
            >${log.event}</span
          >`,
      },
      { label: "Identity Provider", key: "idp_name" },
      { label: "Message", key: "message" },
    ];
  }

  render() {
    return html`
      <div class="page-header">
        <h2>IdP Activity Logs</h2>
      </div>
      <wa-divider></wa-divider>
      <cca-data-table
        .columns=${this._columns as unknown as TableColumn[]}
        .rows=${this.logs}
        .loading=${this.loading}
        empty-message="No activity logged yet."
      ></cca-data-table>
    `;
  }
}
