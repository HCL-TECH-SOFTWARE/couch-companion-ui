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

/**
 * A replication document as {@link ReplicationService} serves it.
 *
 * Field names are CouchDB's own `_replicator` document fields — there is no backend mapper
 * renaming them anymore. `ReplicationService.listReplications`/`getReplication` read the raw
 * `_replicator` document and annotate it with `cca_server_id`, `cca_server_name`,
 * `replicator_doc_id` (a copy of `_id`) and, when a matching `_scheduler/docs` entry exists,
 * live state/progress fields. Note CouchDB itself may still write underscore-prefixed fields
 * (e.g. `_replication_state`) onto the raw document from its legacy (pre-scheduler) replication
 * path — those are distinct from, and not read into, this type's own `replication_state`.
 */
export interface ReplicatorDoc {
  _id?: string;
  _rev?: string;
  replicator_doc_id?: string;
  owner?: string;
  source: string | { url: string };
  target: string | { url: string };
  continuous: boolean;
  /** Live state from `_scheduler/docs` (`running` | `crashing` | `pending` | `completed` | `failed`). */
  replication_state?: string;
  /** `last_updated` from the scheduler entry. */
  replication_state_time?: string;
  cca_server_id?: string;
  cca_server_name?: string;
  /** `info.error` when the scheduler reports a crashing/failed job. */
  scheduler_error?: string;
  error_count?: number;
  docs_written?: number;
  changes_pending?: number | null;
  selector?: Record<string, unknown> | null;
  filter?: string | null;
  doc_ids?: string[] | null;
  query_params?: Record<string, unknown> | null;
  winning_revs_only?: boolean | null;
  since_seq?: string | null;
  create_target?: boolean | null;
  use_checkpoints?: boolean | null;
  checkpoint_interval?: number | null;
  retries_per_request?: number | null;
  worker_processes?: number | null;
  worker_batch_size?: number | null;
  http_connections?: number | null;
}

export interface Server {
  id: string;
  name: string;
  url: string;
}
