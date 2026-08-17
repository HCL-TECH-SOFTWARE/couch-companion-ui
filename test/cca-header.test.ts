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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import '../src/components/cca-header';
import type { CcaHeader } from '../src/components/cca-header';
import {
  addHeaderAction,
  addHeaderActions,
  clearHeaderActions,
  setHeaderTitle,
  clearHeaderTitle
} from '../src/components/cca-header';
import { Logger, Level } from '../src/services/log-service';
import { getContext } from '../src/context';
import type { Server } from '../src/plugins/server-mgmt/types';
import '../src/components/cca-toast';
import type { CcaToast } from '../src/components/cca-toast';
// cca-header.ts deliberately does not self-import wa-drawer (see the comment on that
// import site) — this file's isolated run needs it registered itself.
import '@awesome.me/webawesome/dist/components/drawer/drawer.js';

function getEl(): CcaHeader {
  const el = document.createElement('cca-header') as CcaHeader;
  document.body.appendChild(el);
  return el;
}

async function updated(el: CcaHeader) {
  await el.updateComplete;
}

function requireShadowRoot(el: CcaHeader): ShadowRoot {
  if (!el.shadowRoot) throw new Error('expected shadowRoot');
  return el.shadowRoot;
}

function queryRequired<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`expected element for selector: ${selector}`);
  return element;
}

function subactions(el: CcaHeader): Element[] {
  return Array.from(requireShadowRoot(el).querySelectorAll('.subactions cca-action'));
}

function titleText(el: CcaHeader): string {
  return queryRequired(requireShadowRoot(el), '.title').textContent?.trim() ?? '';
}

/** Mounts a throwaway cca-toast, records history entries via its real .show(), then unmounts. */
function seedToastHistory(entries: Array<[string, 'info' | 'success' | 'error']>) {
  const toastEl = document.createElement('cca-toast') as CcaToast;
  document.body.appendChild(toastEl);
  for (const [text, variant] of entries) {
    toastEl.show(text, variant, 0);
  }
  toastEl.remove();
}

/** Clicks the bell action's real wa-button, the same path a user takes. */
async function openNotifications(el: CcaHeader) {
  const root = requireShadowRoot(el);
  const bell = queryRequired<HTMLElement & { updateComplete: Promise<unknown> }>(
    root,
    'cca-action[icon="bell"]'
  );
  await bell.updateComplete;
  const btn = bell.shadowRoot?.querySelector('wa-button') as HTMLElement | null;
  if (!btn) throw new Error('expected wa-button inside cca-action');
  btn.click();
  await updated(el);
}

describe('cca-header', () => {
  let el: CcaHeader;

  beforeEach(async () => {
    el = getEl();
    await updated(el);
  });

  afterEach(() => {
    el.remove();
    vi.restoreAllMocks();
  });

  describe('layout', () => {
    it('renders the actions container', async () => {
      const root = requireShadowRoot(el);
      const actions = root.querySelector('.actions');
      expect(actions).not.toBeNull();
    });
  });

  describe('fixed buttons', () => {
    it('renders the theme picker and notifications bell action in order', () => {
      const root = requireShadowRoot(el);
      const fixed = Array.from(
        root.querySelectorAll('.actions > cca-theme-picker, .actions > cca-action')
      ).map((n) => n.tagName.toLowerCase());
      expect(fixed).toEqual(['cca-theme-picker', 'cca-action']);
    });

    it('renders the notifications action with the bell icon', () => {
      const bell = queryRequired(requireShadowRoot(el), '.actions > cca-action');
      expect(bell.getAttribute('icon')).toBe('bell');
    });

    it('marks the notifications action with the brand variant', () => {
      const bell = queryRequired(requireShadowRoot(el), 'cca-action[icon="bell"]');
      expect(bell.getAttribute('variant')).toBe('brand');
    });

    // #53: logout moved to cca-shell.ts's navigation-footer once the bell took its spot.
    it('no longer renders a logout action in the header', () => {
      const root = requireShadowRoot(el);
      expect(root.querySelector('cca-action[icon="person-through-window"]')).toBeNull();
    });
  });

  // #31: this deployment manages exactly one CouchDB, so the header no longer
  // carries any server control — neither the interactive picker nor the
  // read-only name. Nothing may resurrect one from a stale attribute either.
  describe('no server control (#31)', () => {
    it('renders no server section by default', () => {
      const root = requireShadowRoot(el);
      expect(root.querySelector('.server-display')).toBeNull();
      expect(root.querySelector('[data-server-display]')).toBeNull();
      expect(root.querySelector('cca-server-select')).toBeNull();
    });

    it('renders no picker even when a stale server-display="rw" attribute is set', async () => {
      el.setAttribute('server-display', 'rw');
      el.setAttribute('all-servers', '');
      await updated(el);
      const root = requireShadowRoot(el);
      expect(root.querySelector('cca-server-select')).toBeNull();
      expect(root.querySelector('.server-display')).toBeNull();
    });

    it('renders no server name even when a stale server-display="ro" attribute is set', async () => {
      vi.spyOn(getContext().serverMgmt, 'listServers').mockResolvedValue({
        servers: [{ id: 'srv1', name: 'Server One' } as Server],
        nextBookmark: '',
      });
      el.setAttribute('server-display', 'ro');
      await updated(el);
      await new Promise((r) => setTimeout(r, 0)); // would flush a name resolution
      await updated(el);
      expect(requireShadowRoot(el).querySelector('[data-server-display]')).toBeNull();
    });

    it('leaves only the title, actions, and notifications drawer in the header', async () => {
      el.setAttribute('server-display', 'rw');
      await updated(el);
      const order = Array.from(requireShadowRoot(el).children).map(
        (n) => n.className.split(' ')[0] || n.tagName.toLowerCase()
      );
      expect(order).toEqual(['title', 'actions', 'wa-drawer']);
    });

    it('never asks the server registry for a display name', async () => {
      const list = vi.spyOn(getContext().serverMgmt, 'listServers');
      const fresh = getEl();
      fresh.setAttribute('server-display', 'ro');
      await updated(fresh);
      await new Promise((r) => setTimeout(r, 0));
      fresh.remove();
      expect(list).not.toHaveBeenCalled();
    });
  });

  describe('dynamic actions', () => {
    it('renders no subactions and no separator by default', () => {
      expect(subactions(el)).toHaveLength(0);
      expect(requireShadowRoot(el).querySelector('.separator')).toBeNull();
    });

    it('addAction renders a cca-action and shows the separator', async () => {
      el.addAction({ icon: 'plus', tooltip: 'New', variant: 'neutral', id: 'new', action: () => {} });
      await updated(el);
      const items = subactions(el);
      expect(items).toHaveLength(1);
      expect(items[0].getAttribute('icon')).toBe('plus');
      expect(items[0].getAttribute('tooltip')).toBe('New');
      expect(items[0].getAttribute('variant')).toBe('neutral');
      expect(items[0].getAttribute('id')).toBe('new');
      expect(requireShadowRoot(el).querySelector('.separator')).not.toBeNull();
    });

    it('addActions appends multiple actions', async () => {
      el.addAction({ icon: 'one', action: () => {} });
      el.addActions([
        { icon: 'two', action: () => {} },
        { icon: 'three', action: () => {} }
      ]);
      await updated(el);
      expect(subactions(el).map((a) => a.getAttribute('icon'))).toEqual(['one', 'two', 'three']);
    });

    it('clearActions removes all subactions and the separator', async () => {
      el.addActions([
        { icon: 'one', action: () => {} },
        { icon: 'two', action: () => {} }
      ]);
      await updated(el);
      expect(subactions(el)).toHaveLength(2);

      el.clearActions();
      await updated(el);
      expect(subactions(el)).toHaveLength(0);
      expect(requireShadowRoot(el).querySelector('.separator')).toBeNull();
    });

    it('invokes the action callback when a dynamic action is clicked', async () => {
      const handler = vi.fn();
      el.addAction({ icon: 'plus', action: handler });
      await updated(el);
      const caAction = subactions(el)[0] as HTMLElement & { updateComplete: Promise<unknown> };
      await caAction.updateComplete;
      const btn = caAction.shadowRoot?.querySelector('wa-button') as HTMLElement | null;
      if (!btn) throw new Error('expected wa-button inside cca-action');
      btn.click();
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('passes disabled through to the rendered cca-action', async () => {
      el.addAction({ icon: 'floppy-disk', disabled: true, action: () => {} });
      await updated(el);
      const action = queryRequired(requireShadowRoot(el), 'cca-action');
      expect(action.hasAttribute('disabled')).toBe(true);
    });
  });

  describe('title override', () => {
    it('renders the route-bound pageTitle when no override is set', async () => {
      el.pageTitle = 'Servers';
      await updated(el);
      expect(titleText(el)).toBe('Servers');
    });

    it('setTitle overrides the route-bound pageTitle', async () => {
      el.pageTitle = 'Servers';
      el.setTitle('Server Prod');
      await updated(el);
      expect(titleText(el)).toBe('Server Prod');
    });

    it('clearTitle restores the route-bound pageTitle', async () => {
      el.pageTitle = 'Servers';
      el.setTitle('Server Prod');
      await updated(el);
      expect(titleText(el)).toBe('Server Prod');

      el.clearTitle();
      await updated(el);
      expect(titleText(el)).toBe('Servers');
    });
  });

  describe('global helpers', () => {
    it('addHeaderAction appends to the mounted header', async () => {
      addHeaderAction({ icon: 'gear', action: () => {} });
      await updated(el);
      expect(subactions(el).map((a) => a.getAttribute('icon'))).toEqual(['gear']);
    });

    it('addHeaderActions appends multiple to the mounted header', async () => {
      addHeaderActions([
        { icon: 'a', action: () => {} },
        { icon: 'b', action: () => {} }
      ]);
      await updated(el);
      expect(subactions(el).map((a) => a.getAttribute('icon'))).toEqual(['a', 'b']);
    });

    it('clearHeaderActions clears the mounted header', async () => {
      addHeaderActions([
        { icon: 'a', action: () => {} },
        { icon: 'b', action: () => {} }
      ]);
      await updated(el);
      expect(subactions(el)).toHaveLength(2);

      clearHeaderActions();
      await updated(el);
      expect(subactions(el)).toHaveLength(0);
    });

    it('setHeaderTitle overrides and clearHeaderTitle restores the title', async () => {
      el.pageTitle = 'Servers';
      await updated(el);

      setHeaderTitle('Server Prod');
      await updated(el);
      expect(titleText(el)).toBe('Server Prod');

      clearHeaderTitle();
      await updated(el);
      expect(titleText(el)).toBe('Servers');
    });

    it('warns and is a no-op when no header is mounted', () => {
      el.remove();
      expect(document.querySelector('cca-header')).toBeNull();

      const warnSpy = vi.fn();
      const original = Logger.logTarget[Level.WARN];
      Logger.logTarget[Level.WARN] = warnSpy;
      try {
        expect(() => addHeaderAction({ icon: 'gear', action: () => {} })).not.toThrow();
        expect(warnSpy).toHaveBeenCalled();
      } finally {
        Logger.logTarget[Level.WARN] = original;
      }
    });
  });

  // #53: the bell action opens a wa-drawer listing the retained toast history.
  describe('notifications drawer', () => {
    it('is closed by default', () => {
      const drawer = queryRequired(requireShadowRoot(el), 'wa-drawer');
      expect(drawer.hasAttribute('open')).toBe(false);
    });

    it('opens the drawer when the bell action is clicked', async () => {
      await openNotifications(el);
      const drawer = queryRequired(requireShadowRoot(el), 'wa-drawer');
      expect(drawer.hasAttribute('open')).toBe(true);
    });

    it('shows a placeholder when there is no history yet', async () => {
      await openNotifications(el);
      const drawer = queryRequired(requireShadowRoot(el), 'wa-drawer');
      expect(drawer.textContent).toContain('No notifications yet.');
    });

    it('lists retained toast history entries, newest first', async () => {
      seedToastHistory([
        ['Order A', 'info'],
        ['Order B', 'success'],
        ['Order C', 'error']
      ]);
      await openNotifications(el);

      const texts = Array.from(
        requireShadowRoot(el).querySelectorAll('.notification-text')
      ).map((n) => n.textContent);
      const indexA = texts.indexOf('Order A');
      const indexB = texts.indexOf('Order B');
      const indexC = texts.indexOf('Order C');
      expect(indexC).toBeLessThan(indexB);
      expect(indexB).toBeLessThan(indexA);
    });

    it('shows each entry\'s text, variant, and a timestamp', async () => {
      seedToastHistory([['Variant check', 'success']]);
      await openNotifications(el);

      const root = requireShadowRoot(el);
      const entry = queryRequired(root, '.notification-entry.success');
      expect(entry.querySelector('.notification-text')?.textContent).toBe('Variant check');
      expect(entry.querySelector('.notification-time')?.textContent?.trim()).not.toBe('');
    });
  });
});
