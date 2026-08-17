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

import type { RouterTransport } from './router-transport.js';

/** Monotonic counter fallback for environments where crypto.randomUUID is unavailable. */
let _nextId = 0;
const _generateId = (): string =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : String(_nextId++);

interface BroadcastMessage {
  sourceId: string;
  eventName: string;
  data: unknown;
}

/**
 * BroadcastChannelTransport — relays router events across browser tabs and windows
 * sharing the same origin via the Web BroadcastChannel API.
 *
 * Usage (declarative via provider attribute):
 * ```html
 * <cca-router-provider broadcast-channel="my-app">
 * ```
 *
 * Usage (programmatic):
 * ```ts
 * import { getRouter } from '../customEventRouter.js';
 * import { BroadcastChannelTransport } from './broadcast-channel-transport.js';
 *
 * const router = getRouter();
 * const transport = new BroadcastChannelTransport('my-app');
 * router.addTransport(transport);
 * ```
 *
 * Loop prevention: each instance tags outgoing messages with a `sourceId`.
 * Inbound messages with the same `sourceId` are silently ignored.
 */
export class BroadcastChannelTransport implements RouterTransport {
  readonly id: string;
  private readonly _channel: BroadcastChannel;
  private readonly _sourceId: string;

  constructor(channelName: string) {
    if (!channelName || typeof channelName !== 'string') {
      throw new Error('BroadcastChannelTransport: channelName must be a non-empty string');
    }
    this._sourceId = _generateId();
    this.id = `broadcast:${channelName}:${this._sourceId}`;
    this._channel = new BroadcastChannel(channelName);
  }

  send(eventName: string, data: unknown): void {
    const message: BroadcastMessage = {
      sourceId: this._sourceId,
      eventName,
      data
    };
    this._channel.postMessage(message);
  }

  onReceive(handler: (eventName: string, data: unknown) => void): void {
    this._channel.onmessage = (event: MessageEvent<BroadcastMessage>) => {
      const msg = event.data;
      // Ignore echoes from this same tab
      if (!msg || msg.sourceId === this._sourceId) return;
      handler(msg.eventName, msg.data);
    };
  }

  destroy(): void {
    this._channel.onmessage = null;
    this._channel.close();
  }
}
