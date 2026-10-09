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

import type { DatabaseInfo } from "../plugins/server-mgmt/types.js";
import { ApiError } from "./api-error.js";

/** CouchDB accepts at most 100 keys per `POST /_dbs_info` request. */
export const DBS_INFO_CHUNK_SIZE = 100;

/** Any CouchDB-shaped request function — the local session client or a remote endpoint route. */
export type CouchRequest = <T>(
  method: string,
  path: string,
  body?: unknown,
) => Promise<T>;

/**
 * Maps database names to {@link DatabaseInfo} via chunked `POST /_dbs_info`.
 * Degrades instead of hiding databases:
 * - a whole `_dbs_info` call failing (CouchDB < 2.2, a proxy blocking POST)
 *   falls back to name-only rows for that chunk;
 * - a row answered without `info` (db deleted mid-listing, per-db read denied)
 *   stays in the result as a name-only row.
 * A database the server just named in `_all_dbs` must never vanish from the
 * list only because its details were unavailable.
 */
export async function fetchDatabaseInfos(
  request: CouchRequest,
  names: string[],
): Promise<DatabaseInfo[]> {
  const all: DatabaseInfo[] = [];
  for (let i = 0; i < names.length; i += DBS_INFO_CHUNK_SIZE) {
    const keys = names.slice(i, i + DBS_INFO_CHUNK_SIZE);
    let entries: Array<{
      key: string;
      info?: {
        db_name: string;
        doc_count: number;
        sizes?: { file?: number };
        props?: { partitioned?: boolean };
      };
      error?: string;
    }>;
    try {
      entries = await request("POST", "/_dbs_info", { keys });
    } catch (err) {
      if (err instanceof ApiError) {
        all.push(...keys.map((db_name) => ({ db_name })));
        continue;
      }
      throw err;
    }
    for (const entry of entries) {
      if (!entry.info) {
        all.push({ db_name: entry.key });
        continue;
      }
      all.push({
        db_name: entry.info.db_name,
        doc_count: entry.info.doc_count,
        size_byte: entry.info.sizes?.file,
        partitioned: entry.info.props?.partitioned ?? false,
      });
    }
  }
  return all;
}
