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

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import '../src/components/cca-nav-header';
import type { CcaNavHeader } from '../src/components/cca-nav-header';

function getEl(): CcaNavHeader {
  const el = document.createElement('cca-nav-header') as CcaNavHeader;
  document.body.appendChild(el);
  return el;
}

async function updated(el: CcaNavHeader) {
  await el.updateComplete;
}

function requireShadowRoot(el: CcaNavHeader): ShadowRoot {
  if (!el.shadowRoot) throw new Error('expected shadowRoot');
  return el.shadowRoot;
}

function queryRequired<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`expected element for selector: ${selector}`);
  return element;
}

describe('cca-nav-header', () => {
  let el: CcaNavHeader;

  beforeEach(async () => {
    el = getEl();
    await updated(el);
  });

  afterEach(() => {
    el.remove();
  });

  it('renders the product title and logo', () => {
    const root = requireShadowRoot(el);
    const title = queryRequired(root, '.navigation-header-title');
    const logo = queryRequired<HTMLImageElement>(root, 'img');

    expect(title.textContent?.trim()).toBe('CouchCompanion');
    expect(logo.getAttribute('alt')).toBe('CouchCompanion Logo');
    expect(logo.getAttribute('src')).toBeTruthy();
  });

  it('renders fallback values when properties are null', () => {
    el.companionServer = null;
    el.userName = null;

    const root = requireShadowRoot(el);
    const server = queryRequired(root, '.navigation-header-server');
    const user = queryRequired(root, '.navigation-header-user');

    expect(server.textContent).toContain('Server: n/a');
    expect(user.textContent).toContain('User: Anonymous');
  });

  it('renders provided companion server and username', async () => {
    el.companionServer = 'https://couch.example.com';
    el.userName = 'admin';
    await updated(el);

    const root = requireShadowRoot(el);
    const server = queryRequired(root, '.navigation-header-server');
    const user = queryRequired(root, '.navigation-header-user');

    expect(server.textContent).toContain('Server: https://couch.example.com');
    expect(user.textContent).toContain('User: admin');
  });

  // #51: the collapsed nav rail. Logo-only when collapsed — title, server and user text
  // all drop out, matching keep-admin-ui's pattern of conditionally omitting the wordmark.
  describe('collapsed', () => {
    it('still renders the logo when collapsed', async () => {
      el.collapsed = true;
      await updated(el);

      const root = requireShadowRoot(el);
      const logo = queryRequired<HTMLImageElement>(root, 'img');
      expect(logo.getAttribute('alt')).toBe('CouchCompanion Logo');
    });

    it('omits title, server and user text when collapsed', async () => {
      el.companionServer = 'https://couch.example.com';
      el.userName = 'admin';
      el.collapsed = true;
      await updated(el);

      const root = requireShadowRoot(el);
      expect(root.querySelector('.navigation-header-title')).toBeNull();
      expect(root.querySelector('.navigation-header-server')).toBeNull();
      expect(root.querySelector('.navigation-header-user')).toBeNull();
    });

    it('restores the text once expanded again', async () => {
      el.collapsed = true;
      await updated(el);
      expect(requireShadowRoot(el).querySelector('.navigation-header-title')).toBeNull();

      el.collapsed = false;
      await updated(el);
      const title = queryRequired(requireShadowRoot(el), '.navigation-header-title');
      expect(title.textContent?.trim()).toBe('CouchCompanion');
    });
  });

  it('updates rendered values when properties change', async () => {
    el.companionServer = 'https://one.example.com';
    el.userName = 'alice';
    await updated(el);

    el.companionServer = 'https://two.example.com';
    el.userName = 'bob';
    await updated(el);

    const root = requireShadowRoot(el);
    const server = queryRequired(root, '.navigation-header-server');
    const user = queryRequired(root, '.navigation-header-user');

    expect(server.textContent).toContain('Server: https://two.example.com');
    expect(user.textContent).toContain('User: bob');
  });
});
