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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getContext } from '../src/context';

// Prevent monaco-editor from initialising in happy-dom
// Must be called before importing the component that transitively pulls in Monaco.
vi.mock('../src/components/cca-monaco-editor.js', () => ({}));

// cca-user-detail.ts itself no longer self-imports these — production gets them from
// webawesome.ts's barrel, loaded once at app boot. This isolated test run needs its own.
import '@awesome.me/webawesome/dist/components/card/card.js';
import '@awesome.me/webawesome/dist/components/input/input.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/spinner/spinner.js';
import '@awesome.me/webawesome/dist/components/tab-group/tab-group.js';
import '@awesome.me/webawesome/dist/components/tab/tab.js';
import '@awesome.me/webawesome/dist/components/tab-panel/tab-panel.js';
import '../src/plugins/users/cca-user-detail';
import type { CcaUserDetail } from '../src/plugins/users/cca-user-detail';

// Register a minimal cca-monaco-editor stub so the component template renders
// when the Raw tab is activated. The real module is mocked above.
if (!customElements.get('cca-monaco-editor')) {
  customElements.define(
    'cca-monaco-editor',
    class extends HTMLElement {
      setValue(_: string) {}
    },
  );
}

async function mount(serverId: string, userId: string): Promise<CcaUserDetail> {
  const el = document.createElement('cca-user-detail') as CcaUserDetail;
  el.serverId = serverId;
  el.userId = userId;
  document.body.appendChild(el);
  await el.updateComplete;
  await new Promise((r) => setTimeout(r, 0));
  await el.updateComplete;
  return el;
}

describe('cca-user-detail', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Provide a peer user carrying a distinct role so collectRoles has data to work with
    vi.spyOn(getContext().users, 'listUsers').mockResolvedValue([
      { _id: 'org.couchdb.user:zoe', name: 'zoe', type: 'user', roles: ['publisher'] },
    ] as any[]);
    // Provide a _security-derived role so the merge has data from both sources
    vi.spyOn(getContext().dbMgmt, 'listDatabaseRoles').mockResolvedValue({
      roles: ['auditor'],
    });
  });

  afterEach(() => {
    document.body.querySelectorAll('cca-user-detail').forEach((e) => e.remove());
  });

  it('create mode: submits a complete user doc with derived _id', async () => {
    const save = vi
      .spyOn(getContext().users, 'saveUser')
      .mockResolvedValue({ id: 'org.couchdb.user:carol', rev: '1-x' });
    vi.spyOn(getContext().router, 'navigate').mockImplementation(() => {});
    const el = await mount('srv1', 'new');

    // roles picker should offer roles gathered from the other users via collectRoles
    const picker = el.shadowRoot!.querySelector('cca-roles-picker') as any;
    expect(picker.candidates).toContain('publisher');

    const nameInput = el.shadowRoot!.querySelector('wa-input[data-name]') as HTMLInputElement;
    nameInput.value = 'carol';
    nameInput.dispatchEvent(new Event('input'));
    (el.shadowRoot!.querySelector('wa-input[data-pw]') as HTMLInputElement).value = 'pw1';
    (el.shadowRoot!.querySelector('wa-input[data-pw2]') as HTMLInputElement).value = 'pw1';
    await el.updateComplete;

    el.shadowRoot!.querySelector<HTMLElement>('wa-button[data-save]')!.click();
    await new Promise((r) => setTimeout(r, 0));

    expect(save).toHaveBeenCalledTimes(1);
    const [serverId, body] = save.mock.calls[0];
    expect(serverId).toBe('srv1');
    expect(body).toMatchObject({
      _id: 'org.couchdb.user:carol',
      name: 'carol',
      type: 'user',
      password: 'pw1',
    });
  });

  it('roles-picker candidates merge _users and _security-derived roles', async () => {
    const el = await mount('srv1', 'new');
    const picker = el.shadowRoot!.querySelector('cca-roles-picker') as any;
    expect(picker.candidates).toContain('publisher');
    expect(picker.candidates).toContain('auditor');
  });

  it('roles-picker candidates: listDatabaseRoles rejecting still offers user-derived roles', async () => {
    vi.spyOn(getContext().dbMgmt, 'listDatabaseRoles').mockRejectedValue(new Error('boom'));
    const el = await mount('srv1', 'new');
    const picker = el.shadowRoot!.querySelector('cca-roles-picker') as any;
    expect(picker.candidates).toContain('publisher');
    expect(picker.candidates).not.toContain('auditor');
  });

  it('roles-picker candidates: listUsers rejecting still offers security-derived roles', async () => {
    vi.spyOn(getContext().users, 'listUsers').mockRejectedValue(new Error('boom'));
    const el = await mount('srv1', 'new');
    const picker = el.shadowRoot!.querySelector('cca-roles-picker') as any;
    expect(picker.candidates).toContain('auditor');
    expect(picker.candidates).not.toContain('publisher');
  });

  it('create mode: forces the username to lowercase as it is typed', async () => {
    const el = await mount('srv1', 'new');
    const nameInput = el.shadowRoot!.querySelector('wa-input[data-name]') as HTMLInputElement;
    nameInput.value = 'Alice';
    nameInput.dispatchEvent(new Event('input'));
    await el.updateComplete;
    const text = el.shadowRoot!.textContent ?? '';
    expect(text).toContain('org.couchdb.user:alice');
    expect(text).not.toContain('org.couchdb.user:Alice');
  });

  it('create mode: strips spaces and disallowed characters from the username', async () => {
    const el = await mount('srv1', 'new');
    const nameInput = el.shadowRoot!.querySelector('wa-input[data-name]') as HTMLInputElement;
    nameInput.value = 'Al ice-1!';
    nameInput.dispatchEvent(new Event('input'));
    await el.updateComplete;
    const text = el.shadowRoot!.textContent ?? '';
    expect(text).toContain('org.couchdb.user:alice-1');
  });

  it('create mode: shows a live green match / red mismatch password indicator', async () => {
    const el = await mount('srv1', 'new');
    const pw = el.shadowRoot!.querySelector('wa-input[data-pw]') as HTMLInputElement;
    const pw2 = el.shadowRoot!.querySelector('wa-input[data-pw2]') as HTMLInputElement;

    // mismatch first
    pw.value = 'secret';
    pw.dispatchEvent(new Event('input'));
    pw2.value = 'sec';
    pw2.dispatchEvent(new Event('input'));
    await el.updateComplete;
    let indicator = el.shadowRoot!.querySelector('[data-pw-match]') as HTMLElement;
    expect(indicator).not.toBeNull();
    expect(indicator.textContent).toMatch(/don'?t match|do not match/i);
    expect(indicator.classList.contains('bad')).toBe(true);

    // now matching
    pw2.value = 'secret';
    pw2.dispatchEvent(new Event('input'));
    await el.updateComplete;
    indicator = el.shadowRoot!.querySelector('[data-pw-match]') as HTMLElement;
    expect(indicator.textContent).toMatch(/match/i);
    expect(indicator.classList.contains('ok')).toBe(true);
  });

  it('create mode: blocks save when passwords differ', async () => {
    const save = vi.spyOn(getContext().users, 'saveUser').mockResolvedValue({ id: 'x', rev: '1' });
    const el = await mount('srv1', 'new');
    const nameInput = el.shadowRoot!.querySelector('wa-input[data-name]') as HTMLInputElement;
    nameInput.value = 'carol';
    nameInput.dispatchEvent(new Event('input'));
    (el.shadowRoot!.querySelector('wa-input[data-pw]') as HTMLInputElement).value = 'pw1';
    (el.shadowRoot!.querySelector('wa-input[data-pw2]') as HTMLInputElement).value = 'pw2';
    el.shadowRoot!.querySelector<HTMLElement>('wa-button[data-save]')!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(save).not.toHaveBeenCalled();
  });

  it('edit mode: preserves _rev and hash fields, name is read-only', async () => {
    vi.spyOn(getContext().users, 'getUser').mockResolvedValue({
      _id: 'org.couchdb.user:dave',
      _rev: '3-abc',
      name: 'dave',
      type: 'user',
      roles: ['reader'],
      derived_key: 'beef',
      salt: 'cafe',
      password_scheme: 'pbkdf2',
      iterations: 10,
    });
    const save = vi
      .spyOn(getContext().users, 'saveUser')
      .mockResolvedValue({ id: 'org.couchdb.user:dave', rev: '4-x' });
    vi.spyOn(getContext().router, 'navigate').mockImplementation(() => {});

    const el = await mount('srv1', 'org.couchdb.user:dave');
    // name field is rendered read-only (no editable wa-input[data-name])
    expect(el.shadowRoot!.querySelector('wa-input[data-name]')).toBeNull();

    el.shadowRoot!.querySelector<HTMLElement>('wa-button[data-save]')!.click();
    await new Promise((r) => setTimeout(r, 0));

    const [, body] = save.mock.calls[0];
    expect(body).toMatchObject({
      _id: 'org.couchdb.user:dave',
      _rev: '3-abc',
      derived_key: 'beef',
      salt: 'cafe',
    });
    expect('password' in (body as object)).toBe(false);
  });

  describe('Source tab (#85)', () => {
    function switchToSource(el: CcaUserDetail) {
      el.shadowRoot!.querySelector('wa-tab-group')!.dispatchEvent(
        new CustomEvent('wa-tab-show', { detail: { name: 'raw' } }),
      );
    }

    function sourceEditor(el: CcaUserDetail): HTMLElement & { value?: string } {
      return el.shadowRoot!.querySelector('cca-monaco-editor') as HTMLElement & {
        value?: string;
      };
    }

    function editSource(el: CcaUserDetail, json: string) {
      sourceEditor(el).dispatchEvent(
        new CustomEvent('change', { detail: { value: json } }),
      );
    }

    it('renders "Source", not "Raw", as the tab label', async () => {
      const el = await mount('srv1', 'new');
      const text = el.shadowRoot!.textContent ?? '';
      expect(text).toContain('Source');
      expect(text).not.toContain('Raw');
    });

    it('is editable — no readOnly on the Source editor', async () => {
      const el = await mount('srv1', 'new');
      switchToSource(el);
      await el.updateComplete;
      expect(sourceEditor(el).hasAttribute('readonly')).toBe(false);
    });

    it('edit mode: saves the edited Source JSON verbatim when the id is unchanged', async () => {
      vi.spyOn(getContext().users, 'getUser').mockResolvedValue({
        _id: 'org.couchdb.user:dave',
        _rev: '3-abc',
        name: 'dave',
        type: 'user',
        roles: ['reader'],
      });
      const save = vi
        .spyOn(getContext().users, 'saveUser')
        .mockResolvedValue({ id: 'org.couchdb.user:dave', rev: '4-x' });
      vi.spyOn(getContext().router, 'navigate').mockImplementation(() => {});

      const el = await mount('srv1', 'org.couchdb.user:dave');
      switchToSource(el);
      await el.updateComplete;

      editSource(
        el,
        JSON.stringify({
          _id: 'org.couchdb.user:dave',
          _rev: '3-abc',
          name: 'dave',
          type: 'user',
          roles: ['reader', 'auditor'],
        }),
      );
      el.shadowRoot!.querySelector<HTMLElement>('wa-button[data-save]')!.click();
      await new Promise((r) => setTimeout(r, 0));

      expect(save).toHaveBeenCalledTimes(1);
      const [, body] = save.mock.calls[0];
      expect(body).toMatchObject({ _id: 'org.couchdb.user:dave', roles: ['reader', 'auditor'] });
    });

    it('edit mode: refuses to save when _id was changed in Source', async () => {
      vi.spyOn(getContext().users, 'getUser').mockResolvedValue({
        _id: 'org.couchdb.user:dave',
        _rev: '3-abc',
        name: 'dave',
        type: 'user',
        roles: ['reader'],
      });
      const save = vi.spyOn(getContext().users, 'saveUser').mockResolvedValue({ id: 'x', rev: '1' });

      const el = await mount('srv1', 'org.couchdb.user:dave');
      switchToSource(el);
      await el.updateComplete;

      editSource(
        el,
        JSON.stringify({
          _id: 'org.couchdb.user:eve',
          _rev: '3-abc',
          name: 'dave',
          type: 'user',
          roles: ['reader'],
        }),
      );
      el.shadowRoot!.querySelector<HTMLElement>('wa-button[data-save]')!.click();
      await new Promise((r) => setTimeout(r, 0));
      await el.updateComplete;

      expect(save).not.toHaveBeenCalled();
      expect(el.shadowRoot!.textContent).toMatch(/_id.*cannot be changed/i);
    });

    it('edit mode: refuses to save invalid JSON typed into Source', async () => {
      vi.spyOn(getContext().users, 'getUser').mockResolvedValue({
        _id: 'org.couchdb.user:dave',
        _rev: '3-abc',
        name: 'dave',
        type: 'user',
        roles: [],
      });
      const save = vi.spyOn(getContext().users, 'saveUser').mockResolvedValue({ id: 'x', rev: '1' });

      const el = await mount('srv1', 'org.couchdb.user:dave');
      switchToSource(el);
      await el.updateComplete;

      editSource(el, '{ not valid json');
      el.shadowRoot!.querySelector<HTMLElement>('wa-button[data-save]')!.click();
      await new Promise((r) => setTimeout(r, 0));
      await el.updateComplete;

      expect(save).not.toHaveBeenCalled();
      expect(el.shadowRoot!.textContent).toMatch(/not contain valid json/i);
    });

    it('edit mode: restores a staged password left as the mask, rather than dropping or submitting it literally', async () => {
      vi.spyOn(getContext().users, 'getUser').mockResolvedValue({
        _id: 'org.couchdb.user:dave',
        _rev: '3-abc',
        name: 'dave',
        type: 'user',
        roles: ['reader'],
      });
      const save = vi
        .spyOn(getContext().users, 'saveUser')
        .mockResolvedValue({ id: 'org.couchdb.user:dave', rev: '4-x' });
      vi.spyOn(getContext().router, 'navigate').mockImplementation(() => {});

      const el = await mount('srv1', 'org.couchdb.user:dave');
      // Stage a new password the same way the Change Password dialog does.
      el.shadowRoot!.querySelector('cca-change-password-dialog')!.dispatchEvent(
        new CustomEvent('password-confirmed', {
          detail: { password: 'new-secret' },
          bubbles: true,
          composed: true,
        }),
      );
      await el.updateComplete;

      switchToSource(el);
      await el.updateComplete;
      // The snapshot taken on tab-switch must show the mask, not the real password.
      expect(sourceEditor(el).value).toContain('••••••');
      expect(sourceEditor(el).value).not.toContain('new-secret');

      // Save without touching the password field in Source.
      el.shadowRoot!.querySelector<HTMLElement>('wa-button[data-save]')!.click();
      await new Promise((r) => setTimeout(r, 0));

      expect(save).toHaveBeenCalledTimes(1);
      const [, body] = save.mock.calls[0];
      expect((body as Record<string, unknown>).password).toBe('new-secret');
    });
  });
});
