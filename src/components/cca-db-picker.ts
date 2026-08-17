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

import { html, css, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import '@awesome.me/webawesome/dist/components/select/select.js';
import '@awesome.me/webawesome/dist/components/option/option.js';
import '@awesome.me/webawesome/dist/components/input/input.js';
import { CcaElement } from './cca-element.js';

/** Detail carried by the `cca-db-change` event this picker emits. */
export type CcaDbChangeDetail = { database: string };

/**
 * Database picker that degrades to free text when the list cannot be fetched.
 *
 * CouchDB restricts `GET /_all_dbs` to admins by default, so a non-admin gets
 * 401 and every database dropdown in the app renders empty — a dead end, even
 * though the per-database screens themselves answer 200 for a member. The
 * enumeration is what is refused, not the access; so when the host reports the
 * list is `unavailable`, this renders a free-text field and the user types the
 * name they already know. That free-text half deliberately looks like the
 * Target Database field in replication, which is free text for the same reason
 * (a remote server's databases cannot be enumerated either).
 *
 * The component renders the control and nothing else — no label, no layout.
 * All three hosts (design-list, repl-source-section, db-list) already supply
 * their own label and helper text in their own grid, and it has to drop into
 * each without fighting them.
 *
 * Fully host-driven: it never fetches. The host owns `databases`, decides what
 * counts as `unavailable`, and commits the `cca-db-change` detail.
 */
@customElement('cca-db-picker')
export class CcaDbPicker extends CcaElement {
  static styles = css`
    :host {
      display: block;
    }

    wa-select,
    wa-input {
      width: 100%;
    }

    [data-reason] {
      margin: var(--wa-space-xs, 0.25rem) 0 0;
      font-size: var(--wa-font-size-xs, 0.75rem);
      color: var(--wa-color-text-quiet);
    }
  `;

  /** Database names known to the host. Empty is legitimate, not an error. */
  @property({ attribute: false }) databases: string[] = [];

  /** The currently picked database name. */
  @property({ type: String }) value = '';

  /** The host could not enumerate databases; offer free text instead. */
  @property({ type: Boolean }) unavailable = false;

  /** Short host-supplied explanation shown under the free-text field. */
  @property({ type: String }) reason = '';

  /** Disable the control (e.g. no server selected yet). */
  @property({ type: Boolean }) disabled = false;

  /** Override the placeholder; empty picks one to suit the current state. */
  @property({ type: String }) placeholder = '';

  private get _placeholder(): string {
    if (this.placeholder) return this.placeholder;
    return this.unavailable ? 'Database name' : 'Select database';
  }

  private _commit(database: string): void {
    this.value = database;
    this.dispatchEvent(
      new CustomEvent<CcaDbChangeDetail>('cca-db-change', {
        detail: { database },
        bubbles: true,
        composed: true
      })
    );
  }

  /**
   * Free text: the list was refused, so the only source of a database name is
   * the user.
   *
   * `value` tracks every keystroke but `cca-db-change` fires only on `change` —
   * the same commit semantics a native input has, and the same ones the select
   * branch below has. Emitting per keystroke would make a host that loads on
   * selection (design-list calls selectDatabase -> loadDesignDocs) issue one
   * request per letter, each against a half-typed name that 404s. Hosts that
   * want the in-progress text can still read `.value`.
   *
   * Both events do reach us: wa-input relays the native `input`, and its
   * `handleChange` re-dispatches the native `change` with `composed: true`
   * (checked in WebAwesome's own source — a native `change` is NOT composed by
   * default and would otherwise never leave wa-input's shadow root).
   */
  private _renderFreeText() {
    return html`
      <wa-input
        type="text"
        .value=${this.value}
        placeholder=${this._placeholder}
        ?disabled=${this.disabled}
        @input=${(e: Event) => {
          this.value = (e.target as HTMLInputElement).value || '';
        }}
        @change=${(e: Event) => this._commit((e.target as HTMLInputElement).value || '')}></wa-input>
      ${this.reason ? html`<p data-reason>${this.reason}</p>` : nothing}
    `;
  }

  /**
   * The dropdown. A `value` the host restored from a route or a saved document
   * may not be in the fetched list (renamed, filtered, or fetched under a
   * different server); a synthetic option keeps it visible instead of silently
   * blanking the field. wa-select dispatches a native `change`.
   */
  private _renderSelect() {
    const missing = this.value && !this.databases.includes(this.value);
    return html`
      <wa-select
        placeholder=${this._placeholder}
        .value=${this.value}
        ?disabled=${this.disabled}
        @change=${(e: Event) => this._commit((e.target as HTMLSelectElement).value || '')}>
        ${missing ? html`<wa-option value=${this.value}>${this.value}</wa-option>` : nothing}
        ${this.databases.map((db) => html`<wa-option value=${db}>${db}</wa-option>`)}
      </wa-select>
    `;
  }

  render() {
    return this.unavailable ? this._renderFreeText() : this._renderSelect();
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'cca-db-picker': CcaDbPicker;
  }
}
