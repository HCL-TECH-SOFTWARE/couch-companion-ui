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

/**
 * SharedWorker relay script — bridges the event router across browser tabs via a SharedWorker.
 *
 * This script is the WORKER SIDE. Deploy it to your public/ directory (or any URL reachable
 * by your app) and reference it from the provider attribute:
 *
 * ```html
 * <cca-router-provider shared-worker="/cca-router-worker.js">
 * ```
 *
 * How it works:
 * - Every tab that opens this worker gets a MessagePort.
 * - When any port sends a message, the worker re-broadcasts it to ALL other ports.
 * - The sending tab ignores the echo via `sourceId` in SharedWorkerTransport.
 */

interface WorkerMessage {
  sourceId: string;
  eventName: string;
  data: unknown;
}

// Ports from all connected tabs
const ports: MessagePort[] = [];

// Minimal interface — SharedWorkerGlobalScope is not in the default tslib set.
// This file is deployed and run as a SharedWorker script, not in the browser window context.
interface SharedWorkerSelf {
  onconnect: ((event: MessageEvent) => void) | null;
}

(self as unknown as SharedWorkerSelf).onconnect = (connectEvent: MessageEvent) => {
  const port: MessagePort = connectEvent.ports[0];
  ports.push(port);

  port.onmessage = (event: MessageEvent<WorkerMessage>) => {
    const message = event.data;
    // Relay to all OTHER connected ports (not back to sender)
    ports.forEach((p) => {
      if (p !== port) {
        p.postMessage(message);
      }
    });
  };

  port.onmessageerror = () => {
    // Remove stale port on error
    const idx = ports.indexOf(port);
    if (idx !== -1) ports.splice(idx, 1);
  };

  port.start();
};
