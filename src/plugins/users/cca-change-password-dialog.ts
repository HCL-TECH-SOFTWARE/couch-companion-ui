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

import { LitElement, html, css } from 'lit';
import { customElement, query, state } from 'lit/decorators.js';
import '@awesome.me/webawesome/dist/components/dialog/dialog.js';
import '@awesome.me/webawesome/dist/components/input/input.js';
import '@awesome.me/webawesome/dist/components/button/button.js';

/** Modal that collects a new password twice and confirms on match. */
@customElement('cca-change-password-dialog')
export class CcaChangePasswordDialog extends LitElement {
  static styles = css`
    .fields {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }
    .error {
      color: var(--wa-color-danger-on-quiet);
      font-size: var(--wa-font-size-s);
    }
    .pw-match {
      font-size: var(--wa-font-size-s);
    }
    .pw-match.ok {
      color: var(--wa-color-success-on-quiet);
    }
    .pw-match.bad {
      color: var(--wa-color-danger-on-quiet);
    }
    .actions {
      display: flex;
      gap: 0.5rem;
      justify-content: flex-end;
      margin-top: 1rem;
    }
  `;

  @state() private _error = '';
  @state() private _pwValue = '';
  @state() private _pw2Value = '';
  @query('wa-dialog') private _dialog?: HTMLElement & { open: boolean };
  @query('wa-input[data-pw]') private _pw?: HTMLInputElement;
  @query('wa-input[data-pw2]') private _pw2?: HTMLInputElement;

  /** Open the dialog and reset its state. */
  open() {
    this._error = '';
    this._pwValue = '';
    this._pw2Value = '';
    if (this._pw) this._pw.value = '';
    if (this._pw2) this._pw2.value = '';
    if (this._dialog) this._dialog.open = true;
  }

  /** Live red/green indicator comparing the new password and its repeat. */
  private _renderPwMatch() {
    if (!this._pw2Value) return '';
    const ok = this._pwValue === this._pw2Value;
    return html`<div data-pw-match class="pw-match ${ok ? 'ok' : 'bad'}">
      ${ok ? 'Passwords match' : "Passwords don't match"}
    </div>`;
  }

  private _confirm() {
    const pw = this._pw?.value ?? '';
    const pw2 = this._pw2?.value ?? '';
    if (!pw || !pw2) {
      this._error = 'Password is required.';
      return;
    }
    if (pw !== pw2) {
      this._error = 'Passwords do not match.';
      return;
    }
    this._error = '';
    if (this._dialog) this._dialog.open = false;
    this.dispatchEvent(
      new CustomEvent<{ password: string }>('password-confirmed', {
        detail: { password: pw },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _cancel() {
    this._error = '';
    if (this._dialog) this._dialog.open = false;
  }

  render() {
    return html`
      <wa-dialog label="Change Password">
        <div class="fields">
          <wa-input
            data-pw
            type="password"
            label="New password"
            password-toggle
            @input=${(e: Event) => (this._pwValue = (e.target as HTMLInputElement).value)}
          ></wa-input>
          <wa-input
            data-pw2
            type="password"
            label="Repeat password"
            password-toggle
            @input=${(e: Event) => (this._pw2Value = (e.target as HTMLInputElement).value)}
          ></wa-input>
          ${this._renderPwMatch()}
          ${this._error ? html`<div class="error">${this._error}</div>` : ''}
        </div>
        <div class="actions">
          <wa-button @click=${this._cancel}>Cancel</wa-button>
          <wa-button data-confirm appearance="filled" variant="brand" @click=${this._confirm}
            >Set password</wa-button
          >
        </div>
      </wa-dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'cca-change-password-dialog': CcaChangePasswordDialog;
  }
}
