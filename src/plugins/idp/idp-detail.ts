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
import { customElement, property, state } from "lit/decorators.js";
import { getContext } from "../../context.js";
import { toast } from "../../components/cca-toast.js";
import { ApiError } from "../../services/api-error.js";
import { getLogger } from "../../services/log-service.js";
import {
  addHeaderActions,
  clearHeaderActions,
  type HeaderAction,
} from "../../components/cca-header.js";
import { oidcKey } from "../../services/oidc-ini.js";
import type { IdpConfig, JwkKey } from "./types.js";
import type { UpdateIdpRequest } from "../../services/idp-service.js";
import "@awesome.me/webawesome/dist/components/divider/divider.js";
import "@awesome.me/webawesome/dist/components/input/input.js";
import "@awesome.me/webawesome/dist/components/switch/switch.js";

const log = getLogger("plugins/idp/idp-detail");

@customElement("cca-idp-detail")
export class CcaIdpDetail extends LitElement {
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
    .grid {
      display: grid;
      grid-template-columns: 160px 1fr;
      gap: var(--wa-space-s) var(--wa-space-m);
      font-size: var(--wa-font-size-s);
      align-items: center;
    }
    .label {
      font-weight: var(--wa-font-weight-semibold);
      color: var(--wa-color-text-quiet);
    }
    wa-input {
      width: 100%;
    }
    h3 {
      font-size: var(--wa-font-size-m);
      margin: var(--wa-space-l) 0 var(--wa-space-s);
    }
    .key-list {
      display: flex;
      flex-direction: column;
      gap: var(--wa-space-xs);
    }
    .key {
      padding: var(--wa-space-xs) var(--wa-space-s);
      background: var(--wa-color-surface-raised);
      border-radius: var(--wa-border-radius-m);
      font-size: var(--wa-font-size-xs);
      font-family: var(--wa-font-family-code);
      display: flex;
      gap: var(--wa-space-xs);
      align-items: baseline;
    }
    .key-id {
      font-weight: var(--wa-font-weight-bold);
    }
    .key-meta {
      color: var(--wa-color-text-quiet);
    }
    .key-missing {
      margin-inline-start: auto;
      padding: var(--wa-space-3xs) var(--wa-space-xs);
      border-radius: var(--wa-border-radius-pill);
      background: var(--wa-color-warning-fill-quiet);
      color: var(--wa-color-warning-on-quiet);
      font-family: var(--wa-font-family-body);
      font-weight: var(--wa-font-weight-semibold);
    }
    .empty-keys,
    .keys-hint {
      color: var(--wa-color-text-quiet);
      font-size: var(--wa-font-size-s);
    }
  `;

  @property({ type: String }) id = "";
  @property({ type: Boolean, attribute: "hide-back" }) hideBack = false;
  @state() private idp: IdpConfig | null = null;
  @state() private loading = true;
  @state() private applying = false;
  @state() private refreshing = false;
  @state() private restarting = false;
  @state() private deleting = false;
  @state() private editing = false;
  @state() private saving = false;
  @state() private draftClientId = "";
  @state() private draftRolesClaim = "";
  @state() private draftIdpOnly = false;

  async connectedCallback() {
    super.connectedCallback();
    if (this.id) {
      await this.load();
    }
    this.updateHeaderActions();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    clearHeaderActions();
  }

  private async load() {
    this.loading = true;
    try {
      this.idp = await getContext().idp.getIdp(this.id);
    } catch (err) {
      log.error("Failed to load IdP", err as Error);
      toast("Failed to load identity provider.", "error");
    } finally {
      this.loading = false;
    }
  }

  /** Rebuilds the header icon actions for the current mode (view vs edit). */
  private updateHeaderActions() {
    clearHeaderActions();
    const actions: HeaderAction[] = [];
    if (!this.hideBack) {
      actions.push({
        icon: "arrow-left",
        tooltip: "Back",
        label: "Back",
        variant: "neutral",
        action: () => getContext().router.back("/idp"),
      });
    }
    if (!this.idp) {
      addHeaderActions(actions);
      return;
    }
    if (this.editing) {
      actions.push({
        icon: "check",
        tooltip: "Save",
        label: "Save",
        variant: "success",
        action: () => this.saveEdit(),
      });
      actions.push({
        icon: "xmark",
        tooltip: "Cancel",
        label: "Cancel",
        variant: "neutral",
        action: () => this.cancelEdit(),
      });
    } else {
      actions.push({
        icon: "pen-to-square",
        tooltip: "Edit",
        label: "Edit",
        variant: "brand",
        action: () => this.startEdit(),
      });
      actions.push({
        icon: "arrows-rotate",
        tooltip: "Refresh Keys",
        label: "Refresh Keys",
        variant: "brand",
        action: () => this.handleRefresh(),
      });
      actions.push({
        icon: "cloud-arrow-up",
        tooltip: "Apply to Servers",
        label: "Apply to Servers",
        variant: "brand",
        action: () => this.handleApply(),
      });
      actions.push({
        icon: "power-off",
        tooltip: "Restart Server(s)",
        label: "Restart Server(s)",
        variant: "brand",
        action: () => this.handleRestart(),
      });
      actions.push({
        icon: "trash-can",
        tooltip: "Delete IdP",
        label: "Delete IdP",
        variant: "danger",
        action: () => this.handleDelete(),
      });
    }
    addHeaderActions(actions);
  }

  private startEdit() {
    if (!this.idp) return;
    this.draftClientId = this.idp.client_id ?? "";
    this.draftRolesClaim = this.idp.roles_claim ?? "";
    this.draftIdpOnly = this.idp.idp_only;
    this.editing = true;
    this.updateHeaderActions();
  }

  private cancelEdit() {
    this.editing = false;
    this.updateHeaderActions();
  }

  private async saveEdit() {
    if (this.saving || !this.idp) return;
    this.saving = true;
    try {
      const req: UpdateIdpRequest = {
        client_id: this.draftClientId.trim() ? this.draftClientId.trim() : null,
        roles_claim: this.draftRolesClaim.trim()
          ? this.draftRolesClaim.trim()
          : null,
        idp_only: this.draftIdpOnly,
      };
      await getContext().idp.updateIdp(this.id, req);
      toast("Identity provider updated.", "success");
      this.editing = false;
      await this.load();
    } catch (err) {
      log.error("Failed to update IdP", err as Error);
      toast(
        err instanceof ApiError
          ? err.message
          : "Failed to update identity provider",
        "error",
      );
    } finally {
      this.saving = false;
      this.updateHeaderActions();
    }
  }

  private async handleRefresh() {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      await getContext().idp.refreshIdp(this.id);
      toast("OIDC discovery and JWKS refreshed", "success");
      await this.load();
    } catch (err) {
      log.error("Failed to refresh IdP", err as Error);
      toast(
        err instanceof ApiError
          ? err.message
          : "Failed to refresh identity provider",
        "error",
      );
    } finally {
      this.refreshing = false;
    }
  }

  private async handleApply() {
    if (this.applying) return;
    this.applying = true;
    try {
      const result = await getContext().idp.applyIdp(this.id);
      const applied = result.applied_to?.length ?? 0;
      const removed = result.removed_from?.length ?? 0;
      const errs = result.errors?.length ?? 0;
      const removedNote = removed > 0 ? `, removed from ${removed}` : "";
      if (errs > 0) {
        toast(
          `Applied to ${applied} server(s)${removedNote}, ${errs} error(s)`,
          "error",
        );
      } else {
        toast(
          `JWT configuration applied to ${applied} server(s)${removedNote}`,
          "success",
        );
      }
    } catch (err) {
      log.error("Failed to apply IdP config", err as Error);
      toast(
        err instanceof ApiError ? err.message : "Failed to apply configuration",
        "error",
      );
    } finally {
      this.applying = false;
    }
  }

  private async handleRestart() {
    if (this.restarting) return;
    this.restarting = true;
    try {
      const result = await getContext().idp.restartNode(this.id);
      const applied = result.target_servers?.length ?? 0;
      const errs = result.errors?.length ?? 0;
      if (errs > 0) {
        toast(`${errs} error(s)`, "error");
      } else {
        toast(`Restarted ${applied} server(s)`, "success");
      }
    } catch (err) {
      log.error("Failed to restart target server", err as Error);
      toast(
        err instanceof ApiError
          ? err.message
          : "Failed to Restart Target Server",
        "error",
      );
    } finally {
      this.restarting = false;
    }
  }

  private async handleDelete() {
    if (this.deleting) return;
    this.deleting = true;
    try {
      await getContext().idp.deleteIdp(this.id);
      toast(`IdP deleted`, "success");
      getContext().router.navigate("/idp");
    } catch (err) {
      log.error("Failed to delete IdP", err as Error);
      toast(
        err instanceof ApiError ? err.message : "Failed to delete IdP",
        "error",
      );
    } finally {
      this.deleting = false;
    }
  }

  render() {
    // D9: Apply and Restart write `_node/_local/_config`, which CouchDB refuses to a
    // non-admin. Say so rather than rendering buttons that can only fail.
    if (!getContext().auth.isAdmin) {
      return html`<p>
        Only a server administrator can manage identity providers — they write CouchDB's JWT
        configuration.
      </p>`;
    }
    if (this.loading) {
      return html`<p>Loading identity provider...</p>`;
    }
    if (!this.idp) {
      return html`<p>Identity provider not found.</p>`;
    }

    const idp = this.idp;

    return html`
      <div class="page-header">
        <h2>${idp.name}</h2>
      </div>
      <wa-divider></wa-divider>

      <div class="grid">
        <span class="label">Issuer</span>
        <span>${idp.issuer}</span>

        <span class="label">Discovery URL</span>
        <span>${idp.well_known_url}</span>

        <span class="label">Client ID</span>
        ${this.editing
          ? html`<wa-input
              .value=${this.draftClientId}
              placeholder="Client ID"
              @input=${(e: Event) => {
                this.draftClientId = (e.target as HTMLInputElement).value;
              }}
            ></wa-input>`
          : html`<span>${idp.client_id ?? "—"}</span>`}

        <span class="label">Roles Claim</span>
        ${this.editing
          ? html`<wa-input
              .value=${this.draftRolesClaim}
              placeholder="realm_access.roles"
              @input=${(e: Event) => {
                this.draftRolesClaim = (e.target as HTMLInputElement).value;
              }}
            ></wa-input>`
          : html`<span>${idp.roles_claim}</span>`}

        <span class="label">Provider-only sign-in</span>
        ${this.editing
          ? html`<wa-switch
              data-idp-only
              ?checked=${this.draftIdpOnly}
              @change=${(e: Event) => {
                this.draftIdpOnly = (e.target as HTMLInputElement).checked;
              }}
              hint="Hides the username/password form. ?password on the login URL brings it back."
            >
              Sign in with this provider only
            </wa-switch>`
          : html`<span data-idp-only>${idp.idp_only ? "Yes" : "No"}</span>`}

        <span class="label">Last Refreshed</span>
        <span>
          ${idp.last_refreshed
            ? new Date(idp.last_refreshed).toLocaleString()
            : "Never"}
        </span>
      </div>

      <h3>Signing keys (${idp.jwks_keys.length})</h3>
      ${idp.jwks_keys.length === 0
        ? html`<p class="empty-keys">
            No keys loaded yet. Refresh to fetch from JWKS URI.
          </p>`
        : html`
            <p class="keys-hint">
              One config key per signing key, in both sections: this provider's metadata under
              [oidc], its public key under [jwt_keys].
            </p>
            <div class="key-list" data-key-list>
              ${idp.jwks_keys.map((k) => this.renderKey(k))}
            </div>
          `}
    `;
  }

  /**
   * One signing key, named the way CouchDB's config names it.
   *
   * The "not installed" state is the read-back the shared `rsa:<kid>` key format buys (#32):
   * before it, this screen rendered a copy of the keys stored beside the provider and could
   * never say whether CouchDB actually held them. It appears when someone removes a
   * [jwt_keys] entry by hand, and Refresh Keys is what puts it back.
   */
  private renderKey(key: JwkKey) {
    return html`
      <div class="key">
        <span class="key-id">${oidcKey(key.kid)}</span>
        <span class="key-meta">— ${key.kty} / ${key.alg}</span>
        ${key.installed === false
          ? html`<span class="key-missing" data-key-missing
              >not in [jwt_keys]</span
            >`
          : ""}
      </div>
    `;
  }
}
