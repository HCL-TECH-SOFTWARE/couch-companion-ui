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

export interface DatabaseOverview {
  db_name: string;
  servers: DatabaseServerInfo[];
}

export interface DatabaseServerInfo {
  server_id: string;
  server_name: string;
  doc_count: number;
  size_bytes?: number;
  partitioned?: boolean;
}

/**
 * The body CouchDB answers `GET /{db}` with — the database's own info document, distinct from the
 * `_dbs_info`-derived {@link DatabaseServerInfo} the list screens render. Read live on every call.
 *
 * Only `db_name` and `doc_count` are treated as guaranteed; the rest vary by CouchDB version and
 * topology, so render them as absent rather than assuming they are there. Note the nested `sizes` —
 * this is CouchDB's native spelling, not the flattened `size_bytes` the UI shapes use.
 *
 * Measured against 3.5.2: `props` comes back as `{}` on a non-partitioned database, and `cluster`
 * *is* present on a single node (`{q,n,w,r}`) rather than omitted.
 */
export interface DatabaseInfoResponse {
  db_name: string;
  doc_count: number;
  doc_del_count?: number;
  /** Epoch seconds as a string on 3.5.2 (`"1786033342"`), not the `"0"` older clients expect. */
  instance_start_time?: string;
  update_seq?: string;
  purge_seq?: string | number;
  compact_running?: boolean;
  disk_format_version?: number;
  sizes?: { active?: number; external?: number; file?: number };
  props?: { partitioned?: boolean };
  cluster?: { n?: number; q?: number; r?: number; w?: number };
}

export interface DatabaseAccess {
  member: AccessRolesAndNames;
  admin: AccessRolesAndNames;
}

export interface AccessRolesAndNames {
  name: string[];
  roles: string[];
}

export interface DatabaseRoles {
  roles: string[];
}

export interface AllDocsResponse {
  total_rows: number;
  offset: number;
  rows: AllDocsRow[];
}

export interface AllDocsRow {
  id: string;
  value: { rev: string };
  doc?: Record<string, unknown>;
}

export interface DocumentResponse {
  bookmark?: string;
  documents?: Record<string, unknown>[];
  total_count?: number;
}

export interface ServerCreateConfig {
  server_id: string;
  partitioned?: boolean;
  access?: DatabaseAccess;
}

export interface ReplicationPair {
  source_id: string;
  target_id: string;
}

export interface CreateDatabaseRequest {
  db_name: string;
  setup_replication: boolean;
  servers: ServerCreateConfig[];
  replication_pairs?: ReplicationPair[];
  skip_existing?: boolean;
}

export interface MangoQueryRequest {
  selector: Record<string, unknown>;
  sort?: unknown[];
  fields?: string[];
  limit?: number;
  /** Documents to skip before the first result. Only honoured on a bookmark-less request (#80). */
  skip?: number;
  scope?: "raw" | "full";
  bookmark?: string;
}

export interface ExplainQueryRequest {
  selector: Record<string, unknown>;
  sort?: unknown[];
  fields?: string[];
  limit?: number;
  skip?: number;
}

export interface ExplainResponse {
  dbname: string;
  index: IndexExplainInfo;
  selector: Record<string, unknown>;
  opts: OptsExplainInfo;
  limit: number;
  skip: number;
  fields: string[];
  covering: boolean;
  index_candidates?: IndexCandidate[];
  mrargs?: Record<string, unknown>;
  selector_hints?: Record<string, unknown>[];
  condition?: QueryCondition;
}

export interface QueryCondition {
  type: "warning" | "info" | "error";
  title: string;
  description: string;
  actionLabel?: string;
  actionCallback?: () => void;
}

export interface IndexExplainInfo {
  ddoc?: string | null;
  name: string;
  type: string;
  def?: {
    fields?: Array<Record<string, "asc" | "desc" | string>>;
  };
}

export interface OptsExplainInfo {
  use_index?: string[];
  bookmark?: string;
  limit?: number;
  skip?: number;
  sort?: Record<string, "asc" | "desc" | string>;
  fields?: string[];
  r?: number[];
  conflicts?: boolean;
}

export interface ExplainIndexAnalysis {
  usable?: boolean;
  reasons?: Array<{ name?: string }>;
  ranking?: number;
  covering?: boolean | null;
}

export interface IndexCandidate {
  index?: {
    ddoc?: string | null;
    name?: string;
    type?: string;
    partitioned?: boolean | null;
    def?: {
      fields?: Array<Record<string, "asc" | "desc" | string>>;
    };
  };
  analysis?: ExplainIndexAnalysis;
}

export interface SaveDocumentRequest {
  id?: string | null;
  body: Record<string, unknown>;
}

export interface SaveDocumentResponse {
  id: string;
  rev: string;
}

export interface BulkDeleteDocumentRequest {
  documents: { id?: string; rev: string }[];
}

export interface BulkDeleteDocumentResponse {
  deleted: number;
  errors: ErrorDetails[];
}

export interface ErrorDetails {
  title: string;
  detail: string;
  error?: string;
}

export interface CreateIndexRequest {
  name: string;
  type?: "json" | "text";
  /**
   * A plain field name defaults to ascending order (CouchDB's own default). A single-key
   * object (`{fieldName: "desc"}`) opts that field into descending order — CouchDB's Mango
   * index API accepts a mix of both shapes in the same array (#57).
   */
  fields: Array<string | Record<string, "asc" | "desc">>;
  ddoc?: string;
  partial_filter_selector?: string;
}

export interface CreateIndexResponse {
  id: string;
  name: string;
  type: string;
  fields: Array<string | Record<string, "asc" | "desc">>;
  ddoc?: string;
  result?: string;
}

export interface ListIndexesResponse {
  indexes: IndexInfo[];
  total_count: number;
}

export interface IndexInfo {
  name: string;
  type?: "json" | "text" | string;
  ddoc?: string;
  partitioned?: boolean;
  def: Record<string, unknown>;
}

export interface SavedQuerySnapshot {
  id: string;
  db_name: string;
  selected_server_id: string;
  selectorJson: string;
  fields: string[];
  sortItems: Array<{ field: string; direction: "asc" | "desc" }>;
  scope: "raw" | "full";
  savedAt: string;
  title?: string;
}

export interface BackendHistoryDoc {
  _id?: string;
  _rev?: string;
  type?: string;
  db_name?: string;
  selected_server_id?: string;
  updated_at?: string;
  entries?: unknown[];
}
