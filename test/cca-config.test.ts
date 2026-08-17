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
import * as toastModule from '../src/components/cca-toast';

import '../src/components/cca-header';
import '../src/plugins/config/cca-config';
import type { CcaConfig } from '../src/plugins/config/cca-config';

let mounted: HTMLElement[] = [];

async function mount(serverId = 'srv-1'): Promise<CcaConfig> {
  const header = document.createElement('cca-header');
  document.body.appendChild(header);
  mounted.push(header);

  const el = document.createElement('cca-config') as CcaConfig;
  el.serverId = serverId;
  document.body.appendChild(el);
  mounted.push(el);
  await el.updateComplete;
  await new Promise((r) => setTimeout(r, 0));
  await el.updateComplete;
  return el;
}

const table = (el: CcaConfig) =>
  el.shadowRoot!.querySelector('cca-data-table') as HTMLElement & {
    rows: Record<string, unknown>[];
    updateComplete: Promise<unknown>;
  };

const field = (el: CcaConfig, name: string) =>
  el.shadowRoot!.querySelector(`[data-field="${name}"]`) as HTMLInputElement;

const dialog = (el: CcaConfig, sel: string) =>
  el.shadowRoot!.querySelector(sel) as HTMLElement & { open: boolean };

/** The dynamic header action carrying `icon`, or null when the screen never published it. */
async function headerAction(icon: string) {
  const header = document.querySelector('cca-header') as HTMLElement & {
    updateComplete: Promise<unknown>;
  };
  await header.updateComplete;
  return header.shadowRoot!.querySelector(`.subactions cca-action[icon="${icon}"]`) as
    | (Element & { action?: (e: Event) => void })
    | null;
}

const picker = (el: CcaConfig) =>
  el.shadowRoot!.querySelector('cca-config-compare-picker') as HTMLElement & { open: boolean };

const CONFIG = {
  chttpd: { port: '5984', bind_address: 'any' },
  cors: { origins: '*' }
};

// Real Erlang node names — `name` doubles as the compare-table column id and the query value.
const NODE_1 = 'couchdb@couchdb1.ccui.local';
const NODE_2 = 'couchdb@couchdb2.ccui.local';
const NODE_3 = 'couchdb@couchdb3.ccui.local';

const cluster = (...names: string[]) => names.map((name) => ({ name, reachable: true }));

describe('cca-config', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(getContext().serverMgmt, 'listServers').mockResolvedValue({
      servers: [{ id: 'srv-1', name: 'Alpha', url: 'http://a' }]
    } as never);
    vi.spyOn(getContext().config, 'getConfig').mockResolvedValue(structuredClone(CONFIG));
    vi.spyOn(getContext().config, 'setConfigValue').mockResolvedValue('old');
    vi.spyOn(getContext().config, 'deleteConfigValue').mockResolvedValue(undefined);
    vi.spyOn(getContext().config, 'restartNode').mockResolvedValue(undefined);
    // Default to a stock single-node CouchDB; the cluster cases re-mock before mounting.
    vi.spyOn(getContext().membership, 'listNodes').mockResolvedValue(cluster(NODE_1));
  });

  afterEach(() => {
    for (const el of mounted) el.remove();
    mounted = [];
  });

  it('loads config for the selected server and renders one row per key, grouped', async () => {
    const el = await mount();
    // 2 chttpd keys + 1 cors key = 3 rows
    expect(table(el).rows.length).toBe(3);
    // Section label only on the first row of each group.
    const firsts = table(el).rows.filter((r) => (r as { _first: boolean })._first);
    expect(firsts.length).toBe(2); // chttpd, cors
  });

  it('shows a prompt when no server is resolvable ($all, none registered)', async () => {
    vi.spyOn(getContext().serverMgmt, 'listServers').mockResolvedValue({
      servers: []
    } as never);
    const el = await mount('$all');
    expect(el.shadowRoot!.querySelector('[data-empty]')).not.toBeNull();
  });

  it('renders no in-body server picker — there is nothing to pick (#31)', async () => {
    const el = await mount('srv-1');
    expect(el.shadowRoot!.querySelector('cca-server-select')).toBeNull();
  });

  it('adopts the single server locally when mounted on a legacy $all deep link (#31)', async () => {
    // beforeEach mocks a single server (srv-1).
    const el = await mount('$all');
    expect(el.serverId).toBe('srv-1');
    expect(getContext().config.getConfig).toHaveBeenCalledWith('srv-1');
    expect(el.shadowRoot!.querySelector('[data-empty]')).toBeNull();
  });

  it('does not adopt a server when $all and several exist', async () => {
    vi.spyOn(getContext().serverMgmt, 'listServers').mockResolvedValue({
      servers: [
        { id: 'srv-1', name: 'Alpha', url: 'http://a' },
        { id: 'srv-2', name: 'Bravo', url: 'http://b' },
      ]
    } as never);
    const el = await mount('$all');
    expect(el.serverId).toBe('$all');
    expect(el.shadowRoot!.querySelector('[data-empty]')).not.toBeNull();
  });

  it('openNew opens an empty add modal with editable section/key', async () => {
    const el = await mount();
    el.openNew();
    await el.updateComplete;
    expect(dialog(el, 'wa-dialog[data-edit]').hasAttribute('open')).toBe(true);
    expect(field(el, 'section').value).toBe('');
    expect(field(el, 'key').value).toBe('');
  });

  it('row click opens edit modal with value editable and section/key read-only', async () => {
    const el = await mount();
    table(el).dispatchEvent(
      new CustomEvent('cca-row-click', {
        detail: { section: 'chttpd', key: 'port', value: '5984', _first: false },
        bubbles: true,
        composed: true
      })
    );
    await el.updateComplete;
    expect(field(el, 'value').value).toBe('5984');
    expect(el.shadowRoot!.querySelector('[data-ro-section]')!.textContent).toContain('chttpd');
    expect(el.shadowRoot!.querySelector('[data-field="section"]')).toBeNull();
  });

  it('saveDraft PUTs the value and reloads', async () => {
    const set = vi.spyOn(getContext().config, 'setConfigValue');
    const el = await mount();
    el.openNew();
    await el.updateComplete;
    field(el, 'section').value = 'log';
    field(el, 'section').dispatchEvent(new Event('input'));
    field(el, 'key').value = 'level';
    field(el, 'key').dispatchEvent(new Event('input'));
    field(el, 'value').value = 'debug';
    field(el, 'value').dispatchEvent(new Event('input'));
    await el.updateComplete;

    await el.saveDraft();
    expect(set).toHaveBeenCalledWith('srv-1', 'log', 'level', 'debug');
  });

  it('saveDraft rejects an empty section/key', async () => {
    const set = vi.spyOn(getContext().config, 'setConfigValue');
    const el = await mount();
    el.openNew();
    await el.updateComplete;
    await el.saveDraft();
    expect(set).not.toHaveBeenCalled();
    expect(el.shadowRoot!.textContent).toMatch(/required/i);
  });

  it('delete asks for confirmation then DELETEs the key', async () => {
    const del = vi.spyOn(getContext().config, 'deleteConfigValue');
    const el = await mount();
    (el as unknown as { _askDelete: (r: unknown) => void })._askDelete({
      section: 'cors',
      key: 'origins',
      value: '*'
    });
    await el.updateComplete;
    expect(dialog(el, 'wa-dialog[data-confirm]').hasAttribute('open')).toBe(true);
    await el.runConfirm();
    expect(del).toHaveBeenCalledWith('srv-1', 'cors', 'origins');
  });

  it('gives the row-delete button the shared outlined/row-action-button treatment (#112)', async () => {
    const el = await mount();
    const btn = table(el).shadowRoot!.querySelector('[data-row-delete]')!;
    expect(btn.getAttribute('appearance')).toBe('outlined');
    expect(btn.classList.contains('row-action-button')).toBe(true);
  });

  it('restart action asks for confirmation then POSTs restart', async () => {
    const restart = vi.spyOn(getContext().config, 'restartNode');
    const el = await mount();
    (el as unknown as { _askRestart: () => void })._askRestart();
    await el.updateComplete;
    expect(dialog(el, 'wa-dialog[data-confirm]').hasAttribute('open')).toBe(true);
    await el.runConfirm();
    expect(restart).toHaveBeenCalledWith('srv-1');
  });

  it('renders a JSON tab showing the raw config as formatted JSON', async () => {
    const el = await mount();
    const tabs = [...el.shadowRoot!.querySelectorAll('wa-tab')].map((t) => t.textContent!.trim());
    expect(tabs).toEqual(['Main config', 'CORS', 'JSON']);
    const view = el.shadowRoot!.querySelector('[data-json-view]')!;
    const parsed = JSON.parse(view.textContent!);
    expect(parsed.chttpd.port).toBe('5984');
    expect(parsed.cors.origins).toBe('*');
  });

  describe('compare entry point', () => {
    it('offers the compare action on a multi-node cluster, and clicking it opens the picker', async () => {
      vi.spyOn(getContext().membership, 'listNodes').mockResolvedValue(
        cluster(NODE_1, NODE_2, NODE_3)
      );
      const el = await mount();
      const action = await headerAction('code-compare');
      expect(action?.action).toBeTruthy();
      action!.action!(new Event('click'));
      await el.updateComplete;
      expect(picker(el).open).toBe(true);
    });

    it('hides the compare action on a stock single-node CouchDB', async () => {
      await mount(); // beforeEach reports exactly one node
      expect(await headerAction('code-compare')).toBeNull();
      // The rest of the header is untouched — this is a hidden feature, not a broken screen.
      expect(await headerAction('plus')).not.toBeNull();
      expect(await headerAction('power-off')).not.toBeNull();
    });

    it('hides the compare action, silently, when _membership is refused (non-admin 401)', async () => {
      const toastSpy = vi.spyOn(toastModule, 'toast');
      vi.spyOn(getContext().membership, 'listNodes').mockRejectedValue(
        new Error('unauthorized: You are not a server admin.')
      );
      await mount();
      expect(await headerAction('code-compare')).toBeNull();
      // A member simply does not get the feature; nothing failed from their point of view.
      expect(toastSpy).not.toHaveBeenCalled();
    });

    it('hides the compare action when the cluster reports no nodes at all', async () => {
      vi.spyOn(getContext().membership, 'listNodes').mockResolvedValue([]);
      await mount();
      expect(await headerAction('code-compare')).toBeNull();
    });

    it('navigates to the compare route with the picker order preserved verbatim', async () => {
      const navigate = vi.spyOn(getContext().router, 'navigate').mockImplementation(() => {});
      vi.spyOn(getContext().membership, 'listNodes').mockResolvedValue(
        cluster(NODE_1, NODE_2, NODE_3)
      );
      const el = await mount();
      picker(el).dispatchEvent(
        new CustomEvent('compare-confirm', {
          detail: { nodes: [NODE_3, NODE_1] },
          bubbles: true,
          composed: true
        })
      );
      await el.updateComplete;
      expect(navigate).toHaveBeenCalledWith(`/configuration/compare?nodes=${NODE_3},${NODE_1}`);
    });

    it('compare-cancel closes the picker without navigating', async () => {
      const navigate = vi.spyOn(getContext().router, 'navigate').mockImplementation(() => {});
      vi.spyOn(getContext().membership, 'listNodes').mockResolvedValue(cluster(NODE_1, NODE_2));
      const el = await mount();
      (el as unknown as { _showPicker: boolean })._showPicker = true;
      await el.updateComplete;
      expect(picker(el).open).toBe(true);
      picker(el).dispatchEvent(new CustomEvent('compare-cancel', { bubbles: true, composed: true }));
      await el.updateComplete;
      expect(picker(el).open).toBe(false);
      expect(navigate).not.toHaveBeenCalled();
    });
  });
});
