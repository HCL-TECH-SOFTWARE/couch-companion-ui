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
import type { AppContext } from '../src/context';

/**
 * app.ts is a side-effect module that bootstraps the application.
 * It cannot be directly imported in tests without custom element conflicts.
 * These tests verify the bootstrap contract: context initialization,
 * auth-driven DOM switching, and DOMContentLoaded readiness.
 */
describe('app bootstrap contract', () => {
  let ctx: AppContext;

  beforeEach(() => {
    sessionStorage.clear();
    document.body.innerHTML = '';
    ctx = getContext();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('getContext provides auth state for bootstrap decisions', () => {
    const state = ctx.auth.state;
    expect(state).toHaveProperty('authenticated');
    expect(state).toHaveProperty('username');
    expect(state).toHaveProperty('roles');
    expect(Array.isArray(state.roles)).toBe(true);
  });

  it('unauthenticated state has authenticated false', () => {
    expect(ctx.auth.state.authenticated).toBe(false);
    expect(ctx.auth.state.username).toBeNull();
  });

  it('auth subscribe enables reactive login-to-shell transitions', () => {
    const listener = vi.fn();
    const unsub = ctx.auth.subscribe(listener);

    expect(typeof unsub).toBe('function');
    unsub();

    // After unsubscribe, listener should not be called
    ctx.auth.logout();
    expect(listener).not.toHaveBeenCalled();
  });

  it('DOMContentLoaded is a valid event for bootstrap attachment', () => {
    const listener = vi.fn();
    document.addEventListener('DOMContentLoaded', listener);
    document.dispatchEvent(new Event('DOMContentLoaded'));

    expect(listener).toHaveBeenCalledOnce();
    document.removeEventListener('DOMContentLoaded', listener);
  });

  /**
   * Regression for the post-hard-nav-removal lifecycle gap: a restored
   * session (live cookie confirmed by `restore()`) boots straight into
   * `cca-shell` without ever visiting `initLogin()`. If the auth
   * subscription is only installed from inside `initLogin()`, that boot
   * path never subscribes, and a later `logout()` (explicit or the
   * central 401 handler) has nothing to notify — the shell stays mounted
   * forever. `bootstrap()` must subscribe unconditionally, before it
   * branches on the initial auth state.
   */
  it('restored-session boot then logout() mounts the login screen', async () => {
    sessionStorage.setItem(
      'cca_user',
      JSON.stringify({ name: 'kai', roles: ['user'], companionServer: 'http://couch.local' })
    );
    vi.spyOn(ctx.api, 'probeUp').mockResolvedValue(false);
    vi.spyOn(ctx.auth, 'restore').mockResolvedValue(undefined);
    vi.spyOn(ctx.api, 'request').mockImplementation(async (method, path) => {
      if (method === 'DELETE' && path === '/_session') return undefined;
      throw new Error(`unexpected request in this test: ${String(method)} ${String(path)}`);
    });

    await import('../src/app.js');
    // Belt-and-suspenders: covers both the immediate-bootstrap branch (readyState
    // already past 'loading', the happy-dom default) and the DOMContentLoaded
    // branch, without double-bootstrapping either way.
    document.dispatchEvent(new Event('DOMContentLoaded'));

    await vi.waitFor(() => {
      expect(document.querySelector('cca-shell')).not.toBeNull();
    });
    expect(document.querySelector('cca-login')).toBeNull();
    // Mounted once, directly under <body> — independent of which screen is showing (#115).
    expect(document.querySelector('cca-toast')).not.toBeNull();

    ctx.auth.logout();

    await vi.waitFor(() => {
      expect(document.querySelector('cca-login')).not.toBeNull();
    });
    expect(document.querySelector('cca-shell')).toBeNull();
    // Still there after the login/shell swap: the login screen needs it just as much as the
    // shell does — a failed OIDC callback is reported here, before either screen exists yet.
    expect(document.querySelector('cca-toast')).not.toBeNull();
  });
});
