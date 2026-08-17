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
import { ConfigService } from "../src/services/config-service";
import { SINGLE_SERVER_ID } from "../src/services/single-server";
import { ApiClient } from "../src/services/api-client";

let api: ApiClient & { request: ReturnType<typeof vi.fn> };
let service: ConfigService;

beforeEach(() => {
  api = { request: vi.fn().mockResolvedValue({}) } as unknown as typeof api;
  service = new ConfigService(api);
});

describe("getConfig", () => {
  it("reads the local node config verbatim", async () => {
    api.request.mockResolvedValue({ chttpd: { port: "5984" }, cors: { origins: "*" } });
    await expect(service.getConfig(SINGLE_SERVER_ID)).resolves.toEqual({
      chttpd: { port: "5984" },
      cors: { origins: "*" },
    });
    expect(api.request).toHaveBeenCalledWith("GET", "/_node/_local/_config");
  });
});

describe("setConfigValue", () => {
  it("PUTs the bare JSON value and returns the previous one", async () => {
    api.request.mockResolvedValue("false");
    await expect(service.setConfigValue(SINGLE_SERVER_ID, "chttpd", "enable_cors", "true")).resolves.toBe("false");
    expect(api.request).toHaveBeenCalledWith("PUT", "/_node/_local/_config/chttpd/enable_cors", "true");
  });

  it("returns an empty string when CouchDB reports no previous value", async () => {
    api.request.mockResolvedValue("");
    await expect(service.setConfigValue(SINGLE_SERVER_ID, "cors", "origins", "*")).resolves.toBe("");
    api.request.mockResolvedValue(undefined);
    await expect(service.setConfigValue(SINGLE_SERVER_ID, "cors", "origins", "*")).resolves.toBe("");
  });

  it("URL-encodes section and key", async () => {
    api.request.mockResolvedValue("");
    await service.setConfigValue(SINGLE_SERVER_ID, "feature_flags", "partitioned||*", "true");
    expect(api.request).toHaveBeenCalledWith(
      "PUT",
      "/_node/_local/_config/feature_flags/partitioned%7C%7C*",
      "true",
    );
  });
});

describe("node-scoped config", () => {
  const NODE = "couchdb@couchdb1.example.local";
  const ENCODED = "couchdb%40couchdb1.example.local";

  it("reads one named node's config, percent-encoding the @ in the node name", async () => {
    api.request.mockResolvedValue({ chttpd: { port: "5984" }, cluster: { n: "3" } });
    await expect(service.getNodeConfig(NODE)).resolves.toEqual({
      chttpd: { port: "5984" },
      cluster: { n: "3" },
    });
    expect(api.request).toHaveBeenCalledWith("GET", `/_node/${ENCODED}/_config`);
  });

  it("PUTs the bare JSON value to the named node and returns the previous one", async () => {
    api.request.mockResolvedValue("false");
    await expect(service.setNodeConfigValue(NODE, "chttpd", "enable_cors", "true")).resolves.toBe("false");
    expect(api.request).toHaveBeenCalledWith(
      "PUT",
      `/_node/${ENCODED}/_config/chttpd/enable_cors`,
      "true",
    );
  });

  it("returns an empty string when CouchDB reports no previous value", async () => {
    api.request.mockResolvedValue(undefined);
    await expect(service.setNodeConfigValue(NODE, "cors", "origins", "*")).resolves.toBe("");
    api.request.mockResolvedValue(null);
    await expect(service.setNodeConfigValue(NODE, "cors", "origins", "*")).resolves.toBe("");
  });

  it("URL-encodes node, section and key", async () => {
    api.request.mockResolvedValue("");
    await service.setNodeConfigValue(NODE, "feature_flags", "partitioned||*", "true");
    expect(api.request).toHaveBeenCalledWith(
      "PUT",
      `/_node/${ENCODED}/_config/feature_flags/partitioned%7C%7C*`,
      "true",
    );
  });

  it("propagates a rejected request instead of swallowing it", async () => {
    api.request.mockRejectedValue(new Error("nodedown"));
    await expect(service.getNodeConfig(NODE)).rejects.toThrow("nodedown");
    await expect(service.setNodeConfigValue(NODE, "cors", "origins", "*")).rejects.toThrow("nodedown");
  });
});

describe("deleteConfigValue", () => {
  it("DELETEs the key", async () => {
    await service.deleteConfigValue(SINGLE_SERVER_ID, "cors", "origins");
    expect(api.request).toHaveBeenCalledWith("DELETE", "/_node/_local/_config/cors/origins");
  });
});

describe("restartNode", () => {
  it("POSTs the local restart endpoint", async () => {
    await service.restartNode(SINGLE_SERVER_ID);
    expect(api.request).toHaveBeenCalledWith("POST", "/_node/_local/_restart");
  });
});
