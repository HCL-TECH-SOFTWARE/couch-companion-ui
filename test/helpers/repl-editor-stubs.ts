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

import { vi } from "vitest";
import { getContext } from "../../src/context";
import type { ReplicatorDoc } from "../../src/plugins/replication/types";
import type { Server, DatabaseInfo } from "../../src/plugins/server-mgmt/types";
import type { PreviewResult } from "../../src/services/replication-service";

/** Matches the server the old fetch mocks answered with. */
export const STUB_SERVER = { id: "s", name: "S", url: "https://a" } as Server;

/**
 * The replication doc the old fetch mocks served for GET /api/replications/s/r.
 * `source`/`target` carry endpoint `headers` (remote CouchDB auth payload), which the
 * ReplicatorDoc type doesn't declare — hence the cast.
 */
export function stubDoc(overrides: Record<string, unknown> = {}): ReplicatorDoc {
  return {
    _id: "r",
    _rev: "1-x",
    source: { url: "https://a/db", headers: {} },
    target: { url: "https://a/db2", headers: {} },
    continuous: true,
    ...overrides,
  } as ReplicatorDoc;
}

/**
 * Spies the context services cca-repl-editor talks to, with the same data the
 * old global-fetch mocks served. Callers restore via vi.restoreAllMocks().
 */
export function stubReplEditorServices(
  opts: {
    servers?: Server[];
    doc?: ReplicatorDoc;
    databases?: DatabaseInfo[];
    preview?: PreviewResult;
    /** Defaults to {@link STUB_SERVER}'s url, so the default fixture's "https://a/..." endpoints read as local. */
    localBaseUrl?: string;
  } = {},
) {
  const ctx = getContext();
  return {
    listServers: vi.spyOn(ctx.serverMgmt, "listServers").mockResolvedValue({
      servers: opts.servers ?? [STUB_SERVER],
      nextBookmark: "",
    }),
    getDatabases: vi
      .spyOn(ctx.serverMgmt, "getDatabases")
      .mockResolvedValue(opts.databases ?? [{ name: "db" }]),
    getReplication: vi
      .spyOn(ctx.replication, "getReplication")
      .mockResolvedValue(opts.doc ?? stubDoc()),
    updateReplication: vi
      .spyOn(ctx.replication, "updateReplication")
      .mockResolvedValue({ ok: true, id: "r", rev: "2-y" }),
    createReplication: vi
      .spyOn(ctx.replication, "createReplication")
      .mockResolvedValue({ ok: true, id: "new", rev: "1-a" }),
    previewReplication: vi
      .spyOn(ctx.replication, "previewReplication")
      .mockResolvedValue(
        opts.preview ?? { estimated_doc_count: 0, sample_doc_ids: [] },
      ),
    localBaseUrl: vi
      .spyOn(ctx.replication, "localBaseUrl")
      .mockReturnValue(opts.localBaseUrl ?? STUB_SERVER.url),
  };
}
