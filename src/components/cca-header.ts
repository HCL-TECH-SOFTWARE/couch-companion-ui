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
import { customElement, property, state } from 'lit/decorators.js';
import { ifDefined } from 'lit/directives/if-defined.js';
import { getLogger } from '../services/log-service.js';
import { getToastHistory } from './cca-toast.js';
import type { ToastHistoryEntry } from './cca-toast.js';
import './cca-action.js';
import './cca-theme-picker.js';
// wa-drawer is NOT self-imported here (unlike this file's other wa-* dependencies):
// cca-shell.ts always loads webawesome.js — which registers it — before it loads this
// module, so production never needs it registered twice. Importing it here as well is
// otherwise harmless in isolation, but shifts Web Awesome's own internal chunk-loading
// order for every OTHER page that pulls in cca-header.ts via addHeaderActions() (e.g.
// repo-overview.ts), which was enough to desync unrelated wa-drawer timing there (see
// test/repo-overview.test.ts's account-edit drawer tests). test/cca-header.test.ts
// imports it directly for this file's own isolated run.
import type { CcaActionVariant } from './cca-action.js';

const log = getLogger('components/cca-header');

/** Describes a dynamic header action button, rendered as a `cca-action`. */
export interface HeaderAction {
  icon: string;
  tooltip?: string;
  label?: string;
  variant?: CcaActionVariant;
  disabled?: boolean;
  action: (event: Event) => void;
  id?: string;
}

/** Live singleton so submodules can reach the header without a cross-shadow ref. */
let _instance: CcaHeader | null = null;

@customElement('cca-header')
export class CcaHeader extends LitElement {
  static styles = css`
    :host {
      display: flex;
      align-items: center;
      justify-content: space-between;
      width: 100%;
      padding: 0 var(--wa-space-l) !important;
      gap: var(--wa-space-m);
    }

    .title {
      color: var(--wa-color-text-normal);
      flex: 0 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: var(--wa-font-size-l);
      font-weight: var(--wa-font-weight-bold);
    }

    .actions {
      display: flex;
      align-items: center;
      gap: 0.25rem;
      flex: 0 0 auto;
      min-height: var(--wa-form-control-height);
      white-space: nowrap;
    }

    .subactions {
      display: flex;
      align-items: center;
      gap: 0.25rem;
    }

    .separator {
      color: var(--wa-color-text-quiet);
      padding: 0 0.25rem;
    }

    .notification-list {
      display: flex;
      flex-direction: column;
      gap: var(--wa-space-xs);
      margin: 0;
      padding: 0;
      list-style: none;
    }

    .notification-entry {
      display: flex;
      flex-direction: column;
      gap: var(--wa-space-2xs);
      padding: var(--wa-space-s);
      border-radius: var(--wa-border-radius-m);
      border-inline-start: var(--wa-border-width-l) var(--wa-border-style)
        var(--wa-color-neutral-border-normal);
      background-color: var(--wa-color-surface-lowered);
    }

    .notification-entry.success {
      border-inline-start-color: var(--wa-color-success-border-normal);
    }

    .notification-entry.error {
      border-inline-start-color: var(--wa-color-danger-border-normal);
    }

    .notification-text {
      color: var(--wa-color-text-normal);
      font-size: var(--wa-font-size-s);
    }

    .notification-time {
      color: var(--wa-color-text-quiet);
      font-size: var(--wa-font-size-2xs);
    }

    .notification-empty {
      color: var(--wa-color-text-quiet);
      font-size: var(--wa-font-size-s);
    }
  `;

  @property({ type: String }) accessor pageTitle = '';

  @state() private actions: HeaderAction[] = [];
  /** Optional title that takes precedence over the route-bound `pageTitle`. */
  @state() private titleOverride: string | null = null;
  /** Whether the notifications drawer (#53) is open. */
  @state() private notificationsOpen = false;
  /** Snapshot of the toast history, taken when the drawer opens. */
  @state() private notificationHistory: ToastHistoryEntry[] = [];

  connectedCallback() {
    super.connectedCallback();
    _instance = this;
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (_instance === this) {
      _instance = null;
    }
  }

  /** Appends one dynamic action to the left of the fixed buttons. */
  addAction(action: HeaderAction) {
    this.actions = [...this.actions, action];
  }

  /** Appends multiple dynamic actions to the left of the fixed buttons. */
  addActions(actions: HeaderAction[]) {
    this.actions = [...this.actions, ...actions];
  }

  /** Removes all dynamic actions. */
  clearActions() {
    this.actions = [];
  }

  /** Overrides the route-bound title (e.g. a context-specific page name). */
  setTitle(title: string) {
    this.titleOverride = title;
  }

  /** Drops the title override, restoring the route-bound `pageTitle`. */
  clearTitle() {
    this.titleOverride = null;
  }

  /** Opens the notifications drawer, snapshotting the toast history (#53). */
  private handleOpenNotifications = () => {
    this.notificationHistory = getToastHistory();
    this.notificationsOpen = true;
  };

  private renderNotificationEntry(entry: ToastHistoryEntry) {
    return html`
      <li class="notification-entry ${entry.variant}">
        <span class="notification-text">${entry.text}</span>
        <span class="notification-time">${new Date(entry.timestamp).toLocaleString()}</span>
      </li>
    `;
  }

  render() {
    // No server control lives here: this deployment manages exactly one
    // CouchDB, so there is nothing to pick and nothing worth naming (#31).
    return html`
      <div class="title">${this.titleOverride ?? this.pageTitle}</div>
      <div class="actions">
        <div class="subactions">
          ${this.actions.map(
            (a) =>
              html`<cca-action
                id=${ifDefined(a.id)}
                icon=${a.icon}
                tooltip=${a.tooltip ?? a.icon}
                label=${a.label ?? a.icon}
                variant=${a.variant ?? 'brand'}
                ?disabled=${a.disabled ?? false}
                .action=${a.action}></cca-action>`
          )}
        </div>
        ${this.actions.length ? html`<span class="separator">|</span>` : nothing}
        <cca-theme-picker></cca-theme-picker>
        <cca-action
          icon="bell"
          tooltip="Notifications"
          variant="brand"
          .action=${this.handleOpenNotifications}></cca-action>
      </div>
      <wa-drawer
        label="Notifications"
        ?open=${this.notificationsOpen}
        @wa-after-hide=${(e: Event) => {
          if (e.target === e.currentTarget) this.notificationsOpen = false;
        }}>
        ${this.notificationHistory.length
          ? html`<ul class="notification-list">
              ${this.notificationHistory.map((entry) => this.renderNotificationEntry(entry))}
            </ul>`
          : html`<p class="notification-empty">No notifications yet.</p>`}
      </wa-drawer>
    `;
  }
}

/** Resolves the live cca-header instance, falling back to a DOM query. */
function resolveHeader(): CcaHeader | null {
  if (!_instance) {
    _instance = document.querySelector('cca-header');
  }
  return _instance;
}

/** Appends one action to the header. No-op (with a warning) if no header is mounted. */
export function addHeaderAction(action: HeaderAction) {
  const header = resolveHeader();
  if (!header) {
    log.warn('addHeaderAction: no cca-header mounted');
    return;
  }
  header.addAction(action);
}

/** Appends multiple actions to the header. No-op (with a warning) if no header is mounted. */
export function addHeaderActions(actions: HeaderAction[]) {
  const header = resolveHeader();
  if (!header) {
    log.warn('addHeaderActions: no cca-header mounted');
    return;
  }
  header.addActions(actions);
}

/** Clears all dynamic actions from the header. No-op (with a warning) if no header is mounted. */
export function clearHeaderActions() {
  const header = resolveHeader();
  if (!header) {
    log.warn('clearHeaderActions: no cca-header mounted');
    return;
  }
  header.clearActions();
}

/** Overrides the header title. No-op (with a warning) if no header is mounted. */
export function setHeaderTitle(title: string) {
  const header = resolveHeader();
  if (!header) {
    log.warn('setHeaderTitle: no cca-header mounted');
    return;
  }
  header.setTitle(title);
}

/** Clears the header title override, restoring the route-bound title. No-op (with a warning) if no header is mounted. */
export function clearHeaderTitle() {
  const header = resolveHeader();
  if (!header) {
    log.warn('clearHeaderTitle: no cca-header mounted');
    return;
  }
  header.clearTitle();
}
