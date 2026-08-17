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
import { Router } from '../src/router';

describe('Router hash parsing', () => {
  let router: Router;
  beforeEach(() => {
    location.hash = '';
    router = new Router();
  });

  it('treats an empty hash as "/"', () => {
    location.hash = '';
    expect(router.currentPath()).toBe('/');
  });

  it('returns the hash path without the leading #', () => {
    location.hash = '#/databases/mydb/documents';
    expect(router.currentPath()).toBe('/databases/mydb/documents');
  });

  it('strips the query string from currentPath', () => {
    location.hash = '#/databases/mydb/documents?server_id=srv1';
    expect(router.currentPath()).toBe('/databases/mydb/documents');
  });

  it('exposes the in-hash query via currentQuery', () => {
    location.hash = '#/databases/mydb/documents?server_id=srv1&foo=bar';
    expect(router.currentQuery().get('server_id')).toBe('srv1');
    expect(router.currentQuery().get('foo')).toBe('bar');
  });
});

describe('Router matching', () => {
  it('prefers a literal segment over a param segment', () => {
    const router = new Router();
    router.addRoutes([
      { path: '/databases/:serverId', component: 'cca-db-list' },
      { path: '/databases/create', component: 'cca-db-create' },
    ]);
    expect(router.match('/databases/create')?.route.component).toBe('cca-db-create');
    expect(router.match('/databases/srv1')?.route.component).toBe('cca-db-list');
    expect(router.match('/databases/srv1')?.params.serverId).toBe('srv1');
  });

  it('resolves the current hash and notifies subscribers', () => {
    location.hash = '#/databases/srv1';
    const router = new Router();
    router.addRoute({ path: '/databases/:serverId', component: 'cca-db-list' });
    let seen: string | undefined;
    router.subscribe((route, params) => { seen = params.serverId; });
    router.resolve();
    expect(seen).toBe('srv1');
  });
});

describe('Router redirects', () => {
  beforeEach(() => {
    location.hash = '';
  });

  it('rewrites the URL and resolves the target route in one pass', () => {
    location.hash = '#/servers';
    const router = new Router();
    router.addRoute({ path: '/', component: 'cca-server-dashboard' });
    router.addRedirect('/servers', '/');
    let seen: string | null | undefined;
    router.subscribe((route) => { seen = route?.component ?? null; });

    router.resolve();

    expect(router.currentPath()).toBe('/');
    expect(seen).toBe('cca-server-dashboard');
  });

  it('matches a redirect source with params', () => {
    location.hash = '#/servers/local';
    const router = new Router();
    router.addRoute({ path: '/', component: 'cca-server-dashboard' });
    router.addRedirect('/servers/:serverId', '/');

    router.resolve();

    expect(router.currentPath()).toBe('/');
  });

  it('leaves unrelated paths alone', () => {
    location.hash = '#/databases/srv1';
    const router = new Router();
    router.addRoute({ path: '/databases/:serverId', component: 'cca-db-list' });
    router.addRedirect('/servers', '/');

    router.resolve();

    expect(router.currentPath()).toBe('/databases/srv1');
  });
});

describe('Router navigation', () => {
  it('navigate sets the hash and resolves', async () => {
    const router = new Router();
    router.addRoute({ path: '/databases/:serverId', component: 'cca-db-list' });
    let seen: string | undefined;
    router.subscribe((_r, params) => { seen = params.serverId; });
    router.navigate('/databases/srv9');
    await new Promise((r) => setTimeout(r, 0)); // allow hashchange to fire
    expect(location.hash).toBe('#/databases/srv9');
    expect(seen).toBe('srv9');
  });
});

describe('Router back', () => {
  let historyBack: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    location.hash = '';
    historyBack = vi.spyOn(window.history, 'back').mockImplementation(() => {});
  });

  afterEach(() => {
    historyBack.mockRestore();
  });

  it('navigates to the fallback when nothing in the app was visited yet', () => {
    const router = new Router();
    router.addRoute({ path: '/back-deep/:id', component: 'cca-back-deep' });

    router.back('/back-deep/parent');
    router.resolve(); // drive resolution synchronously — never wait on hashchange

    expect(historyBack).not.toHaveBeenCalled();
    expect(router.currentPath()).toBe('/back-deep/parent');
  });

  it('returns to the previous entry after an in-app navigation', () => {
    const router = new Router();
    router.addRoute({ path: '/back-visited/:id', component: 'cca-back-visited' });

    router.navigate('/back-visited/child');
    router.resolve();
    router.back('/back-visited/fallback');

    expect(historyBack).toHaveBeenCalledOnce();
    expect(router.currentPath()).toBe('/back-visited/child'); // no fallback navigation
  });

  it('does not count a navigation to the path already shown', () => {
    location.hash = '#/back-same/here';
    const router = new Router();
    router.addRoute({ path: '/back-same/:id', component: 'cca-back-same' });

    router.navigate('/back-same/here'); // same path → no history entry added
    router.back('/back-same/fallback');
    router.resolve();

    expect(historyBack).not.toHaveBeenCalled();
    expect(router.currentPath()).toBe('/back-same/fallback');
  });

  it('unwinds a step when the browser itself goes back', () => {
    const router = new Router();
    router.addRoute({ path: '/back-unwind/:id', component: 'cca-back-unwind' });

    router.navigate('/back-unwind/child');
    // First hashchange belongs to the navigate above; the second is the user
    // pressing the browser's back button, which spends the step just taken.
    window.dispatchEvent(new Event('hashchange'));
    window.dispatchEvent(new Event('hashchange'));

    router.back('/back-unwind/fallback');
    router.resolve();

    expect(historyBack).not.toHaveBeenCalled();
    expect(router.currentPath()).toBe('/back-unwind/fallback');
  });
});
