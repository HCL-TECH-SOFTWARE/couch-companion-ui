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

import { LitElement, html, css, nothing } from 'lit';
import { customElement, query, state } from 'lit/decorators.js';
import '@awesome.me/webawesome/dist/components/dialog/dialog.js';
import '@awesome.me/webawesome/dist/components/checkbox/checkbox.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
import { readRpLogout, type RpLogout } from '../services/oidc-service.js';

/**
 * `localStorage` key remembering whether the last logout ended the identity-provider session
 * too (#24). Same convention as `cca-shell.ts`'s {@link NAV_COLLAPSED_STORAGE_KEY}: a
 * per-browser UI preference, owned by the one component that renders it, never in the
 * `couchcompanion` database (D13).
 */
export const FULL_IDP_LOGOUT_STORAGE_KEY = 'ccaFullIdpLogout';

/**
 * The remembered choice, defaulting to **on**.
 *
 * Only the literal `"false"` turns it off. An absent key is a user who has never chosen, and a
 * garbled one is a user whose choice we lost — both get the safer default, because the surprise
 * this issue exists to fix is a logout that quietly left the IdP session alive.
 */
export function fullIdpLogoutPreference(): boolean {
  return localStorage.getItem(FULL_IDP_LOGOUT_STORAGE_KEY) !== 'false';
}

/**
 * The logout confirmation (#24).
 *
 * Two dialogs in one, and which one you get is not a matter of taste: the "Full logout from
 * IdP" checkbox appears **only** when there is genuinely an identity-provider session this
 * browser can end — see {@link readRpLogout}, which is `null` for a cookie session, a pasted
 * token, and a provider that publishes no `end_session_endpoint`. A provider that does not
 * advertise one must not be offered as a choice, because choosing it would navigate to a 404.
 *
 * Presentational: it decides what to ask and remembers the answer, but performs nothing.
 * `cca-shell.ts` owns the teardown and the redirect, in that order.
 */
@customElement('cca-logout-dialog')
export class CcaLogoutDialog extends LitElement {
  static styles = css`
    .body {
      display: flex;
      flex-direction: column;
      gap: var(--wa-space-m);
    }
    .hint {
      color: var(--wa-color-text-quiet);
      font-size: var(--wa-font-size-s);
    }
    .actions {
      display: flex;
      gap: var(--wa-space-s);
      justify-content: flex-end;
      margin-block-start: var(--wa-space-l);
    }
  `;

  /** The IdP session that could be ended, or null when there is none to offer. */
  @state() private _rp: RpLogout | null = null;
  @state() private _everywhere = true;

  @query('wa-dialog') private _dialog?: HTMLElement & { open: boolean };

  /**
   * Opens the dialog, re-reading both the IdP session and the remembered preference.
   *
   * Read on every open rather than on connect: the shell mounts this once and keeps it for the
   * app's lifetime, so a value captured at connect time would describe whichever session
   * happened to be current then.
   */
  open(): void {
    this._rp = readRpLogout();
    this._everywhere = fullIdpLogoutPreference();
    if (this._dialog) this._dialog.open = true;
  }

  private _close(): void {
    if (this._dialog) this._dialog.open = false;
  }

  /**
   * `wa-checkbox` dispatches a **native** `change` — a plain `Event`, bubbling and composed —
   * not `wa-change`. Verified in the component's own source; binding `wa-change` would silently
   * never fire and the checkbox would look stuck.
   */
  private _onToggle(e: Event): void {
    this._everywhere = (e.target as HTMLInputElement).checked;
  }

  private _confirm(): void {
    const everywhere = this._rp !== null && this._everywhere;
    // Only a choice that was actually offered is worth remembering; a cookie session never
    // saw the checkbox, so recording "false" for it would silently flip the next IdP logout.
    if (this._rp) {
      localStorage.setItem(FULL_IDP_LOGOUT_STORAGE_KEY, String(everywhere));
    }
    this._close();
    this.dispatchEvent(
      new CustomEvent<{ everywhere: boolean }>('logout-confirmed', {
        detail: { everywhere },
        bubbles: true,
        composed: true,
      }),
    );
  }

  /** The extra question an IdP session earns, and nothing at all when there is none to end. */
  private _renderIdpChoice() {
    if (!this._rp) return nothing;
    return html`
      <div>
        <wa-checkbox data-everywhere .checked=${this._everywhere} @change=${this._onToggle}
          >Full logout from IdP</wa-checkbox
        >
        <div class="hint">
          Also ends the session at your identity provider, so the next sign-in asks for your
          credentials again. Leave it off to sign out of this app only.
        </div>
      </div>
    `;
  }

  render() {
    return html`
      <wa-dialog label="Log out">
        <div class="body">
          <div data-question>Are you sure you want to log out?</div>
          ${this._renderIdpChoice()}
        </div>
        <div class="actions">
          <wa-button data-cancel @click=${this._close}>Cancel</wa-button>
          <wa-button data-confirm appearance="filled" variant="brand" @click=${this._confirm}
            >Log out</wa-button
          >
        </div>
      </wa-dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'cca-logout-dialog': CcaLogoutDialog;
  }
}
