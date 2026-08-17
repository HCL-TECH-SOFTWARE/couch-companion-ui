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

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getRouter } from "../src/customEventRouter.js";
import { ServerDashboardService } from "../src/services/server-dashboard-service";
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
} from "../src/components/server-dashboard/events";

type AnyRouter = ReturnType<typeof getRouter>;

function once(router: AnyRouter, eventName: string): Promise<any> {
  return new Promise((resolve) => {
    const token = {};
    router.subscribe(token, eventName, (_t, ev) => {
      router.unsubscribe(token);
      resolve((ev as CustomEvent).detail);
    });
  });
}

describe("ServerDashboardService", () => {
  let router: AnyRouter;
  let activeServices: ServerDashboardService[] = [];

  function startService(
    serverMgmt: unknown,
    idp: unknown = {},
    replication: unknown = {},
  ): ServerDashboardService {
    const svc = new ServerDashboardService(serverMgmt as any, idp as any, replication as any, router);
    svc.start();
    activeServices.push(svc);
    return svc;
  }

  beforeEach(() => {
    router = getRouter(true); // fresh singleton per test
  });

  afterEach(() => {
    activeServices.forEach((s) => s.stop());
    activeServices = [];
  });

  it("answers welcome:request with welcome:data, merging the record and the live GET /", async () => {
    const serverMgmt = {
      getServer: vi.fn().mockResolvedValue({
        name: "Prod",
        url: "http://couch:5984",
        couch_version: "3.3.3",
        reachable: true,
      }),
      getServerInfo: vi.fn().mockResolvedValue({
        couchdb: "Welcome",
        version: "3.3.3",
        uuid: "abc123",
        git_sha: "40bce0dc5",
        features: ["scheduler"],
        vendor: { name: "The Apache Software Foundation" },
      }),
    } as any;
    startService(serverMgmt);

    const dataP = once(router, WELCOME_DATA);
    router.publish(WELCOME_REQUEST, { serverId: "server:abc" });
    const data = await dataP;

    expect(serverMgmt.getServer).toHaveBeenCalledWith("server:abc");
    expect(serverMgmt.getServerInfo).toHaveBeenCalledWith("server:abc");
    expect(data).toMatchObject({
      serverId: "server:abc",
      name: "Prod",
      url: "http://couch:5984",
      version: "3.3.3",
      reachable: true,
      couchdb: "Welcome",
      uuid: "abc123",
      gitSha: "40bce0dc5",
      features: ["scheduler"],
      vendor: "The Apache Software Foundation",
    });
  });

  // The stored `couch_version` is only as fresh as the last reachability check. The live one is
  // what the server says about itself right now, so an upgrade shows up without waiting for a
  // re-probe.
  it("prefers the live version over the stored couch_version", async () => {
    const serverMgmt = {
      getServer: vi.fn().mockResolvedValue({ name: "Prod", couch_version: "3.3.2" }),
      getServerInfo: vi.fn().mockResolvedValue({
        couchdb: "Welcome",
        version: "3.4.1",
        uuid: "u1",
      }),
    } as any;
    startService(serverMgmt);

    const dataP = once(router, WELCOME_DATA);
    router.publish(WELCOME_REQUEST, { serverId: "server:abc" });
    const data = await dataP;

    expect(data.version).toBe("3.4.1");
  });

  // Decision #2 of #587. The two fetches fail independently: losing the live document must not
  // cost us the stored record, or a down server would render no tile at all — precisely when you
  // most want to see its URL and when it was last reachable.
  it("degrades to the stored record when only the live GET / fails", async () => {
    const serverMgmt = {
      getServer: vi.fn().mockResolvedValue({
        name: "Edge",
        url: "http://edge:5984",
        couch_version: "3.3.2",
        reachable: false,
        last_checked: "2026-01-02T03:04:05Z",
      }),
      getServerInfo: vi.fn().mockRejectedValue(new Error("Bad Gateway")),
    } as any;
    startService(serverMgmt);

    const dataP = once(router, WELCOME_DATA);
    router.publish(WELCOME_REQUEST, { serverId: "server:abc" });
    const data = await dataP;

    expect(data).toMatchObject({
      serverId: "server:abc",
      name: "Edge",
      url: "http://edge:5984",
      version: "3.3.2",
      reachable: false,
    });
    expect(data.liveError).toContain("Bad Gateway");
    // Not a hard error: the tile must still render.
    expect(data.error).toBeUndefined();
    expect(data.uuid).toBeUndefined();
  });

  it("publishes an error payload when the stored record cannot be fetched", async () => {
    const serverMgmt = {
      getServer: vi.fn().mockRejectedValue(new Error("unreachable")),
      getServerInfo: vi.fn().mockRejectedValue(new Error("Bad Gateway")),
    } as any;
    startService(serverMgmt);

    const dataP = once(router, WELCOME_DATA);
    router.publish(WELCOME_REQUEST, { serverId: "server:abc" });
    const data = await dataP;

    expect(data.serverId).toBe("server:abc");
    expect(data.error).toContain("unreachable");
  });

  it("aggregates databases into storage:data", async () => {
    const serverMgmt = {
      getDatabases: vi.fn().mockResolvedValue([
        { name: "a", doc_count: 5, size_byte: 100 },
        { name: "b", doc_count: 3, size_byte: 50 },
      ]),
    } as any;
    startService(serverMgmt);

    const dataP = once(router, STORAGE_DATA);
    router.publish(STORAGE_REQUEST, { serverId: "server:abc" });
    const data = await dataP;

    expect(serverMgmt.getDatabases).toHaveBeenCalledWith("server:abc", { scope: "full" });
    expect(data).toMatchObject({
      serverId: "server:abc",
      dbCount: 2,
      docTotal: 8,
      storageBytes: 150,
    });
  });

  it("groups active tasks by type", async () => {
    const serverMgmt = {
      getActiveTasks: vi.fn().mockResolvedValue([
        { type: "replication" },
        { type: "replication" },
        { type: "indexer" },
        {},
      ]),
    } as any;
    startService(serverMgmt);

    const dataP = once(router, TASKS_DATA);
    router.publish(TASKS_REQUEST, { serverId: "server:abc" });
    const data = await dataP;

    expect(serverMgmt.getActiveTasks).toHaveBeenCalledWith("server:abc");
    expect(data.serverId).toBe("server:abc");
    expect(data.byType).toEqual({ replication: 2, indexer: 1, unknown: 1 });
  });

  it("counts replications scoped to this server", async () => {
    const replication = {
      listReplications: vi.fn().mockResolvedValue([
        { continuous: true, cca_server_id: "server:abc" },
        { continuous: false, cca_server_id: "server:abc" },
        { continuous: true, cca_server_id: "server:other" },
      ]),
    } as any;
    startService({}, {}, replication);

    const dataP = once(router, REPLICATIONS_DATA);
    router.publish(REPLICATIONS_REQUEST, { serverId: "server:abc" });
    const data = await dataP;

    expect(replication.listReplications).toHaveBeenCalledOnce();
    expect(data).toMatchObject({
      serverId: "server:abc",
      continuousCount: 1,
      totalCount: 2,
    });
  });

  // #104: every registered provider belongs to the one server this app configures, so the
  // `urls` filter that used to sit here had nothing left to filter on.
  it("returns every registered IdP for this server", async () => {
    const serverMgmt = {
      getServer: vi.fn().mockResolvedValue({ id: "server:abc", url: "http://abc" }),
    } as any;
    const idp = {
      listIdps: vi.fn().mockResolvedValue([
        { _id: "a", name: "Okta", issuer: "https://okta" },
        { _id: "b", name: "Azure", issuer: "https://azure" },
      ]),
    } as any;
    startService(serverMgmt, idp);

    const dataP = once(router, IDP_DATA);
    router.publish(IDP_REQUEST, { serverId: "server:abc" });
    const data = await dataP;

    expect(data.serverId).toBe("server:abc");
    expect(data.idps).toEqual([
      { id: "a", name: "Okta", issuer: "https://okta" },
      { id: "b", name: "Azure", issuer: "https://azure" },
    ]);
  });

  // #802: N tiles remounting during a search burst re-request the same servers
  // while the previous live GET / probes are still running. Concurrent requests
  // per serverId must share one fetch; requests after settle must fetch fresh.
  describe("welcome request coalescing", () => {
    function deferredServerMgmt() {
      let resolveRecord!: (v: unknown) => void;
      const serverMgmt = {
        getServer: vi.fn().mockReturnValue(new Promise((r) => { resolveRecord = r; })),
        getServerInfo: vi.fn().mockResolvedValue({}),
      } as any;
      return { serverMgmt, resolveRecord: (v: unknown) => resolveRecord(v) };
    }

    it("coalesces concurrent welcome requests for the same server into one fetch", async () => {
      const { serverMgmt, resolveRecord } = deferredServerMgmt();
      startService(serverMgmt);

      const dataP = once(router, WELCOME_DATA);
      router.publish(WELCOME_REQUEST, { serverId: "server:abc" });
      router.publish(WELCOME_REQUEST, { serverId: "server:abc" });
      router.publish(WELCOME_REQUEST, { serverId: "server:abc" });
      resolveRecord({ name: "Prod", reachable: true });
      await dataP;

      expect(serverMgmt.getServer).toHaveBeenCalledTimes(1);
      expect(serverMgmt.getServerInfo).toHaveBeenCalledTimes(1);
    });

    it("fetches fresh again once the previous welcome settled", async () => {
      const serverMgmt = {
        getServer: vi.fn().mockResolvedValue({ name: "Prod", reachable: true }),
        getServerInfo: vi.fn().mockResolvedValue({}),
      } as any;
      startService(serverMgmt);

      const p1 = once(router, WELCOME_DATA);
      router.publish(WELCOME_REQUEST, { serverId: "server:abc" });
      await p1;
      // Drain the fetch promise's settle + .finally() cleanup: WELCOME_DATA is
      // published while the in-flight entry is still set (the entry clears a
      // few microtask ticks later), so an immediate synchronous re-request
      // would still coalesce — harmless in production, where re-requests
      // arrive much later. The setTimeout(0) macrotask drain is right
      // precisely because it flushes every pending microtask without having
      // to count ticks.
      await new Promise((r) => setTimeout(r, 0));
      const p2 = once(router, WELCOME_DATA);
      router.publish(WELCOME_REQUEST, { serverId: "server:abc" });
      await p2;

      expect(serverMgmt.getServer).toHaveBeenCalledTimes(2);
    });

    it("does not coalesce concurrent requests for different servers", async () => {
      const { serverMgmt, resolveRecord } = deferredServerMgmt();
      startService(serverMgmt);

      router.publish(WELCOME_REQUEST, { serverId: "server:a" });
      router.publish(WELCOME_REQUEST, { serverId: "server:b" });
      resolveRecord({ name: "A", reachable: true });

      expect(serverMgmt.getServer).toHaveBeenCalledTimes(2);
      expect(serverMgmt.getServer).toHaveBeenNthCalledWith(1, "server:a");
      expect(serverMgmt.getServer).toHaveBeenNthCalledWith(2, "server:b");
    });

    it("coalesces again after a failed fetch (map entry removed on settle)", async () => {
      const serverMgmt = {
        getServer: vi.fn().mockRejectedValue(new Error("boom")),
        getServerInfo: vi.fn().mockRejectedValue(new Error("down")),
      } as any;
      startService(serverMgmt);

      const p1 = once(router, WELCOME_DATA);
      router.publish(WELCOME_REQUEST, { serverId: "server:abc" });
      const first = await p1;
      expect(first.error).toBeTruthy();
      // Drain the fetch promise's settle + .finally() cleanup: WELCOME_DATA is
      // published while the in-flight entry is still set (the entry clears a
      // few microtask ticks later), so an immediate synchronous re-request
      // would still coalesce — harmless in production, where re-requests
      // arrive much later. The setTimeout(0) macrotask drain is right
      // precisely because it flushes every pending microtask without having
      // to count ticks.
      await new Promise((r) => setTimeout(r, 0));

      const p2 = once(router, WELCOME_DATA);
      router.publish(WELCOME_REQUEST, { serverId: "server:abc" });
      await p2;
      expect(serverMgmt.getServer).toHaveBeenCalledTimes(2);
    });
  });
});
