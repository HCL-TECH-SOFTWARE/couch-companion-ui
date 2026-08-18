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
import { getLogger } from "../../services/log-service.js";
import {
  addHeaderActions,
  clearHeaderActions,
} from "../../components/cca-header.js";
import type { IdpConfig } from "./types.js";
import type { TableColumn } from "../../components/cca-data-table.js";
import { requiredIdpOrigins } from "../../services/idp-origins.js";

const log = getLogger("plugins/idp/idp-list");
import "../../components/cca-data-table.js";
import "../../components/cca-csp-check.js";
import "@awesome.me/webawesome/dist/components/badge/badge.js";

@customElement("cca-idp-list")
export class CcaIdpList extends LitElement {
  static styles = css`
    :host {
      display: block;
    }
    .orphans {
      margin: 0 0 var(--wa-space-m);
      padding: var(--wa-space-s) var(--wa-space-m);
      border-radius: var(--wa-border-radius-m);
      background: var(--wa-color-warning-fill-quiet);
      color: var(--wa-color-warning-on-quiet);
      font-size: var(--wa-font-size-s);
    }
    .orphans code {
      font-family: var(--wa-font-family-code);
    }
  `;

  @state() private idps: IdpConfig[] = [];
  @state() private orphanKids: string[] = [];
  @state() private loading = true;

  async connectedCallback() {
    super.connectedCallback();
    clearHeaderActions();
    addHeaderActions([
      {
        icon: "file-lines",
        tooltip: "Logs",
        variant: "neutral",
        action: () => getContext().router.navigate("/idp/logs"),
      },
      {
        icon: "circle-plus",
        tooltip: "Add IdP",
        action: () => getContext().router.navigate("/idp/add"),
      },
    ]);
    await this.loadIdps();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    clearHeaderActions();
  }

  private async loadIdps() {
    this.loading = true;
    try {
      this.idps = await getContext().idp.listIdps();
      this.orphanKids = await getContext().idp.listOrphanKeys();
    } catch (err) {
      log.error("Failed to load identity providers", err as Error);
      toast("Failed to load identity providers.", "error");
    } finally {
      this.loading = false;
    }
  }

  private get _columns(): TableColumn<IdpConfig>[] {
    return [
      { label: "Name", key: "name" },
      { label: "Issuer", key: "issuer" },
      {
        label: "Signing Keys",
        render: (idp) => this.renderKeyCount(idp),
      },
      {
        label: "Last Refreshed",
        render: (idp) =>
          idp.last_refreshed
            ? new Date(idp.last_refreshed).toLocaleString()
            : "Never",
      },
    ];
  }

  /**
   * Keys configured under [oidc] versus keys CouchDB actually holds under [jwt_keys].
   *
   * The two counts are the same number in every healthy install; showing them as one badge
   * would hide the case the shared `rsa:<kid>` key format exists to expose (#32) — an entry
   * whose twin was removed by hand, which no amount of Apply will fix and Refresh Keys will.
   */
  private renderKeyCount(idp: IdpConfig) {
    const installed = idp.jwks_keys.filter((key) => key.installed !== false).length;
    const total = idp.jwks_keys.length;
    return installed === total
      ? html`<wa-badge variant="brand" pill>${total} keys</wa-badge>`
      : html`<wa-badge variant="warning" pill
          >${installed} of ${total} installed</wa-badge
        >`;
  }

  /**
   * Signing keys CouchDB still trusts that no provider claims. Deleting an identity provider
   * deliberately leaves its key in place so tokens already issued keep working; saying so here
   * is what keeps that from being a silent leak.
   */
  private renderOrphans() {
    if (this.orphanKids.length === 0) return "";
    return html`
      <p class="orphans" data-orphan-keys>
        ${this.orphanKids.length} signing key(s) in CouchDB's [jwt_keys] belong to no identity
        provider listed here — left behind when a provider was deleted or its keys rotated:
        <code>${this.orphanKids.map((kid) => `rsa:${kid}`).join(", ")}</code>. Tokens they
        signed still verify. Remove them under Configuration when that is no longer wanted.
      </p>
    `;
  }

  render() {
    return html`
      ${this.renderOrphans()}
      <!--
        On the drop-in, CouchDB's own /_utils policy is what decides whether the browser may talk
        to the identity provider at all, and it refuses cross-origin connections by default. The
        origins come from what is registered (#149); the component hides itself entirely in SPA
        mode, where the policy belongs to whoever serves the page instead.
      -->
      <cca-csp-check
        .origins=${requiredIdpOrigins(this.idps)}
        .subject=${"single sign-on"}
        .blockedSymptom=${"signing in fails — discovery, the signing keys or the token exchange never leave the browser, and nothing appears in the network tab"}
        .emptyMessage=${"No identity providers are registered yet, so there is nothing for the policy to allow."}
      ></cca-csp-check>
      <cca-data-table
        .columns=${this._columns as any[]}
        .rows=${this.idps}
        .loading=${this.loading}
        row-key="_id"
        empty-message='No identity providers configured. Click "Add IdP" to register one.'
        @cca-row-click=${(e: CustomEvent<IdpConfig>) =>
          getContext().router.navigate(
            `/idp/${encodeURIComponent(e.detail._id)}`,
          )}
      ></cca-data-table>
    `;
  }
}
