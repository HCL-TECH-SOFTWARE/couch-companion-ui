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

import { describe, it, expect, vi, afterEach } from "vitest";
import { ApiClient } from "../src/services/api-client";
import { ApiError } from "../src/services/api-error";

function okJson(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function errJson(status: number, data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("ApiClient.requestRemote", () => {
  it("fetches the foreign base URL with the given headers and credentials omitted", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson(["db1"]));
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient("https://local:5984");
    const data = await client.requestRemote<string[]>(
      "http://remote:5984",
      "GET",
      "/_all_dbs",
      { Authorization: "Basic abc" },
    );
    expect(data).toEqual(["db1"]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://remote:5984/_all_dbs");
    expect(init.method).toBe("GET");
    expect(init.credentials).toBe("omit");
    expect(init.headers).toEqual({ Authorization: "Basic abc" });
    expect(init.body).toBeUndefined();
  });

  it("serialises a JSON body and sets Content-Type", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson([]));
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient("https://local:5984");
    await client.requestRemote("http://remote:5984/", "POST", "/_dbs_info", {}, { keys: ["a"] });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://remote:5984/_dbs_info");
    expect(init.body).toBe(JSON.stringify({ keys: ["a"] }));
    expect(init.headers["Content-Type"]).toBe("application/json");
  });

  it("throws ApiError with CouchDB's reason on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(errJson(401, { error: "unauthorized", reason: "nope" })),
    );
    const client = new ApiClient("https://local:5984");
    const err = await client
      .requestRemote("http://remote:5984", "GET", "/_all_dbs", {})
      .catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(401);
    expect(err.message).toBe("nope");
  });

  it("does not trigger the session-death probe on a remote 401", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(errJson(401, { error: "unauthorized", reason: "nope" }));
    vi.stubGlobal("fetch", fetchMock);
    const onUnauthorized = vi.fn();
    const client = new ApiClient("https://local:5984", onUnauthorized);
    await expect(
      client.requestRemote("http://remote:5984", "GET", "/_all_dbs", {}),
    ).rejects.toBeInstanceOf(ApiError);
    // Only the one remote call: no /_session probe against the local server.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});
