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

import { getRouter } from "../customEventRouter.js";
import type { ServerMgmtService } from "./server-mgmt-service.js";
import type { IdpService } from "./idp-service.js";
import type { ReplicationService } from "./replication-service.js";
import { getLogger } from "./log-service.js";
import {
  WELCOME_REQUEST,
  WELCOME_DATA,
  STORAGE_REQUEST,
  STORAGE_DATA,
  REPLICATIONS_REQUEST,
  REPLICATIONS_DATA,
  TASKS_REQUEST,
  TASKS_DATA,
  IDP_REQUEST,
  IDP_DATA,
  type DashboardRequest,
  type WelcomeData,
} from "../components/server-dashboard/events.js";

const log = getLogger("services/server-dashboard-service");

type Router = ReturnType<typeof getRouter>;

/**
 * Owns the server-dashboard request/response event contract. Subscribes to
 * every `server-dashboard:<tile>:request` event, fetches via the existing
 * services, and publishes the matching `:data` event. Started once in
 * context.ts.
 */
export class ServerDashboardService {
  private readonly _token = {};

  /** In-flight welcome fetch per serverId — coalesces concurrency, never caches (#802). */
  private readonly _welcomeInFlight = new Map<string, Promise<void>>();

  constructor(
    private serverMgmt: ServerMgmtService,
    private idp: IdpService,
    private replication: ReplicationService,
    private router: Router = getRouter(),
  ) {}

  start(): void {
    this.router.subscribe(this._token, WELCOME_REQUEST, (_t, ev) =>
      this._welcome(serverIdOf(ev)),
    );
    this.router.subscribe(this._token, STORAGE_REQUEST, (_t, ev) =>
      this._onStorage(serverIdOf(ev)),
    );
    this.router.subscribe(this._token, REPLICATIONS_REQUEST, (_t, ev) =>
      this._onReplications(serverIdOf(ev)),
    );
    this.router.subscribe(this._token, TASKS_REQUEST, (_t, ev) =>
      this._onTasks(serverIdOf(ev)),
    );
    this.router.subscribe(this._token, IDP_REQUEST, (_t, ev) =>
      this._onIdp(serverIdOf(ev)),
    );
  }

  stop(): void {
    this.router.unsubscribe(this._token);
  }

  /**
   * Coalesce concurrent welcome fetches per server: a request arriving while
   * the same server's fetch is running shares that fetch (and its single
   * WELCOME_DATA broadcast). The entry clears on settle, so this is not a
   * cache — a request after completion always probes fresh.
   */
  private _welcome(serverId: string): Promise<void> {
    const inFlight = this._welcomeInFlight.get(serverId);
    if (inFlight) return inFlight;
    const fetchP = this._onWelcome(serverId).finally(() => {
      this._welcomeInFlight.delete(serverId);
    });
    this._welcomeInFlight.set(serverId, fetchP);
    return fetchP;
  }

  /**
   * The stored record and the server's live `GET /`, fetched together.
   *
   * They fail independently and are treated that way. The record is the tile's backbone — lose it
   * and there is nothing to render, so that is a hard error. The live welcome document is a bonus:
   * an unreachable server answers 502, and the tile should still show name, URL and the last-known
   * state rather than collapsing. Hence `allSettled` over `all`, and `liveError` over `error`.
   */
  private async _onWelcome(serverId: string): Promise<void> {
    const [record, live] = await Promise.allSettled([
      this.serverMgmt.getServer(serverId),
      this.serverMgmt.getServerInfo(serverId),
    ]);

    if (record.status === "rejected") {
      this._fail(WELCOME_DATA, serverId, record.reason);
      return;
    }

    const s = record.value;
    const base: WelcomeData = {
      serverId,
      name: s.name,
      url: s.url,
      username: s.username,
      version: s.couch_version,
      reachable: s.reachable,
      lastChecked: s.last_checked,
    };

    if (live.status === "rejected") {
      this.router.publish(WELCOME_DATA, {
        ...base,
        liveError: this._message(live.reason),
      });
      return;
    }

    const w = live.value;
    this.router.publish(WELCOME_DATA, {
      ...base,
      couchdb: w.couchdb,
      uuid: w.uuid,
      gitSha: w.git_sha,
      features: w.features,
      vendor: w.vendor?.name,
      // The live version is authoritative: the stored one is only as fresh as the last
      // reachability check, so an upgraded server would otherwise read stale here.
      version: w.version ?? s.couch_version,
    });
  }

  private async _onStorage(serverId: string): Promise<void> {
    try {
      const dbs = await this.serverMgmt.getDatabases(serverId, { scope: "full" });
      const docTotal = dbs.reduce((n, d) => n + (d.doc_count ?? 0), 0);
      const storageBytes = dbs.reduce((n, d) => n + (d.size_byte ?? 0), 0);
      this.router.publish(STORAGE_DATA, {
        serverId,
        dbCount: dbs.length,
        docTotal,
        storageBytes,
      });
    } catch (e) {
      this._fail(STORAGE_DATA, serverId, e);
    }
  }

  private async _onReplications(serverId: string): Promise<void> {
    try {
      const docs = await this.replication.listReplications();
      const mine = docs.filter((d) => d.cca_server_id === serverId);
      this.router.publish(REPLICATIONS_DATA, {
        serverId,
        continuousCount: mine.filter((d) => d.continuous).length,
        totalCount: mine.length,
      });
    } catch (e) {
      this._fail(REPLICATIONS_DATA, serverId, e);
    }
  }

  private async _onTasks(serverId: string): Promise<void> {
    try {
      const tasks = await this.serverMgmt.getActiveTasks(serverId);
      const byType: Record<string, number> = {};
      for (const t of tasks ?? []) {
        const key = t.type ?? "unknown";
        byType[key] = (byType[key] ?? 0) + 1;
      }
      this.router.publish(TASKS_DATA, { serverId, byType });
    } catch (e) {
      this._fail(TASKS_DATA, serverId, e);
    }
  }

  /**
   * Every registered provider belongs to this server — there is only one (#104), and the
   * `urls` field this used to filter on never held anything else. `getServer` stays because it
   * is what turns an unknown serverId into the panel's error state rather than an empty list.
   */
  private async _onIdp(serverId: string): Promise<void> {
    try {
      await this.serverMgmt.getServer(serverId);
      const all = await this.idp.listIdps();
      const idps = (all ?? []).map((c) => ({ id: c._id, name: c.name, issuer: c.issuer }));
      this.router.publish(IDP_DATA, { serverId, idps });
    } catch (e) {
      this._fail(IDP_DATA, serverId, e);
    }
  }

  private _message(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
  }

  private _fail(dataEvent: string, serverId: string, e: unknown): void {
    log.error(`dashboard fetch failed for ${dataEvent}`, e as Error);
    this.router.publish(dataEvent, { serverId, error: this._message(e) });
  }
}

function serverIdOf(ev: Event): string {
  return (ev as CustomEvent<DashboardRequest>).detail.serverId;
}
