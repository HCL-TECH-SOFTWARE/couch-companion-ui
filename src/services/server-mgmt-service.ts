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

import { ApiClient } from "./api-client.js";
import { synthesizeServer } from "./single-server.js";
import type { SessionResponse } from "../types/api.js";
import type {
  ActiveTask,
  Server,
  ServerWelcome,
  DatabaseInfo,
} from "../plugins/server-mgmt/types.js";

/**
 * Encapsulates all server-management API calls. There is exactly one server (spec D2/D3): reads
 * below talk to CouchDB directly and synthesize a single `Server` record under
 * `SINGLE_SERVER_ID` (see `single-server.ts`). Every `id`/`serverId` parameter is accepted for
 * call-site compatibility (dozens of components pass one) but is inert.
 * @param api - shared ApiClient (base URL already set for this deployment)
 */
export interface ListServersParams {
  server_name?: string;
  server_url?: string;
  username?: string;
  limit?: number;
  bookmark?: string;
  sort_by?: "name" | "url" | "username" | "created_at";
  sort_order?: "asc" | "desc";
}

const SERVER_LIST_TTL_MS = 30_000;
// CouchDB's `_dbs_info` accepts at most 100 keys per request.
const DBS_INFO_CHUNK_SIZE = 100;

export class ServerMgmtService {
  // Cache for the bare (no-params) `listServers()` call only. Many components
  // (design-list, db-list, repl-source-section, ...) fetch the full server
  // list independently on mount; this dedupes those fetches transparently.
  private _serverList: {
    at: number;
    servers: Server[];
    nextBookmark: string;
  } | null = null;
  private _serverListInFlight: Promise<{
    servers: Server[];
    nextBookmark: string;
  }> | null = null;
  // Bumped by every invalidation so a fetch started before a mutation can
  // never write cache/in-flight state after the mutation invalidates it.
  private _serverListGen = 0;

  constructor(private api: ApiClient) {}

  /**
   * @param _params - accepted for call-site compatibility; ignored — one server can't be
   * paginated, filtered or sorted.
   * @returns the single synthesized server and an empty next bookmark. Parameterless results may
   * be served from a shared cache whose copy is shallow — treat the returned Server objects as
   * read-only.
   */
  async listServers(
    _params?: ListServersParams,
  ): Promise<{ servers: Server[]; nextBookmark: string }> {
    if (
      this._serverList &&
      Date.now() - this._serverList.at < SERVER_LIST_TTL_MS
    ) {
      return {
        servers: [...this._serverList.servers],
        nextBookmark: this._serverList.nextBookmark,
      };
    }

    if (!this._serverListInFlight) {
      const gen = this._serverListGen;
      this._serverListInFlight = this._fetchServerList()
        .then((result) => {
          if (gen === this._serverListGen) {
            this._serverList = { at: Date.now(), ...result };
          }
          return result;
        })
        .finally(() => {
          if (gen === this._serverListGen) {
            this._serverListInFlight = null;
          }
        });
    }
    const result = await this._serverListInFlight;
    return { servers: [...result.servers], nextBookmark: result.nextBookmark };
  }

  /**
   * Invalidates the bare-call server-list cache. Bumping the generation counter ensures a fetch
   * already in flight can never repopulate the cache with stale data, and that the next bare call
   * starts a fresh fetch rather than joining a leftover in-flight promise.
   */
  private _invalidateServerList(): void {
    this._serverList = null;
    this._serverListInFlight = null;
    this._serverListGen++;
  }

  /**
   * Synthesizes the single virtual server from CouchDB's own `GET /` and `GET /_session` — the
   * two calls fail independently (`allSettled`), so an unreachable server still produces a record
   * (reachable: false) rather than an empty list.
   */
  private async _fetchServerList(): Promise<{
    servers: Server[];
    nextBookmark: string;
  }> {
    const [welcomeResult, sessionResult] = await Promise.allSettled([
      this.api.request<ServerWelcome>("GET", "/"),
      this.api.request<SessionResponse>("GET", "/_session"),
    ]);
    const welcome =
      welcomeResult.status === "fulfilled" ? welcomeResult.value : null;
    const session =
      sessionResult.status === "fulfilled" ? sessionResult.value : null;
    const server = synthesizeServer(
      welcome,
      session,
      this.api.currentBaseUrl,
      new Date().toISOString(),
    );
    return { servers: [server], nextBookmark: "" };
  }

  /**
   * Returns the synthesized server record — there is only one, so every id resolves to it.
   * Reuses the cached bare `listServers()` fetch so a dashboard mounted alongside the list
   * doesn't double-fetch.
   * @param _id - inert (spec D2/D3)
   */
  async getServer(_id: string): Promise<Server> {
    const { servers } = await this.listServers();
    return servers[0];
  }

  /**
   * Lists databases on the server: `GET /_all_dbs`, then the names are chunked into
   * `POST /_dbs_info` calls (CouchDB accepts at most 100 keys per request) and mapped into
   * {@link DatabaseInfo}. Filtering and sorting happen client-side since CouchDB has no
   * equivalent query parameters for this endpoint.
   * @param _id - inert (spec D2/D3)
   * @param params - optional filter and sort params
   */
  async getDatabases(
    _id: string,
    params?: {
      database_name?: string;
      sort_by?: "db_name" | "doc_count" | "size_bytes";
      sort_order?: "asc" | "desc";
      /** Accepted for call-site compatibility; this implementation always returns full info. */
      scope?: "raw" | "full";
    },
  ): Promise<DatabaseInfo[]> {
    const names = await this.api.request<string[]>("GET", "/_all_dbs");

    const all: DatabaseInfo[] = [];
    for (let i = 0; i < names.length; i += DBS_INFO_CHUNK_SIZE) {
      const keys = names.slice(i, i + DBS_INFO_CHUNK_SIZE);
      const entries = await this.api.request<
        Array<{
          key: string;
          info?: {
            db_name: string;
            doc_count: number;
            sizes?: { file?: number };
            props?: { partitioned?: boolean };
          };
          error?: string;
        }>
      >("POST", "/_dbs_info", { keys });
      for (const entry of entries) {
        if (!entry.info) continue;
        all.push({
          db_name: entry.info.db_name,
          doc_count: entry.info.doc_count,
          size_byte: entry.info.sizes?.file,
          partitioned: entry.info.props?.partitioned ?? false,
        });
      }
    }

    let result = all;
    if (params?.database_name) {
      const needle = params.database_name.toLowerCase();
      result = result.filter((d) =>
        (d.db_name ?? "").toLowerCase().includes(needle),
      );
    }
    if (params?.sort_by) {
      const field = params.sort_by === "size_bytes" ? "size_byte" : params.sort_by;
      const dir = params.sort_order === "desc" ? -1 : 1;
      result = [...result].sort((a, b) => {
        const av = a[field as keyof DatabaseInfo];
        const bv = b[field as keyof DatabaseInfo];
        if (av == null && bv == null) return 0;
        if (av == null) return 1;
        if (bv == null) return -1;
        if (av < bv) return -1 * dir;
        if (av > bv) return 1 * dir;
        return 0;
      });
    }
    return result;
  }

  /**
   * Lists active CouchDB tasks on the server.
   * @param _id - inert (spec D2/D3)
   */
  getActiveTasks(_id: string): Promise<ActiveTask[]> {
    return this.api.request("GET", "/_active_tasks");
  }

  /**
   * Reads the server's CouchDB welcome document, live from `GET /`.
   * @param _id - inert (spec D2/D3)
   */
  getServerInfo(_id: string): Promise<ServerWelcome> {
    return this.api.request("GET", "/");
  }
}
