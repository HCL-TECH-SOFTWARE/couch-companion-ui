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
import { ReplicationService, maskUrlCredentials } from "../src/services/replication-service";
import { SINGLE_SERVER_ID } from "../src/services/single-server";
import { ApiClient } from "../src/services/api-client";

const REPL_ROWS = {
  total_rows: 2,
  rows: [
    { id: "_design/x", key: "_design/x", value: { rev: "1-a" }, doc: { _id: "_design/x", _rev: "1-a" } },
    {
      id: "r1", key: "r1", value: { rev: "1-b" },
      doc: {
        _id: "r1", _rev: "1-b", continuous: true, owner: "admin",
        source: "http://admin:secret@localhost:5984/src",
        target: "http://localhost:5984/tgt",
      },
    },
  ],
};

const SCHED_HEALTHY = {
  total_rows: 1, offset: 0,
  docs: [{
    database: "_replicator", doc_id: "r1", id: "abc+continuous", node: "nonode@nohost",
    source: "http://localhost:5984/src/", target: "http://localhost:5984/tgt/",
    state: "running",
    info: { revisions_checked: 3, docs_read: 3, docs_written: 3, changes_pending: 0, doc_write_failures: 0 },
    error_count: 0, last_updated: "2026-08-06T10:00:00Z", start_time: "2026-08-06T09:59:00Z",
  }],
};

let api: ApiClient & { request: ReturnType<typeof vi.fn>; currentBaseUrl: string };
let service: ReplicationService;

const route = (over: Record<string, unknown> = {}) =>
  vi.fn((_m: string, path: string) => {
    const table: Record<string, unknown> = {
      "/_replicator/_all_docs?include_docs=true": REPL_ROWS,
      "/_scheduler/docs": SCHED_HEALTHY,
      ...over,
    };
    const hit = Object.entries(table).find(([k]) => path.startsWith(k.split("?")[0]));
    if (hit) return Promise.resolve(over[path] ?? hit[1]);
    return Promise.reject(new Error(`unexpected ${path}`));
  });

beforeEach(() => {
  api = { request: route(), currentBaseUrl: "http://localhost:5984" } as unknown as typeof api;
  service = new ReplicationService(api);
});

describe("maskUrlCredentials", () => {
  it("masks userinfo and leaves clean URLs alone", () => {
    expect(maskUrlCredentials("http://admin:secret@localhost:5984/db")).toBe("http://***@localhost:5984/db");
    expect(maskUrlCredentials("http://localhost:5984/db")).toBe("http://localhost:5984/db");
    expect(maskUrlCredentials("not a url")).toBe("not a url");
  });
});

describe("listReplications", () => {
  it("returns replicator docs, skipping design docs, annotated with the single server", async () => {
    const docs = await service.listReplications();
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({
      _id: "r1",
      replicator_doc_id: "r1",
      cca_server_id: SINGLE_SERVER_ID,
      continuous: true,
    });
    expect(typeof docs[0].cca_server_name).toBe("string");
  });

  it("joins scheduler state, progress and timestamps by doc_id", async () => {
    const [doc] = await service.listReplications();
    expect(doc.replication_state).toBe("running");
    expect(doc.replication_state_time).toBe("2026-08-06T10:00:00Z");
    expect(doc.docs_written).toBe(3);
    expect(doc.changes_pending).toBe(0);
    expect(doc.error_count).toBe(0);
    expect(doc.scheduler_error).toBeUndefined();
  });

  it("surfaces a crashing job's error from the info union", async () => {
    api.request = route({
      "/_scheduler/docs": {
        total_rows: 1, offset: 0,
        docs: [{ doc_id: "r1", database: "_replicator", state: "crashing", error_count: 4,
                 info: { error: "unauthorized: unauthorized to access or create database http://h/src/" },
                 last_updated: "2026-08-06T10:05:00Z" }],
      },
    }) as never;
    const [doc] = await service.listReplications();
    expect(doc.replication_state).toBe("crashing");
    expect(doc.error_count).toBe(4);
    expect(doc.scheduler_error).toMatch(/unauthorized/);
    expect(doc.docs_written).toBeUndefined();
  });

  it("still lists documents when the scheduler call fails", async () => {
    api.request = route({ "/_scheduler/docs": new Error("boom") }) as never;
    api.request = vi.fn((_m: string, path: string) =>
      path.startsWith("/_scheduler") ? Promise.reject(new Error("boom")) : Promise.resolve(REPL_ROWS),
    ) as never;
    const docs = await service.listReplications();
    expect(docs).toHaveLength(1);
    expect(docs[0].replication_state).toBeUndefined();
  });

  it("rejects when the primary _replicator read fails, unlike a scheduler failure", async () => {
    const boom = new Error("boom");
    api.request = vi.fn((_m: string, path: string) =>
      path.startsWith("/_replicator/_all_docs") ? Promise.reject(boom) : Promise.resolve(SCHED_HEALTHY),
    ) as never;
    await expect(service.listReplications()).rejects.toBe(boom);
  });

  it("filters client-side on the filter param across id, source and target", async () => {
    expect(await service.listReplications({ filter: "tgt" })).toHaveLength(1);
    expect(await service.listReplications({ filter: "nomatch" })).toHaveLength(0);
    expect(await service.listReplications({ filter: "  " })).toHaveLength(1);
  });

  it("never leaks credentials in the source/target it returns", async () => {
    const [doc] = await service.listReplications();
    expect(JSON.stringify(doc)).not.toContain("secret");
    expect(String(doc.source)).toBe("http://***@localhost:5984/src");
  });

  it("strips endpoint headers from the list payload entirely, unlike getReplication", async () => {
    api.request = route({
      "/_replicator/_all_docs?include_docs=true": {
        rows: [
          {
            id: "r1", key: "r1", value: { rev: "1-b" },
            doc: {
              _id: "r1", _rev: "1-b", continuous: true,
              source: { url: "http://h/src", headers: { Authorization: "Basic zzz" } },
              target: { url: "http://h/tgt", headers: { "X-Auth-CouchDB-Token": "tok-secret" } },
            },
          },
        ],
      },
    }) as never;
    const [doc] = await service.listReplications();
    expect(JSON.stringify(doc)).not.toContain("zzz");
    expect(JSON.stringify(doc)).not.toContain("tok-secret");
    expect((doc.source as { headers?: unknown }).headers).toBeUndefined();
    expect((doc.target as { headers?: unknown }).headers).toBeUndefined();
    // The url itself is still there (masked, not stripped) — only headers are dropped.
    expect((doc.source as { url: string }).url).toBe("http://h/src");
  });
});

describe("getReplication", () => {
  it("reads one document by id and masks credentials", async () => {
    api.request = vi.fn().mockResolvedValue({
      _id: "r1", _rev: "1-b", continuous: false,
      source: { url: "http://admin:secret@h/src", headers: { Authorization: "Basic zzz" } },
      target: "http://h/tgt",
    }) as never;
    const doc = await service.getReplication(SINGLE_SERVER_ID, "r1");
    expect(api.request).toHaveBeenCalledWith("GET", "/_replicator/r1");
    expect(JSON.stringify(doc)).not.toContain("secret");
    expect((doc.source as { url: string }).url).toBe("http://***@h/src");
  });

  it("preserves the Authorization header so an edit round-trip does not drop it", async () => {
    api.request = vi.fn().mockResolvedValue({
      _id: "r1", _rev: "1-b", continuous: false,
      source: { url: "http://h/src", headers: { Authorization: "Basic zzz" } }, target: "http://h/tgt",
    }) as never;
    const doc = await service.getReplication(SINGLE_SERVER_ID, "r1");
    expect((doc.source as { headers?: Record<string, string> }).headers?.Authorization).toBe("Basic zzz");
  });
});

describe("createReplication", () => {
  it("PUTs the document under its _id and returns {ok,id,rev}", async () => {
    api.request = vi.fn().mockResolvedValue({ ok: true, id: "mine", rev: "1-z" }) as never;
    const doc = { _id: "mine", source: "http://h/a", target: "http://h/b", continuous: true };
    await expect(service.createReplication(doc as never)).resolves.toEqual({ ok: true, id: "mine", rev: "1-z" });
    expect(api.request).toHaveBeenCalledWith("PUT", "/_replicator/mine", expect.objectContaining({ source: "http://h/a" }));
  });

  it("POSTs when the document carries no _id", async () => {
    api.request = vi.fn().mockResolvedValue({ ok: true, id: "gen", rev: "1-y" }) as never;
    await service.createReplication({ source: "http://h/a", target: "http://h/b", continuous: false } as never);
    expect(api.request).toHaveBeenCalledWith("POST", "/_replicator", expect.any(Object));
  });

  it("strips annotation fields before writing", async () => {
    api.request = vi.fn().mockResolvedValue({ ok: true, id: "x", rev: "1-a" }) as never;
    await service.createReplication({
      _id: "x", source: "http://h/a", target: "http://h/b", continuous: false,
      cca_server_id: "local", cca_server_name: "here", replicator_doc_id: "x",
      replication_state: "running", scheduler_error: "nope", error_count: 2, docs_written: 9,
    } as never);
    const body = (api.request as ReturnType<typeof vi.fn>).mock.calls[0][2] as Record<string, unknown>;
    for (const k of ["cca_server_id", "cca_server_name", "replicator_doc_id", "replication_state",
                     "scheduler_error", "error_count", "docs_written", "changes_pending"]) {
      expect(body).not.toHaveProperty(k);
    }
  });
});

describe("updateReplication", () => {
  it("read-modify-writes so unedited tuning fields survive", async () => {
    const stored = {
      _id: "r1", _rev: "3-c", source: "http://h/a", target: "http://h/b", continuous: false,
      use_checkpoints: false, checkpoint_interval: 9000, worker_processes: 8,
    };
    api.request = vi.fn((m: string, path: string) => {
      if (m === "GET" && path === "/_replicator/r1") return Promise.resolve(stored);
      return Promise.resolve({ ok: true, id: "r1", rev: "4-d" });
    }) as never;
    await service.updateReplication(SINGLE_SERVER_ID, "r1", { continuous: true } as never);
    const [, path, body] = (api.request as ReturnType<typeof vi.fn>).mock.calls.at(-1) as [string, string, Record<string, unknown>];
    expect(path).toBe("/_replicator/r1");
    expect(body).toMatchObject({ _id: "r1", _rev: "3-c", continuous: true,
      use_checkpoints: false, checkpoint_interval: 9000, worker_processes: 8 });
  });

  it("uses the caller's _rev when it supplies one", async () => {
    api.request = vi.fn((m: string) =>
      m === "GET" ? Promise.resolve({ _id: "r1", _rev: "3-c", source: "a", target: "b", continuous: false })
                  : Promise.resolve({ ok: true, id: "r1", rev: "9-z" })) as never;
    await service.updateReplication(SINGLE_SERVER_ID, "r1", { _rev: "8-y", continuous: false } as never);
    const body = (api.request as ReturnType<typeof vi.fn>).mock.calls.at(-1)![2] as Record<string, unknown>;
    expect(body._rev).toBe("8-y");
  });

  it("keeps the stored source when the caller sends back a masked one (round-tripped from a read)", async () => {
    const stored = {
      _id: "r1", _rev: "3-c", continuous: false,
      source: "http://admin:real@h/src", target: "http://h/tgt",
    };
    api.request = vi.fn((m: string, path: string) =>
      m === "GET" && path === "/_replicator/r1"
        ? Promise.resolve(stored)
        : Promise.resolve({ ok: true, id: "r1", rev: "4-d" })) as never;
    await service.updateReplication(SINGLE_SERVER_ID, "r1", {
      source: "http://***@h/src", continuous: false,
    } as never);
    const body = (api.request as ReturnType<typeof vi.fn>).mock.calls.at(-1)![2] as Record<string, unknown>;
    expect(body.source).toBe("http://admin:real@h/src");
  });

  it("writes a genuinely new source that carries real credentials", async () => {
    const stored = {
      _id: "r1", _rev: "3-c", continuous: false,
      source: "http://admin:real@h/src", target: "http://h/tgt",
    };
    api.request = vi.fn((m: string, path: string) =>
      m === "GET" && path === "/_replicator/r1"
        ? Promise.resolve(stored)
        : Promise.resolve({ ok: true, id: "r1", rev: "4-d" })) as never;
    await service.updateReplication(SINGLE_SERVER_ID, "r1", {
      source: "http://admin:newpass@h2/src2", continuous: false,
    } as never);
    const body = (api.request as ReturnType<typeof vi.fn>).mock.calls.at(-1)![2] as Record<string, unknown>;
    expect(body.source).toBe("http://admin:newpass@h2/src2");
  });

  it("keeps the stored url but takes new headers when the caller's url is still masked", async () => {
    const stored = {
      _id: "r1", _rev: "3-c", continuous: false,
      source: { url: "http://admin:real@h/src", headers: { Authorization: "Basic old" } },
      target: "http://h/tgt",
    };
    api.request = vi.fn((m: string, path: string) =>
      m === "GET" && path === "/_replicator/r1"
        ? Promise.resolve(stored)
        : Promise.resolve({ ok: true, id: "r1", rev: "4-d" })) as never;
    await service.updateReplication(SINGLE_SERVER_ID, "r1", {
      source: { url: "http://***@h/src", headers: { Authorization: "Basic new" } },
      continuous: false,
    } as never);
    const body = (api.request as ReturnType<typeof vi.fn>).mock.calls.at(-1)![2] as Record<string, unknown>;
    expect(body.source).toEqual({ url: "http://admin:real@h/src", headers: { Authorization: "Basic new" } });
  });

  // A masked endpoint whose editor-recombined URL still points at the same server (only its
  // path/database changed) must not be fully reverted — that would silently discard a legitimate
  // "just changed the database" edit while still reporting success (found in review of 2e609d5).
  it("splices the stored credentials onto a same-origin masked target whose path changed", async () => {
    const stored = {
      _id: "r1", _rev: "3-c", continuous: false,
      source: "http://h/src",
      target: { url: "http://realuser:realpass@remote:5984/db2", headers: {} },
    };
    api.request = vi.fn((m: string, path: string) =>
      m === "GET" && path === "/_replicator/r1"
        ? Promise.resolve(stored)
        : Promise.resolve({ ok: true, id: "r1", rev: "4-d" })) as never;
    await service.updateReplication(SINGLE_SERVER_ID, "r1", {
      // Same origin as stored (remote:5984), masked credentials, but a different path — exactly
      // what the editor sends when only the target database field was edited.
      target: { url: "http://***@remote:5984/mirror", headers: {} },
      continuous: false,
    } as never);
    const body = (api.request as ReturnType<typeof vi.fn>).mock.calls.at(-1)![2] as Record<string, unknown>;
    expect(body.target).toEqual({ url: "http://realuser:realpass@remote:5984/mirror", headers: {} });
  });

  // `cca-repl-editor` writes an explicit `null` (edit mode only) for a managed key the user
  // cleared — see MANAGED_CLEARABLE_KEYS / buildReplicatorDocFromDesign. Without this drop, the
  // `{...stored, ...safeDoc}` merge would PUT a literal `null` instead of omitting the key.
  it("drops a caller-supplied null key from the merge instead of PUTting a literal null", async () => {
    const stored = {
      _id: "r1", _rev: "3-c", continuous: false,
      source: "http://h/a", target: "http://h/b",
      filter: "ddoc/fn", worker_processes: 8,
    };
    api.request = vi.fn((m: string, path: string) =>
      m === "GET" && path === "/_replicator/r1"
        ? Promise.resolve(stored)
        : Promise.resolve({ ok: true, id: "r1", rev: "4-d" })) as never;
    await service.updateReplication(SINGLE_SERVER_ID, "r1", {
      filter: null, continuous: false,
    } as never);
    const body = (api.request as ReturnType<typeof vi.fn>).mock.calls.at(-1)![2] as Record<string, unknown>;
    expect(body).not.toHaveProperty("filter");
    // A key the caller never mentioned at all (untouched) still survives the merge —
    // dropNullValues must not disturb it (the existing Task-1 guarantee).
    expect(body.worker_processes).toBe(8);
  });

  it("ignores a masked target whose origin no longer matches stored, keeping the stored endpoint", async () => {
    const stored = {
      _id: "r1", _rev: "3-c", continuous: false,
      source: "http://h/src",
      target: "http://realuser:realpass@remote:5984/db2",
    };
    api.request = vi.fn((m: string, path: string) =>
      m === "GET" && path === "/_replicator/r1"
        ? Promise.resolve(stored)
        : Promise.resolve({ ok: true, id: "r1", rev: "4-d" })) as never;
    await service.updateReplication(SINGLE_SERVER_ID, "r1", {
      // Different host than stored (otherhost, not remote) — the frontend cannot know that
      // server's real credentials, so this must not be honoured even though it's "masked".
      target: "http://***@otherhost:5984/mirror",
      continuous: false,
    } as never);
    const body = (api.request as ReturnType<typeof vi.fn>).mock.calls.at(-1)![2] as Record<string, unknown>;
    expect(body.target).toBe("http://realuser:realpass@remote:5984/db2");
  });
});

describe("deleteReplication", () => {
  it("reads the current rev then DELETEs", async () => {
    api.request = vi.fn((m: string) =>
      m === "GET" ? Promise.resolve({ _id: "r1", _rev: "5-e" }) : Promise.resolve({ ok: true })) as never;
    await service.deleteReplication(SINGLE_SERVER_ID, "r1");
    expect(api.request).toHaveBeenLastCalledWith("DELETE", "/_replicator/r1?rev=5-e");
  });
});

describe("previewReplication", () => {
  it("counts and samples with a selector via _find", async () => {
    api.request = vi.fn().mockResolvedValue({ docs: [{ _id: "a" }, { _id: "b" }] }) as never;
    const res = await service.previewReplication({ source_server_id: "local", source_db: "src", selector: { type: "x" } } as never);
    const [, path, body] = (api.request as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(path).toBe("/src/_find");
    expect(body).toMatchObject({ selector: { type: "x" } });
    expect(res.estimated_doc_count).toBe(2);
    expect(res.sample_doc_ids).toEqual(["a", "b"]);
  });

  it("uses _all_docs total_rows when there is no selector", async () => {
    api.request = vi.fn().mockResolvedValue({ total_rows: 4321, rows: [{ id: "a" }] }) as never;
    const res = await service.previewReplication({ source_server_id: "local", source_db: "src" } as never);
    expect(res.estimated_doc_count).toBe(4321);
  });

  it("warns that the count is a lower bound when the sample hits the cap", async () => {
    api.request = vi.fn().mockResolvedValue({ docs: Array.from({ length: 101 }, (_, i) => ({ _id: `d${i}` })) }) as never;
    const res = await service.previewReplication({ source_server_id: "local", source_db: "src", selector: {} } as never);
    expect(res.warning).toBeTruthy();
    expect(res.sample_doc_ids.length).toBeLessThanOrEqual(5);
  });

  it("warns that a JavaScript filter cannot be evaluated in the browser", async () => {
    api.request = vi.fn().mockResolvedValue({ total_rows: 3, rows: [] }) as never;
    const res = await service.previewReplication({ source_server_id: "local", source_db: "src", filter: "ddoc/fn" } as never);
    expect(res.warning).toMatch(/filter/i);
  });
});
