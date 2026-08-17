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

import { ApiClient } from "./api-client";
import { getLogger } from "./log-service.js";

const log = getLogger("services/reachability-status-service");

const HEARTBEAT_MS = 15_000;

/** One reachability observation, replayed to late subscribers. */
export interface StatusUpdate {
  id: string;
  reachable: boolean;
  couch_version: string | null;
  checked_at: string;
}

type Listener = (update: StatusUpdate) => void;

/**
 * Visible-tab polling session for one server id (spec D14/A5: no sockets,
 * no background work — an immediate check on first subscribe, then a 15 s
 * poll that pauses while the tab is hidden).
 */
class Session {
  private listeners = new Set<Listener>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private last: StatusUpdate | null = null;
  private version: string | null = null;
  private destroyed = false;

  constructor(
    private readonly serverId: string,
    private readonly api: ApiClient,
  ) {}

  add(listener: Listener) {
    this.listeners.add(listener);
    if (this.last) {
      listener(this.last);
    }
  }

  remove(listener: Listener): number {
    this.listeners.delete(listener);
    return this.listeners.size;
  }

  start() {
    void this.check();
    this.startTimer();
  }

  destroy() {
    this.destroyed = true;
    this.stopTimer();
    this.listeners.clear();
  }

  pause() {
    this.stopTimer();
  }

  resume() {
    if (this.destroyed) return;
    void this.check();
    this.startTimer();
  }

  private startTimer() {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.check(), HEARTBEAT_MS);
  }

  private stopTimer() {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async check() {
    let reachable = false;
    try {
      const up = await this.api.request<{ status?: string }>("GET", "/_up");
      reachable = up?.status === "ok";
    } catch (err) {
      log.debug?.("reachability check failed", err as Error);
    }
    if (reachable && this.version === null) {
      try {
        const welcome = await this.api.request<{ version?: string }>("GET", "/");
        this.version = welcome?.version ?? null;
      } catch {
        this.version = null;
      }
    }
    if (this.destroyed) return;
    this.last = {
      id: this.serverId,
      reachable,
      couch_version: this.version,
      checked_at: new Date().toISOString(),
    };
    for (const listener of this.listeners) {
      listener(this.last);
    }
  }
}

/**
 * Reachability status per server id. `subscribe` is the whole API: the
 * subscriber set is the refcount — the first subscriber starts the polling
 * session, the last unsubscribe tears it down, and late subscribers get the
 * most recent status replayed immediately.
 */
export class ReachabilityStatusService {
  private sessions = new Map<string, Session>();

  constructor(private readonly api: ApiClient) {
    document.addEventListener("visibilitychange", () => {
      for (const session of this.sessions.values()) {
        if (document.hidden) {
          session.pause();
        } else {
          session.resume();
        }
      }
    });
  }

  subscribe(serverId: string, cb: Listener, _initialReachable = false): () => void {
    let session = this.sessions.get(serverId);
    if (!session) {
      session = new Session(serverId, this.api);
      this.sessions.set(serverId, session);
      session.add(cb);
      session.start();
    } else {
      session.add(cb);
    }
    return () => {
      const remaining = session!.remove(cb);
      if (remaining === 0) {
        session!.destroy();
        this.sessions.delete(serverId);
      }
    };
  }
}
