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

import { LitElement, css, html, nothing, unsafeCSS } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import { getContext } from "../context.js";
import { ApiError } from "../services/api-error.js";
import { CrossSiteSessionError } from "../services/auth-service.js";
import type { DiscoveredIdp } from "../services/idp-discovery.js";
import { beginLogin, redirectUriFor, resolveEndpoints } from "../services/oidc-service.js";
import ccalogo from "../assets/ccalogo.jpg";
import {
  getLastServer,
  loadRecentServers,
  recordRecentServer,
  STORAGE_KEY,
  type RecentServer
} from "../services/recent-servers.js";
import { getLogger } from "../services/log-service.js";
import { toast } from "./cca-toast.js";

const log = getLogger("components/cca-login");
const ADD_SERVER_SENTINEL = "__add_server__";

/**
 * Maps a login failure to user-facing copy. CouchDB's `POST /_session`
 * answers 401 for bad credentials; anything else is a connectivity or
 * server problem and gets the generic message.
 *
 * A dropped cross-site session cookie is the exception: it already carries a diagnosis no
 * caller can reconstruct, so it passes through verbatim (#35).
 */
function describeLoginError(err: unknown): string {
  if (err instanceof CrossSiteSessionError) {
    return err.message;
  }
  if (!(err instanceof ApiError)) {
    return "Unable to connect to server";
  }
  return err.status === 401 ? "Invalid username or password" : "Unable to connect to server";
}

@customElement("cca-login")
export class CcaLogin extends LitElement {
  static styles = css`
    :host {
      display: block;
    }

    .login-shell {
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      /* ccalogo is a build-time import, so Vite has already rewritten it to a hashed asset
         URL by the time this template is evaluated. unsafeCSS is lit's sanctioned escape for
         exactly that: a constant known at module scope, never user input. */
      background-image: url(${unsafeCSS(ccalogo)});
      background-position: center;
      background-repeat: no-repeat;
      background-size: cover;
    }

    .companion-server-field {
      display: grid;
      gap: var(--wa-space-2xs);
      margin-block-end: var(--wa-space-xs);
    }

    .companion-server-with-button {
      display: flex;
      gap: var(--wa-space-xs);
      align-items: flex-end;
    }

    .companion-server-select-wrapper {
      flex: 1;
      min-width: 0;
    }

    .companion-server-label {
      color: var(--wa-color-text-normal);
      font-size: var(--wa-font-size-s);
      font-weight: var(--wa-font-weight-semibold);
      line-height: var(--wa-line-height-condensed);
      margin: 0;
    }

    .companion-server-input {
      box-sizing: border-box;
      width: 100%;
      min-height: 2.75rem;
      border: 1px solid var(--wa-color-neutral-border-normal);
      border-radius: var(--wa-border-radius-m);
      background: var(--wa-color-surface-default);
      color: var(--wa-color-text-normal);
      font: inherit;
      line-height: var(--wa-line-height-normal);
      padding: 0.625rem 0.75rem;
      transition:
        border-color 120ms ease,
        box-shadow 120ms ease;
    }

    .companion-server-input::placeholder {
      color: var(--wa-color-text-quiet);
    }

    .companion-server-input:hover {
      border-color: var(--wa-color-neutral-border-loud);
    }

    .companion-server-input:focus {
      border-color: var(--wa-color-brand-fill-loud);
      box-shadow: 0 0 0 3px
        color-mix(in oklab, var(--wa-color-brand-fill-loud) 20%, transparent);
      outline: none;
    }

    .add-server-error {
      color: var(--wa-color-danger-on-quiet);
      font-size: var(--wa-font-size-s);
      margin: var(--wa-space-xs) 0 0;
    }

    .idp-list {
      display: grid;
      gap: var(--wa-space-xs);
    }

    .idp-separator {
      color: var(--wa-color-text-quiet);
      font-size: var(--wa-font-size-s);
      text-align: center;
    }

    .paste-token {
      display: grid;
      gap: var(--wa-space-2xs);
    }

    .paste-token-hint {
      color: var(--wa-color-text-quiet);
      font-size: var(--wa-font-size-s);
      margin: 0;
    }
  `;

  /**
   * Identity providers found by the discovery chain (§5), in the order the discovery
   * document lists them — the operator controls the order by editing that document.
   * Empty is the ordinary case: a CouchDB with no IdP renders exactly the password screen
   * it rendered before Phase 6.
   */
  @property({ attribute: false }) idps: DiscoveredIdp[] = [];

  /**
   * Whether `GET /_session` listed the `jwt` handler. With no discoverable IdP, this is what
   * distinguishes "JWT login is possible but unconfigured" — where §5 step 3 says to offer a
   * paste-a-token affordance — from "password login only".
   */
  @property({ type: Boolean }) jwtHandlerEnabled = false;

  /**
   * The paste-a-token field, which only exists while {@link renderIdpOptions} offers it.
   * `@query` looks in `renderRoot` — this component renders into a shadow root, so a plain
   * `this.querySelector` searches the light DOM and can only ever answer `null` (#139).
   */
  @query("#pasted-token") private pastedTokenField?: HTMLInputElement;

  @state() private error = "";
  @state() private loading = false;
  @state() private recentServers: RecentServer[] = loadRecentServers();
  @state() private companionServer: string = getLastServer() ?? "";
  @state() private addServerDialogOpen = false;
  @state() private addServerValue = "";
  @state() private addServerError = "";

  private handleCompanionInput(e: Event) {
    this.companionServer = (e.target as HTMLInputElement).value;
  }

  private handleCompanionSelectChange(e: Event) {
    const next = String((e.target as { value?: string }).value ?? "");
    if (next === ADD_SERVER_SENTINEL) {
      this.addServerValue = "";
      this.addServerError = "";
      this.addServerDialogOpen = true;
      return;
    }
    this.companionServer = next;
  }

  private handleAddServerInput(e: Event) {
    this.addServerValue = (e.target as HTMLInputElement).value;
    if (this.addServerError) {
      this.addServerError = "";
    }
  }

  private cancelAddServer() {
    this.addServerDialogOpen = false;
    this.addServerValue = "";
    this.addServerError = "";
  }

  private confirmAddServer() {
    const url = this.addServerValue.trim();
    if (!url) {
      this.addServerError = "Please enter a server URL";
      return;
    }
    try {
      new URL(url);
    } catch {
      this.addServerError = "Invalid server URL";
      return;
    }
    recordRecentServer(url);
    this.recentServers = loadRecentServers();
    this.companionServer = url;
    this.cancelAddServer();
  }

  private handleAddServerDialogKeydown(e: KeyboardEvent) {
    if (!this.addServerDialogOpen) {
      return;
    }

    if (e.key === "Escape") {
      e.preventDefault();
      this.cancelAddServer();
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      this.confirmAddServer();
    }
  }

  private clearCurrentServer() {
    // Remove the current server from recent servers
    this.recentServers = this.recentServers.filter(
      (s) => s.url !== this.companionServer
    );
    // Clear the selection
    this.companionServer = "";
    // Persist the updated recent servers list
    localStorage.removeItem(STORAGE_KEY);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.recentServers));
  }

  /**
   * Resolves the IdP's endpoints and hands off to the PKCE redirect. Nothing after
   * `beginLogin` runs in this page — the browser is on its way to the identity provider — so
   * the only outcome worth handling here is a failure to get that far.
   */
  private async startIdpLogin(idp: DiscoveredIdp) {
    this.error = "";
    this.loading = true;
    try {
      const endpoints = await resolveEndpoints(idp);
      await beginLogin(idp, endpoints, redirectUriFor(window.location.href));
    } catch (err) {
      log.error(`Could not start login with ${idp.name}`, err as Error);
      this.error = (err as Error).message;
      toast(this.error, "error");
      this.loading = false;
    }
  }

  /** §5 step 3: CouchDB accepts JWTs but no IdP is discoverable, so the operator can paste
   *  one obtained out-of-band. Validated by CouchDB on the very next request, not here. */
  private async handlePastedToken(e: Event) {
    e.preventDefault();
    const token = this.pastedTokenField?.value.trim();
    if (!token) {
      this.error = "Paste a token first";
      toast(this.error, "error");
      return;
    }

    this.error = "";
    this.loading = true;
    try {
      await getContext().auth.loginWithToken(token);
      toast("Logged in successfully", "success");
      this.dispatchEvent(
        new CustomEvent("login-success", { bubbles: true, composed: true })
      );
    } catch (err) {
      log.error("Token login failed", err as Error);
      this.error = "That token was not accepted by this server";
      toast(this.error, "error");
    } finally {
      this.loading = false;
    }
  }

  async handleSubmit(e: Event) {
    e.preventDefault();
    this.error = "";
    this.loading = true;

    const form = e.target as HTMLFormElement;
    const data = new FormData(form);
    const dep = getContext().deployment;
    const sameOrigin = dep.mode === "same-origin";
    const submittedCompanion =
      (data.get("companion_server") as string | null) ?? "";
    const companionServer = sameOrigin
      ? dep.baseUrl
      : (this.companionServer || submittedCompanion).trim();
    const username = data.get("username") as string;
    const password = data.get("password") as string;

    if ((!sameOrigin && !companionServer) || !username || !password) {
      this.error = "Please fill in all fields";
      toast(this.error, "error");
      this.loading = false;
      return;
    }

    if (!sameOrigin) {
      try {
        new URL(companionServer);
      } catch {
        this.error = "Invalid server URL";
        toast(this.error, "error");
        this.loading = false;
        return;
      }
    }

    try {
      await getContext().auth.login(companionServer, username, password);
      this.recentServers = loadRecentServers();
      this.companionServer = companionServer;
      this.error = "";
      toast("Logged in successfully", "success");
      this.dispatchEvent(
        new CustomEvent("login-success", { bubbles: true, composed: true })
      );
    } catch (err) {
      log.error("Login failed", err as Error);
      this.error = describeLoginError(err);
      toast(this.error, "error");
    } finally {
      this.loading = false;
    }
  }

  /**
   * Whether the username/password form is offered at all.
   *
   * An IdP marked `idp_only` says this deployment signs in through identity providers, so the
   * password form is hidden — but `?password` on the URL always brings it back. That escape
   * hatch is not optional: `idp_only` is stored in the very CouchDB it locks, so a provider
   * that is misconfigured, expired, or simply unreachable would otherwise leave the admin no
   * way in to fix it. It is not a security boundary either — CouchDB still accepts the
   * password, and hiding a form has never stopped anyone who can type a curl command.
   */
  private get passwordLoginVisible(): boolean {
    if (new URLSearchParams(window.location.search).has("password")) return true;
    return !this.idps.some((idp) => idp.idp_only);
  }

  /**
   * The JWT half of the login screen, above the password form. Renders nothing at all when
   * discovery found no IdP and CouchDB has no `jwt` handler — the ordinary case, and the one
   * that has to look untouched (D8: native session otherwise).
   */
  private renderIdpOptions() {
    if (this.idps.length > 0) {
      return html`
        <div class="idp-list">
          ${this.idps.map(
            (idp) => html`
              <wa-button
                data-idp=${idp.client_id}
                appearance="outlined"
                ?disabled=${this.loading}
                @click=${() => this.startIdpLogin(idp)}
              >
                Sign in with ${idp.name}
              </wa-button>
            `
          )}
        </div>
        ${this.passwordLoginVisible
          ? html`<p class="idp-separator">or sign in with a username</p>`
          : nothing}
      `;
    }

    if (!this.jwtHandlerEnabled) {
      return nothing;
    }

    return html`
      <form class="paste-token" data-paste-token @submit=${this.handlePastedToken}>
        <label class="companion-server-label" for="pasted-token">Bearer token</label>
        <p class="paste-token-hint">
          This server accepts JWTs but publishes no identity provider. Paste a token issued by
          one it trusts.
        </p>
        <input
          class="companion-server-input"
          id="pasted-token"
          type="password"
          autocomplete="off"
          placeholder="eyJhbGciOiJSUzI1NiIs..."
        />
        <wa-button type="submit" appearance="outlined" ?disabled=${this.loading}>
          Sign in with token
        </wa-button>
      </form>
      <p class="idp-separator">or sign in with a username</p>
    `;
  }

  /** CouchDB's own session login (D8). Hidden only by {@link passwordLoginVisible}. */
  private renderPasswordForm() {
    const sameOrigin = getContext().deployment.mode === "same-origin";
    return html`
      <form @submit=${this.handleSubmit} class="wa-stack wa-gap-m">
        ${sameOrigin
          ? nothing
          : html`
              <div class="companion-server-field">
                ${this.recentServers.length === 0
                  ? html`
                      <wa-input
                        label="Companion Server"
                        type="url"
                        name="companion_server"
                        .value=${this.companionServer}
                        @input=${this.handleCompanionInput}
                        autocomplete="url"
                        placeholder="https://couchdb.example.com:5984"
                        required
                      >
                      </wa-input>
                    `
                  : html`
                      <div class="companion-server-with-button">
                        <div class="companion-server-select-wrapper">
                          <wa-select
                            label="Companion Server"
                            name="companion_server"
                            .value=${this.companionServer}
                            @change=${this.handleCompanionSelectChange}
                            required
                          >
                            ${this.recentServers.map(
                              (s) =>
                                html`<wa-option value=${s.url}
                                  >${s.url}</wa-option
                                >`
                            )}
                            <wa-divider></wa-divider>
                            <wa-option value=${ADD_SERVER_SENTINEL}
                              >Add server ...</wa-option
                            >
                          </wa-select>
                        </div>
                        <wa-button
                          size="m"
                          appearance="outlined"
                          variant="danger"
                          aria-label="Clear server"
                          @click=${this.clearCurrentServer}
                        >
                          <wa-icon name="trash" label="Clear server"></wa-icon>
                        </wa-button>
                      </div>
                    `}
              </div>
            `}
        <wa-input
          label="Username"
          type="text"
          name="username"
          autocomplete="username"
          style="margin-block-start: var(--wa-space-m);"
          required
        ></wa-input>
        <wa-input
          label="Password"
          type="password"
          password-toggle
          name="password"
          autocomplete="current-password"
          style="margin-block-start: var(--wa-space-m);"
          required
        ></wa-input>
        <wa-button
          type="submit"
          appearance="filled"
          style="margin-block-start: var(--wa-space-m);"
          ?disabled=${this.loading}
        >
          ${this.loading ? "Logging in..." : "Log in"}
        </wa-button>
      </form>
    `;
  }

  render() {
    return html`
      <div class="login-shell">
        <wa-card style="max-width: 50ch; width: 100%;">
          <h2>CouchCompanion</h2>
          ${this.renderIdpOptions()}
          <!-- One error line for all three sign-in paths, outside the password form: with
               idp_only set (#119) that form is gone, and a failed IdP redirect is then the
               only thing that can go wrong and the only thing worth saying. -->
          ${this.error ? html`<p class="error">${this.error}</p>` : nothing}
          ${this.passwordLoginVisible ? this.renderPasswordForm() : nothing}
          <wa-dialog
            label="Add Companion Server"
            ?open=${this.addServerDialogOpen}
            @keydown=${this.handleAddServerDialogKeydown}
          >
            <label class="companion-server-label" for="add-server-url"
              >Server URL</label
            >
            <input
              class="companion-server-input"
              id="add-server-url"
              type="url"
              .value=${this.addServerValue}
              @input=${this.handleAddServerInput}
              autocomplete="url"
              placeholder="https://couchdb.example.com:5984"
              required
            />
            ${this.addServerError
              ? html`<p class="add-server-error">${this.addServerError}</p>`
              : ""}
            <wa-button
              slot="footer"
              appearance="plain"
              @click=${this.cancelAddServer}
              >Cancel</wa-button
            >
            <wa-button
              slot="footer"
              appearance="filled"
              @click=${this.confirmAddServer}
              >Add</wa-button
            >
          </wa-dialog>
        </wa-card>
      </div>
    `;
  }
}
