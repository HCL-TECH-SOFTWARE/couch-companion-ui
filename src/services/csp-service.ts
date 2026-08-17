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
import type { ConfigService } from './config-service.js';

/** Where CouchDB keeps the `/_utils` policy. Writing it replaces the header wholesale. */
const CSP_SECTION = 'csp';
const CSP_KEY = 'utils_header_value';

/**
 * The path whose response actually carries the policy. Verified against CouchDB 3.5.2: the header
 * is sent on `/_utils/` and **not** on the API endpoints — `GET /_session`, `GET /_all_dbs` and the
 * rest come back with no `Content-Security-Policy` at all, so reading it from an ordinary API call
 * would report "no policy" on a server that has one.
 */
const UTILS_PATH = '/_utils/';

/**
 * Reads the Content-Security-Policy CouchDB is actually serving, and writes a replacement (#34).
 *
 * WHY THE LIVE HEADER AND NOT THE CONFIG. An empty `[csp]` section does not mean "no policy" — it
 * means CouchDB's built-in default, which is exactly the policy this feature exists to fix
 * (`default-src 'self'`, no `connect-src`, so every cross-origin request is refused before it is
 * dispatched and nothing appears in the network tab). Reading `[csp] utils_header_value` and
 * finding nothing therefore proves nothing. The response header is the only source of truth, and
 * it is readable by anyone: `/_utils/` needs no credentials, so a non-admin can still be shown
 * exactly what is in force and exactly what to hand to an administrator.
 */
export class CspService {
  constructor(
    private readonly api: ApiClient,
    private readonly config: ConfigService
  ) {}

  /**
   * The live `/_utils` policy, or `null` when the server sends none (`[csp] utils_enable = false`,
   * or a proxy that strips it) — in which case nothing is blocking anything.
   *
   * `HEAD`, not `GET`: `/_utils/` answers with HTML, and every JSON-parsing read path would choke
   * on it. A `HEAD` carries the identical headers with no body to misparse.
   */
  async readUtilsPolicy(): Promise<string | null> {
    const { headers } = await this.api.requestWithHeaders<void>('HEAD', UTILS_PATH);
    return headers.get?.('content-security-policy') ?? null;
  }

  /**
   * Replaces `[csp] utils_header_value`. No restart is needed — the next request to `/_utils/`
   * carries the new header.
   *
   * Rejects for anyone who is not a server admin. CouchDB 3.5.2 answers that with **401**
   * (`{"error":"unauthorized","reason":"You are not a server admin."}`), not 403 — verified live —
   * so callers must key off the failure itself rather than off a status code they assumed.
   *
   * Always writes the key, never deletes it — including when the caller is switching the extension
   * back off. Deleting would return the server to its *built-in* default, and nothing here can
   * establish that that is the same string the operator started from: once the key is set, the
   * built-in value is no longer observable, and this app has nowhere durable to have kept a copy.
   * So the header round-trips exactly (which is the property that matters) while the key stays
   * set to it. The visible consequence is narrow and worth stating: a CouchDB upgrade that changed
   * the built-in policy would not reach a server whose key has been written.
   */
  async writeUtilsPolicy(serverId: string, header: string): Promise<void> {
    await this.config.setConfigValue(serverId, CSP_SECTION, CSP_KEY, header);
  }
}
