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

import type { DbMgmtService } from './db-mgmt-service.js';
import type { SaveDocumentResponse } from '../plugins/db-mgmt/types.js';
import type { UserDoc } from '../plugins/users/types.js';
import { USERS_DB, isUserDoc } from '../plugins/users/users-doc.js';

/** Page size per request; the full set is aggregated across pages (#825). */
const USERS_PAGE_LIMIT = 1000;

/** Wraps the generic document proxy with `_users`-specific helpers. */
export class UsersService {
  constructor(private db: DbMgmtService) {}

  /**
   * Fetches ALL `_users` documents by following bookmarks until exhausted.
   * CouchDB _find returns a bookmark on every page (even the last), so the
   * end is a short page; a repeated or missing bookmark also stops the loop
   * (guards against servers echoing the same bookmark forever).
   */
  async listUsers(serverId: string): Promise<UserDoc[]> {
    const all: Record<string, unknown>[] = [];
    let bookmark: string | undefined;
    for (;;) {
      const resp = await this.db.listDocuments(serverId, USERS_DB, {
        scope: 'full',
        limit: USERS_PAGE_LIMIT,
        ...(bookmark ? { bookmark } : {}),
      });
      const docs = resp.documents ?? [];
      all.push(...docs);
      const next = resp.bookmark;
      if (docs.length < USERS_PAGE_LIMIT || !next || next === bookmark) break;
      bookmark = next;
    }
    return all.filter((d) => isUserDoc(d)) as unknown as UserDoc[];
  }

  getUser(serverId: string, userId: string): Promise<Record<string, unknown>> {
    return this.db.getDoc(serverId, USERS_DB, userId);
  }

  saveUser(serverId: string, body: Record<string, unknown>): Promise<SaveDocumentResponse> {
    return this.db.saveDocument(serverId, USERS_DB, {
      id: (body._id as string) ?? null,
      body,
    });
  }

  deleteUser(serverId: string, userId: string, rev: string): Promise<Record<string, unknown>> {
    return this.db.deleteDoc(serverId, USERS_DB, userId, rev);
  }
}
