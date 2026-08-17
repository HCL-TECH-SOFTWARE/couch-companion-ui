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
import '../src/plugins/users/cca-roles-picker';
import type { CcaRolesPicker } from '../src/plugins/users/cca-roles-picker';

async function makePicker(selected: string[], candidates: string[]): Promise<CcaRolesPicker> {
  const el = (await fixture(html`<cca-roles-picker></cca-roles-picker>`)) as CcaRolesPicker;
  el.candidates = candidates;
  el.selected = selected;
  await el.updateComplete;
  return el;
}

describe('cca-roles-picker', () => {
  it('renders a pill per candidate, marking selected ones', async () => {
    const el = await makePicker(['reader'], ['reader', 'admin']);
    const pills = [...el.shadowRoot!.querySelectorAll('wa-tag[data-role]')];
    expect(pills.length).toBe(2);
    const reader = el.shadowRoot!.querySelector('wa-tag[data-role="reader"]');
    expect(reader?.getAttribute('appearance')).toBe('accent');
  });

  it('toggling an unselected pill emits roles-change with it added', async () => {
    const el = await makePicker(['reader'], ['reader', 'admin']);
    let detail: string[] | null = null;
    el.addEventListener('roles-change', (e) => {
      detail = (e as CustomEvent<string[]>).detail;
    });
    el.shadowRoot!.querySelector<HTMLElement>('wa-tag[data-role="admin"]')!.click();
    expect(detail).toEqual(['reader', 'admin']);
  });

  it('toggling a selected pill emits roles-change with it removed', async () => {
    const el = await makePicker(['reader', 'admin'], ['reader', 'admin']);
    let detail: string[] | null = null;
    el.addEventListener('roles-change', (e) => {
      detail = (e as CustomEvent<string[]>).detail;
    });
    el.shadowRoot!.querySelector<HTMLElement>('wa-tag[data-role="reader"]')!.click();
    expect(detail).toEqual(['admin']);
  });

  it('the OTHER flow adds a valid custom role', async () => {
    const el = await makePicker([], ['reader']);
    let detail: string[] | null = null;
    el.addEventListener('roles-change', (e) => {
      detail = (e as CustomEvent<string[]>).detail;
    });
    el.shadowRoot!.querySelector<HTMLElement>('wa-tag[data-other]')!.click();
    await el.updateComplete;
    const input = el.shadowRoot!.querySelector('wa-input[data-other-input]') as HTMLInputElement;
    input.value = 'editor';
    el.shadowRoot!.querySelector<HTMLElement>('wa-button[data-other-add]')!.click();
    expect(detail).toEqual(['editor']);
  });

  it('the OTHER flow rejects an illegal system role', async () => {
    const el = await makePicker([], []);
    let fired = false;
    el.addEventListener('roles-change', () => {
      fired = true;
    });
    el.shadowRoot!.querySelector<HTMLElement>('wa-tag[data-other]')!.click();
    await el.updateComplete;
    const input = el.shadowRoot!.querySelector('wa-input[data-other-input]') as HTMLInputElement;
    input.value = '_admin';
    el.shadowRoot!.querySelector<HTMLElement>('wa-button[data-other-add]')!.click();
    await el.updateComplete;
    expect(fired).toBe(false);
    expect(el.shadowRoot!.textContent).toMatch(/system roles/i);
  });
});
