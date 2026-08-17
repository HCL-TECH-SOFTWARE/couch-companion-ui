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
import { ApiError } from "../../services/api-error.js";
import { IdpConflictError } from "../../services/idp-service.js";
import { OidcHttpError } from "../../services/oidc-http.js";
import { getLogger } from "../../services/log-service.js";
import type { IdpConfig } from "./types.js";
import "@awesome.me/webawesome/dist/components/button/button.js";
import "@awesome.me/webawesome/dist/components/card/card.js";
import "@awesome.me/webawesome/dist/components/dialog/dialog.js";
import "@awesome.me/webawesome/dist/components/divider/divider.js";
import "@awesome.me/webawesome/dist/components/input/input.js";
import "@awesome.me/webawesome/dist/components/switch/switch.js";

const log = getLogger("plugins/idp/idp-add");

const WELL_KNOWN_SUFFIX = "/.well-known/openid-configuration";
const WELL_KNOWN_DIR_SUFFIX = "/.well-known";

/**
 * Completes a `.well-known` URL an operator typed only part of — the discovery *document*
 * (`.../.well-known/openid-configuration`), not just the directory or the bare issuer (#102).
 * Trailing whitespace/slashes are trimmed first so completion never produces a `//`.
 *
 * - Already ends with the full document path → returned as-is.
 * - Ends with `.well-known` (with or without a trailing slash) → `openid-configuration` is
 *   appended.
 * - Anything else (a bare issuer, or any other path) → the whole
 *   `/.well-known/openid-configuration` suffix is appended.
 */
export function normalizeWellKnownUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return trimmed;
  const base = trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;

  if (base.endsWith(WELL_KNOWN_SUFFIX)) return base;
  if (base.endsWith(WELL_KNOWN_DIR_SUFFIX)) return `${base}/openid-configuration`;
  return `${base}${WELL_KNOWN_SUFFIX}`;
}

@customElement("cca-idp-add")
export class CcaIdpAdd extends LitElement {
  static styles = css`
    :host {
      display: block;
      max-width: 520px;
    }
    h2 {
      margin: 0 0 1.5rem;
      font-size: var(--wa-font-size-l);
    }
    .field {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
      margin-bottom: 1rem;
    }
    label {
      font-size: var(--wa-font-size-s);
      font-weight: var(--wa-font-weight-semibold);
      color: var(--wa-color-text-quiet);
    }
    wa-input {
      width: 100%;
    }
    .hint {
      font-size: var(--wa-font-size-xs);
      color: var(--wa-color-text-quiet);
    }
    .error {
      font-size: var(--wa-font-size-s);
      color: var(--wa-color-danger-on-quiet);
      margin-bottom: 0.5rem;
    }
    .actions {
      display: flex;
      gap: 0.75rem;
      margin-top: 0.5rem;
    }
    .jwks-paste {
      border: 1px solid var(--wa-color-warning-border-normal);
      border-radius: var(--wa-border-radius-m);
      padding: 1rem;
      margin-bottom: 1rem;
    }
    .jwks-paste textarea {
      width: 100%;
      min-height: 8rem;
      font-family: var(--wa-font-family-code);
      font-size: var(--wa-font-size-s);
    }
    .denied {
      color: var(--wa-color-text-quiet);
    }
    .dialog-body {
      color: var(--wa-color-text-normal);
    }
    .footer {
      display: flex;
      gap: var(--wa-space-s);
      justify-content: flex-end;
    }
  `;

  @state() private error = "";
  @state() private submitting = false;

  /**
   * The JWKS URL that could not be fetched, or empty. Set only for a `cors-blocked` failure
   * (D15): an IdP whose JWKS endpoint sends no CORS header cannot be read from a browser at
   * all, so pasting is the only way forward. A 404 gets the ordinary error — offering the
   * paste box there would paper over a mistyped URL.
   */
  @state() private jwksBlockedUrl = "";
  @state() private jwksPasteError = "";

  /**
   * Pending restart confirmation, or null when no dialog is showing. Applying is not worth
   * asking permission for — it is just a config write — but a restart briefly drops every
   * connection to the server, which is disruptive enough that it should not happen without
   * the operator explicitly asking for it.
   */
  @state() private restartConfirm: { message: string; run: () => Promise<void> } | null = null;

  /** The submitted form values, kept so the paste retry does not make the operator retype. */
  private pendingRequest: {
    name: string;
    well_known_url: string;
    client_id: string | null;
    roles_claim: string | null;
    idp_only: boolean;
  } | null = null;

  private async handleSubmit(e: Event) {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const data = new FormData(form);

    this.pendingRequest = {
      name: data.get("name") as string,
      well_known_url: normalizeWellKnownUrl(data.get("well_known_url") as string),
      client_id: (data.get("client_id") as string) || null,
      roles_claim: (data.get("roles_claim") as string) || null,
      // Read off the element rather than out of the FormData: wa-switch reports itself through
      // ElementInternals, which `new FormData(form)` does not collect everywhere this runs.
      idp_only:
        this.shadowRoot?.querySelector<HTMLInputElement>("[data-idp-only]")?.checked ?? false,
    };
    await this.register();
  }

  /**
   * Registers the pending request, optionally with a pasted JWKS. Shared by the initial
   * submit and the paste retry so both paths report failures identically.
   *
   * Apply runs immediately afterward, unprompted: this app only ever configures the one
   * CouchDB it is running against (D2/D3), so there is no "which server" decision Apply used
   * to exist to defer. A restart is different — it briefly drops every connection to the
   * server — so that still asks first, via {@link askRestart}.
   */
  private async register(jwks?: unknown) {
    if (!this.pendingRequest) return;
    this.error = "";
    this.submitting = true;

    let created: IdpConfig;
    try {
      created = await getContext().idp.createIdp({ ...this.pendingRequest, jwks });
    } catch (err) {
      log.error("Failed to register IdP", err as Error);
      if (err instanceof OidcHttpError && err.kind === "cors-blocked") {
        this.jwksBlockedUrl = err.url;
        this.error = "";
      } else {
        this.jwksBlockedUrl = "";
        this.error = this.messageFor(err);
      }
      this.submitting = false;
      return;
    }

    toast("Identity provider registered — OIDC discovery and JWKS fetched", "success");

    try {
      const result = await getContext().idp.applyIdp(created._id);
      if (result.errors.length > 0) {
        toast(`Applied with ${result.errors.length} error(s): ${result.errors.join("; ")}`, "error");
        getContext().router.navigate("/idp");
      } else {
        this.askRestart(created);
      }
    } catch (err) {
      log.error("Failed to apply IdP config", err as Error);
      toast(
        err instanceof ApiError ? err.message : "Failed to apply JWT configuration",
        "error",
      );
      getContext().router.navigate("/idp");
    } finally {
      this.submitting = false;
    }
  }

  /**
   * `[chttpd] authentication_handlers` only takes effect on the running process after a
   * restart (`idp-service.ts`'s `applyIdp` never rewires it live) — until then CouchDB keeps
   * answering `/_session` with an anonymous `userCtx` for any token this provider issues, no
   * matter how correctly the client sends it (#115).
   */
  private askRestart(created: IdpConfig) {
    this.restartConfirm = {
      message: `${created.name} is applied. CouchDB must restart before it will accept sign-ins through it — connections will briefly drop. Restart now?`,
      run: async () => {
        await getContext().idp.restartNode(created._id);
        toast("Restart requested.", "success");
      },
    };
  }

  private async runRestartConfirm() {
    const c = this.restartConfirm;
    this.restartConfirm = null;
    if (c) {
      try {
        await c.run();
      } catch (err) {
        log.error("Failed to restart CouchDB", err as Error);
        toast(err instanceof ApiError ? err.message : "Failed to restart CouchDB", "error");
      }
    }
    getContext().router.navigate("/idp");
  }

  private declineRestart() {
    if (!this.restartConfirm) return;
    this.restartConfirm = null;
    toast(
      "Remember to restart CouchDB from the identity provider's page — it won't accept sign-ins through it until then.",
      "info",
    );
    getContext().router.navigate("/idp");
  }

  /**
   * The failures worth repeating verbatim.
   *
   * {@link IdpConflictError} joins the list because an identity provider is now identified by
   * its issuer (#32): a second registration of an already-configured issuer would overwrite the
   * first one's `[oidc]` entries rather than sit beside it, so it is refused — and "Failed to
   * register identity provider" would leave the operator with no idea why, or which provider
   * is in the way.
   */
  private messageFor(err: unknown): string {
    if (err instanceof IdpConflictError) return err.message;
    if (err instanceof ApiError || err instanceof OidcHttpError) return err.message;
    return "Failed to register identity provider";
  }

  /**
   * Validates the pasted JWKS here, before it reaches the service. The operator is pasting
   * because the network already failed them once; a parse error deserves an immediate,
   * specific answer rather than another round trip.
   */
  private handleJwksRetry() {
    this.jwksPasteError = "";
    const area = this.shadowRoot?.querySelector<HTMLTextAreaElement>(
      "[data-jwks-paste] textarea",
    );
    const text = area?.value.trim() ?? "";

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.jwksPasteError = "That is not valid JSON.";
      return;
    }

    if (!Array.isArray((parsed as { keys?: unknown })?.keys)) {
      this.jwksPasteError = 'A JWKS must be an object with a "keys" array.';
      return;
    }

    void this.register(parsed);
  }

  /**
   * D15's escape hatch. Rendered only after a `cors-blocked` failure, and it names the exact
   * URL that failed — the operator has to go fetch that document by other means, so telling
   * them which one is the whole point.
   */
  private renderJwksPaste() {
    if (!this.jwksBlockedUrl) return html``;
    return html`
      <div class="jwks-paste" data-jwks-paste>
        <p>
          The signing keys could not be fetched from
          <code>${this.jwksBlockedUrl}</code> — the identity provider does not allow this
          origin to read it. Fetch that URL yourself and paste the JWKS below.
        </p>
        <textarea
          aria-label="JWKS JSON"
          placeholder='{"keys":[ ... ]}'
        ></textarea>
        ${this.jwksPasteError
          ? html`<p class="error">${this.jwksPasteError}</p>`
          : html``}
        <wa-button
          data-jwks-retry
          appearance="filled"
          ?disabled=${this.submitting}
          @click=${this.handleJwksRetry}
        >
          Register with pasted keys
        </wa-button>
      </div>
    `;
  }

  render() {
    // D9: this screen writes `_node/_local/_config`, which CouchDB refuses to a non-admin.
    // Saying so beats letting them fill the form and collect a 401 on submit.
    if (!getContext().auth.isAdmin) {
      return html`
        <wa-card>
          <h2>Add Identity Provider</h2>
          <p class="denied">
            Only a server administrator can register an identity provider — it writes CouchDB's
            JWT configuration.
          </p>
        </wa-card>
      `;
    }

    return html`
      <wa-card>
        <h2>Add Identity Provider</h2>
        ${this.renderJwksPaste()}
        <form @submit=${this.handleSubmit}>
          <div class="field">
            <label for="name">Name</label>
            <wa-input
              id="name"
              name="name"
              required
              placeholder="e.g. Auth0 Production"
            ></wa-input>
          </div>

          <div class="field">
            <label for="well_known_url">.well-known URL</label>
            <wa-input
              id="well_known_url"
              name="well_known_url"
              type="url"
              required
              autocomplete="off"
              placeholder="https://example.auth0.com/.well-known/openid-configuration"
            ></wa-input>
            <p class="hint">
              CCA will auto-discover issuer, JWKS URI, and signing keys from
              this endpoint. The issuer it finds identifies the provider — one
              CouchDB holds one registration per issuer.
            </p>
          </div>

          <div class="field">
            <label for="client_id">Client ID (optional)</label>
            <wa-input
              id="client_id"
              name="client_id"
              placeholder="Your OAuth client ID"
            ></wa-input>
          </div>

          <div class="field">
            <label for="roles_claim">Roles Claim Name (optional)</label>
            <wa-input
              id="roles_claim"
              name="roles_claim"
              placeholder="Default: _couchdb.roles"
            ></wa-input>
            <p class="hint">
              The JWT claim containing CouchDB roles. Common values:
              _couchdb.roles, roles, groups
            </p>
          </div>

          <div class="field">
            <wa-switch data-idp-only>
              Sign in with this provider only
            </wa-switch>
            <p class="hint">
              Hides the username/password form on the login screen. CouchDB still accepts
              passwords — add ?password to the login URL to get the form back if this provider
              ever stops working.
            </p>
          </div>

          ${this.error ? html`<p class="error">${this.error}</p>` : ""}

          <div class="actions">
            <wa-button
              type="submit"
              appearance="filled"
              ?disabled=${this.submitting}
            >
              ${this.submitting ? "Registering..." : "Register & Discover"}
            </wa-button>
            <wa-button
              type="button"
              @click=${() => getContext().router.navigate("/idp")}
              >Cancel</wa-button
            >
          </div>
        </form>
      </wa-card>
      ${this.renderRestartConfirm()}
    `;
  }

  private renderRestartConfirm() {
    return html`
      <wa-dialog
        data-confirm-restart
        label="Restart CouchDB?"
        ?open=${this.restartConfirm !== null}
        @wa-after-hide=${(e: Event) => {
          if (e.target === e.currentTarget) this.declineRestart();
        }}
      >
        <div class="dialog-body">${this.restartConfirm?.message}</div>
        <div slot="footer" class="footer">
          <wa-button data-restart-later @click=${() => this.declineRestart()}
            >Later</wa-button
          >
          <wa-button
            data-restart-now
            variant="brand"
            appearance="filled"
            @click=${() => void this.runRestartConfirm()}
            >Restart Now</wa-button
          >
        </div>
      </wa-dialog>
    `;
  }
}
