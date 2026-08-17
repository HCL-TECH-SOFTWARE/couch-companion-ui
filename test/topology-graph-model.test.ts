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
import {
  buildTopology,
  buildTopologyGraph,
  type TopologyGraph,
  type TopologyGraphEdge,
} from "../src/services/topology-model";
import type { Server, TopologyData } from "../src/plugins/server-mgmt/types";

const local = {
  id: "local",
  name: "localhost:5984",
  url: "http://localhost:5984",
  reachable: true,
} as Server;

const REMOTE = "remote:remote.example:6984";

/** The graph as the topology view builds it: raw `_replicator` documents in, drawn shapes out. */
function graphOf(docs: unknown[]): TopologyGraph {
  return buildTopologyGraph(buildTopology(docs as never, local));
}

function hostsEdges(graph: TopologyGraph) {
  return graph.edges.filter((e) => e.kind === "hosts");
}

function replicationEdges(graph: TopologyGraph) {
  return graph.edges.filter((e) => e.kind === "replication");
}

/** `source -> target`, the readable form of an edge for a whole-set assertion. */
function arrow(edge: TopologyGraphEdge): string {
  return `${edge.source} -> ${edge.target}`;
}

it("hangs each database off the server that holds it, with the replication between the databases", () => {
  const graph = graphOf([
    {
      _id: "r1",
      source: "http://localhost:5984/a",
      target: "http://localhost:5984/b",
      continuous: true,
      replicator_doc_id: "r1",
    },
  ]);

  expect(graph.nodes).toEqual([
    {
      kind: "server",
      id: "server:local",
      label: "localhost:5984",
      serverId: "local",
      serverKind: "local",
      reachable: true,
    },
    {
      kind: "database",
      id: "db:local:a",
      label: "a",
      serverId: "local",
      serverKind: "local",
      direction: "outgoing",
    },
    {
      kind: "database",
      id: "db:local:b",
      label: "b",
      serverId: "local",
      serverKind: "local",
      direction: "incoming",
    },
  ]);
  expect(hostsEdges(graph).map(arrow)).toEqual([
    "server:local -> db:local:a",
    "server:local -> db:local:b",
  ]);
  expect(replicationEdges(graph)).toEqual([
    {
      kind: "replication",
      source: "db:local:a",
      target: "db:local:b",
      bidirectional: false,
      count: 1,
      continuity: "continuous",
      replicator_doc_ids: ["r1"],
    },
  ]);
});

it("colours a database by which side of a document it appears on", () => {
  const graph = graphOf([
    {
      _id: "r1",
      source: "http://localhost:5984/a",
      target: "http://localhost:5984/b",
      continuous: false,
      replicator_doc_id: "r1",
    },
    // `b` is now written to *and* read from; `c` is only written to.
    {
      _id: "r2",
      source: "http://localhost:5984/b",
      target: "http://localhost:5984/c",
      continuous: false,
      replicator_doc_id: "r2",
    },
  ]);

  expect(
    graph.nodes
      .filter((n) => n.kind === "database")
      .map((n) => [n.label, n.direction]),
  ).toEqual([
    ["a", "outgoing"],
    ["b", "both"],
    ["c", "incoming"],
  ]);
});

it("aggregates every document between one pair of databases onto one edge", () => {
  const graph = graphOf([
    {
      _id: "r1",
      source: "db_a",
      target: "db_b",
      continuous: true,
      replicator_doc_id: "r1",
    },
    // A second document the same way round: one more line lying exactly on the first, before #43.
    {
      _id: "r2",
      source: "db_a",
      target: "db_b",
      continuous: false,
      replicator_doc_id: "r2",
    },
  ]);

  expect(replicationEdges(graph)).toEqual([
    {
      kind: "replication",
      source: "db:local:db_a",
      target: "db:local:db_b",
      bidirectional: false,
      count: 2,
      // One of each, so neither line style alone would be true.
      continuity: "mixed",
      replicator_doc_ids: ["r1", "r2"],
    },
  ]);
});

it("folds documents running both ways into one bidirectional edge", () => {
  const graph = graphOf([
    {
      _id: "r1",
      source: "db_a",
      target: "db_b",
      continuous: true,
      replicator_doc_id: "r1",
    },
    {
      _id: "r2",
      source: "db_b",
      target: "db_a",
      continuous: true,
      replicator_doc_id: "r2",
    },
  ]);

  expect(replicationEdges(graph)).toEqual([
    {
      kind: "replication",
      // The orientation of the first document seen; the flag carries the other way.
      source: "db:local:db_a",
      target: "db:local:db_b",
      bidirectional: true,
      count: 2,
      continuity: "continuous",
      replicator_doc_ids: ["r1", "r2"],
    },
  ]);
  // Both databases are read from and written to, so both are "both".
  expect(
    graph.nodes.filter((n) => n.kind === "database").map((n) => n.direction),
  ).toEqual(["both", "both"]);
});

it("keeps a self-replication as a self-loop rather than marking it bidirectional", () => {
  // `source === target` cannot run on CouchDB, which is why it must stay visible: before
  // databases were nodes it drew as a zero-length line, i.e. as nothing at all.
  const graph = graphOf([
    {
      _id: "r1",
      source: "db_a",
      target: "db_a",
      continuous: false,
      replicator_doc_id: "r1",
    },
  ]);

  const [edge] = replicationEdges(graph);
  expect(edge).toMatchObject({
    source: "db:local:db_a",
    target: "db:local:db_a",
    bidirectional: false,
    count: 1,
  });
  expect(
    graph.nodes.filter((n) => n.kind === "database").map((n) => n.direction),
  ).toEqual(["both"]);
});

it("draws two replications between one pair of servers as two pairs of databases (#43)", () => {
  // The defect #43 fixed: both of these used to collapse onto the single server-to-server line
  // `local -> remote`, because the render layer read only source_server_id/target_server_id and
  // discarded the database names the model had already resolved.
  const graph = graphOf([
    {
      _id: "r1",
      source: "http://localhost:5984/orders",
      target: "https://remote.example:6984/orders_mirror",
      continuous: true,
      replicator_doc_id: "r1",
    },
    {
      _id: "r2",
      source: "http://localhost:5984/customers",
      target: "https://remote.example:6984/customers_mirror",
      continuous: false,
      replicator_doc_id: "r2",
    },
  ]);

  expect(graph.nodes.filter((n) => n.kind === "server")).toHaveLength(2);
  expect(
    graph.nodes.filter((n) => n.kind === "database").map((n) => n.label),
  ).toEqual(["orders", "orders_mirror", "customers", "customers_mirror"]);
  expect(replicationEdges(graph).map(arrow)).toEqual([
    `db:local:orders -> db:${REMOTE}:orders_mirror`,
    `db:local:customers -> db:${REMOTE}:customers_mirror`,
  ]);
  // Each database is claimed by exactly one server, the one its endpoint named.
  expect(hostsEdges(graph).map(arrow)).toEqual([
    "server:local -> db:local:orders",
    `server:${REMOTE} -> db:${REMOTE}:orders_mirror`,
    "server:local -> db:local:customers",
    `server:${REMOTE} -> db:${REMOTE}:customers_mirror`,
  ]);
});

it("reads bare database names as databases on the local server (#59)", () => {
  const graph = graphOf([
    {
      _id: "r1",
      source: "db_a",
      target: "db_b",
      continuous: false,
      replicator_doc_id: "r1",
    },
  ]);

  expect(graph.nodes.map((n) => n.id)).toEqual([
    "server:local",
    "db:local:db_a",
    "db:local:db_b",
  ]);
  expect(hostsEdges(graph).map(arrow)).toEqual([
    "server:local -> db:local:db_a",
    "server:local -> db:local:db_b",
  ]);
  expect(replicationEdges(graph).map(arrow)).toEqual([
    "db:local:db_a -> db:local:db_b",
  ]);
});

it("pairs a bare database name on one side with a URL on the other (#59)", () => {
  const graph = graphOf([
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
  ]);

  expect(
    graph.nodes
      .filter((n) => n.kind === "database")
      .map((n) => [n.label, n.serverId, n.serverKind]),
  ).toEqual([
    ["db_a", "local", "local"],
    ["mirror", REMOTE, "remote"],
    ["_users", "local", "local"],
  ]);
  expect(replicationEdges(graph).map(arrow)).toEqual([
    `db:local:db_a -> db:${REMOTE}:mirror`,
    `db:${REMOTE}:mirror -> db:local:_users`,
  ]);
});

it("gives a database one node however many replications name it", () => {
  const graph = graphOf([
    {
      _id: "r1",
      source: "http://localhost:5984/a",
      target: "https://remote.example:6984/mirror",
      continuous: true,
      replicator_doc_id: "r1",
    },
    // The same two databases, replicating back the other way.
    {
      _id: "r2",
      source: "https://remote.example:6984/mirror",
      target: "http://localhost:5984/a",
      continuous: true,
      replicator_doc_id: "r2",
    },
  ]);

  expect(graph.nodes.filter((n) => n.kind === "database")).toHaveLength(2);
  expect(hostsEdges(graph)).toHaveLength(2);
  // And one edge, not two: the pair replicates both ways.
  expect(replicationEdges(graph).map(arrow)).toEqual([
    `db:local:a -> db:${REMOTE}:mirror`,
  ]);
  expect(replicationEdges(graph)[0]).toMatchObject({
    bidirectional: true,
    count: 2,
  });
});

it("keeps the same database name on two servers apart, so a mirror is not a self-loop", () => {
  const graph = graphOf([
    {
      _id: "r1",
      source: "http://localhost:5984/mirror",
      target: "https://remote.example:6984/mirror",
      continuous: false,
      replicator_doc_id: "r1",
    },
  ]);

  const databases = graph.nodes.filter((n) => n.kind === "database");
  expect(databases).toHaveLength(2);
  expect(databases.every((n) => n.label === "mirror")).toBe(true);
  const [edge] = replicationEdges(graph);
  expect(edge.source).not.toBe(edge.target);
});

it("distinguishes databases whose node ids would otherwise run together", () => {
  // `host a, database "5984:c"` and `host a:5984, database "c"` concatenate to the same string
  // unless the database name is escaped. Contrived, but a URL path segment is not held to
  // CouchDB's database-name grammar the way a bare endpoint is, so nothing else rules it out.
  const graph = graphOf([
    {
      _id: "r1",
      source: "http://localhost:5984/x",
      target: "http://a/5984%3Ac",
      continuous: false,
      replicator_doc_id: "r1",
    },
    {
      _id: "r2",
      source: "http://localhost:5984/y",
      target: "http://a:5984/c",
      continuous: false,
      replicator_doc_id: "r2",
    },
  ]);

  const [first, second] = replicationEdges(graph);
  expect(first.target).not.toBe(second.target);
  expect(new Set(graph.nodes.map((n) => n.id)).size).toBe(graph.nodes.length);
});

it("attaches an endpoint that names no database to the server node itself", () => {
  // `http://host:6984/` resolves with an empty database name. CouchDB cannot run such a
  // replication, which by #59's reasoning is exactly why it is drawn rather than dropped — but
  // it must not invent a nameless database node to hang it on.
  const graph = graphOf([
    {
      _id: "r1",
      source: "http://localhost:5984/a",
      target: "https://remote.example:6984/",
      continuous: false,
      replicator_doc_id: "r1",
    },
  ]);

  expect(
    graph.nodes.filter((n) => n.kind === "database").map((n) => n.label),
  ).toEqual(["a"]);
  expect(replicationEdges(graph).map(arrow)).toEqual([
    `db:local:a -> server:${REMOTE}`,
  ]);
});

it("draws the local server alone when there are no replications", () => {
  const graph = graphOf([]);

  expect(graph.nodes).toHaveLength(1);
  expect(graph.nodes[0]).toMatchObject({ kind: "server", id: "server:local" });
  expect(graph.edges).toEqual([]);
});

it("carries reachability onto the local server node and never onto a database", () => {
  const graph = buildTopologyGraph(
    buildTopology(
      [
        {
          _id: "r1",
          source: "db_a",
          target: "https://remote.example:6984/mirror",
          continuous: false,
          replicator_doc_id: "r1",
        },
      ] as never,
      { ...local, reachable: false },
    ),
  );

  const servers = graph.nodes.filter((n) => n.kind === "server");
  expect(servers.map((n) => [n.serverKind, n.reachable])).toEqual([
    ["local", false],
    // A remote node is drawn, never probed (spec D10), so `buildTopology` reports it as not
    // reachable and the graph passes that through without turning it into a live signal.
    ["remote", false],
  ]);
  for (const node of graph.nodes.filter((n) => n.kind === "database")) {
    expect(node).not.toHaveProperty("reachable");
  }
});

it("emits no edge whose endpoint is not a node, so the force layout cannot fail to resolve one", () => {
  const graph = graphOf([
    { _id: "r1", source: "db_a", target: "db_b" },
    {
      _id: "r2",
      source: "http://localhost:5984/a",
      target: "https://remote.example:6984/mirror",
    },
    {
      _id: "r3",
      source: "http://localhost:5984/b",
      target: "http://other.example/c",
    },
    // Neither a URL nor a database name: dropped upstream, so it contributes no node either.
    { _id: "r4", source: "not a valid url", target: "db_c" },
  ]);

  const ids = new Set(graph.nodes.map((n) => n.id));
  for (const edge of graph.edges) {
    expect(ids.has(edge.source)).toBe(true);
    expect(ids.has(edge.target)).toBe(true);
  }
  expect(graph.nodes.map((n) => n.label)).not.toContain("db_c");
});

it("drops a connection naming a server with no node rather than dangling an edge", () => {
  // `buildTopology` never produces this; a caller assembling TopologyData by hand can.
  const data: TopologyData = {
    servers: [{ ...local, kind: "local" }],
    connections: [
      {
        source_server_id: "local",
        target_server_id: "remote:ghost.example",
        source_db: "a",
        target_db: "b",
        continuous: false,
        replicator_doc_id: "r1",
      },
    ],
  };

  const graph = buildTopologyGraph(data);

  expect(replicationEdges(graph)).toEqual([]);
  // The source database was reached before the target failed; it still belongs to its server.
  expect(graph.nodes.map((n) => n.id)).toEqual(["server:local", "db:local:a"]);
  expect(hostsEdges(graph).map(arrow)).toEqual(["server:local -> db:local:a"]);
});
