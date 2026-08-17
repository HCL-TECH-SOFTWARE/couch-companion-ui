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

import { getRouter } from '../customEventRouter.js';
import type { RouterTransport } from '../transports/router-transport.js';
import { BroadcastChannelTransport } from '../transports/broadcast-channel-transport.js';
import { SharedWorkerTransport } from '../transports/shared-worker-transport.js';
import { getLogger } from '../services/log-service.js';

const providerLog = getLogger('cca-router-provider');

/**
 * Context provider for the custom event router singleton.
 * Place <cca-router-provider> near the root of your app, or anywhere in the document.
 * Components will find it via ancestor search first, then fall back to document-level search.
 * No global pollution: router is only accessible via the provider instance.
 *
 * ### Cross-tab relay via BroadcastChannel
 * Add the `broadcast-channel` attribute with a shared channel name.
 * All tabs/windows using the same channel name will exchange events.
 * ```html
 * <cca-router-provider broadcast-channel="my-app">
 * ```
 *
 * ### Cross-tab relay via SharedWorker
 * Add the `shared-worker` attribute pointing to the cca-router-worker.js script URL.
 * ```html
 * <cca-router-provider shared-worker="/cca-router-worker.js">
 * ```
 */
export class CcaRouterProvider extends HTMLElement {
  public router: ReturnType<typeof getRouter>;
  private _transport: RouterTransport | null = null;

  static get observedAttributes(): string[] {
    return ['broadcast-channel', 'shared-worker', 'debug'];
  }

  constructor() {
    super();
    this.router = getRouter();
  }

  connectedCallback(): void {
    this.router.debug = this.hasAttribute('debug');
    this._setupTransport();
  }

  disconnectedCallback(): void {
    this.router.debug = false;
    this._teardownTransport();
  }

  attributeChangedCallback(): void {
    this.router.debug = this.hasAttribute('debug');
    // Re-wire transport when attribute changes at runtime
    this._teardownTransport();
    this._setupTransport();
  }

  private _setupTransport(): void {
    const channelName = this.getAttribute('broadcast-channel');
    const workerUrl = this.getAttribute('shared-worker');

    if (channelName) {
      try {
        this._transport = new BroadcastChannelTransport(channelName);
        this.router.addTransport(this._transport);
      } catch (e) {
        providerLog.warn('Failed to create BroadcastChannelTransport', e as Error);
      }
      return;
    }

    if (workerUrl) {
      try {
        this._transport = new SharedWorkerTransport(workerUrl);
        this.router.addTransport(this._transport);
      } catch (e) {
        providerLog.warn('Failed to create SharedWorkerTransport', e as Error);
      }
    }
  }

  private _teardownTransport(): void {
    if (this._transport) {
      this.router.removeTransport(this._transport);
      this._transport = null;
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'cca-router-provider': CcaRouterProvider;
  }
}

customElements.define('cca-router-provider', CcaRouterProvider);
