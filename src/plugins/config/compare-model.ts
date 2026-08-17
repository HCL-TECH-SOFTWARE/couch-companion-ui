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

import type { NodeConfig } from './types.js';

/** One cluster-node column shown in the compare table. */
export interface CompareColumn {
  /** Erlang node name — `couchdb@host`. The key everything else in the model is keyed by. */
  id: string;
  /** Label shown in the column header. The node name today; kept separate so it can shorten. */
  name: string;
  /** Currently connected, per `_membership`'s `all_nodes`. */
  reachable: boolean;
  /** That node's config failed to load — a down node answers `{"error":"nodedown"}`. */
  error?: boolean;
}

/** One (section, key) row in the compare table. */
export interface CompareRow {
  section: string;
  key: string;
  /** Keyed by node name; `undefined` means the key is absent on that node. */
  values: Record<string, string | undefined>;
  /** `true` unless every column has the key present and all values are strictly equal. */
  differs: boolean;
}

/** Full comparison result for a set of node configurations. */
export interface CompareModel {
  columns: CompareColumn[];
  rows: CompareRow[];
  differingCount: number;
  totalCount: number;
}

/**
 * Build the pure diff model for comparing `NodeConfig`s across cluster nodes.
 *
 * Rows are the union of (section, key) pairs found in `configs`, sorted by
 * section then key ascending. A column id present in `columns` but missing
 * from `configs` (or mapped to `{}`) contributes `undefined` for every key.
 *
 * A key absent from one node is a difference, not a tie — which is the whole
 * point on a cluster, where an option written through `_node/_local/_config`
 * lands on exactly one node and silently diverges from its peers.
 */
export function buildCompareModel(
  columns: CompareColumn[],
  configs: Record<string, NodeConfig>,
): CompareModel {
  const sections = new Map<string, Set<string>>();

  for (const columnId of Object.keys(configs)) {
    const config = configs[columnId];
    for (const section of Object.keys(config)) {
      let keys = sections.get(section);
      if (!keys) {
        keys = new Set<string>();
        sections.set(section, keys);
      }
      for (const key of Object.keys(config[section])) {
        keys.add(key);
      }
    }
  }

  const sortedSections = [...sections.keys()].sort((a, b) => a.localeCompare(b));

  const rows: CompareRow[] = [];
  for (const section of sortedSections) {
    const keys = [...(sections.get(section) ?? [])].sort((a, b) => a.localeCompare(b));
    for (const key of keys) {
      const values: Record<string, string | undefined> = {};
      for (const column of columns) {
        values[column.id] = configs[column.id]?.[section]?.[key];
      }
      rows.push({ section, key, values, differs: computeDiffers(columns, values) });
    }
  }

  return {
    columns,
    rows,
    differingCount: rows.filter((r) => r.differs).length,
    totalCount: rows.length,
  };
}

function computeDiffers(
  columns: CompareColumn[],
  values: Record<string, string | undefined>,
): boolean {
  const first = values[columns[0]?.id];
  if (first === undefined) return true;
  return !columns.every((c) => values[c.id] === first);
}
