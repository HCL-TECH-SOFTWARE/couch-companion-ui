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
import { customElement, property, state } from 'lit/decorators.js';
import '@awesome.me/webawesome/dist/components/tag/tag.js';
import '@awesome.me/webawesome/dist/components/input/input.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
import { validateRole } from './users-doc.js';

/** Pill-based role selector with an `<OTHER>` free-text escape hatch. */
@customElement('cca-roles-picker')
export class CcaRolesPicker extends LitElement {
  static styles = css`
    .pills {
      display: flex;
      flex-wrap: wrap;
      gap: 0.4rem;
      align-items: center;
    }
    wa-tag {
      cursor: pointer;
    }
    .other-row {
      display: flex;
      gap: 0.5rem;
      align-items: center;
      margin-top: 0.5rem;
      max-width: 24rem;
    }
    .error {
      color: var(--wa-color-danger-on-quiet);
      font-size: var(--wa-font-size-s);
      margin-top: 0.4rem;
    }
  `;

  /** Currently selected roles (controlled by the parent). */
  @property({ type: Array }) selected: string[] = [];
  /** Known roles to offer as pills (union with `selected` is displayed). */
  @property({ type: Array }) candidates: string[] = [];

  @state() private _otherOpen = false;
  @state() private _otherValue = '';
  @state() private _error = '';

  private _emit(next: string[]) {
    this.dispatchEvent(
      new CustomEvent<string[]>('roles-change', {
        detail: next,
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _toggle(role: string) {
    const next = this.selected.includes(role)
      ? this.selected.filter((r) => r !== role)
      : [...this.selected, role];
    this._emit(next);
  }

  private _openOther() {
    this._otherOpen = true;
    this._error = '';
  }

  private _addOther() {
    const inputEl = this.shadowRoot?.querySelector<HTMLInputElement>('wa-input[data-other-input]');
    const role = (inputEl?.value ?? this._otherValue).trim();
    const err = validateRole(role);
    if (err) {
      this._error = err;
      return;
    }
    if (!this.selected.includes(role)) this._emit([...this.selected, role]);
    this._otherValue = '';
    this._otherOpen = false;
    this._error = '';
  }

  render() {
    const all = [...new Set([...this.candidates, ...this.selected])].sort();
    return html`
      <div class="pills">
        ${all.map((role) => {
          const active = this.selected.includes(role);
          return html`<wa-tag
            pill
            size="small"
            data-role=${role}
            appearance=${active ? 'accent' : 'outlined'}
            @click=${() => this._toggle(role)}
            >${role}</wa-tag
          >`;
        })}
        <wa-tag pill size="small" data-other appearance="outlined" @click=${this._openOther}
          >&lt;OTHER&gt;</wa-tag
        >
      </div>
      ${this._otherOpen
        ? html`<div class="other-row">
            <wa-input
              data-other-input
              placeholder="role name"
              .value=${this._otherValue}
              @input=${(e: Event) => (this._otherValue = (e.target as HTMLInputElement).value)}
            ></wa-input>
            <wa-button data-other-add size="s" appearance="filled" @click=${this._addOther}
              >Add</wa-button
            >
            <wa-button
              size="s"
              @click=${() => {
                this._otherOpen = false;
                this._error = '';
              }}
              >Cancel</wa-button
            >
          </div>`
        : ''}
      ${this._error ? html`<div class="error">${this._error}</div>` : ''}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'cca-roles-picker': CcaRolesPicker;
  }
}
