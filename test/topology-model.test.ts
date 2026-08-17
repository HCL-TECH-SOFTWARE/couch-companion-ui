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

import { it, expect } from "vitest";
import { buildTopology } from "../src/services/topology-model";
import type { Server, TopologyData } from "../src/plugins/server-mgmt/types";

const local = {
  id: "local",
  name: "localhost:5984",
  url: "http://localhost:5984",
  reachable: true,
} as Server;

it("draws one local node when a replication is local to local", () => {
  const t = buildTopology(
    [
      {
        _id: "r1",
        source: "http://localhost:5984/a",
        target: "http://localhost:5984/b",
        continuous: true,
        replicator_doc_id: "r1",
      } as never,
    ],
    local,
  );
  expect(t.servers).toHaveLength(1);
  expect(t.connections[0]).toMatchObject({
    source_server_id: "local",
    target_server_id: "local",
    source_db: "a",
    target_db: "b",
    continuous: true,
  });
});

it("synthesizes one node per distinct remote host, never contacting it", () => {
  const t = buildTopology(
    [
      {
        _id: "r1",
        source: "http://localhost:5984/a",
        target: "https://remote.example:6984/mirror",
        continuous: false,
        replicator_doc_id: "r1",
      },
      {
        _id: "r2",
        source: "http://localhost:5984/b",
        target: "https://remote.example:6984/other",
        continuous: false,
        replicator_doc_id: "r2",
      },
    ] as never,
    local,
  );
  const remotes = t.servers.filter((s) => s.kind === "remote");
  expect(remotes).toHaveLength(1);
  expect(remotes[0].url).toBe("https://remote.example:6984");
  expect(t.connections).toHaveLength(2);
});

it("keeps masked credentials out of node labels and urls", () => {
  const t = buildTopology(
    [
      {
        _id: "r1",
        source: "http://localhost:5984/a",
        target: "http://***@remote.example:6984/x",
        continuous: false,
        replicator_doc_id: "r1",
      } as never,
    ],
    local,
  );
  expect(JSON.stringify(t)).not.toContain("***@");
});

it("handles {url} endpoint objects and unparseable endpoints", () => {
  const docs = [
    {
      _id: "r1",
      source: { url: "http://localhost:5984/a" },
      target: { url: "https://remote.example:6984/b" },
      continuous: true,
      replicator_doc_id: "r1",
    },
    {
      // Garbage source: not a parseable URL. The whole connection must be
      // dropped rather than the function throwing or half-resolving it.
      _id: "r2",
      source: "not a valid url",
      target: "https://remote.example:6984/c",
      continuous: false,
      replicator_doc_id: "r2",
    },
  ] as never;

  let t: TopologyData | undefined;
  expect(() => {
    t = buildTopology(docs, local);
  }).not.toThrow();

  expect(t!.connections).toHaveLength(1);
  expect(t!.connections[0]).toMatchObject({
    source_server_id: "local",
    target_server_id: "remote:remote.example:6984",
    source_db: "a",
    target_db: "b",
    continuous: true,
  });
  // The one distinct remote host referenced by the surviving connection.
  const remotes = t!.servers.filter((s) => s.kind === "remote");
  expect(remotes).toHaveLength(1);
  expect(remotes[0].url).toBe("https://remote.example:6984");
});

it("returns the local node alone when there are no replications", () => {
  const t = buildTopology([], local);
  expect(t.servers).toHaveLength(1);
  expect(t.servers[0]).toMatchObject({ id: "local", kind: "local" });
  expect(t.connections).toEqual([]);
});

it("reads bare database names on both sides as local databases (#59)", () => {
  const t = buildTopology(
    [
      {
        _id: "r1",
        source: "db_a",
        target: "db_b",
        continuous: false,
        replicator_doc_id: "r1",
      } as never,
    ],
    local,
  );
  expect(t.servers).toHaveLength(1);
  expect(t.connections).toHaveLength(1);
  expect(t.connections[0]).toMatchObject({
    source_server_id: "local",
    target_server_id: "local",
    source_db: "db_a",
    target_db: "db_b",
  });
});

it("reads a bare name on one side and a URL on the other (#59)", () => {
  const t = buildTopology(
    [
      {
        _id: "r1",
        source: "db_a",
        target: "https://remote.example:6984/mirror",
        continuous: true,
        replicator_doc_id: "r1",
      },
      {
        _id: "r2",
        source: { url: "https://remote.example:6984/mirror" },
        target: "_users",
        continuous: false,
        replicator_doc_id: "r2",
      },
    ] as never,
    local,
  );
  expect(t.connections).toHaveLength(2);
  expect(t.connections[0]).toMatchObject({
    source_server_id: "local",
    source_db: "db_a",
    target_server_id: "remote:remote.example:6984",
    target_db: "mirror",
  });
  expect(t.connections[1]).toMatchObject({
    source_server_id: "remote:remote.example:6984",
    source_db: "mirror",
    target_server_id: "local",
    target_db: "_users",
  });
  expect(t.servers.filter((s) => s.kind === "remote")).toHaveLength(1);
});

it("skips documents that do not name both ends of a replication (#59)", () => {
  const t = buildTopology(
    [
      // No source at all — must stay off the graph now that a non-URL endpoint
      // is readable, instead of falling out only because `new URL("")` threw.
      { _id: "no-source", target: "db_b" },
      { _id: "no-target", source: "db_a" },
      { _id: "empty-strings", source: "", target: "" },
      { _id: "empty-url-objects", source: { url: "" }, target: { url: "" } },
      { _id: "nothing-at-all" },
    ] as never,
    local,
  );
  expect(t.connections).toEqual([]);
  expect(t.servers).toHaveLength(1);
});

it("drops endpoints that are neither a URL nor a database name (#59)", () => {
  const t = buildTopology(
    [
      // Space: not a legal CouchDB database name. Loosening the URL parse must
      // not turn arbitrary strings into database nodes.
      { _id: "r1", source: "not a valid url", target: "db_b" },
      // Path-shaped: a malformed URL far more often than a database whose name
      // contains a slash.
      { _id: "r2", source: "//localhost:5984/a", target: "db_b" },
      { _id: "r3", source: "_design/mydesign", target: "db_b" },
      // Uppercase: CouchDB rejects it as a database name.
      { _id: "r4", source: "DbA", target: "db_b" },
    ] as never,
    local,
  );
  expect(t.connections).toEqual([]);
  expect(t.servers).toHaveLength(1);
});

it("treats loopback aliases of the local server as the local node (#59)", () => {
  const t = buildTopology(
    [
      {
        _id: "r1",
        source: "http://127.0.0.1:5984/a",
        target: "http://localhost:5984/b",
        continuous: true,
        replicator_doc_id: "r1",
      },
      {
        _id: "r2",
        source: "http://[::1]:5984/a",
        // Explicit default port + uppercase host: still the same origin.
        target: "http://LOCALHOST:5984/c",
        continuous: false,
        replicator_doc_id: "r2",
      },
    ] as never,
    local,
  );
  expect(t.servers).toHaveLength(1);
  expect(t.connections).toHaveLength(2);
  expect(
    t.connections.every(
      (c) => c.source_server_id === "local" && c.target_server_id === "local",
    ),
  ).toBe(true);
});

it("collapses loopback aliases of one remote host onto one node (#59)", () => {
  const t = buildTopology(
    [
      {
        _id: "r1",
        source: "http://localhost:5984/a",
        // A *different* CouchDB on the same machine: same host, other port.
        target: "http://127.0.0.1:15984/mirror",
        continuous: false,
        replicator_doc_id: "r1",
      },
      {
        _id: "r2",
        source: "http://localhost:5984/b",
        target: "http://localhost:15984/mirror",
        continuous: false,
        replicator_doc_id: "r2",
      },
    ] as never,
    local,
  );
  const remotes = t.servers.filter((s) => s.kind === "remote");
  expect(remotes).toHaveLength(1);
  expect(t.connections).toHaveLength(2);
  expect(t.connections[0].target_server_id).toBe(
    t.connections[1].target_server_id,
  );
});

it("keeps masked credentials out of the output for aliased and bare endpoints", () => {
  const t = buildTopology(
    [
      {
        _id: "r1",
        source: "db_a",
        target: "http://***@127.0.0.1:5984/x",
        continuous: false,
        replicator_doc_id: "r1",
      } as never,
    ],
    local,
  );
  expect(JSON.stringify(t)).not.toContain("***@");
  expect(JSON.stringify(t)).not.toContain("***");
});
