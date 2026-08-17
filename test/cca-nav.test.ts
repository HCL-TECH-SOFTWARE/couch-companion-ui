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
import type { NavItem } from '../src/types/plugin';
import { getContext } from '../src/context';
import '../src/components/cca-nav';
import type { CcaNav } from '../src/components/cca-nav';

function getEl(): CcaNav {
  const el = document.createElement('cca-nav') as CcaNav;
  document.body.appendChild(el);
  return el;
}

async function updated(el: CcaNav) {
  await el.updateComplete;
}

function requireShadowRoot(el: CcaNav): ShadowRoot {
  if (!el.shadowRoot) throw new Error('expected shadowRoot');
  return el.shadowRoot;
}

function queryRequired<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`expected element for selector: ${selector}`);
  return element;
}

describe('cca-nav', () => {
  let el: CcaNav;

  beforeEach(async () => {
    el = getEl();
    await updated(el);
  });

  afterEach(() => {
    el.remove();
    vi.restoreAllMocks();
  });

  describe('rendering', () => {
    it('renders home link by default', () => {
      const root = requireShadowRoot(el);
      const homeLink = Array.from(root.querySelectorAll('a')).find((a) => a.textContent?.includes('Home'));
      expect(homeLink).toBeTruthy();
    });

    it('renders placeholder items', async () => {
      el.navItems = [];
      await updated(el);

      const root = requireShadowRoot(el);
      const links = Array.from(root.querySelectorAll('a'));
      const labels = links.map((l) => l.textContent?.trim()).filter(Boolean);

      expect(labels).toContain('Home');
      expect(labels).toContain('Setup');
      expect(labels).toContain('Active Tasks');
      expect(labels).toContain('Configuration');
    });

    it('renders custom nav items from props', async () => {
      const items: NavItem[] = [{ label: 'Custom Page', path: '/custom', icon: 'star', order: 10 }];
      el.navItems = items;
      await updated(el);

      const root = requireShadowRoot(el);
      const links = Array.from(root.querySelectorAll('a'));
      expect(links.some((l) => l.textContent?.includes('Custom Page'))).toBe(true);
    });

    it('sorts items by order property', async () => {
      el.navItems = [
        { label: 'First', path: '/first', order: 1 },
        { label: 'Third', path: '/third', order: 3 },
        { label: 'Second', path: '/second', order: 2 }
      ];
      await updated(el);

      const root = requireShadowRoot(el);
      const links = Array.from(root.querySelectorAll('a'));
      const labels = links.map((l) => l.textContent?.trim()).filter(Boolean);

      expect(labels).toEqual([
        'Home',
        'First',
        'Second',
        'Third',
        'Setup',
        'Active Tasks',
        'Configuration',
        'Logout'
      ]);
    });

    it('renders icons for items with icon property', async () => {
      el.navItems = [{ label: 'Test', path: '/test', icon: 'check', order: 1 }];
      await updated(el);

      const root = requireShadowRoot(el);
      const icon = root.querySelector('wa-icon[name="check"]');
      expect(icon).not.toBeNull();
    });

    it('renders items without icons gracefully', async () => {
      el.navItems = [{ label: 'No Icon', path: '/no-icon', order: 1 }];
      await updated(el);

      const root = requireShadowRoot(el);
      const links = Array.from(root.querySelectorAll('a'));
      expect(links.some((l) => l.textContent?.includes('No Icon'))).toBe(true);
    });
  });

  describe('active state', () => {
    it('marks home link as active when currentPath is /', async () => {
      el.currentPath = '/';
      await updated(el);

      const root = requireShadowRoot(el);
      const homeLink = Array.from(root.querySelectorAll('a')).find((a) => a.textContent?.includes('Home'));
      expect(homeLink?.className).toContain('active');
    });

    it('marks home link as not active for other paths', async () => {
      el.currentPath = '/setup';
      await updated(el);

      const root = requireShadowRoot(el);
      const homeLink = Array.from(root.querySelectorAll('a')).find((a) => a.textContent?.includes('Home'));
      expect(homeLink?.className).not.toContain('active');
    });

    it('marks item as active when currentPath matches item path', async () => {
      el.navItems = [{ label: 'Test Page', path: '/test', order: 1 }];
      el.currentPath = '/test';
      await updated(el);

      const root = requireShadowRoot(el);
      const testLink = Array.from(root.querySelectorAll('a')).find((a) => a.textContent?.includes('Test Page'));
      expect(testLink?.className).toContain('active');
    });

    it('marks item as active when currentPath starts with item path plus slash', async () => {
      el.navItems = [{ label: 'Parent', path: '/parent', order: 1 }];
      el.currentPath = '/parent/child';
      await updated(el);

      const root = requireShadowRoot(el);
      const parentLink = Array.from(root.querySelectorAll('a')).find((a) => a.textContent?.includes('Parent'));
      expect(parentLink?.className).toContain('active');
    });

    it('marks a $all item as active for a resolved server path (issue #758)', async () => {
      el.navItems = [
        { label: 'Users', path: '/users/$all', icon: 'users', order: 1 },
        { label: 'Banners', path: '/banners', icon: 'flag', order: 2 }
      ];
      el.currentPath = '/users/server-1';
      await updated(el);

      const root = requireShadowRoot(el);
      const links = Array.from(root.querySelectorAll('a'));
      const usersLink = links.find((a) => a.textContent?.includes('Users'));
      const bannersLink = links.find((a) => a.textContent?.includes('Banners'));
      expect(usersLink?.className).toContain('active');
      expect(bannersLink?.className).not.toContain('active');
    });

    it('does not mark item as active for similar but different paths', async () => {
      el.navItems = [{ label: 'Test', path: '/test', order: 1 }];
      el.currentPath = '/testing';
      await updated(el);

      const root = requireShadowRoot(el);
      const testLink = Array.from(root.querySelectorAll('a')).find((a) => a.textContent?.includes('Test'));
      expect(testLink?.className).not.toContain('active');
    });
  });

  describe('navigation', () => {
    it('home link renders with hash href #/', async () => {
      const root = requireShadowRoot(el);
      const homeLink = queryRequired<HTMLAnchorElement>(root, 'a');

      expect(homeLink.getAttribute('href')).toBe('#/');
    });

    it('nav item link renders with hash href matching item path', async () => {
      el.navItems = [{ label: 'Custom', path: '/custom-path', order: 1 }];
      await updated(el);

      const root = requireShadowRoot(el);
      const links = Array.from(root.querySelectorAll('a'));
      const customLink = links.find((l) => l.textContent?.includes('Custom')) as HTMLAnchorElement;

      expect(customLink.getAttribute('href')).toBe('#/custom-path');
    });

    it('placeholder items render with hash hrefs', async () => {
      const root = requireShadowRoot(el);
      const links = Array.from(root.querySelectorAll<HTMLAnchorElement>('a'));
      const setupLink = links.find((l) => l.textContent?.includes('Setup'));

      expect(setupLink?.getAttribute('href')).toBe('#/setup');
    });

    // The server-scoped pages route on /:serverId, so their nav entry must carry the
    // $all sentinel. A bare /active-tasks matches no route and lands on the 404 page.
    it('server-scoped placeholders link to the $all sentinel route', async () => {
      const root = requireShadowRoot(el);
      const links = Array.from(root.querySelectorAll<HTMLAnchorElement>('a'));
      const href = (label: string) =>
        links.find((l) => l.textContent?.includes(label))?.getAttribute('href');

      expect(href('Active Tasks')).toBe('#/active-tasks/$all');
      expect(href('Configuration')).toBe('#/configuration/$all');
    });
  });

  // #51: the collapsed nav rail. cca-shell.ts owns the toggle and threads a `collapsed`
  // boolean down; this element's job is purely to render the right markup for it.
  describe('collapsed', () => {
    it('renders no tooltips when expanded (default)', () => {
      const root = requireShadowRoot(el);
      expect(root.querySelectorAll('wa-tooltip').length).toBe(0);
    });

    it('renders a wa-tooltip per link when collapsed', async () => {
      el.navItems = [{ label: 'Custom Page', path: '/custom', icon: 'star', order: 10 }];
      el.collapsed = true;
      await updated(el);

      const root = requireShadowRoot(el);
      const links = root.querySelectorAll('a');
      const tooltips = root.querySelectorAll('wa-tooltip');
      // Home + the one custom item + the three placeholders + Logout.
      expect(links.length).toBe(6);
      expect(tooltips.length).toBe(links.length);
    });

    it("each tooltip's for attribute targets its own link by id, and its content matches the label", async () => {
      el.navItems = [{ label: 'Custom Page', path: '/custom', icon: 'star', order: 10 }];
      el.collapsed = true;
      await updated(el);

      const root = requireShadowRoot(el);
      const link = Array.from(root.querySelectorAll('a')).find((a) =>
        a.textContent?.includes('Custom Page')
      ) as HTMLAnchorElement;
      const tooltip = root.querySelector(`wa-tooltip[for="${link.id}"]`);

      expect(link.id).toBeTruthy();
      expect(tooltip).not.toBeNull();
      expect(tooltip?.textContent?.trim()).toBe('Custom Page');
    });

    it('removes the tooltips again once expanded', async () => {
      el.collapsed = true;
      await updated(el);
      expect(requireShadowRoot(el).querySelectorAll('wa-tooltip').length).toBeGreaterThan(0);

      el.collapsed = false;
      await updated(el);
      expect(requireShadowRoot(el).querySelectorAll('wa-tooltip').length).toBe(0);
    });

    it('keeps the label text in the DOM when collapsed (clipped visually, not removed)', async () => {
      el.collapsed = true;
      await updated(el);

      const root = requireShadowRoot(el);
      const homeLink = Array.from(root.querySelectorAll('a')).find((a) => a.id === 'nav-home');
      expect(homeLink?.querySelector('.nav-label')?.textContent?.trim()).toBe('Home');
    });
  });

  // Logout lives in the main nav list, not cca-shell.ts's navigation-footer (moved there
  // for #53, moved again here). This component only dispatches a `logout` event and
  // prevents the href="#" default — cca-shell.ts owns calling auth.logout(), since this
  // component otherwise has no context/service access.
  describe('logout', () => {
    function logoutLink(): HTMLAnchorElement {
      const root = requireShadowRoot(el);
      return queryRequired<HTMLAnchorElement>(root, '#nav-logout');
    }

    it('renders a Logout entry as the last item in the list', () => {
      const root = requireShadowRoot(el);
      const labels = Array.from(root.querySelectorAll('a'))
        .map((a) => a.textContent?.trim())
        .filter(Boolean);
      expect(labels.at(-1)).toBe('Logout');
    });

    it('renders the Logout entry with the person-through-window icon', () => {
      const icon = logoutLink().querySelector('wa-icon');
      expect(icon?.getAttribute('name')).toBe('person-through-window');
    });

    it('dispatches a bubbling, composed logout event on click', () => {
      const handler = vi.fn();
      el.addEventListener('logout', handler);
      logoutLink().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('prevents the default navigation so the bare href="#" never changes the route', () => {
      const event = new MouseEvent('click', { bubbles: true, cancelable: true });
      const preventDefaultSpy = vi.spyOn(event, 'preventDefault');
      logoutLink().dispatchEvent(event);
      expect(preventDefaultSpy).toHaveBeenCalledTimes(1);
    });

    describe('when collapsed', () => {
      it('keeps the label in the DOM (clipped visually, not removed) like every other link', async () => {
        el.collapsed = true;
        await updated(el);

        expect(logoutLink().querySelector('.nav-label')?.textContent?.trim()).toBe('Logout');
        expect(logoutLink().querySelector('wa-icon')?.getAttribute('name')).toBe(
          'person-through-window'
        );
      });

      it('adds a wa-tooltip naming Logout, matching every other collapsed link', async () => {
        el.collapsed = true;
        await updated(el);

        const tooltip = requireShadowRoot(el).querySelector('wa-tooltip[for="nav-logout"]');
        expect(tooltip?.textContent?.trim()).toBe('Logout');
      });

      it('still dispatches logout when clicked while collapsed', async () => {
        el.collapsed = true;
        await updated(el);

        const handler = vi.fn();
        el.addEventListener('logout', handler);
        logoutLink().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        expect(handler).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('dynamic updates', () => {
    it('updates active state when currentPath changes', async () => {
      el.navItems = [
        { label: 'Page A', path: '/a', order: 1 },
        { label: 'Page B', path: '/b', order: 2 }
      ];
      el.currentPath = '/a';
      await updated(el);

      let root = requireShadowRoot(el);
      let pageALink = Array.from(root.querySelectorAll('a')).find((a) => a.textContent?.includes('Page A'));
      expect(pageALink?.className).toContain('active');

      el.currentPath = '/b';
      await updated(el);

      root = requireShadowRoot(el);
      pageALink = Array.from(root.querySelectorAll('a')).find((a) => a.textContent?.includes('Page A'));
      const pageBLink = Array.from(root.querySelectorAll('a')).find((a) => a.textContent?.includes('Page B'));
      expect(pageALink?.className).not.toContain('active');
      expect(pageBLink?.className).toContain('active');
    });

    it('updates rendered items when navItems prop changes', async () => {
      el.navItems = [{ label: 'Item 1', path: '/item1', order: 1 }];
      await updated(el);

      let root = requireShadowRoot(el);
      expect(Array.from(root.querySelectorAll('a')).some((a) => a.textContent?.includes('Item 1'))).toBe(true);

      el.navItems = [{ label: 'Item 2', path: '/item2', order: 1 }];
      await updated(el);

      root = requireShadowRoot(el);
      expect(Array.from(root.querySelectorAll('a')).some((a) => a.textContent?.includes('Item 1'))).toBe(false);
      expect(Array.from(root.querySelectorAll('a')).some((a) => a.textContent?.includes('Item 2'))).toBe(true);
    });
  });
});
