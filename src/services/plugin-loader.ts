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

import { Router } from '../router';
import type { NavItem } from '../types/plugin';
import { PLUGIN_REGISTRY, type PluginRegistration } from '../plugin-registry';
import { getLogger } from './log-service.js';

const log = getLogger('services/plugin-loader');

/**
 * Registers the statically bundled plugin manifests and lazy-loads their entry
 * modules on first route hit. Manifest data lives in src/plugin-registry.ts —
 * there is no backend discovery (spec D7).
 * @param router - Router where plugin routes are registered
 * @param registry - defaults to the shipped PLUGIN_REGISTRY; injectable for tests
 */
export class PluginLoader {
  private router: Router;
  private registry: PluginRegistration[];
  private pendingLoads: Map<string, Promise<unknown>> = new Map();
  private componentToRegistration: Map<string, PluginRegistration> = new Map();
  private navItems: NavItem[] = [];
  private registeredOnce = false;

  constructor(router: Router, registry: PluginRegistration[] = PLUGIN_REGISTRY) {
    this.router = router;
    this.registry = registry;
  }

  /** Registers all bundled routes + nav items. Idempotent. Stays async so cca-shell call sites are unchanged. */
  async discoverAndRegister(): Promise<void> {
    if (this.registeredOnce) {
      return;
    }
    for (const registration of this.registry) {
      this.registerManifest(registration);
    }
    this.registeredOnce = true;
  }

  private registerManifest(registration: PluginRegistration) {
    const { manifest } = registration;
    for (const route of manifest.routes) {
      this.router.addRoute({
        path: route.path,
        component: route.component,
        label: manifest.name,
        allowsAllServers: route.allows_all_servers ?? false
      });
      this.componentToRegistration.set(route.component, registration);
    }
    this.navItems.push(...manifest.nav_items);
    this.navItems.sort((a, b) => a.order - b.order);
  }

  /**
   * Imports a plugin's entry module the first time one of its components is needed.
   * A failed import is forgotten so the next navigation retries it.
   * @param componentTag - custom element tag name to look up in the registry
   */
  async ensureComponentLoaded(componentTag: string): Promise<void> {
    const registration = this.componentToRegistration.get(componentTag);
    if (!registration) {
      return;
    }
    const name = registration.manifest.name;
    let pending = this.pendingLoads.get(name);
    if (!pending) {
      pending = registration.load();
      this.pendingLoads.set(name, pending);
    }
    try {
      await pending;
    } catch (err) {
      this.pendingLoads.delete(name);
      log.error(`Failed to load plugin ${name}`, err as Error);
      throw err;
    }
  }

  /** @returns a defensive copy of nav items sorted by display order */
  getNavItems(): NavItem[] {
    return [...this.navItems];
  }
}
