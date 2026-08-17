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

import { describe, it, expect, vi } from 'vitest';
import { PluginLoader } from '../src/services/plugin-loader';
import { PLUGIN_REGISTRY, type PluginRegistration } from '../src/plugin-registry';
import { Router } from '../src/router';
import type { FrontendManifest } from '../src/types/plugin';

const makeManifest = (over: Partial<FrontendManifest> = {}): FrontendManifest => ({
  name: 'fake',
  version: '0.1.0',
  routes: [{ path: '/fake/:serverId', component: 'cca-fake' }],
  nav_items: [{ label: 'Fake', path: '/fake', icon: null, order: 5 }],
  extension_points: [],
  ...over
});

const makeRegistration = (
  over: Partial<FrontendManifest> = {},
  load: PluginRegistration['load'] = () => Promise.resolve({})
): PluginRegistration => ({ manifest: makeManifest(over), load });

describe('PluginLoader (static registry)', () => {
  it('registers routes and nav items sorted by order, idempotently', async () => {
    const router = new Router();
    const addRoute = vi.spyOn(router, 'addRoute');
    const loader = new PluginLoader(router, [
      makeRegistration({ name: 'b', nav_items: [{ label: 'B', path: '/b', icon: null, order: 20 }] }),
      makeRegistration({
        name: 'a',
        routes: [{ path: '/a', component: 'cca-a', allows_all_servers: true }],
        nav_items: [{ label: 'A', path: '/a', icon: null, order: 10 }]
      })
    ]);
    await loader.discoverAndRegister();
    await loader.discoverAndRegister();
    expect(addRoute).toHaveBeenCalledTimes(2);
    expect(addRoute).toHaveBeenCalledWith({
      path: '/a', component: 'cca-a', label: 'a', allowsAllServers: true
    });
    expect(loader.getNavItems().map((n) => n.label)).toEqual(['A', 'B']);
  });

  it('lazy-loads a plugin module once, even for two components of one plugin', async () => {
    const load = vi.fn().mockResolvedValue({});
    const loader = new PluginLoader(new Router(), [
      makeRegistration(
        {
          routes: [
            { path: '/one', component: 'cca-one' },
            { path: '/two', component: 'cca-two' }
          ]
        },
        load
      )
    ]);
    await loader.discoverAndRegister();
    await loader.ensureComponentLoaded('cca-one');
    await loader.ensureComponentLoaded('cca-two');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('rethrows a failed load and retries on the next call', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({});
    const loader = new PluginLoader(new Router(), [makeRegistration({}, load)]);
    await loader.discoverAndRegister();
    await expect(loader.ensureComponentLoaded('cca-fake')).rejects.toThrow('boom');
    await expect(loader.ensureComponentLoaded('cca-fake')).resolves.toBeUndefined();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('ignores unknown component tags', async () => {
    const loader = new PluginLoader(new Router(), [makeRegistration()]);
    await loader.discoverAndRegister();
    await expect(loader.ensureComponentLoaded('cca-unknown')).resolves.toBeUndefined();
  });

  it('ships the real registry: 8 plugins, unique route paths, no entry_module field', () => {
    expect(PLUGIN_REGISTRY).toHaveLength(8);
    const names = PLUGIN_REGISTRY.map((r) => r.manifest.name).sort();
    expect(names).toEqual([
      'banner-admin', 'config', 'db-mgmt', 'design-mgmt',
      'idp', 'replication', 'server-mgmt', 'users'
    ]);
    const paths = PLUGIN_REGISTRY.flatMap((r) => r.manifest.routes.map((rt) => rt.path));
    expect(paths).toHaveLength(28);
    expect(new Set(paths).size).toBe(paths.length);
    for (const r of PLUGIN_REGISTRY) {
      expect(r.manifest).not.toHaveProperty('entry_module');
      expect(typeof r.load).toBe('function');
    }
  });

  // The server dashboard is the home page now (spec D2/D3): a registry of one
  // needs neither a list screen nor a nav entry to reach it.
  it('has retired the /servers screens: no routes, no nav item', () => {
    const paths = PLUGIN_REGISTRY.flatMap((r) => r.manifest.routes.map((rt) => rt.path));
    expect(paths.filter((p) => p.startsWith('/servers'))).toEqual([]);
    const labels = PLUGIN_REGISTRY.flatMap((r) => r.manifest.nav_items.map((n) => n.label));
    expect(labels).not.toContain('Servers');
  });
});
