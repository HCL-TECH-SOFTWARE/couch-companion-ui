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

/**
 * Unit tests for the shared connect-git dialog render functions (`connect-git-account-flow.ts`).
 *
 * These are plain functions returning a `TemplateResult`, not a component — rendered into a
 * detached host via `lit`'s own `render()`, the same pattern `repo-overview.test.ts` uses to
 * inspect a `TableColumn.render()` cell.
 */

import { describe, it, expect, vi } from 'vitest';
import { render } from 'lit';
import {
  renderProviderDialog,
  renderConnectAccountDialog,
  type ConnectGitDialogState,
  type ConnectGitDialogCallbacks
} from '../src/plugins/design-mgmt/connect-git-account-flow.js';
import { CREDENTIAL_MODE_COPY } from '../src/services/git/git-credential-store.js';

function baseState(overrides: Partial<ConnectGitDialogState> = {}): ConnectGitDialogState {
  return {
    showProviderDialog: false,
    showConnectAccountDialog: false,
    connectProvider: null,
    connectLabel: '',
    connectUsername: '',
    connectToken: '',
    connectBaseUrl: '',
    connectingAccount: false,
    credentialMode: 'none',
    ...overrides
  };
}

function baseCallbacks(overrides: Partial<ConnectGitDialogCallbacks> = {}): ConnectGitDialogCallbacks {
  return {
    onRequestClose: vi.fn(),
    onSelectProvider: vi.fn(),
    onConnectClick: vi.fn(),
    onCancelClick: vi.fn(),
    onLabelChange: vi.fn(),
    onUsernameChange: vi.fn(),
    onTokenChange: vi.fn(),
    onBaseUrlChange: vi.fn(),
    onCredentialModeChange: vi.fn(),
    ...overrides
  };
}

function mount(template: unknown): HTMLElement {
  const host = document.createElement('div');
  render(template as never, host);
  return host;
}

describe('renderProviderDialog', () => {
  it('offers only GitHub — D11 ships no other provider in this phase', () => {
    const host = mount(renderProviderDialog(baseState({ showProviderDialog: true }), baseCallbacks()));
    const icons = Array.from(host.querySelectorAll('wa-icon[family="brands"]')).map((el) =>
      el.getAttribute('name')
    );
    expect(icons).toEqual(['github']);
  });
});

describe('renderConnectAccountDialog — credential mode picker (D12)', () => {
  it('offers exactly the three CREDENTIAL_MODE_COPY options, none preselected', () => {
    const host = mount(
      renderConnectAccountDialog(baseState({ showConnectAccountDialog: true, connectProvider: 'github' }), baseCallbacks())
    );
    const group = host.querySelector('wa-radio-group[name="credential-mode"]') as HTMLElement & { value: string };
    expect(group).not.toBeNull();
    expect(group.value).toBe('none');

    const options = Array.from(host.querySelectorAll('wa-radio')).map((el) => el.getAttribute('value'));
    expect(options).toEqual(['none', 'indexeddb', 'couchdb']);
  });

  it('shows the caution copy for the currently selected mode', () => {
    const host = mount(
      renderConnectAccountDialog(
        baseState({ showConnectAccountDialog: true, connectProvider: 'github', credentialMode: 'couchdb' }),
        baseCallbacks()
      )
    );
    expect(host.textContent).toContain(CREDENTIAL_MODE_COPY.couchdb.caution);
  });

  it('binds @change, not @wa-change — wa-radio-group never fires wa-change', () => {
    const onCredentialModeChange = vi.fn();
    const host = mount(
      renderConnectAccountDialog(
        baseState({ showConnectAccountDialog: true, connectProvider: 'github' }),
        baseCallbacks({ onCredentialModeChange })
      )
    );
    const group = host.querySelector('wa-radio-group[name="credential-mode"]') as HTMLElement & { value: string };

    // Simulate a real wa-radio-group selection: it fires a native `change`.
    Object.defineProperty(group, 'value', { value: 'couchdb', configurable: true });
    group.dispatchEvent(new Event('change', { bubbles: true }));
    expect(onCredentialModeChange).toHaveBeenCalledWith('couchdb');

    // The regression this test exists for: wa-change must NOT be what's wired.
    onCredentialModeChange.mockClear();
    group.dispatchEvent(new CustomEvent('wa-change', { bubbles: true }));
    expect(onCredentialModeChange).not.toHaveBeenCalled();
  });
});
