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

import type { ApiClient } from './api-client.js';

/** One node of the configured server's CouchDB cluster. */
export interface ClusterNode {
  /** Erlang node name, e.g. `couchdb@couchdb1.example.local`. Also the compare-table column id. */
  name: string;
  /** Currently connected — see the class doc for why this is `all_nodes` and not `cluster_nodes`. */
  reachable: boolean;
}

/**
 * Enumerates the nodes of the configured CouchDB cluster, via `/_membership` (#73).
 *
 * The two lists `/_membership` returns are not the same list. Measured live against CouchDB 3.5.2
 * with a 3-node cluster while one node was stopped:
 *
 * ```
 * all_nodes     [couchdb1, couchdb2]              <- currently connected
 * cluster_nodes [couchdb1, couchdb2, couchdb3]    <- the cluster's membership
 * ```
 *
 * `cluster_nodes` keeps the stopped node, `all_nodes` drops it. So membership comes from the
 * UNION of both — a node that is down is still a node the operator wants to see a column for —
 * while `reachable` comes from `all_nodes` alone, which is the list that actually tracks who is
 * answering right now. The union (rather than `cluster_nodes` alone) also covers the reverse
 * skew, a node connected but not yet in the cluster's membership.
 *
 * @param api - shared ApiClient (token already set by AuthService)
 */
export class MembershipService {
  constructor(private api: ApiClient) {}

  /**
   * Every node of the cluster, de-duplicated and sorted by name.
   *
   * Deliberately NOT wrapped in a try/catch: `_membership` is admin-only and answers 401 for
   * non-admins, and the caller has to see that failure to degrade sensibly (fall back to the
   * single-node view). Swallowing it into an empty list would make "not allowed to ask" look
   * exactly like "a cluster with no nodes".
   */
  async listNodes(): Promise<ClusterNode[]> {
    const body = await this.api.request<{ all_nodes?: string[]; cluster_nodes?: string[] }>(
      "GET",
      "/_membership",
    );
    const all = Array.isArray(body?.all_nodes) ? body.all_nodes : [];
    const cluster = Array.isArray(body?.cluster_nodes) ? body.cluster_nodes : [];
    const connected = new Set(all);
    return [...new Set([...cluster, ...all])]
      .sort((a, b) => a.localeCompare(b))
      .map((name) => ({ name, reachable: connected.has(name) }));
  }
}
