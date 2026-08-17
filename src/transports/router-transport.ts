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
 * RouterTransport — pluggable channel for relaying events outside the current window context.
 *
 * Implement this interface to bridge the event router to:
 * - Other browser tabs/windows via BroadcastChannel
 * - Background threads via SharedWorker / Web Worker
 *
 * Transports are registered on the router via `addTransport()` and are automatically
 * invoked on every `publish()` call (unless `{ local: true }` is passed).
 */
export interface RouterTransport {
  /** Unique identifier for this transport instance — used for deduplication. */
  readonly id: string;

  /**
   * Send an event to the remote endpoint (other tab, worker, etc.).
   * Called by the router after local dispatch on every `publish()`.
   */
  send(eventName: string, data: unknown): void;

  /**
   * Register a handler that the transport will call whenever a message arrives
   * from the remote endpoint. The router uses this to inject inbound events locally.
   */
  onReceive(handler: (eventName: string, data: unknown) => void): void;

  /** Tear down the transport (close channel, terminate worker port, etc.). */
  destroy(): void;
}
