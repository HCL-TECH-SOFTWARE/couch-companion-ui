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
import type { Banner } from '../types/api.js';
import { ApiError } from './api-error.js';
import { SINGLE_SERVER_ID } from './single-server.js';
import { BANNER_DB, BANNER_DOC_ID } from '../plugins/banner-admin/types.js';

/**
 * Reads/writes the companion server's `couchcompanion` → `BannerMessages` document
 * by reusing the generic document proxy.
 */
export class BannerAdminService {
  constructor(private db: DbMgmtService) {}

  /**
   * There is exactly one server (spec D2/D3), so this always resolves to it —
   * no network call, no URL matching against a registry that no longer exists.
   */
  async resolveCompanionServerId(): Promise<string> {
    return SINGLE_SERVER_ID;
  }

  /** Loads the `BannerMessages` document, or `null` when it does not exist yet (404). */
  async getBannerDoc(serverId: string): Promise<Record<string, unknown> | null> {
    try {
      return await this.db.getDoc(serverId, BANNER_DB, BANNER_DOC_ID);
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    }
  }

  /** Saves the full `BannerMessages` document (body must carry `_id`/`_rev` for updates). */
  saveBannerDoc(
    serverId: string,
    body: Record<string, unknown>,
  ): Promise<SaveDocumentResponse> {
    return this.db.saveDocument(serverId, BANNER_DB, { id: BANNER_DOC_ID, body });
  }

  /**
   * Reads the active announcement banner: loads the `BannerMessages` document
   * and returns the first entry whose `until` is absent or still in the
   * future (an unparseable `until` counts as expired). Never rejects — any
   * read failure (missing db/doc, network error, a malformed `banners`
   * field) resolves to `{}`, since the banner is non-essential UI.
   */
  async getActiveBanner(): Promise<Banner> {
    try {
      const doc = await this.getBannerDoc(SINGLE_SERVER_ID);
      const banners = doc && Array.isArray(doc.banners) ? (doc.banners as Banner[]) : [];
      const now = Date.now();
      for (const b of banners) {
        if (!b.until || Date.parse(b.until) > now) return b;
      }
      return {};
    } catch {
      return {};
    }
  }
}
