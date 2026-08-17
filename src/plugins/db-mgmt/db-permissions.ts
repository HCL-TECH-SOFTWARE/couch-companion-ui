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

import { html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { CcaElement } from '../../components/cca-element.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import type { DatabaseAccess, AccessRolesAndNames } from './types.js';

export type { DatabaseAccess, AccessRolesAndNames };

/**
 * Database permissions component for managing admin and member access.
 * Can be used standalone or embedded in other components like db-create.
 *
 * Emits 'cca-permissions-change' event when permissions are modified.
 */
@customElement('cca-db-permissions')
export class CcaDbPermissions extends CcaElement {
  /** Initial database access configuration */
  @property({ type: Object }) access: DatabaseAccess = {
    admin: { name: [], roles: ['_admin'] },
    member: { name: [], roles: ['_admin'] }
  };

  /** When true, component operates in read-only mode */
  @property({ type: Boolean }) readonly = false;

  @state() private _adminUserInput = '';
  @state() private _adminRoleInput = '';
  @state() private _memberUserInput = '';
  @state() private _memberRoleInput = '';

  static override styles = css`
    :host {
      display: block;
      width: 100%;
      box-sizing: border-box;
    }

    .section {
      margin-bottom: 1.5rem;
      padding-top: 1rem;
      border-top: 1px solid var(--wa-color-surface-border);
    }

    .section:first-of-type {
      border-top: none;
      padding-top: 0;
    }

    .section-title {
      font-size: var(--wa-font-size-m);
      font-weight: var(--wa-font-weight-bold);
      margin-bottom: 0.25rem;
      color: var(--wa-color-text-normal, #1f2a35);
    }

    .section-description {
      color: var(--wa-color-text-quiet);
      margin-bottom: 0.75rem;
      font-size: var(--wa-font-size-s);
    }

    .subsection-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 2rem;
      margin-bottom: 0.75rem;
    }

    .subsection {
      display: flex;
      flex-direction: column;
    }

    .subsection-title {
      font-weight: var(--wa-font-weight-semibold);
      font-size: var(--wa-font-size-m);
      margin-bottom: 0.25rem;
      color: var(--wa-color-text-normal, #1f2a35);
    }

    .subsection-subtitle {
      color: var(--wa-color-text-quiet);
      font-size: var(--wa-font-size-xs);
      margin-bottom: 0.4rem;
    }

    .tag-input-wrapper {
      display: flex;
      box-sizing: border-box;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.375rem;
      padding: 0.5rem;
      min-height: 80px;
      border: 1px solid var(--wa-color-neutral-border-normal);
      border-radius: 4px;
      background: white;
      cursor: text;
      transition:
        border-color 0.2s,
        box-shadow 0.2s;
    }

    .tag-input-wrapper:focus-within {
      border-color: var(--wa-color-brand-border-loud);
      box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.1);
    }

    .tag {
      display: inline-flex;
      align-items: center;
      gap: 0.375rem;
      padding: 0.25rem 0.5rem;
      background: var(--wa-color-brand-fill-quiet);
      border: 1px solid var(--wa-color-brand-border-quiet);
      border-radius: 4px;
      font-size: var(--wa-font-size-s);
      line-height: var(--wa-line-height-normal);
      white-space: nowrap;
    }

    .tag-text {
      color: var(--wa-color-brand-on-quiet);
    }

    .tag-remove {
      background: none;
      border: none;
      cursor: pointer;
      padding: 0;
      color: var(--wa-color-brand-on-quiet);
      display: flex;
      align-items: center;
      justify-content: center;
      transition: color 0.15s;
      line-height: var(--wa-line-height-condensed);
    }

    .tag-remove:hover {
      color: var(--wa-color-danger-on-quiet);
    }

    .tag-input {
      flex: 1;
      min-width: 120px;
      border: none;
      outline: none;
      padding: 0.25rem 0;
      font-size: var(--wa-font-size-s);
      font-family: inherit;
      background: transparent;
    }

    .tag-input::placeholder {
      color: var(--wa-form-control-placeholder-color);
    }

    .textarea-help {
      font-size: var(--wa-font-size-xs);
      color: var(--wa-form-control-hint-color);
      margin-top: 0.375rem;
    }

    .readonly-wrapper {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.375rem;
    }

    .readonly-empty {
      font-size: var(--wa-font-size-s);
      color: var(--wa-color-text-quiet);
    }

    .tag-icon {
      font-size: var(--wa-font-size-xs);
    }
  `;

  private _emitChange() {
    this.dispatchEvent(
      new CustomEvent('cca-permissions-change', {
        bubbles: true,
        composed: true,
        detail: { access: this.access }
      })
    );
  }

  private _addItem(
    type: 'admin' | 'member',
    field: 'name' | 'roles',
    value: string
  ) {
    const trimmed = value.trim();
    if (!trimmed) return false;

    const currentItems = this.access[type][field];
    if (currentItems.includes(trimmed)) return false;

    this.access = {
      ...this.access,
      [type]: {
        ...this.access[type],
        [field]: [...currentItems, trimmed]
      }
    };
    this._emitChange();
    return true;
  }

  private _removeItem(
    type: 'admin' | 'member',
    field: 'name' | 'roles',
    value: string
  ) {
    this.access = {
      ...this.access,
      [type]: {
        ...this.access[type],
        [field]: this.access[type][field].filter((item) => item !== value)
      }
    };
    this._emitChange();
  }

  private _handleKeyDown(
    e: KeyboardEvent,
    type: 'admin' | 'member',
    field: 'name' | 'roles',
    inputKey:
      | '_adminUserInput'
      | '_adminRoleInput'
      | '_memberUserInput'
      | '_memberRoleInput'
  ) {
    if (e.key === 'Enter') {
      e.preventDefault();
      const input = e.target as HTMLInputElement;
      if (this._addItem(type, field, input.value)) {
        this[inputKey] = '';
      }
    } else if (
      e.key === 'Backspace' &&
      (e.target as HTMLInputElement).value === ''
    ) {
      // Remove last tag when backspace is pressed on empty input
      const items = this.access[type][field];
      if (items.length > 0) {
        this._removeItem(type, field, items[items.length - 1]);
      }
    }
  }

  private _handleBlur(
    e: FocusEvent,
    type: 'admin' | 'member',
    field: 'name' | 'roles',
    inputKey:
      | '_adminUserInput'
      | '_adminRoleInput'
      | '_memberUserInput'
      | '_memberRoleInput'
  ) {
    const input = e.target as HTMLInputElement;
    if (this._addItem(type, field, input.value)) {
      this[inputKey] = '';
    }
  }

  private _focusInput(e: Event) {
    const wrapper = e.currentTarget as HTMLElement;
    const input = wrapper.querySelector('input');
    if (input) input.focus();
  }

  private _renderSection(
    title: string,
    description: string,
    type: 'admin' | 'member'
  ) {
    return html`
      <div class="section">
        <div class="section-title">${title}</div>
        <div class="section-description">${description}</div>

        <div class="subsection-grid">
          <!-- Users subsection -->
          <div class="subsection">
            <div class="subsection-title">Users</div>
            ${
              !this.readonly
                ? html`
                    <div class="subsection-subtitle">
                      Specify users who will have ${type}s access to this
                      database.
                    </div>
                  `
                : ''
            }
            ${
              !this.readonly ? this.renderUsers(type) : this.readOnlyUsers(type)
            }
          </div>

          <!-- Roles subsection -->
          <div class="subsection">
            <div class="subsection-title">Roles</div>
            ${
              !this.readonly
                ? html`
                    <div class="subsection-subtitle">
                      Users with any of the following role(s) will have
                      ${type}s access.
                    </div>
                  `
                : ''
            }
            ${
              !this.readonly
                ? this.renderRoles(type)
                : this.renderReadOnlyRoles(type)
            }
          </div>
        </div>
      </div>
    `;
  }

  private renderRoles(type: 'admin' | 'member') {
    const data = type === 'admin' ? this.access.admin : this.access.member;
    const roleInputKey =
      type === 'admin' ? '_adminRoleInput' : '_memberRoleInput';
    const roleInputValue =
      type === 'admin' ? this._adminRoleInput : this._memberRoleInput;

    return html`
      <div class="tag-input-wrapper" @click=${this._focusInput}>
        ${data.roles.map(
          (role) => html`
            <span class="tag">
              <span class="tag-text">${role}</span>
              <button
                class="tag-remove"
                @click=${(e: Event) => {
                  e.stopPropagation();
                  this._removeItem(type, 'roles', role);
                }}
                aria-label="Remove ${role}"
              >
                <wa-icon name="x" class="tag-icon"></wa-icon>
              </button>
            </span>
          `
        )}
        <input
          class="tag-input"
          type="text"
          placeholder="${
            data.roles.length > 0 ? 'Add role...' : 'Type role and press Enter'
          }"
          .value=${roleInputValue}
          @input=${(e: Event) => {
            this[roleInputKey] = (e.target as HTMLInputElement).value;
          }}
          @keydown=${(e: KeyboardEvent) =>
            this._handleKeyDown(e, type, 'roles', roleInputKey)}
          @blur=${(e: FocusEvent) =>
            this._handleBlur(e, type, 'roles', roleInputKey)}
        />
      </div>
      <div class="textarea-help">
        Press Enter to add. Backspace removes last item.
      </div>
    `;
  }

  private renderReadOnlyRoles(type: 'admin' | 'member') {
    const data = type === 'admin' ? this.access.admin : this.access.member;
    return html`
      <div class="readonly-wrapper">
        ${
          data.roles.length > 0
            ? data.roles.map(
                (role) => html`
                  <span class="tag">
                    <span class="tag-text">${role}</span>
                  </span>
                `
              )
            : html`<span class="readonly-empty">No roles defined</span>`
        }
      </div>
    `;
  }

  private renderUsers(type: 'admin' | 'member') {
    const data = type === 'admin' ? this.access.admin : this.access.member;
    const userInputKey =
      type === 'admin' ? '_adminUserInput' : '_memberUserInput';
    const userInputValue =
      type === 'admin' ? this._adminUserInput : this._memberUserInput;
    return html`
      <div class="tag-input-wrapper" @click=${this._focusInput}>
        ${data.name.map(
          (username) => html`
            <span class="tag">
              <span class="tag-text">${username}</span>
              <button
                class="tag-remove"
                @click=${(e: Event) => {
                  e.stopPropagation();
                  this._removeItem(type, 'name', username);
                }}
                aria-label="Remove ${username}"
              >
                <wa-icon name="x" class="tag-icon"></wa-icon>
              </button>
            </span>
          `
        )}
        <input
          class="tag-input"
          type="text"
          placeholder="${
            data.name.length > 0
              ? 'Add user...'
              : 'Type username and press Enter'
          }"
          .value=${userInputValue}
          @input=${(e: Event) => {
            this[userInputKey] = (e.target as HTMLInputElement).value;
          }}
          @keydown=${(e: KeyboardEvent) =>
            this._handleKeyDown(e, type, 'name', userInputKey)}
          @blur=${(e: FocusEvent) =>
            this._handleBlur(e, type, 'name', userInputKey)}
        />
      </div>
      <div class="textarea-help">
        Press Enter to add. Backspace removes last item.
      </div>
    `;
  }

  private readOnlyUsers(type: 'admin' | 'member') {
    const data = type === 'admin' ? this.access.admin : this.access.member;
    return html`
      <div class="readonly-wrapper">
        ${
          data.name.length > 0
            ? data.name.map(
                (username) => html`
                  <span class="tag">
                    <span class="tag-text">${username}</span>
                  </span>
                `
              )
            : html`<span class="readonly-empty">No users defined</span>`
        }
      </div>
    `;
  }

  override render() {
    return html`
      ${this._renderSection(
        'Administrators',
        'Database members can access the database. If no members are defined, the database is public.',
        'admin'
      )}
      ${this._renderSection(
        'Members',
        'Database members can access the database. If no members are defined, the database is public.',
        'member'
      )}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'cca-db-permissions': CcaDbPermissions;
  }
}