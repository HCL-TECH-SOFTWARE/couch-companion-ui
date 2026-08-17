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

// Prevent monaco-editor from initialising in happy-dom.
vi.mock('../src/components/cca-monaco-editor.js', () => ({}));

import '../src/components/cca-header';
import '../src/plugins/banner-admin/cca-banner-admin';
import type { CcaBannerAdmin } from '../src/plugins/banner-admin/cca-banner-admin';

// Minimal stub so the Source tab template renders; the real module is mocked above.
if (!customElements.get('cca-monaco-editor')) {
  customElements.define(
    'cca-monaco-editor',
    class extends HTMLElement {
      setValue(_: string) {}
    },
  );
}

let mounted: HTMLElement[] = [];

async function mount(): Promise<CcaBannerAdmin> {
  const header = document.createElement('cca-header');
  document.body.appendChild(header);
  mounted.push(header);

  const el = document.createElement('cca-banner-admin') as CcaBannerAdmin;
  document.body.appendChild(el);
  mounted.push(el);
  await el.updateComplete;
  await new Promise((r) => setTimeout(r, 0));
  await el.updateComplete;
  return el;
}

const table = (el: CcaBannerAdmin) =>
  el.shadowRoot!.querySelector('cca-data-table') as HTMLElement & {
    rows: Record<string, unknown>[];
    updateComplete: Promise<unknown>;
  };

const dialog = (el: CcaBannerAdmin) =>
  el.shadowRoot!.querySelector('wa-dialog[data-edit]') as HTMLElement & { open: boolean };

const field = (el: CcaBannerAdmin, name: string) =>
  el.shadowRoot!.querySelector(`[data-field="${name}"]`) as HTMLInputElement;

const callout = (el: CcaBannerAdmin) =>
  el.shadowRoot!.querySelector('[data-unsaved]') as HTMLElement | null;

describe('cca-banner-admin', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(getContext().bannerAdmin, 'resolveCompanionServerId').mockResolvedValue(
      'srv-companion',
    );
    vi.spyOn(getContext().bannerAdmin, 'getBannerDoc').mockResolvedValue({
      _id: 'BannerMessages',
      _rev: '5-xyz',
      banners: [
        { message: 'Hello', icon: 'bell', link: 'https://x', until: '2026-07-01T12:00:00Z' },
      ],
    });
    vi.spyOn(getContext().bannerAdmin, 'saveBannerDoc').mockResolvedValue({
      id: 'BannerMessages',
      rev: '6-abc',
    } as never);
  });

  afterEach(() => {
    for (const el of mounted) el.remove();
    mounted = [];
  });

  it('loads the document and renders one table row per banner entry', async () => {
    const el = await mount();
    expect(table(el).rows.length).toBe(1);
    expect((table(el).rows[0] as { message: string }).message).toBe('Hello');
  });

  it('renders a link icon (new tab) and strikes through expired entries', async () => {
    vi.spyOn(getContext().bannerAdmin, 'getBannerDoc').mockResolvedValue({
      _id: 'BannerMessages',
      _rev: '1-a',
      banners: [
        { message: 'Past', link: 'https://past', until: '2000-01-01T00:00:00Z' },
        { message: 'Future', until: '2999-01-01T00:00:00Z' },
      ],
    });
    const el = await mount();
    const t = table(el);
    await t.updateComplete;
    const link = t.shadowRoot!.querySelector('a[data-link]') as HTMLAnchorElement;
    expect(link).not.toBeNull();
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('href')).toBe('https://past');
    // The past entry is struck through; the future one is not.
    const expired = t.shadowRoot!.querySelectorAll('span[data-until][data-expired]');
    expect(expired.length).toBe(1);
  });

  it('opens an empty modal via openNew()', async () => {
    const el = await mount();
    el.openNew();
    await el.updateComplete;
    expect(dialog(el).hasAttribute('open')).toBe(true);
    expect(field(el, 'message').value).toBe('');
  });

  it('opens the modal populated when a row is clicked', async () => {
    const el = await mount();
    table(el).dispatchEvent(
      new CustomEvent('cca-row-click', {
        detail: { message: 'Hello', icon: 'bell', link: 'https://x', until: '2026-07-01T12:00:00Z', _index: 0 },
        bubbles: true,
        composed: true,
      }),
    );
    await el.updateComplete;
    expect(dialog(el).hasAttribute('open')).toBe(true);
    expect(field(el, 'message').value).toBe('Hello');
  });

  it('modal Save commits an edit to the table in memory without persisting', async () => {
    const save = vi.spyOn(getContext().bannerAdmin, 'saveBannerDoc');
    const el = await mount();
    // Edit the existing row (its `until` is already valid) so the commit succeeds
    // without depending on the native datetime-local input under happy-dom.
    table(el).dispatchEvent(
      new CustomEvent('cca-row-click', {
        detail: { message: 'Hello', icon: 'bell', link: 'https://x', until: '2026-07-01T12:00:00Z', _index: 0 },
        bubbles: true,
        composed: true,
      }),
    );
    await el.updateComplete;
    field(el, 'message').value = 'Updated';
    field(el, 'message').dispatchEvent(new Event('input'));
    await el.updateComplete;

    el.shadowRoot!.querySelector<HTMLElement>('[data-modal-save]')!.click();
    await el.updateComplete;

    expect(table(el).rows.length).toBe(1);
    expect((table(el).rows[0] as { message: string }).message).toBe('Updated');
    expect(save).not.toHaveBeenCalled();
  });

  it('modal Save with an empty message shows an error and keeps the modal open', async () => {
    const el = await mount();
    el.openNew();
    await el.updateComplete;
    el.shadowRoot!.querySelector<HTMLElement>('[data-modal-save]')!.click();
    await el.updateComplete;

    expect(table(el).rows.length).toBe(1); // nothing added
    expect(dialog(el).hasAttribute('open')).toBe(true);
    expect(el.shadowRoot!.textContent).toMatch(/message is required/i);
  });

  it('modal Delete removes the entry', async () => {
    const el = await mount();
    table(el).dispatchEvent(
      new CustomEvent('cca-row-click', {
        detail: { message: 'Hello', until: '2026-07-01T12:00:00Z', _index: 0 },
        bubbles: true,
        composed: true,
      }),
    );
    await el.updateComplete;
    el.shadowRoot!.querySelector<HTMLElement>('[data-modal-delete]')!.click();
    await el.updateComplete;
    expect(table(el).rows.length).toBe(0);
  });

  it('gives the row-remove button the shared outlined/row-action-button treatment (#112)', async () => {
    const el = await mount();
    const t = table(el);
    await (t as unknown as { updateComplete: Promise<unknown> }).updateComplete;
    const btn = t.shadowRoot!.querySelector('[data-row-remove]')!;

    expect(btn.getAttribute('appearance')).toBe('outlined');
    expect(btn.classList.contains('row-action-button')).toBe(true);
  });

  it('removeEntry drops the row (row trash action)', async () => {
    const el = await mount();
    el.removeEntry(0);
    await el.updateComplete;
    expect(table(el).rows.length).toBe(0);
  });

  it('shows no unsaved-changes reminder on initial load', async () => {
    const el = await mount();
    expect(callout(el)).toBeNull();
  });

  it('shows the unsaved-changes reminder after an edit is committed', async () => {
    const el = await mount();
    table(el).dispatchEvent(
      new CustomEvent('cca-row-click', {
        detail: { message: 'Hello', icon: 'bell', link: 'https://x', until: '2026-07-01T12:00:00Z', _index: 0 },
        bubbles: true,
        composed: true,
      }),
    );
    await el.updateComplete;
    field(el, 'message').value = 'Updated';
    field(el, 'message').dispatchEvent(new Event('input'));
    await el.updateComplete;
    el.shadowRoot!.querySelector<HTMLElement>('[data-modal-save]')!.click();
    await el.updateComplete;

    expect(callout(el)).not.toBeNull();
  });

  it('shows the unsaved-changes reminder after a delete', async () => {
    const el = await mount();
    el.removeEntry(0);
    await el.updateComplete;
    expect(callout(el)).not.toBeNull();
  });

  it('the reminder Save button persists changes and clears the reminder', async () => {
    const save = vi.spyOn(getContext().bannerAdmin, 'saveBannerDoc');
    const el = await mount();
    el.removeEntry(0);
    await el.updateComplete;
    expect(callout(el)).not.toBeNull();

    el.shadowRoot!.querySelector<HTMLElement>('[data-save-changes]')!.click();
    await el.updateComplete;
    await new Promise((r) => setTimeout(r, 0));
    await el.updateComplete;

    expect(save).toHaveBeenCalledTimes(1);
    expect(callout(el)).toBeNull();
  });

  it('save() persists the whole document, preserving _id/_rev and the existing until', async () => {
    const save = vi.spyOn(getContext().bannerAdmin, 'saveBannerDoc');
    const el = await mount();
    await el.save();

    expect(save).toHaveBeenCalledTimes(1);
    const [serverId, body] = save.mock.calls[0];
    expect(serverId).toBe('srv-companion');
    expect(body._id).toBe('BannerMessages');
    expect(body._rev).toBe('5-xyz');
    expect(body.banners).toEqual([
      { message: 'Hello', icon: 'bell', link: 'https://x', until: '2026-07-01T12:00:00Z' },
    ]);
  });
});
