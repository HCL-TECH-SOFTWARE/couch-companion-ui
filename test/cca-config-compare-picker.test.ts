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
import '../src/components/cca-toast';
import type { CcaToast } from '../src/components/cca-toast';
import '../src/plugins/config/cca-config-compare-picker';
import type { CcaConfigComparePicker } from '../src/plugins/config/cca-config-compare-picker';

/**
 * Real Erlang node names on purpose: the `@` and the dots are what end up inside the
 * `[data-node="…"]` attribute selectors the component's own tests (and any consumer) use
 * to find a checkbox, so the fixture has to exercise them rather than tidy ids like `n1`.
 */
const N1 = 'couchdb@couchdb1.ccui.local';
const N2 = 'couchdb@couchdb2.ccui.local';
const N3 = 'couchdb@couchdb3.ccui.local';
const N4 = 'couchdb@couchdb4.ccui.local';
const N5 = 'couchdb@couchdb5.ccui.local';

const NODES = [
  { name: N1, reachable: true },
  { name: N2, reachable: true },
  { name: N3, reachable: false },
  { name: N4, reachable: true },
  { name: N5, reachable: true }
];

let mounted: HTMLElement[] = [];

async function mount(preselectedNodes: string[] = []): Promise<CcaConfigComparePicker> {
  const el = document.createElement('cca-config-compare-picker') as CcaConfigComparePicker;
  el.preselectedNodes = preselectedNodes;
  document.body.appendChild(el);
  mounted.push(el);
  el.open = true;
  await el.updateComplete;
  await new Promise((r) => setTimeout(r, 0));
  await el.updateComplete;
  return el;
}

function checkbox(el: CcaConfigComparePicker, name: string): HTMLInputElement {
  return el.shadowRoot!.querySelector(`[data-node="${name}"]`) as HTMLInputElement;
}

function confirmButton(el: CcaConfigComparePicker): HTMLElement {
  return el.shadowRoot!.querySelector('[data-confirm]') as HTMLElement;
}

async function check(el: CcaConfigComparePicker, name: string, value: boolean) {
  const cb = checkbox(el, name);
  cb.checked = value;
  cb.dispatchEvent(new Event('change'));
  await el.updateComplete;
}

describe('cca-config-compare-picker', () => {
  let listNodes: ReturnType<typeof vi.spyOn>;
  let toastEl: CcaToast;

  beforeEach(async () => {
    vi.restoreAllMocks();
    // Mounted before anything can toast: toast() buffers messages while no <cca-toast> exists
    // and flushes them into the next host to connect, which would leak toasts across tests.
    toastEl = document.createElement('cca-toast') as CcaToast;
    document.body.appendChild(toastEl);
    mounted.push(toastEl);
    await toastEl.updateComplete;

    listNodes = vi
      .spyOn(getContext().membership, 'listNodes')
      .mockResolvedValue(NODES.map((n) => ({ ...n })));
  });

  afterEach(() => {
    for (const el of mounted) el.remove();
    mounted = [];
  });

  const toastText = (variant: 'success' | 'error'): string | undefined =>
    toastEl.shadowRoot!.querySelector(`.toast.${variant}`)?.textContent ?? undefined;

  it('lists every cluster node from a mocked membership.listNodes when opened', async () => {
    const el = await mount();
    expect(listNodes).toHaveBeenCalledTimes(1);
    const rows = el.shadowRoot!.querySelectorAll('[data-node]');
    expect(rows.length).toBe(NODES.length);
    expect(el.shadowRoot!.textContent).toContain(N1);
    expect(el.shadowRoot!.textContent).toContain(N5);
  });

  it('pre-checks preselectedNodes; confirm stays disabled with only 1 preselected', async () => {
    const el = await mount([N1]);
    expect(checkbox(el, N1).checked).toBe(true);
    expect(checkbox(el, N2).checked).toBe(false);
    expect(confirmButton(el).hasAttribute('disabled')).toBe(true);
  });

  it('ignores preselected names that are not nodes of this cluster', async () => {
    const el = await mount([N1, 'couchdb@ghost.ccui.local']);
    expect(checkbox(el, N1).checked).toBe(true);
    expect(el.shadowRoot!.querySelectorAll('[data-node]').length).toBe(NODES.length);
    // Only the known node counted, so confirm is still one short of the minimum.
    expect(confirmButton(el).hasAttribute('disabled')).toBe(true);
    expect(el.shadowRoot!.querySelector('[data-count]')?.textContent).toMatch(/1 of 4/);
  });

  it('checking a 2nd node enables confirm, which dispatches compare-confirm with both names', async () => {
    const el = await mount([N1]);
    await check(el, N2, true);
    expect(confirmButton(el).hasAttribute('disabled')).toBe(false);

    const listener = vi.fn();
    el.addEventListener('compare-confirm', listener);
    confirmButton(el).click();

    expect(listener).toHaveBeenCalledTimes(1);
    const event = listener.mock.calls[0][0] as CustomEvent<{ nodes: string[] }>;
    expect(event.detail).toEqual({ nodes: [N1, N2] });
    expect(event.bubbles).toBe(true);
    expect(event.composed).toBe(true);

    await el.updateComplete;
    expect(el.open).toBe(false);
  });

  it('reports the checked nodes in list order, not in the order they were checked', async () => {
    const el = await mount();
    await check(el, N4, true);
    await check(el, N2, true);

    const listener = vi.fn();
    el.addEventListener('compare-confirm', listener);
    confirmButton(el).click();

    const event = listener.mock.calls[0][0] as CustomEvent<{ nodes: string[] }>;
    expect(event.detail.nodes).toEqual([N2, N4]);
  });

  it('disables remaining unchecked checkboxes once 4 are checked, but keeps checked ones enabled', async () => {
    const el = await mount([N1, N2, N3, N4]);
    expect(checkbox(el, N5).hasAttribute('disabled')).toBe(true);
    expect(checkbox(el, N1).hasAttribute('disabled')).toBe(false);
    expect(confirmButton(el).hasAttribute('disabled')).toBe(false);
  });

  it('shows the single-node message and disables confirm when the cluster has one node', async () => {
    listNodes.mockResolvedValue([{ name: N1, reachable: true }] as never);
    const el = await mount();
    const tooFew = el.shadowRoot!.querySelector('[data-too-few]');
    expect(tooFew).not.toBeNull();
    expect(tooFew?.textContent).toMatch(/at least 2 nodes/i);
    expect(tooFew?.textContent).toMatch(/single node/i);
    expect(el.shadowRoot!.querySelectorAll('[data-node]').length).toBe(0);
    expect(confirmButton(el).hasAttribute('disabled')).toBe(true);
  });

  it('cancel dispatches compare-cancel and closes without confirming', async () => {
    const el = await mount([N1, N2]);
    const cancelListener = vi.fn();
    const confirmListener = vi.fn();
    el.addEventListener('compare-cancel', cancelListener);
    el.addEventListener('compare-confirm', confirmListener);

    const cancelBtn = el.shadowRoot!.querySelector('[data-cancel]') as HTMLElement;
    cancelBtn.click();

    expect(cancelListener).toHaveBeenCalledTimes(1);
    expect(confirmListener).not.toHaveBeenCalled();
    await el.updateComplete;
    expect(el.open).toBe(false);
  });

  it('dismissing the dialog itself dispatches compare-cancel', async () => {
    const el = await mount([N1, N2]);
    const cancelListener = vi.fn();
    el.addEventListener('compare-cancel', cancelListener);

    const dialog = el.shadowRoot!.querySelector('wa-dialog') as HTMLElement;
    dialog.dispatchEvent(new Event('wa-after-hide'));

    expect(cancelListener).toHaveBeenCalledTimes(1);
    await el.updateComplete;
    expect(el.open).toBe(false);
  });

  it('shows a running count of how many nodes are selected', async () => {
    const el = await mount([N1]);
    const count = el.shadowRoot!.querySelector('[data-count]');
    expect(count?.textContent).toMatch(/1 of 4/);
    await check(el, N2, true);
    const countAfter = el.shadowRoot!.querySelector('[data-count]');
    expect(countAfter?.textContent).toMatch(/2 of 4/);
  });

  it('unchecking a node drops it from the selection and can re-disable confirm', async () => {
    const el = await mount([N1, N2]);
    expect(confirmButton(el).hasAttribute('disabled')).toBe(false);
    await check(el, N2, false);
    expect(checkbox(el, N2).checked).toBe(false);
    expect(confirmButton(el).hasAttribute('disabled')).toBe(true);
    const count = el.shadowRoot!.querySelector('[data-count]');
    expect(count?.textContent).toMatch(/1 of 4/);
  });

  it('caches the node list: only calls listNodes once across repeated opens', async () => {
    const el = await mount();
    el.open = false;
    await el.updateComplete;
    el.open = true;
    await el.updateComplete;
    await new Promise((r) => setTimeout(r, 0));
    await el.updateComplete;
    expect(listNodes).toHaveBeenCalledTimes(1);
  });

  it('toasts and stays usable when listNodes rejects, e.g. _membership is admin-only', async () => {
    listNodes.mockRejectedValue(new Error('401 Unauthorized'));
    const el = await mount();
    await toastEl.updateComplete;

    expect(toastText('error')).toMatch(/401 Unauthorized/);
    // No node list, so the picker falls back to the nothing-to-compare body rather than crashing.
    expect(el.shadowRoot!.querySelectorAll('[data-node]').length).toBe(0);
    expect(el.shadowRoot!.querySelector('[data-too-few]')).not.toBeNull();
    expect(confirmButton(el).hasAttribute('disabled')).toBe(true);
  });
});
