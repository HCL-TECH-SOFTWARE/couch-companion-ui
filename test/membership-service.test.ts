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
import { MembershipService } from "../src/services/membership-service";
import { ApiClient } from "../src/services/api-client";

let api: ApiClient & { request: ReturnType<typeof vi.fn> };
let service: MembershipService;

beforeEach(() => {
  api = { request: vi.fn().mockResolvedValue({}) } as unknown as typeof api;
  service = new MembershipService(api);
});

describe("listNodes", () => {
  it("reports every node of a healthy cluster as reachable", async () => {
    api.request.mockResolvedValue({
      all_nodes: ["couchdb@couchdb1.local", "couchdb@couchdb2.local", "couchdb@couchdb3.local"],
      cluster_nodes: ["couchdb@couchdb1.local", "couchdb@couchdb2.local", "couchdb@couchdb3.local"],
    });
    await expect(service.listNodes()).resolves.toEqual([
      { name: "couchdb@couchdb1.local", reachable: true },
      { name: "couchdb@couchdb2.local", reachable: true },
      { name: "couchdb@couchdb3.local", reachable: true },
    ]);
    expect(api.request).toHaveBeenCalledWith("GET", "/_membership");
  });

  it("still offers a stopped node, marked unreachable", async () => {
    // Measured against CouchDB 3.5.2: cluster_nodes keeps the stopped node, all_nodes drops it.
    api.request.mockResolvedValue({
      all_nodes: ["couchdb@couchdb1.local", "couchdb@couchdb2.local"],
      cluster_nodes: ["couchdb@couchdb1.local", "couchdb@couchdb2.local", "couchdb@couchdb3.local"],
    });
    await expect(service.listNodes()).resolves.toEqual([
      { name: "couchdb@couchdb1.local", reachable: true },
      { name: "couchdb@couchdb2.local", reachable: true },
      { name: "couchdb@couchdb3.local", reachable: false },
    ]);
  });

  it("offers a connected node that is not in the cluster's membership yet", async () => {
    api.request.mockResolvedValue({
      all_nodes: ["couchdb@couchdb1.local", "couchdb@couchdb2.local"],
      cluster_nodes: ["couchdb@couchdb1.local"],
    });
    await expect(service.listNodes()).resolves.toEqual([
      { name: "couchdb@couchdb1.local", reachable: true },
      { name: "couchdb@couchdb2.local", reachable: true },
    ]);
  });

  it("sorts the union by name and de-duplicates it", async () => {
    api.request.mockResolvedValue({
      all_nodes: ["couchdb@zulu.local", "couchdb@alpha.local"],
      cluster_nodes: ["couchdb@mike.local", "couchdb@alpha.local"],
    });
    await expect(service.listNodes()).resolves.toEqual([
      { name: "couchdb@alpha.local", reachable: true },
      { name: "couchdb@mike.local", reachable: false },
      { name: "couchdb@zulu.local", reachable: true },
    ]);
  });

  it("treats absent or malformed fields as empty lists", async () => {
    api.request.mockResolvedValue({});
    await expect(service.listNodes()).resolves.toEqual([]);
    api.request.mockResolvedValue({ all_nodes: null, cluster_nodes: "couchdb@couchdb1.local" });
    await expect(service.listNodes()).resolves.toEqual([]);
    api.request.mockResolvedValue({ cluster_nodes: ["couchdb@couchdb1.local"] });
    await expect(service.listNodes()).resolves.toEqual([
      { name: "couchdb@couchdb1.local", reachable: false },
    ]);
  });

  it("propagates a failed request instead of pretending the cluster is empty", async () => {
    // _membership is admin-only: a non-admin gets 401, and the caller must see it to degrade.
    api.request.mockRejectedValue(new Error("401 Unauthorized"));
    await expect(service.listNodes()).rejects.toThrow("401 Unauthorized");
  });
});
