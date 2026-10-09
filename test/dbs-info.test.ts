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

import { describe, it, expect, vi } from "vitest";
import { fetchDatabaseInfos, DBS_INFO_CHUNK_SIZE } from "../src/services/dbs-info";
import { ApiError } from "../src/services/api-error";

const names = (n: number) => Array.from({ length: n }, (_, i) => `db${i}`);

describe("fetchDatabaseInfos", () => {
  it("chunks 101 names into two POSTs of 100 and 1 keys", async () => {
    const request = vi.fn(async (_m: string, _p: string, body?: unknown) =>
      (body as { keys: string[] }).keys.map((key) => ({
        key,
        info: { db_name: key, doc_count: 2, sizes: { file: 10 }, props: { partitioned: true } },
      })),
    );
    const result = await fetchDatabaseInfos(request as never, names(101));
    expect(DBS_INFO_CHUNK_SIZE).toBe(100);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0][0]).toBe("POST");
    expect(request.mock.calls[0][1]).toBe("/_dbs_info");
    expect((request.mock.calls[0][2] as { keys: string[] }).keys).toHaveLength(100);
    expect((request.mock.calls[1][2] as { keys: string[] }).keys).toEqual(["db100"]);
    expect(result).toHaveLength(101);
    expect(result[0]).toEqual({ db_name: "db0", doc_count: 2, size_byte: 10, partitioned: true });
  });

  it("keeps a row without info as a name-only row", async () => {
    const request = vi.fn().mockResolvedValue([
      { key: "gone", error: "not_found" },
      { key: "ok", info: { db_name: "ok", doc_count: 1 } },
    ]);
    const result = await fetchDatabaseInfos(request as never, ["gone", "ok"]);
    expect(result).toEqual([
      { db_name: "gone" },
      { db_name: "ok", doc_count: 1, size_byte: undefined, partitioned: false },
    ]);
  });

  it("degrades a chunk whose _dbs_info call fails with ApiError to name-only rows", async () => {
    const request = vi.fn().mockRejectedValue(new ApiError(404, "no _dbs_info"));
    const result = await fetchDatabaseInfos(request as never, ["a", "b"]);
    expect(result).toEqual([{ db_name: "a" }, { db_name: "b" }]);
  });

  it("re-throws non-ApiError failures such as a network TypeError", async () => {
    const request = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(fetchDatabaseInfos(request as never, ["a"])).rejects.toBeInstanceOf(TypeError);
  });
});
