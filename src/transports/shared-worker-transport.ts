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

interface WorkerMessage {
  sourceId: string;
  eventName: string;
  data: unknown;
}

/**
 * SharedWorkerTransport — relays router events across browser tabs via a SharedWorker.
 *
 * A SharedWorker is a background JS thread shared by all tabs of the same origin.
 * This transport connects to it and uses its port to forward/receive events.
 * The worker itself (cca-router-worker.ts) must be deployed to a public URL.
 *
 * Usage (declarative via provider attribute):
 * ```html
 * <cca-router-provider shared-worker="/cca-router-worker.js">
 * ```
 *
 * Usage (programmatic):
 * ```ts
 * import { getRouter } from '../customEventRouter.js';
 * import { SharedWorkerTransport } from './shared-worker-transport.js';
 *
 * const router = getRouter();
 * const transport = new SharedWorkerTransport('/cca-router-worker.js');
 * router.addTransport(transport);
 * ```
 *
 * Loop prevention: the worker only forwards to OTHER ports, not back to the sender.
 */
export class SharedWorkerTransport implements RouterTransport {
  readonly id: string;
  private readonly _worker: SharedWorker;
  private readonly _sourceId: string;

  constructor(workerUrl: string) {
    if (!workerUrl || typeof workerUrl !== 'string') {
      throw new Error('SharedWorkerTransport: workerUrl must be a non-empty string');
    }
    this._sourceId = _generateId();
    this.id = `shared-worker:${workerUrl}:${this._sourceId}`;
    this._worker = new SharedWorker(workerUrl);
    this._worker.port.start();
  }

  send(eventName: string, data: unknown): void {
    const message: WorkerMessage = {
      sourceId: this._sourceId,
      eventName,
      data
    };
    this._worker.port.postMessage(message);
  }

  onReceive(handler: (eventName: string, data: unknown) => void): void {
    this._worker.port.onmessage = (event: MessageEvent<WorkerMessage>) => {
      const msg = event.data;
      if (!msg) return;
      handler(msg.eventName, msg.data);
    };
  }

  destroy(): void {
    this._worker.port.onmessage = null;
    this._worker.port.close();
  }
}
