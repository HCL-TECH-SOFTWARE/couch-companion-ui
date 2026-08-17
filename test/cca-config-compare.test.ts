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

import '../src/components/cca-header';
import '../src/components/cca-toast';
import '../src/plugins/config/cca-config-compare';
import type { CcaConfigCompare } from '../src/plugins/config/cca-config-compare';
import type { CcaConfigCompareTable } from '../src/plugins/config/cca-config-compare-table';
import type { CcaHeader } from '../src/components/cca-header';
import type { CcaToast } from '../src/components/cca-toast';
import type { NodeConfig } from '../src/plugins/config/types';

// Real Erlang node names throughout: the `@` and the dots travel through the
// `?nodes=` query param, the column ids and the `[data-cell="…"]` selectors, so
// a fixture like 'a' would test a shape this feature never sees.
const NODE_A = 'couchdb@couchdb1.ccui.local';
const NODE_B = 'couchdb@couchdb2.ccui.local';
const NODE_C = 'couchdb@couchdb3.ccui.local';

const CONFIG_A: NodeConfig = { httpd: { port: '5984', bind_address: 'any' } };
const CONFIG_B: NodeConfig = { httpd: { port: '5984', bind_address: '0.0.0.0' } };
const CONFIG_C: NodeConfig = { httpd: { port: '5984', bind_address: '127.0.0.1' } };

let mounted: HTMLElement[] = [];
let header: CcaHeader;
let toastHost: CcaToast;

async function flush(el: CcaConfigCompare) {
  await el.updateComplete;
  await new Promise((r) => setTimeout(r, 0));
  await el.updateComplete;
}

async function mount(nodes = `${NODE_A},${NODE_B}`): Promise<CcaConfigCompare> {
  window.location.hash = `#/configuration/compare?nodes=${nodes}`;

  header = document.createElement('cca-header') as CcaHeader;
  document.body.appendChild(header);
  mounted.push(header);

  const el = document.createElement('cca-config-compare') as CcaConfigCompare;
  document.body.appendChild(el);
  mounted.push(el);
  await flush(el);
  return el;
}

const table = (el: CcaConfigCompare) =>
  el.shadowRoot!.querySelector('cca-config-compare-table') as CcaConfigCompareTable;

const dialog = (el: CcaConfigCompare, sel: string) =>
  el.shadowRoot!.querySelector(sel) as (HTMLElement & { open: boolean }) | null;

/** Reads the rendered value cell for a given (key, node) from the compare table. */
function cellText(el: CcaConfigCompare, key: string, node: string): string | null {
  const rows = table(el).shadowRoot!.querySelectorAll('[data-row]');
  for (const row of rows) {
    if (row.querySelector('.key-cell')?.textContent?.trim() === key) {
      return row.querySelector(`[data-cell="${node}"] [data-value]`)?.textContent?.trim() ?? null;
    }
  }
  return null;
}

function configFor(node: string): NodeConfig {
  if (node === NODE_A) return structuredClone(CONFIG_A);
  if (node === NODE_B) return structuredClone(CONFIG_B);
  return structuredClone(CONFIG_C);
}

function copyEvent(sourceNode: string): CustomEvent {
  return new CustomEvent('cell-copy', {
    detail: { section: 'httpd', key: 'bind_address', sourceNode, value: 'any' },
    bubbles: true,
    composed: true
  });
}

function editEvent(node: string): CustomEvent {
  return new CustomEvent('cell-edit', {
    detail: { section: 'httpd', key: 'port', node, value: '5984' },
    bubbles: true,
    composed: true
  });
}

describe('cca-config-compare', () => {
  beforeEach(async () => {
    // Mounted for every test, not just the ones that assert on it: `toast()` buffers
    // messages while no host is mounted and replays them into the next one, so a test
    // without a host leaks its toasts into whichever later test mounts one.
    toastHost = document.createElement('cca-toast') as CcaToast;
    document.body.appendChild(toastHost);
    mounted.push(toastHost);
    await toastHost.updateComplete;

    vi.restoreAllMocks();
    vi.spyOn(getContext().membership, 'listNodes').mockResolvedValue([
      { name: NODE_A, reachable: true },
      { name: NODE_B, reachable: true },
      { name: NODE_C, reachable: false }
    ]);
    vi.spyOn(getContext().config, 'getNodeConfig').mockImplementation((node: string) =>
      Promise.resolve(configFor(node))
    );
    vi.spyOn(getContext().config, 'setNodeConfigValue').mockResolvedValue('old');
    vi.spyOn(getContext().router, 'navigate').mockImplementation(() => {});
  });

  afterEach(() => {
    // Reverse order: the compare element goes first so its disconnect still finds the
    // header it has to clear the title and actions from.
    for (const el of mounted.reverse()) el.remove();
    mounted = [];
    window.location.hash = '';
  });

  it('renders a compare table with one column per node and counts differing rows in the summary', async () => {
    const el = await mount();
    const t = table(el);
    expect(t).not.toBeNull();
    expect(t.columns.length).toBe(2);
    expect(t.columns.map((c) => c.id)).toEqual([NODE_A, NODE_B]);
    // The column label is the node name, not a registered server's display name.
    expect(t.columns.map((c) => c.name)).toEqual([NODE_A, NODE_B]);
    // port matches, bind_address differs -> 1 of 2 rows differ.
    const summary = el.shadowRoot!.querySelector('[data-summary]');
    expect(summary?.textContent).toMatch(/Differs:\s*1/);
    expect(summary?.textContent).toMatch(/Total:\s*2/);
  });

  it('reads each node with getNodeConfig, never the request-local _config', async () => {
    const getSpy = vi.spyOn(getContext().config, 'getNodeConfig');
    await mount(`${NODE_A},${NODE_B}`);
    expect(getSpy.mock.calls.map((c) => c[0]).sort()).toEqual([NODE_A, NODE_B]);
  });

  it('takes column reachability from _membership', async () => {
    const el = await mount(`${NODE_A},${NODE_C}`);
    expect(table(el).columns.map((c) => c.reachable)).toEqual([true, false]);
  });

  it('still compares when _membership is refused, showing every node as not connected', async () => {
    // `_membership` is admin-only and 401s for everyone else; the comparison is the point,
    // the connected dots are decoration, so a rejection must not take the screen down.
    vi.spyOn(getContext().membership, 'listNodes').mockRejectedValue(new Error('unauthorized'));
    const el = await mount();
    const t = table(el);
    expect(t).not.toBeNull();
    expect(t.columns.map((c) => c.reachable)).toEqual([false, false]);
    expect(cellText(el, 'bind_address', NODE_A)).toBe('any');
  });

  it('marks a column error and still renders the others when one node config fails to load', async () => {
    vi.spyOn(getContext().config, 'getNodeConfig').mockImplementation((node: string) =>
      node === NODE_B ? Promise.reject(new Error('nodedown')) : Promise.resolve(configFor(node))
    );
    const el = await mount();
    const t = table(el);
    expect(t.columns[0].error).toBeFalsy();
    expect(t.columns[1].error).toBe(true);
    // The errored node contributes only undefined values -> muted em dashes...
    const dash = t.shadowRoot!.querySelector(`[data-cell="${NODE_B}"] [data-empty-value]`);
    expect(dash?.textContent?.trim()).toBe('—');
    // ...while the reachable node still shows its own values.
    expect(cellText(el, 'bind_address', NODE_A)).toBe('any');
  });

  it('opens the edit modal on cell-edit and saves against the right node, reloading it', async () => {
    const setSpy = vi.spyOn(getContext().config, 'setNodeConfigValue');
    const getSpy = vi.spyOn(getContext().config, 'getNodeConfig');
    const el = await mount();
    const initialA = getSpy.mock.calls.filter((c) => c[0] === NODE_A).length;

    table(el).dispatchEvent(editEvent(NODE_A));
    await el.updateComplete;
    expect(dialog(el, '[data-edit-dialog]')?.hasAttribute('open')).toBe(true);

    const input = el.shadowRoot!.querySelector('[data-value-input]') as HTMLInputElement;
    input.value = '6984';
    input.dispatchEvent(new Event('input'));
    await el.updateComplete;

    await el.saveEdit();
    expect(setSpy).toHaveBeenCalledWith(NODE_A, 'httpd', 'port', '6984');
    // Never the other node.
    expect(setSpy).toHaveBeenCalledTimes(1);
    // Reloaded only the edited node.
    expect(getSpy.mock.calls.filter((c) => c[0] === NODE_A).length).toBe(initialA + 1);
    expect(getSpy.mock.calls.filter((c) => c[0] === NODE_B).length).toBe(1);
  });

  it('keeps the edit modal open and surfaces the error when saving a value fails', async () => {
    vi.spyOn(getContext().config, 'setNodeConfigValue').mockRejectedValue(
      new Error('validation failed')
    );
    const getSpy = vi.spyOn(getContext().config, 'getNodeConfig');
    const el = await mount();
    const initialA = getSpy.mock.calls.filter((c) => c[0] === NODE_A).length;

    table(el).dispatchEvent(editEvent(NODE_A));
    await el.updateComplete;
    expect(dialog(el, '[data-edit-dialog]')?.hasAttribute('open')).toBe(true);

    await el.saveEdit();
    await el.updateComplete;

    // The modal stays open (only a successful save clears `_edit`)...
    expect(dialog(el, '[data-edit-dialog]')?.hasAttribute('open')).toBe(true);
    // ...and the error is surfaced in the modal.
    const errorEl = el.shadowRoot!.querySelector('[data-edit-error]');
    expect(errorEl?.textContent).toMatch(/validation failed/);

    // No reload was attempted since the save failed.
    expect(getSpy.mock.calls.filter((c) => c[0] === NODE_A).length).toBe(initialA);
  });

  it('reloads the edited node after a successful save and shows the new value', async () => {
    let aCalls = 0;
    vi.spyOn(getContext().config, 'getNodeConfig').mockImplementation((node: string) => {
      if (node === NODE_A) {
        aCalls++;
        // First call is the initial load; the second is the post-save reload.
        return Promise.resolve(
          aCalls === 1
            ? structuredClone(CONFIG_A)
            : ({ httpd: { port: '6984', bind_address: 'any' } } as NodeConfig)
        );
      }
      return Promise.resolve(configFor(node));
    });

    const el = await mount();
    expect(cellText(el, 'port', NODE_A)).toBe('5984');

    table(el).dispatchEvent(editEvent(NODE_A));
    await el.updateComplete;

    const input = el.shadowRoot!.querySelector('[data-value-input]') as HTMLInputElement;
    input.value = '6984';
    input.dispatchEvent(new Event('input'));
    await el.updateComplete;

    await el.saveEdit();
    await el.updateComplete;

    expect(cellText(el, 'port', NODE_A)).toBe('6984');
    // The other node is untouched — a per-node write must not look cluster-wide.
    expect(cellText(el, 'port', NODE_B)).toBe('5984');
  });

  it('labels the copy dialog "Copy value to other nodes" and lists the other nodes as targets', async () => {
    const el = await mount(`${NODE_A},${NODE_B}`);

    table(el).dispatchEvent(copyEvent(NODE_A));
    await el.updateComplete;

    const copyDialog = dialog(el, '[data-copy-dialog]');
    expect(copyDialog?.getAttribute('label')).toBe('Copy value to other nodes');
    expect(el.shadowRoot!.querySelector('[data-copy-targets]')?.textContent?.trim()).toBe(NODE_B);
  });

  it('copies a cell value to every other node on confirm', async () => {
    const setSpy = vi.spyOn(getContext().config, 'setNodeConfigValue');
    const el = await mount(`${NODE_A},${NODE_B},${NODE_C}`);

    table(el).dispatchEvent(copyEvent(NODE_A));
    await el.updateComplete;
    expect(dialog(el, '[data-copy-dialog]')?.hasAttribute('open')).toBe(true);

    await el.confirmCopy();
    expect(setSpy).toHaveBeenCalledWith(NODE_B, 'httpd', 'bind_address', 'any');
    expect(setSpy).toHaveBeenCalledWith(NODE_C, 'httpd', 'bind_address', 'any');
    expect(setSpy).not.toHaveBeenCalledWith(NODE_A, 'httpd', 'bind_address', 'any');
    expect(setSpy).toHaveBeenCalledTimes(2);
  });

  it('pluralises the success toast by the number of nodes written', async () => {
    const el = await mount(`${NODE_A},${NODE_B},${NODE_C}`);

    table(el).dispatchEvent(copyEvent(NODE_A));
    await el.updateComplete;
    await el.confirmCopy();
    await toastHost.updateComplete;

    expect(toastHost.shadowRoot!.querySelector('.toast.success')?.textContent).toMatch(
      /Applied to 2 nodes\./
    );
  });

  it('uses the singular "node" when exactly one other node was written', async () => {
    const el = await mount(`${NODE_A},${NODE_B}`);

    table(el).dispatchEvent(copyEvent(NODE_A));
    await el.updateComplete;
    await el.confirmCopy();
    await toastHost.updateComplete;

    const text = toastHost.shadowRoot!.querySelector('.toast.success')?.textContent;
    expect(text).toMatch(/Applied to 1 node\./);
    expect(text).not.toMatch(/nodes/);
  });

  it('does not abort the reconcile loop when one target rejects, and reports a partial failure', async () => {
    const setSpy = vi
      .spyOn(getContext().config, 'setNodeConfigValue')
      .mockImplementation((node: string) =>
        node === NODE_B ? Promise.reject(new Error('conflict')) : Promise.resolve('old')
      );
    const el = await mount(`${NODE_A},${NODE_B},${NODE_C}`);

    table(el).dispatchEvent(copyEvent(NODE_A));
    await el.updateComplete;
    expect(dialog(el, '[data-copy-dialog]')?.hasAttribute('open')).toBe(true);

    await el.confirmCopy();
    await toastHost.updateComplete;

    // Loop did not abort after NODE_B rejected: NODE_C was still attempted.
    expect(setSpy).toHaveBeenCalledWith(NODE_B, 'httpd', 'bind_address', 'any');
    expect(setSpy).toHaveBeenCalledWith(NODE_C, 'httpd', 'bind_address', 'any');
    expect(setSpy).toHaveBeenCalledTimes(2);
    // The source node is never written back to.
    expect(setSpy).not.toHaveBeenCalledWith(NODE_A, 'httpd', 'bind_address', 'any');

    // Partial failure surfaces as an error toast summarizing both outcomes.
    const errorToast = toastHost.shadowRoot!.querySelector('.toast.error');
    expect(errorToast?.textContent).toMatch(/Applied to 1, 1 failed\./);
  });

  it('flips the showOnlyDiffs prop passed to the table when toggled', async () => {
    const el = await mount();
    expect(table(el).showOnlyDiffs).toBe(false);
    el.toggleDiffs();
    await el.updateComplete;
    expect(table(el).showOnlyDiffs).toBe(true);
    el.toggleDiffs();
    await el.updateComplete;
    expect(table(el).showOnlyDiffs).toBe(false);
  });

  it('renders a node prompt (no table) when fewer than 2 nodes are given', async () => {
    const el = await mount(NODE_A);
    const prompt = el.shadowRoot!.querySelector('[data-prompt]');
    expect(prompt).not.toBeNull();
    expect(prompt?.textContent).toMatch(/Select 2–4 nodes to compare\./);
    expect(prompt?.querySelector('wa-button')?.textContent?.trim()).toBe('Select nodes');
    expect(el.shadowRoot!.querySelector('cca-config-compare-table')).toBeNull();
  });

  it('titles the page and offers a "Change nodes" header action', async () => {
    await mount();
    await header.updateComplete;

    expect(header.shadowRoot!.querySelector('.title')?.textContent?.trim()).toBe(
      'Compare configuration'
    );
    const actions = [...header.shadowRoot!.querySelectorAll('.subactions cca-action')];
    const changeNodes = actions.find((a) => a.getAttribute('icon') === 'code-compare');
    expect(changeNodes?.getAttribute('tooltip')).toBe('Change nodes');
  });

  it('navigates to a ?nodes= compare URL when the picker confirms a selection', async () => {
    const nav = vi.spyOn(getContext().router, 'navigate');
    const el = await mount();
    const picker = el.shadowRoot!.querySelector('cca-config-compare-picker')!;
    picker.dispatchEvent(
      new CustomEvent('compare-confirm', {
        detail: { nodes: [NODE_B, NODE_C] },
        bubbles: true,
        composed: true
      })
    );
    await el.updateComplete;
    expect(nav).toHaveBeenCalledWith(`/configuration/compare?nodes=${NODE_B},${NODE_C}`);
  });

  it('reloads from the URL when ?nodes= changes', async () => {
    const el = await mount(`${NODE_A},${NODE_B}`);
    expect(table(el).columns.map((c) => c.id)).toEqual([NODE_A, NODE_B]);

    window.location.hash = `#/configuration/compare?nodes=${NODE_B},${NODE_C}`;
    // resolve() synchronously, rather than waiting on the async hashchange the
    // router's own navigate() depends on — that wait is a known flake here.
    getContext().router.resolve();
    await flush(el);

    expect(table(el).columns.map((c) => c.id)).toEqual([NODE_B, NODE_C]);
    expect(cellText(el, 'bind_address', NODE_C)).toBe('127.0.0.1');
  });
});
