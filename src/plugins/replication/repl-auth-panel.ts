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

import { html, css, LitElement } from "lit";
import { customElement, property, state, query } from "lit/decorators.js";
import "../../components/cca-http-headers-table.js";
import "@awesome.me/webawesome/dist/components/dialog/dialog.js";
import "@awesome.me/webawesome/dist/components/button/button.js";
import "@awesome.me/webawesome/dist/components/select/select.js";
import "@awesome.me/webawesome/dist/components/option/option.js";
import "@awesome.me/webawesome/dist/components/input/input.js";
import type {
  HttpHeaderRow,
  HttpHeadersChangeDetail,
} from "../../components/cca-http-headers-table.js";

export type AuthMode = "none" | "basic" | "bearer" | "custom";

/**
 * `auth` is always a concrete headers object — there is no wire-level "omit
 * to keep" signal. A stored credential the user did not touch is preserved
 * by re-emitting it verbatim (see `compileDraft`'s untouched branch), so a
 * save with an untouched panel round-trips the exact bytes CouchDB already
 * has. An explicit clear emits `{}`. `cca-repl-editor`'s
 * `handleSourceAuthChange`/`handleTargetAuthChange` need no special-casing
 * for either case — both are just "set state to this object".
 */
export interface ReplAuthChangeDetail {
  auth: Record<string, string>;
}

/**
 * Compact replication auth control. Renders as one line —
 * `<title>: [<derived type>]` — and opens a dialog for editing.
 * The single source of truth is the `auth` headers object; the auth
 * type is derived from it. Emits `cca-auth-change` on confirm.
 *
 * A stored credential can be replaced or cleared but is never read back:
 * opening the dialog on a non-empty `auth` shows a "credentials stored"
 * state (Replace / Clear) instead of decoding it into visible fields. Only
 * clicking Replace reveals the editable form, and it always starts blank —
 * see `seedDraft`/`startReplace`/`startClear`.
 */
@customElement("cca-repl-auth-panel")
export class CcaReplAuthPanel extends LitElement {
  static styles = css`
    :host {
      display: block;
    }
    .auth-inline {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      min-height: var(--wa-form-control-height, 2.5rem);
    }
    .auth-label {
      font-size: var(--wa-font-size-s);
      font-weight: var(--wa-font-weight-bold);
      color: var(--wa-color-text-normal);
      white-space: nowrap;
    }
    .dialog-body {
      display: grid;
      gap: 0.9rem;
    }
    .field {
      display: grid;
      gap: 0.35rem;
    }
    .field-label {
      font-size: var(--wa-font-size-s);
      font-weight: var(--wa-font-weight-bold);
      color: var(--wa-color-text-quiet);
    }
    wa-select,
    wa-input {
      width: 100%;
    }
    .stored-message {
      margin: 0;
      font-size: var(--wa-font-size-s);
      color: var(--wa-color-text-quiet);
    }
    .stored-actions {
      display: flex;
      gap: 0.5rem;
    }
    .dialog-actions {
      display: flex;
      gap: 0.5rem;
      justify-content: flex-end;
      margin-top: 1rem;
    }
  `;

  @property({ type: String }) title = "Authentication";
  @property({ attribute: false }) auth: Record<string, string> = {};

  @state() private draftMode: AuthMode = "none";
  @state() private draftUser = "";
  @state() private draftPassword = "";
  @state() private draftToken = "";
  @state() private draftHeaders: HttpHeaderRow[] = [];
  /** True once `auth` classified as non-empty at dialog-open time (see `seedDraft`). */
  @state() private hasStoredCredential = false;
  /**
   * True when the editable form is shown. Always true when there is nothing
   * stored to protect; false for a stored credential until the user clicks
   * Replace or Clear (see `startReplace`/`startClear`).
   */
  @state() private revealed = true;

  @query("wa-dialog") private dialog?: HTMLElement & { open: boolean };

  private authToRows(auth: Record<string, string>): HttpHeaderRow[] {
    return Object.entries(auth).map(([key, value]) => ({
      enabled: true,
      key,
      value: String(value ?? ""),
    }));
  }

  private deriveMode(auth: Record<string, string>): AuthMode {
    const active = this.authToRows(auth).filter((row) => {
      if (!row.key.trim() || !row.value.trim()) return false;
      if (row.key.trim().toLowerCase() !== "authorization") return true;
      return this.hasAuthorizationContent(row.value);
    });
    if (active.length === 0) return "none";
    if (active.length !== 1) return "custom";
    const only = active[0];
    if (only.key.trim().toLowerCase() !== "authorization") return "custom";
    const trimmed = only.value.trim();
    const value = trimmed.toLowerCase();
    if (value.startsWith("bearer")) return "bearer";
    if (value.startsWith("basic")) {
      return this.isBasicCredential(trimmed) ? "basic" : "custom";
    }
    return "custom";
  }

  private typeLabel(): string {
    const mode = this.deriveMode(this.auth);
    if (mode === "none") return "None";
    if (mode === "basic") return "Basic";
    if (mode === "bearer") return "Bearer";
    return "Custom";
  }

  /**
   * True when `value` is a well-formed `Basic <base64 user:pass>` header. Used only to
   * classify the header for the mode label/derivation — unlike the removed `decodeBasic`,
   * it never returns (or stores) the decoded username/password.
   */
  private isBasicCredential(value: string): boolean {
    const match = value.match(/^Basic\s+(.+)$/i);
    if (!match) return false;
    try {
      return atob(match[1]).includes(":");
    } catch {
      return false;
    }
  }

  /**
   * True when an `Authorization` value carries real content beyond a bare
   * `Bearer `/`Basic ` scheme prefix. `compileDraft`'s own bearer/basic
   * branches produce exactly that bare-scheme value when a mode is picked
   * but the field is left blank (`repl-editor.ts` used to default
   * `sourceAuth`/`targetAuth` to `{ Authorization: "Bearer " }` the same
   * way before anything was loaded or typed). Without this check either one
   * reads as a stored credential and locks the panel into the protected
   * "stored" state — Replace/Clear only, no way to type a first credential —
   * for data that was never actually saved.
   */
  private hasAuthorizationContent(value: string): boolean {
    const trimmed = value.trim();
    if (!trimmed) return false;
    const match = trimmed.match(/^(Bearer|Basic)\s*(.*)$/i);
    return match ? match[2].trim().length > 0 : true;
  }

  /**
   * Classifies `auth` and resets the draft. Deliberately does NOT populate
   * `draftUser`/`draftPassword`/`draftToken`/`draftHeaders` from the stored value — a
   * stored credential is replaced or cleared, never decoded back into the form. When
   * something is stored, the dialog opens in the protected "stored" state
   * (`hasStoredCredential && !revealed`); `startReplace`/`startClear` are what reveal
   * the (always-blank) editable form.
   */
  private seedDraft() {
    const mode = this.deriveMode(this.auth);
    this.hasStoredCredential = mode !== "none";
    this.revealed = !this.hasStoredCredential;
    this.draftMode = mode;
    this.draftUser = "";
    this.draftPassword = "";
    this.draftToken = "";
    this.draftHeaders = [{ enabled: true, key: "", value: "" }];
  }

  /** Reveals the editable form, defaulting to the stored value's mode (values stay blank). */
  private startReplace() {
    this.revealed = true;
  }

  /** Reveals the editable form pre-set to "none", so Apply commits an explicit clear. */
  private startClear() {
    this.draftMode = "none";
    this.revealed = true;
  }

  /**
   * Compiles the draft into the headers object to emit. When the panel was never
   * revealed (the stored credential was not touched — see `revealed`), this is the
   * "keep existing" sentinel case: it returns the stored `auth` verbatim rather than
   * recompiling from the (deliberately blank) draft fields, so an untouched panel
   * cannot accidentally clear a stored credential.
   */
  private compileDraft(): Record<string, string> {
    if (!this.revealed) return { ...this.auth };
    if (this.draftMode === "none") return {};
    if (this.draftMode === "bearer") {
      const token = this.draftToken.trim();
      return { Authorization: token ? `Bearer ${token}` : "Bearer " };
    }
    if (this.draftMode === "basic") {
      const user = this.draftUser.trim();
      const password = this.draftPassword.trim();
      const value =
        user || password ? `Basic ${btoa(`${user}:${password}`)}` : "Basic ";
      return { Authorization: value };
    }
    return this.draftHeaders
      .filter((row) => row.enabled && row.key.trim() && row.value.trim())
      .reduce<Record<string, string>>((acc, row) => {
        acc[row.key.trim()] = row.value.trim();
        return acc;
      }, {});
  }

  /**
   * True once the revealed form would compile to a header that isn't a real credential — a bare
   * `"Basic "`/`"Bearer "` scheme with no user-entered content, or a "Custom headers" table with
   * no complete row. `compileDraft`'s basic/bearer branches fall back to exactly that bare-scheme
   * string when the mode is picked but the field is left blank, and `repl-editor.ts`'s
   * `cleanAuthObject` trims it (`"Basic "` -> `"Basic"`) into a truthy, garbage header value.
   * Guards Apply both visually (disabled) and behaviourally (`confirm` no-ops) so a
   * Replace-then-Apply with blank fields cannot overwrite a real stored credential with that
   * garbage value. Explicit "none" (Clear) is never incomplete — an empty object is exactly the
   * real, intended result there. A still-protected stored credential (`!revealed`) is likewise
   * never incomplete — `compileDraft` returns it verbatim, untouched.
   */
  private isDraftIncomplete(): boolean {
    if (!this.revealed) return false;
    if (this.draftMode === "basic") {
      return !this.draftUser.trim() && !this.draftPassword.trim();
    }
    if (this.draftMode === "bearer") {
      return !this.draftToken.trim();
    }
    if (this.draftMode === "custom") {
      return !this.draftHeaders.some(
        (row) => row.enabled && row.key.trim() && row.value.trim(),
      );
    }
    return false;
  }

  private openDialog() {
    this.seedDraft();
    if (this.dialog) this.dialog.open = true;
  }

  private closeDialog() {
    if (this.dialog) this.dialog.open = false;
  }

  private confirm() {
    if (this.isDraftIncomplete()) return;
    const auth = this.compileDraft();
    this.auth = auth;
    this.dispatchEvent(
      new CustomEvent<ReplAuthChangeDetail>("cca-auth-change", {
        detail: { auth },
        bubbles: true,
        composed: true,
      }),
    );
    this.closeDialog();
  }

  private renderModeFields() {
    if (this.draftMode === "basic") {
      return html`
        <div class="field">
          <span class="field-label">User name</span>
          <wa-input
            data-user
            type="text"
            .value=${this.draftUser}
            @input=${(e: Event) => {
              this.draftUser = (e.target as HTMLInputElement).value || "";
            }}
          ></wa-input>
        </div>
        <div class="field">
          <span class="field-label">Password</span>
          <wa-input
            data-password
            type="password"
            password-toggle
            .value=${this.draftPassword}
            @input=${(e: Event) => {
              this.draftPassword = (e.target as HTMLInputElement).value || "";
            }}
          ></wa-input>
        </div>
      `;
    }
    if (this.draftMode === "bearer") {
      return html`
        <div class="field">
          <span class="field-label">Token</span>
          <wa-input
            data-token
            type="password"
            password-toggle
            .value=${this.draftToken}
            @input=${(e: Event) => {
              this.draftToken = (e.target as HTMLInputElement).value || "";
            }}
          ></wa-input>
        </div>
      `;
    }
    if (this.draftMode === "custom") {
      return html`
        <cca-http-headers-table
          grid-only
          title=${this.title}
          .headers=${this.draftHeaders}
          @cca-headers-change=${(e: CustomEvent<HttpHeadersChangeDetail>) => {
            this.draftHeaders = [...e.detail.headers];
          }}
        ></cca-http-headers-table>
      `;
    }
    return "";
  }

  private renderStoredState() {
    return html`
      <div class="field">
        <p data-stored-message class="stored-message">
          Credentials are stored and are not shown here. Replace them with a
          new value, or clear them.
        </p>
        <div class="stored-actions">
          <wa-button
            data-replace
            type="button"
            size="small"
            appearance="outlined"
            @click=${this.startReplace}
          >
            Replace
          </wa-button>
          <wa-button
            data-clear
            type="button"
            size="small"
            appearance="outlined"
            @click=${this.startClear}
          >
            Clear
          </wa-button>
        </div>
      </div>
    `;
  }

  private renderEditableForm() {
    return html`
      <div class="field">
        <span class="field-label">Mode</span>
        <wa-select
          data-mode
          value=${this.draftMode}
          @change=${(e: Event) => {
            const value = (e.target as HTMLSelectElement).value as
              | AuthMode
              | undefined;
            this.draftMode = value ?? "none";
          }}
        >
          <wa-option value="none">None</wa-option>
          <wa-option value="basic">Basic</wa-option>
          <wa-option value="bearer">Bearer</wa-option>
          <wa-option value="custom">Custom headers</wa-option>
        </wa-select>
      </div>
      ${this.renderModeFields()}
    `;
  }

  render() {
    return html`
      <div class="auth-inline">
        <span class="auth-label">${this.title}:</span>
        <wa-button
          data-auth-trigger
          type="button"
          size="small"
          appearance="outlined"
          @click=${this.openDialog}
        >
          ${this.typeLabel()}
        </wa-button>
      </div>

      <wa-dialog label=${this.title} style="--width: 40rem">
        <div class="dialog-body">
          ${this.hasStoredCredential && !this.revealed
            ? this.renderStoredState()
            : this.renderEditableForm()}
        </div>
        <div class="dialog-actions">
          <wa-button data-cancel type="button" @click=${this.closeDialog}>
            Cancel
          </wa-button>
          <wa-button
            data-confirm
            type="button"
            variant="brand"
            ?disabled=${this.isDraftIncomplete()}
            @click=${this.confirm}
          >
            Apply
          </wa-button>
        </div>
      </wa-dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "cca-repl-auth-panel": CcaReplAuthPanel;
  }
}
