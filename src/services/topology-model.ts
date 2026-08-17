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

import { serverKey } from "./single-server.js";
import type { ReplicatorDoc } from "../plugins/replication/types.js";
import type {
  ReplicationConnection,
  Server,
  TopologyData,
} from "../plugins/server-mgmt/types.js";

/**
 * A `_replicator` `source`/`target` endpoint: a bare URL, a bare database name, or `{url}`.
 *
 * `replication-service.ts` has an unexported type of the same shape and an `endpointUrl` reader
 * identical to the one below. Deliberately not imported from there: this module stays free of
 * any dependency on the *stateful* service layer (`ReplicationService`, `ApiClient`) so it remains
 * a pure, synchronous, trivially-mockable model — reaching into `replication-service.ts` for five
 * lines would trade that guarantee for a small DRY win. `single-server.ts` is a different case: it
 * is itself pure data and pure functions, and sharing `serverKey` with the replication editor is
 * the whole point of it living there rather than here.
 */
type Endpoint = string | { url: string };

/**
 * CouchDB's own database-name grammar (`^_?[a-z][a-z0-9_$()+-]*$`), used to decide whether an
 * endpoint that is not a URL is a database name or junk.
 *
 * Two deliberate narrowings from "any non-empty string":
 *
 *  * **The grammar at all.** Reading every unparseable endpoint as a database name would put
 *    arbitrary documents on the graph as nodes named after strings that cannot be databases.
 *  * **No `/`,** which CouchDB does technically allow in a database name (percent-encoded in
 *    paths). An endpoint containing a slash that `new URL()` still rejected is a malformed or
 *    relative URL far more often than it is a database named `a/b`, and drawing a broken URL as a
 *    database is worse than omitting a database nobody has.
 */
const BARE_DB_NAME = /^_?[a-z][a-z0-9_$()+-]*$/;

/** One resolved endpoint: the node it belongs to, and the database it names on that node. */
interface ResolvedEndpoint {
  serverId: string;
  db: string;
}

/**
 * One node of the drawn graph: a CouchDB server, or one database on a server (#43).
 *
 * A union rather than one struct with optional fields, because `reachable` is a property of a
 * *server* and of nothing else. A database node has no reachability of its own — spec D10 forbids
 * contacting anything, and even for the local server "the server answered" says nothing about any
 * individual database — so the type refuses to carry the question rather than answer it wrong.
 */
export type TopologyGraphNode =
  | {
      kind: "server";
      id: string;
      /** The server's display name (`Server.name`). */
      label: string;
      /** The server this node *is*. */
      serverId: string;
      serverKind: Server["kind"];
      reachable: boolean;
    }
  | {
      kind: "database";
      id: string;
      /** The database name, as the `_replicator` endpoint spelled it. */
      label: string;
      /** The server this database lives on. */
      serverId: string;
      serverKind: Server["kind"];
      direction: DatabaseDirection;
    };

/**
 * Which way documents move through a database, **according to the local `_replicator` alone**.
 *
 * `source` in some document means this database is read from; `target` means it is written to.
 * For a remote database that is a partial reading by construction: spec D10 forbids contacting
 * it, so a remote database busily replicating to a third server it never told us about reads as
 * `outgoing` here. The legend has to say so.
 */
export type DatabaseDirection = "outgoing" | "incoming" | "both";

/** Whether the documents behind one edge are continuous, one-time, or some of each. */
export type ReplicationContinuity = "continuous" | "one-time" | "mixed";

/**
 * One edge of the drawn graph: a server owning a database, or a replication between two databases.
 *
 * `source`/`target` are {@link TopologyGraphNode.id} values, never array indices — the render layer
 * hands them to `d3.forceLink().id()`, which resolves them by id.
 */
export type TopologyGraphEdge =
  | {
      /** Server → one of its databases. Undirected in meaning; drawn without an arrowhead. */
      kind: "hosts";
      source: string;
      target: string;
    }
  | {
      /**
       * All the replications between one *pair* of databases, as one edge.
       *
       * Two documents `a → b` used to be two lines lying exactly on top of each other, which said
       * "one replication" to the eye and cost a second draw. `a → b` together with `b → a` is the
       * `<->` of this issue's title: one edge with a head at each end, not two arcs that cross.
       */
      kind: "replication";
      /** The orientation of the *first* document seen for this pair. */
      source: string;
      target: string;
      /** True when some document also runs `target → source`. Never true of a self-loop. */
      bidirectional: boolean;
      /** How many `_replicator` documents this one edge stands for. */
      count: number;
      continuity: ReplicationContinuity;
      /** Every document behind the edge, in the order the connections arrived. */
      replicator_doc_ids: string[];
    };

/** The database-level picture the topology view draws: `server — databases ↔ databases — server`. */
export interface TopologyGraph {
  nodes: TopologyGraphNode[];
  edges: TopologyGraphEdge[];
}

/**
 * Expands {@link TopologyData} into the graph that gets drawn: a node per server **and a node per
 * database**, replication edges running database-to-database (#43).
 *
 * `buildTopology` has always resolved each endpoint's `source_db`/`target_db`; until #43 the render
 * layer read only `source_server_id`/`target_server_id` and threw the database names away, so a
 * server replicating four databases to one peer drew as a single line between two dots — the same
 * picture as one database, with no way to tell them apart. This function is where that data starts
 * being used, and it is deliberately here rather than in `topology-graph.ts`: it is pure, needs no
 * DOM and no d3, and is therefore testable without either.
 *
 * Which databases exist at all is decided *only* by the local `_replicator` documents. Neither
 * `_all_dbs` on the local server nor anything at all on a remote one is consulted — spec D10 —
 * so the graph shows the databases some replication names, not every database that exists.
 *
 * Four shapes need naming:
 *
 *  * **An endpoint that names no database** (`http://host:5984/`, path-only, no trailing segment)
 *    resolves with `db: ""`. Its replication attaches to the *server* node instead of inventing a
 *    nameless database. Such a document cannot run — but #59 established that a broken replication
 *    is exactly the one a user needs to see, so it is drawn rather than dropped.
 *  * **The same database name on two servers** is two nodes, not one. `mirror` on the local server
 *    and `mirror` on a remote one are different databases that a replication typically runs
 *    *between*; collapsing them by name would draw that replication as a self-loop.
 *  * **Every replication between one pair of databases is one edge**, carrying a count and, when
 *    documents run both ways, a `bidirectional` flag. See {@link TopologyGraphEdge}.
 *  * **A database's {@link DatabaseDirection}** falls straight out of which side of a document it
 *    appears on, and is the node's colour.
 */
export function buildTopologyGraph({
  servers,
  connections,
}: TopologyData): TopologyGraph {
  const serverNodes = new Map<string, TopologyGraphNode & { kind: "server" }>();
  /** Database nodes under construction: `direction` is only known once every document is read. */
  const databases = new Map<
    string,
    {
      id: string;
      label: string;
      serverId: string;
      serverKind: Server["kind"];
      outgoing: boolean;
      incoming: boolean;
    }
  >();
  const hosts: TopologyGraphEdge[] = [];
  /** Keyed by the *unordered* pair, so `a → b` and `b → a` land on the same edge. */
  const replications = new Map<
    string,
    TopologyGraphEdge & { kind: "replication" }
  >();

  for (const server of servers) {
    serverNodes.set(serverNodeId(server.id), {
      kind: "server",
      id: serverNodeId(server.id),
      label: server.name,
      serverId: server.id,
      serverKind: server.kind,
      reachable: server.reachable,
    });
  }

  /**
   * The node one endpoint of a replication attaches to, adding the database (and the `hosts` edge
   * that owns it) the first time that database is named, and recording which side of the document
   * it appeared on. Returns null only if the endpoint names a server with no node, which
   * `buildTopology` never produces — every connection it emits refers to a server it also emitted.
   * Kept as a guard so a caller assembling `TopologyData` by hand gets a dropped edge rather than
   * an edge pointing at a node that does not exist, which `d3.forceLink` throws on.
   */
  const attach = (
    serverId: string,
    db: string,
    side: "source" | "target",
  ): string | null => {
    const server = serverNodes.get(serverNodeId(serverId));
    if (!server) return null;
    // An endpoint naming no database has no direction to record: it is the *server* that the
    // replication reaches, and a server is not read from or written to as a whole.
    if (db === "") return server.id;

    const id = databaseNodeId(serverId, db);
    let database = databases.get(id);
    if (!database) {
      database = {
        id,
        label: db,
        serverId,
        serverKind: server.serverKind,
        outgoing: false,
        incoming: false,
      };
      databases.set(id, database);
      hosts.push({ kind: "hosts", source: server.id, target: id });
    }
    if (side === "source") database.outgoing = true;
    else database.incoming = true;
    return id;
  };

  for (const connection of connections) {
    const source = attach(
      connection.source_server_id,
      connection.source_db,
      "source",
    );
    const target = attach(
      connection.target_server_id,
      connection.target_db,
      "target",
    );
    if (source === null || target === null) continue;

    // Sorted, so the two orientations of one pair share a key; JSON rather than a joining
    // character, so no node id can ever be read as two.
    const key = JSON.stringify([source, target].sort());
    const existing = replications.get(key);
    if (!existing) {
      replications.set(key, {
        kind: "replication",
        source,
        target,
        bidirectional: false,
        count: 1,
        continuity: connection.continuous ? "continuous" : "one-time",
        replicator_doc_ids: [connection.replicator_doc_id],
      });
      continue;
    }

    existing.count += 1;
    existing.replicator_doc_ids.push(connection.replicator_doc_id);
    // A self-loop matches its own orientation, so it can never be marked bidirectional.
    if (existing.source !== source) existing.bidirectional = true;
    const continuity = connection.continuous ? "continuous" : "one-time";
    if (existing.continuity !== continuity) existing.continuity = "mixed";
  }

  const nodes: TopologyGraphNode[] = [
    ...serverNodes.values(),
    ...[...databases.values()].map(
      ({ outgoing, incoming, ...rest }): TopologyGraphNode => ({
        kind: "database",
        ...rest,
        direction: outgoing && incoming ? "both" : outgoing ? "outgoing" : "incoming",
      }),
    ),
  ];

  // Structure before flow, so the render layer can paint the quiet `hosts` lines underneath.
  return { nodes, edges: [...hosts, ...replications.values()] };
}

/** The graph node id for a server, given the `Server.id` the model keys it under. */
function serverNodeId(serverId: string): string {
  return `server:${serverId}`;
}

/**
 * The graph node id for one database on one server.
 *
 * The database name is percent-encoded, which escapes both `:` and `/`, so no database name can
 * spell out an id that collides with another server's. Without it, a database named `remote:x` on
 * the local server and a database named `x` on the remote server `remote` would produce the same
 * string and silently render as one node.
 */
function databaseNodeId(serverId: string, db: string): string {
  return `db:${serverId}:${encodeURIComponent(db)}`;
}

/**
 * Builds the read-only topology picture from the local `_replicator` database (spec D10).
 *
 * Pure and synchronous — no network I/O. A remote host is drawn purely because some local
 * `_replicator` document names it as a source or target; it is never contacted to confirm it
 * exists, probe reachability, or read credentials. One node is synthesized per distinct remote
 * server (`serverKey`, so aliases of one host share a node); replications naming the same remote
 * server collapse onto it, whichever of them it appears as source or target of.
 *
 * Which documents make it onto the graph:
 *
 *  * **Both endpoints present** — {@link isReplicationDoc}. Anything else is not a replication,
 *    and `_replicator` is an ordinary database that can hold anything.
 *  * **Each endpoint resolvable** — an `http(s)` URL, or a bare database name on the local server
 *    (`{"source": "db_a"}`, the Fauxton/curl shape). An endpoint that is neither drops its whole
 *    replication rather than half-drawing it.
 *
 * Endpoint credentials arrive already masked with a `***` sentinel (see
 * `replication-service.ts#maskUrlCredentials`) — this function never needs to strip it itself,
 * because `URL.origin`/`URL.host`/`serverKey` never include userinfo, and only those (never the
 * raw endpoint string) ever reach the output.
 *
 * @param docs - raw `_replicator` documents, as `ReplicationService.listReplications()` returns
 *   them.
 * @param localServer - the single synthesized local server (see `single-server.ts`). Its `url`
 *   is what "local" is compared against, by `serverKey` rather than by string equality; it is
 *   always returned as the sole `kind: 'local'` node.
 */
export function buildTopology(
  docs: ReplicatorDoc[],
  localServer: Server,
): TopologyData {
  const servers = new Map<string, Server>();
  servers.set(localServer.id, { ...localServer, kind: "local" });

  const localKey = serverKey(localServer.url);
  const connections: ReplicationConnection[] = [];

  for (const doc of docs) {
    if (!isReplicationDoc(doc)) continue;

    const source = resolveEndpoint(doc.source, localServer, localKey, servers);
    const target = resolveEndpoint(doc.target, localServer, localKey, servers);
    // Either endpoint failing to resolve drops the whole connection rather than half-drawing it
    // or throwing — one malformed `_replicator` document must not take the picture down.
    if (!source || !target) continue;

    connections.push({
      source_server_id: source.serverId,
      target_server_id: target.serverId,
      source_db: source.db,
      target_db: target.db,
      continuous: doc.continuous,
      replicator_doc_id: doc.replicator_doc_id ?? doc._id ?? "",
    });
  }

  return { servers: Array.from(servers.values()), connections };
}

/** Reads the URL (or bare database name) out of a `_replicator` endpoint, whichever of the two
 * shapes it takes. */
function endpointUrl(endpoint: Endpoint | undefined): string {
  if (!endpoint) return "";
  return (typeof endpoint === "string" ? endpoint : endpoint.url)?.trim() ?? "";
}

/**
 * True when `doc` names both ends of a replication — the "is this even a replication?" gate.
 *
 * Stated outright rather than left to fall out of the endpoint parse. Until #59 such documents
 * were dropped only *because* `new URL("")` throws; now that a non-URL endpoint is read as a
 * database name, that accident is gone and the rule has to be written down. `_replicator` is an
 * ordinary database and can hold anything a user PUT into it — `replication-service.ts` already
 * filters design documents out of the list this receives, and this is the other half of the same
 * rule: no source or no target means it is not a replication, whatever else it is.
 */
function isReplicationDoc(doc: ReplicatorDoc): boolean {
  return endpointUrl(doc.source) !== "" && endpointUrl(doc.target) !== "";
}

/**
 * Resolves one endpoint (source or target) to the node it belongs to and the database it names,
 * synthesizing a remote node into `servers` the first time its host is seen. Returns `null` when
 * the endpoint is neither a usable URL nor a database name.
 */
function resolveEndpoint(
  endpoint: Endpoint | undefined,
  localServer: Server,
  localKey: string,
  servers: Map<string, Server>,
): ResolvedEndpoint | null {
  const raw = endpointUrl(endpoint);

  let parsed: URL | null;
  try {
    parsed = new URL(raw);
  } catch {
    parsed = null;
  }

  // A bare database name — `{"source": "db_a", "target": "db_b"}`, the shape Fauxton and
  // hand-written curl calls produce and still the most common `_replicator` document in the
  // wild. It names a database on whichever server stores the document, i.e. always the local one.
  // (CouchDB 3 no longer *runs* these — it fails them with `local_endpoints_not_supported` — but
  // the documents are still there to be read, and a replication that is broken is exactly the one
  // a user needs to see on the graph rather than have silently omitted from it. #59)
  if (!parsed) {
    return BARE_DB_NAME.test(raw) ? { serverId: localServer.id, db: raw } : null;
  }

  // The *last* non-empty path segment, not the first: a bare `http://host:5984/dbname` endpoint
  // (the common case) has only one, but an endpoint reaching CouchDB through a reverse-proxy
  // path prefix (`https://gateway.example/couchdb/dbname`) would otherwise report the prefix
  // segment as the database name.
  const segments = parsed.pathname.split("/").filter(Boolean);
  const db = decodeURIComponent(segments[segments.length - 1] ?? "");

  // Compared on `serverKey`, not on raw origins, so that the aliases one server is reachable
  // under — `localhost` vs `127.0.0.1`, an explicit `:80`, a differently-cased host — resolve to
  // one node instead of splitting the same database into a "local" and a "remote" copy.
  const key = serverKey(parsed.href);
  if (!key) return null;
  if (key === localKey) {
    return { serverId: localServer.id, db };
  }

  const host = parsed.host;
  const serverId = `remote:${key}`;
  if (!servers.has(serverId)) {
    servers.set(serverId, {
      id: serverId,
      // Labelled with the host as this endpoint spelled it; identity is `key` above, so aliases
      // of one remote host share a node and the first spelling seen names it.
      name: host,
      url: parsed.origin,
      username: "",
      location: null,
      // Always false: a remote node is drawn, never probed (spec D10) — this is not a live
      // reachability signal, and the graph must not render it as if it were one (see the
      // dedicated "unknown reachability" visual state in topology-graph.ts).
      reachable: false,
      last_checked: null,
      couch_version: null,
      created_at: "",
      updated_at: "",
      configured_idps: null,
      kind: "remote",
    });
  }
  return { serverId, db };
}
