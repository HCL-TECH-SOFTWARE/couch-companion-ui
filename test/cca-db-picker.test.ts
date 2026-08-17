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

import { describe, it, expect, afterEach, vi } from 'vitest';
import { LitElement } from 'lit';

// Keep the real Web Awesome controls out of the registry so the stubs below win.
// (Verified against the real components: wa-select dispatches a native
// `change` and wa-input a native `input`, both bubbles+composed — but a real
// wa-select cannot be driven from happy-dom, its option click never commits a
// value, which is why every sibling test stubs it.)
vi.mock('@awesome.me/webawesome/dist/components/select/select.js', () => ({}));
vi.mock('@awesome.me/webawesome/dist/components/option/option.js', () => ({}));
vi.mock('@awesome.me/webawesome/dist/components/input/input.js', () => ({}));

class WaStub extends LitElement {
  value = '';
  createRenderRoot() {
    return this;
  }
}

for (const tag of ['wa-select', 'wa-option', 'wa-input']) {
  if (!customElements.get(tag)) {
    customElements.define(tag, class extends WaStub {});
  }
}

import '../src/components/cca-db-picker';
import type { CcaDbPicker } from '../src/components/cca-db-picker';

async function mount(props: Partial<CcaDbPicker> = {}): Promise<CcaDbPicker> {
  const el = document.createElement('cca-db-picker') as CcaDbPicker;
  Object.assign(el, props);
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

function root(el: CcaDbPicker): ShadowRoot {
  if (!el.shadowRoot) throw new Error('expected shadowRoot');
  return el.shadowRoot;
}

const options = (el: CcaDbPicker) =>
  [...root(el).querySelectorAll('wa-option')].map((o) => o.getAttribute('value'));
const select = (el: CcaDbPicker) =>
  root(el).querySelector('wa-select') as (HTMLElement & { value: string }) | null;
const input = (el: CcaDbPicker) =>
  root(el).querySelector('wa-input') as (HTMLElement & { value: string }) | null;

/** Collects cca-db-change details seen at document level (proves bubbles+composed). */
function listen(): { details: { database: string }[]; stop: () => void } {
  const details: { database: string }[] = [];
  const handler = (e: Event) => details.push((e as CustomEvent<{ database: string }>).detail);
  document.addEventListener('cca-db-change', handler);
  return { details, stop: () => document.removeEventListener('cca-db-change', handler) };
}

describe('cca-db-picker', () => {
  afterEach(() => {
    document.body.querySelectorAll('cca-db-picker').forEach((e) => e.remove());
  });

  it('renders a wa-select with one wa-option per known database', async () => {
    const el = await mount({ databases: ['orders', 'invoices'] });

    expect(select(el)).toBeTruthy();
    expect(input(el)).toBeNull();
    expect(options(el)).toEqual(['orders', 'invoices']);
  });

  it('keeps a value that is absent from the list visible as a synthetic option', async () => {
    const el = await mount({ databases: ['orders'], value: 'legacy_archive' });

    expect(options(el)).toContain('legacy_archive');
    expect(options(el)).toContain('orders');
    expect(select(el)!.value).toBe('legacy_archive');
  });

  it('does not duplicate a value that is already in the list', async () => {
    const el = await mount({ databases: ['orders', 'invoices'], value: 'orders' });

    expect(options(el)).toEqual(['orders', 'invoices']);
  });

  it('renders free text instead of a select when enumeration is unavailable', async () => {
    const el = await mount({
      unavailable: true,
      reason: 'The database list needs admin rights.',
      value: 'orders',
    });

    expect(select(el)).toBeNull();
    expect(input(el)).toBeTruthy();
    expect(input(el)!.value).toBe('orders');
    expect(root(el).textContent).toContain('The database list needs admin rights.');
  });

  it('swaps the select for free text when unavailable flips after mount', async () => {
    const el = await mount({ databases: ['orders'] });
    expect(select(el)).toBeTruthy();

    el.unavailable = true;
    await el.updateComplete;

    expect(select(el)).toBeNull();
    expect(input(el)).toBeTruthy();
  });

  it('emits cca-db-change with the typed name in the unavailable state', async () => {
    const el = await mount({ unavailable: true });
    const seen = listen();

    input(el)!.value = 'typed_by_hand';
    input(el)!.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    seen.stop();

    expect(seen.details).toEqual([{ database: 'typed_by_hand' }]);
    expect(el.value).toBe('typed_by_hand');
  });

  /**
   * Commit semantics, matching a native input and matching the select branch. A host that
   * loads on selection (design-list: selectDatabase -> loadDesignDocs) would otherwise fire
   * one request per letter, each against a half-typed name that 404s. The live text stays
   * readable via `.value` for hosts that want it — e.g. a submit button next to the field.
   */
  it('tracks keystrokes in .value but does not emit until the value is committed', async () => {
    const el = await mount({ unavailable: true });
    const seen = listen();

    input(el)!.value = 'ord';
    input(el)!.dispatchEvent(new Event('input', { bubbles: true, composed: true }));

    expect(seen.details, 'no event while still typing').toEqual([]);
    expect(el.value, 'but the in-progress text is readable').toBe('ord');

    input(el)!.value = 'orders';
    input(el)!.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    seen.stop();

    expect(seen.details).toEqual([{ database: 'orders' }]);
  });

  it('emits cca-db-change with the chosen name in the select state', async () => {
    const el = await mount({ databases: ['orders', 'invoices'] });
    const seen = listen();

    select(el)!.value = 'invoices';
    select(el)!.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    seen.stop();

    expect(seen.details).toEqual([{ database: 'invoices' }]);
    expect(el.value).toBe('invoices');
  });

  it('renders no label of its own in either state', async () => {
    const picker = await mount({ databases: ['orders'] });
    expect(root(picker).querySelector('wa-label')).toBeNull();
    expect(root(picker).querySelector('label')).toBeNull();
    expect(select(picker)!.hasAttribute('label')).toBe(false);

    const free = await mount({ unavailable: true, reason: 'no list' });
    expect(root(free).querySelector('wa-label')).toBeNull();
    expect(root(free).querySelector('label')).toBeNull();
    expect(input(free)!.hasAttribute('label')).toBe(false);
  });

  it('omits the reason element when the host supplies none', async () => {
    const el = await mount({ unavailable: true });

    expect(root(el).querySelector('[data-reason]')).toBeNull();
    expect(input(el)).toBeTruthy();
  });
});
