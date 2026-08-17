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

import { html, nothing } from 'lit';
import { CREDENTIAL_MODE_COPY, type CredentialMode } from '../../services/git/git-credential-store.js';

const CONNECT_GIT_QUERY_PARAM = 'connectGit';
const CONNECT_GIT_QUERY_TRUE = '1';
const DESIGN_DOCS_ALL_SERVERS_PATH = '/design-docs/$all';

/** Route to design-list and request opening the connect-git dialog. */
export function buildConnectGitAccountPath(): string {
  const query = new URLSearchParams({
    [CONNECT_GIT_QUERY_PARAM]: CONNECT_GIT_QUERY_TRUE
  });
  return `${DESIGN_DOCS_ALL_SERVERS_PATH}?${query.toString()}`;
}

/** True when current query requests auto-open of the connect-git dialog. */
export function shouldAutoOpenConnectGitDialog(query: URLSearchParams): boolean {
  const value = query.get(CONNECT_GIT_QUERY_PARAM);
  return value === CONNECT_GIT_QUERY_TRUE || value === 'true';
}

/** State for the connect-git flow dialogs. */
export interface ConnectGitDialogState {
  showProviderDialog: boolean;
  showConnectAccountDialog: boolean;
  connectProvider: 'github' | 'gitlab' | 'bitbucket' | null;
  connectLabel: string;
  connectUsername: string;
  connectToken: string;
  connectBaseUrl: string;
  connectingAccount: boolean;
  /** Where the token is allowed to live (D12) — defaults to `'none'` at every call site below. */
  credentialMode: CredentialMode;
}

/** Callbacks for the connect-git flow dialogs. */
export interface ConnectGitDialogCallbacks {
  onRequestClose: () => void;
  onSelectProvider: (provider: 'github' | 'gitlab' | 'bitbucket') => void;
  onConnectClick: () => void;
  onCancelClick: () => void;
  onLabelChange: (value: string) => void;
  onUsernameChange: (value: string) => void;
  onTokenChange: (value: string) => void;
  onBaseUrlChange: (value: string) => void;
  onCredentialModeChange: (mode: CredentialMode) => void;
}

function providerName(provider: string): string {
  const names: Record<string, string> = {
    github: 'GitHub',
    gitlab: 'GitLab',
    bitbucket: 'Bitbucket'
  };
  return names[provider] ?? provider;
}

function tokenPlaceholder(provider: 'github' | 'gitlab' | 'bitbucket' | null): string {
  if (provider === 'github') return 'ghp_...';
  if (provider === 'gitlab') return 'glpat-...';
  return 'API token';
}

function baseUrlPlaceholder(provider: 'github' | 'gitlab' | 'bitbucket' | null): string {
  if (provider === 'github') return 'https://github.example.com';
  if (provider === 'gitlab') return 'https://gitlab.example.com';
  return 'https://bitbucket.example.com';
}

/**
 * The three-way choice from D12/`CREDENTIAL_MODE_COPY`, kept beside its implementation
 * (`git-credential-store.ts`) so a change to how a token is stored cannot leave this copy stale.
 * `Object.entries` on a `Record` preserves declaration order, which is deliberately `none` first —
 * the option this drawer preselects.
 *
 * Binds `@change`, not `@wa-change` — Web Awesome's radio group fires the native `change` event on
 * selection; `wa-change` never fires on it, a lesson this codebase has paid for once already
 * (`db-list.ts`).
 */
export function renderCredentialModePicker(state: ConnectGitDialogState, callbacks: ConnectGitDialogCallbacks) {
  return html`
    <div>
      <label style="display:block;font-size:var(--wa-font-size-s);font-weight:var(--wa-font-weight-semibold);margin-bottom:0.25rem;">
        Where should the access token be stored?
      </label>
      <wa-radio-group
        name="credential-mode"
        .value=${state.credentialMode}
        @change=${(e: Event) => {
          callbacks.onCredentialModeChange((e.target as HTMLInputElement).value as CredentialMode);
        }}
      >
        ${Object.entries(CREDENTIAL_MODE_COPY).map(
          ([mode, copy]) => html`<wa-radio value=${mode}>${copy.label}</wa-radio>`
        )}
      </wa-radio-group>
      <p style="font-size:var(--wa-font-size-xs);color:var(--wa-color-text-quiet);margin:0.25rem 0 0;">
        ${CREDENTIAL_MODE_COPY[state.credentialMode].caution}
      </p>
    </div>
  `;
}

function renderBitbucketEmailField(state: ConnectGitDialogState, callbacks: ConnectGitDialogCallbacks) {
  if (state.connectProvider !== 'bitbucket') return nothing;

  return html`
    <wa-input
      label="Atlassian Email"
      type="email"
      placeholder="user@example.com"
      .value=${state.connectUsername}
      @input=${(e: Event) => {
        callbacks.onUsernameChange((e.target as HTMLInputElement).value);
      }}
    ></wa-input>
  `;
}

/**
 * Providers shown in the picker. Only GitHub ships in this phase (D11) — `GitProvider` stays
 * provider-neutral for GitLab/Bitbucket to return later, but offering their buttons today would
 * lead to a dead end: every account created for them fails the moment anything tries to use it
 * (`providerFor` throws for any non-`'github'` account).
 */
export const SUPPORTED_PROVIDERS = ['github'] as const;

export function renderProviderDialog(state: ConnectGitDialogState, callbacks: ConnectGitDialogCallbacks) {
  return html`
    <wa-dialog
      label="Select Git Provider"
      ?open=${state.showProviderDialog}
      @wa-request-close=${callbacks.onRequestClose}
    >
      <div style="display:flex;gap:1rem;justify-content:center;padding:1rem;">
        ${SUPPORTED_PROVIDERS.map(
          (provider) => html`
            <wa-button
              appearance="outlined"
              @click=${() => callbacks.onSelectProvider(provider)}
              style="display:flex;flex-direction:column;align-items:center;gap:0.5rem;padding:1rem;min-width:7rem;"
            >
              <wa-icon
                name=${provider}
                family="brands"
                style="font-size: var(--wa-font-size-xl);"
              ></wa-icon>
              <span style="font-size: var(--wa-font-size-s);"
                >${providerName(provider)}</span
              >
            </wa-button>
          `
        )}
      </div>
    </wa-dialog>
  `;
}

export function renderConnectAccountDialog(state: ConnectGitDialogState, callbacks: ConnectGitDialogCallbacks) {
  return html`
    <wa-drawer
      label="Connect ${state.connectProvider ? providerName(state.connectProvider) : 'Git'} Account"
      ?open=${state.showConnectAccountDialog}
      @wa-request-close=${callbacks.onRequestClose}
    >
      <div style="display:flex;flex-direction:column;gap:0.75rem;">
        <wa-input
          label="Account Label"
          placeholder="e.g., work-github"
          .value=${state.connectLabel}
          @input=${(e: Event) => {
            callbacks.onLabelChange((e.target as HTMLInputElement).value);
          }}
        ></wa-input>

        ${renderBitbucketEmailField(state, callbacks)}

        <wa-input
          label="Access Token"
          type="password"
          placeholder=${tokenPlaceholder(state.connectProvider)}
          .value=${state.connectToken}
          @input=${(e: Event) => {
            callbacks.onTokenChange((e.target as HTMLInputElement).value);
          }}
        ></wa-input>

        <wa-input
          label="Base URL (for self-hosted)"
          placeholder=${baseUrlPlaceholder(state.connectProvider)}
          .value=${state.connectBaseUrl}
          @input=${(e: Event) => {
            callbacks.onBaseUrlChange((e.target as HTMLInputElement).value);
          }}
        ></wa-input>

        ${renderCredentialModePicker(state, callbacks)}
      </div>

      <div slot="footer" style="display:flex;gap:0.5rem;justify-content:flex-end;">
        <wa-button appearance="outlined" @click=${callbacks.onCancelClick}
          >Cancel</wa-button
        >
        <wa-button
          variant="brand"
          ?disabled=${state.connectingAccount}
          @click=${callbacks.onConnectClick}
          >${state.connectingAccount ? 'Connecting…' : 'Connect'}</wa-button
        >
      </div>
    </wa-drawer>
  `;
}
