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

import { html } from 'lit';
import { CcaElement } from './cca-element.js';
import { customElement, state } from 'lit/decorators.js';
import { getContext } from '../context';
import type { Route } from '../router';

/**
 * Breadcrumb navigation trail. Subscribes to the router and builds a crumb per
 * path segment using the matched route pattern to produce human-readable labels.
 * The server segment is inert context text: this deployment manages exactly one
 * CouchDB, so there is nothing to switch to (#31, retiring #815's dropdown).
 */
@customElement('cca-breadcrumb')
export class CcaBreadcrumb extends CcaElement {
  @state() private route: Route | null = null;
  @state() private params: Record<string, string> = {};

  private unsub?: () => void;

  connectedCallback() {
    super.connectedCallback();
    const ctx = getContext();
    // Capture current state immediately
    const hit = ctx.router.match(ctx.router.currentPath());
    if (hit) {
      this.route = hit.route;
      this.params = hit.params;
    } else {
      this.route = null;
      this.params = {};
    }
    // Subscribe to future route changes
    this.unsub = ctx.router.subscribe((route, params) => {
      this.route = route;
      this.params = params;
    });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.unsub?.();
  }

  private trail(): { label: string; href: string; isServer?: boolean }[] {
    const crumbs: { label: string; href: string; isServer?: boolean }[] = [
      { label: 'Home', href: '#/' }
    ];

    const currentPath = getContext().router.currentPath();
    const actual = currentPath.split('/').filter(Boolean);
    if (actual.length === 0) return crumbs;

    const pattern = this.route ? this.route.path.split('/').filter(Boolean) : [];

    for (let i = 0; i < actual.length; i++) {
      const patternSeg = pattern[i] ?? actual[i];
      const isServer = patternSeg === ':serverId';
      let value: string;
      try {
        value = decodeURIComponent(actual[i]);
      } catch {
        value = actual[i];
      }
      let label: string;

      if (isServer) {
        label = value === '$all' ? 'All servers' : value;
      } else if (patternSeg.startsWith(':')) {
        label = value;
      } else {
        label = patternSeg.charAt(0).toUpperCase() + patternSeg.slice(1);
      }

      crumbs.push({ label, href: `#/${actual.slice(0, i + 1).join('/')}`, isServer });
    }

    return crumbs;
  }

  render() {
    const crumbs = this.trail();
    return html`
      <wa-breadcrumb>
        ${crumbs.map(
          // The server crumb stays as context but carries no href: with one
          // server there is nowhere else to go, and a bare `/databases/local`
          // is not a registered route (#31).
          (crumb) => crumb.isServer
            ? html`<wa-breadcrumb-item data-server-crumb>${crumb.label}</wa-breadcrumb-item>`
            : html`<wa-breadcrumb-item href=${crumb.href}>${crumb.label}</wa-breadcrumb-item>`
        )}
      </wa-breadcrumb>
    `;
  }
}
