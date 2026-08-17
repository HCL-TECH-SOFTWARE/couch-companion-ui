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

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ServerMgmtService } from "../src/services/server-mgmt-service";
import { SINGLE_SERVER_ID } from "../src/services/single-server";
import { ApiClient } from "../src/services/api-client";

const WELCOME = { couchdb: "Welcome", version: "3.5.0", uuid: "abc", git_sha: "deadbee", features: ["scheduler"], vendor: { name: "The Apache Software Foundation" } };
const SESSION = { ok: true, userCtx: { name: "admin", roles: ["_admin"] }, info: { authenticated: "cookie" } };

const routed = (over: Record<string, unknown> = {}) =>
  vi.fn((_m: string, path: string) => {
    const table: Record<string, unknown> = {
      "/": WELCOME,
      "/_session": SESSION,
      "/_active_tasks": [{ type: "indexer", database: "shards/x/db.1", progress: 42, pid: "<0.1.0>", started_on: 1, updated_on: 2 }],
      "/_all_dbs": ["alpha", "beta"],
      ...over,
    };
    if (path in table) return Promise.resolve(table[path]);
    if (path === "/_dbs_info") return Promise.resolve([
      { key: "alpha", info: { db_name: "alpha", doc_count: 3, sizes: { file: 100, active: 90, external: 80 }, props: {} } },
      { key: "beta", info: { db_name: "beta", doc_count: 0, sizes: { file: 50, active: 40, external: 30 }, props: { partitioned: true } } },
    ]);
    return Promise.reject(new Error(`unexpected ${path}`));
  });

let api: ApiClient & { request: ReturnType<typeof vi.fn> };
let service: ServerMgmtService;

beforeEach(() => {
  api = { request: routed(), requestWithHeaders: vi.fn(), setBaseUrl: vi.fn() } as unknown as typeof api;
  service = new ServerMgmtService(api);
});

describe("listServers", () => {
  it("synthesizes exactly one server from GET / and GET /_session", async () => {
    const result = await service.listServers();
    expect(result.nextBookmark).toBe("");
    expect(result.servers).toHaveLength(1);
    const s = result.servers[0];
    expect(s.id).toBe(SINGLE_SERVER_ID);
    expect(s.couch_version).toBe("3.5.0");
    expect(s.username).toBe("admin");
    expect(s.reachable).toBe(true);
    expect(s.location).toBeNull();
    expect(s.configured_idps).toBeNull();
    expect(typeof s.name).toBe("string");
    expect(s.name.length).toBeGreaterThan(0);
    expect(typeof s.created_at).toBe("string");
  });

  it("caches within the TTL and refetches after invalidation", async () => {
    await service.listServers();
    await service.listServers();
    const welcomeCalls = api.request.mock.calls.filter(([, p]) => p === "/").length;
    expect(welcomeCalls).toBe(1);
    service._invalidateServerList();
    await service.listServers();
    expect(api.request.mock.calls.filter(([, p]) => p === "/").length).toBe(2);
  });

  it("reports unreachable instead of throwing when the welcome call fails", async () => {
    api.request = vi.fn((_m: string, path: string) =>
      path === "/" ? Promise.reject(new Error("down")) : Promise.resolve(SESSION),
    ) as never;
    const result = await service.listServers();
    expect(result.servers).toHaveLength(1);
    expect(result.servers[0].reachable).toBe(false);
    expect(result.servers[0].couch_version).toBeNull();
  });

  it("survives an anonymous session (no userCtx name)", async () => {
    api.request = routed({ "/_session": { ok: true, userCtx: { name: null, roles: [] } } }) as never;
    const result = await service.listServers();
    expect(result.servers[0].username).toBe("");
  });
});

describe("getServer", () => {
  it("returns the same synthesized record for any id", async () => {
    const a = await service.getServer(SINGLE_SERVER_ID);
    const b = await service.getServer("whatever-else");
    expect(a.id).toBe(SINGLE_SERVER_ID);
    expect(b).toEqual(a);
  });
});

describe("getServerInfo", () => {
  it("returns the raw welcome document", async () => {
    await expect(service.getServerInfo(SINGLE_SERVER_ID)).resolves.toMatchObject({ couchdb: "Welcome", version: "3.5.0" });
    expect(api.request).toHaveBeenCalledWith("GET", "/");
  });
});

describe("getActiveTasks", () => {
  it("returns raw _active_tasks", async () => {
    const tasks = await service.getActiveTasks(SINGLE_SERVER_ID);
    expect(tasks).toHaveLength(1);
    expect(api.request).toHaveBeenCalledWith("GET", "/_active_tasks");
  });
});

describe("getDatabases", () => {
  it("maps _all_dbs + _dbs_info into DatabaseInfo, keeping the size_byte spelling", async () => {
    const dbs = await service.getDatabases(SINGLE_SERVER_ID);
    expect(dbs.map((d) => d.db_name)).toEqual(["alpha", "beta"]);
    expect(dbs[0].doc_count).toBe(3);
    expect(dbs[0].size_byte).toBe(100);
    expect(dbs[1].partitioned).toBe(true);
  });

  it("filters by database_name and honours sort_order desc", async () => {
    const filtered = await service.getDatabases(SINGLE_SERVER_ID, { database_name: "alp" });
    expect(filtered.map((d) => d.db_name)).toEqual(["alpha"]);
    const desc = await service.getDatabases(SINGLE_SERVER_ID, { sort_by: "db_name", sort_order: "desc" });
    expect(desc.map((d) => d.db_name)).toEqual(["beta", "alpha"]);
  });

  it("chunks _dbs_info at 100 keys", async () => {
    const many = Array.from({ length: 250 }, (_, i) => `db${String(i).padStart(3, "0")}`);
    api.request = vi.fn((_m: string, path: string, body?: unknown) => {
      if (path === "/_all_dbs") return Promise.resolve(many);
      if (path === "/_dbs_info") {
        const keys = (body as { keys: string[] }).keys;
        expect(keys.length).toBeLessThanOrEqual(100);
        return Promise.resolve(keys.map((k) => ({ key: k, info: { db_name: k, doc_count: 1, sizes: { file: 1 } } })));
      }
      return Promise.resolve(WELCOME);
    }) as never;
    const dbs = await service.getDatabases(SINGLE_SERVER_ID);
    expect(dbs).toHaveLength(250);
    expect(api.request.mock.calls.filter(([, p]) => p === "/_dbs_info").length).toBe(3);
  });

  it("tolerates a _dbs_info entry with an error instead of info", async () => {
    api.request = routed() as never;
    (api.request as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => Promise.resolve(["alpha", "gone"]));
    // second call is _dbs_info
    (api.request as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() =>
      Promise.resolve([{ key: "alpha", info: { db_name: "alpha", doc_count: 1, sizes: { file: 2 } } }, { key: "gone", error: "not_found" }]),
    );
    const dbs = await service.getDatabases(SINGLE_SERVER_ID);
    expect(dbs.map((d) => d.db_name)).toEqual(["alpha"]);
  });
});

describe("removed registry mutations", () => {
  it("no longer exposes create/update/remove", () => {
    const svc = service as unknown as Record<string, unknown>;
    expect(svc.createServer).toBeUndefined();
    expect(svc.updateServer).toBeUndefined();
    expect(svc.removeServer).toBeUndefined();
  });
});
