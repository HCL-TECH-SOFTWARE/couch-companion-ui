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

import { describe, it, expect } from 'vitest';
import { fixture, html } from '@open-wc/testing';
import '../src/plugins/users/cca-change-password-dialog';
import type { CcaChangePasswordDialog } from '../src/plugins/users/cca-change-password-dialog';

async function makeDialog(): Promise<CcaChangePasswordDialog> {
  const el = (await fixture(
    html`<cca-change-password-dialog></cca-change-password-dialog>`,
  )) as CcaChangePasswordDialog;
  el.open();
  await el.updateComplete;
  return el;
}

describe('cca-change-password-dialog', () => {
  it('emits password-confirmed when both fields match', async () => {
    const el = await makeDialog();
    let detail: { password: string } | null = null;
    el.addEventListener('password-confirmed', (e) => {
      detail = (e as CustomEvent<{ password: string }>).detail;
    });
    (el.shadowRoot!.querySelector('wa-input[data-pw]') as HTMLInputElement).value = 'secret1';
    (el.shadowRoot!.querySelector('wa-input[data-pw2]') as HTMLInputElement).value = 'secret1';
    el.shadowRoot!.querySelector<HTMLElement>('wa-button[data-confirm]')!.click();
    expect(detail).toEqual({ password: 'secret1' });
  });

  it('blocks and shows an error when the fields differ', async () => {
    const el = await makeDialog();
    let fired = false;
    el.addEventListener('password-confirmed', () => {
      fired = true;
    });
    (el.shadowRoot!.querySelector('wa-input[data-pw]') as HTMLInputElement).value = 'secret1';
    (el.shadowRoot!.querySelector('wa-input[data-pw2]') as HTMLInputElement).value = 'secret2';
    el.shadowRoot!.querySelector<HTMLElement>('wa-button[data-confirm]')!.click();
    await el.updateComplete;
    expect(fired).toBe(false);
    expect(el.shadowRoot!.textContent).toMatch(/do not match/i);
  });

  it('shows a live green match / red mismatch indicator as fields are typed', async () => {
    const el = await makeDialog();
    const pw = el.shadowRoot!.querySelector('wa-input[data-pw]') as HTMLInputElement;
    const pw2 = el.shadowRoot!.querySelector('wa-input[data-pw2]') as HTMLInputElement;

    pw.value = 'secret1';
    pw.dispatchEvent(new Event('input'));
    pw2.value = 'sec';
    pw2.dispatchEvent(new Event('input'));
    await el.updateComplete;
    let indicator = el.shadowRoot!.querySelector('[data-pw-match]') as HTMLElement;
    expect(indicator).not.toBeNull();
    expect(indicator.textContent).toMatch(/don'?t match|do not match/i);
    expect(indicator.classList.contains('bad')).toBe(true);

    pw2.value = 'secret1';
    pw2.dispatchEvent(new Event('input'));
    await el.updateComplete;
    indicator = el.shadowRoot!.querySelector('[data-pw-match]') as HTMLElement;
    expect(indicator.textContent).toMatch(/match/i);
    expect(indicator.classList.contains('ok')).toBe(true);
  });

  it('blocks when empty', async () => {
    const el = await makeDialog();
    let fired = false;
    el.addEventListener('password-confirmed', () => {
      fired = true;
    });
    el.shadowRoot!.querySelector<HTMLElement>('wa-button[data-confirm]')!.click();
    await el.updateComplete;
    expect(fired).toBe(false);
    expect(el.shadowRoot!.textContent).toMatch(/required/i);
  });
});
