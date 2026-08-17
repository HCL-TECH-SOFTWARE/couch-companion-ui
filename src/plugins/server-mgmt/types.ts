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

export interface ServerPaged {
  servers: Server[];
  bookmark: string;
}

export interface Server {
  id: string;
  name: string;
  url: string;
  username: string;
  location: ServerLocation | null;
  reachable: boolean;
  last_checked: string | null;
  couch_version: string | null;
  created_at: string;
  updated_at: string;
  configured_idps: ServerIdpInfo[] | null;
  /**
   * `'local'` for the single real, synthesized server (see `single-server.ts`); `'remote'` for a
   * node `topology-model.ts` synthesizes from a `_replicator` document's source/target endpoint.
   * A remote node is drawn on the topology graph but never contacted (spec D10) — its other
   * fields are placeholders, not live data.
   */
  kind: "local" | "remote";
}

export interface ServerIdpInfo {
  idp_id: string | null;
  name: string | null;
  issuer: string | null;
  keys_count: number | null;
  last_applied: string | null;
}

export interface ServerLocation {
  label: string | null;
  latitude: number | null;
  longitude: number | null;
}

export interface ReplicationConnection {
  source_server_id: string;
  target_server_id: string;
  source_db: string;
  target_db: string;
  continuous: boolean;
  replicator_doc_id: string;
}

export interface TopologyData {
  servers: Server[];
  connections: ReplicationConnection[];
}

export interface DatabaseInfo {
  db_name?: string;
  doc_count?: number;
  size_byte?: number;
  partitioned?: boolean;
}

/**
 * The welcome document a CouchDB node answers `GET /` with (OpenAPI schema `ServerWelcome`),
 * proxied by `GET /api/servers/{id}/info` and read live on every call.
 *
 * Only `couchdb`, `version` and `uuid` are guaranteed. A build made outside a git checkout has no
 * `git_sha`, and non-Apache distributions vary in what they report, so the rest are optional —
 * render them as absent rather than assuming they are there.
 */
export interface ServerWelcome {
  /** The greeting, conventionally "Welcome". Not a version and not an identifier. */
  couchdb: string;
  /** The CouchDB version, e.g. "3.3.3". */
  version: string;
  /** The node's server UUID. */
  uuid: string;
  /** The commit this build was made from. */
  git_sha?: string;
  /** What this build was compiled with, e.g. scheduler, partitioned, reshard. */
  features?: string[];
  /** Who built this CouchDB. */
  vendor?: ServerVendor;
}

export interface ServerVendor {
  name: string;
  version?: string;
}

/**
 * One task currently running on a CouchDB node, as reported by `/_active_tasks`
 * (OpenAPI schema `ActiveTask`).
 *
 * The payload is heterogeneous: only `node`, `pid`, `type`, `started_on` and
 * `updated_on` are present on every task — everything else depends on the task
 * type and is absent otherwise. `type` is deliberately not a union: CouchDB may
 * introduce further task types, and an unknown one must still render.
 */
export interface ActiveTask {
  /** The cluster node the task runs on. */
  node: string;
  /** The Erlang process id owning the task. */
  pid: string;
  /** replication | indexer | database_compaction | view_compaction | search_indexer | … */
  type: string;
  /** Unix timestamp (seconds) at which the task started. */
  started_on: number;
  /** Unix timestamp (seconds) at which the task last reported progress. */
  updated_on: number;

  // Indexer / compaction tasks.
  database?: string;
  design_document?: string;
  /** Completion percentage (0-100). */
  progress?: number;
  changes_done?: number;
  total_changes?: number;
  phase?: string;

  // Replication tasks.
  replication_id?: string;
  /** The `_replicator` doc driving the replication, or null for a transient one. */
  doc_id?: string | null;
  source?: string;
  target?: string;
  continuous?: boolean;
  docs_read?: number;
  docs_written?: number;
  doc_write_failures?: number;
  missing_revisions_found?: number;
  revisions_checked?: number;
  /** Changes known on the source but not yet replicated, or null when unknown. */
  changes_pending?: number | null;
  checkpointed_source_seq?: string;
  source_seq?: string;
  through_seq?: string;
  checkpoint_interval?: number;
  process_status?: string;
  bulk_get_attempts?: number;
  bulk_get_docs?: number;
  /** The user the replication runs as, or null. */
  user?: string | null;
}
