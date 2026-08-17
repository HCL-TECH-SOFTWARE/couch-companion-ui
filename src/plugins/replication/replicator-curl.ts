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

import { maskUrlCredentials } from "../../services/replication-service.js";

/**
 * Stands in for a real header value in generated curl output.
 * Also reused by `repl-editor.ts`'s Source JSON view (the one other place a
 * stored credential could otherwise reach the screen verbatim) so both spots
 * share a single sentinel — see {@link maskHeaderValues}.
 */
export const CREDENTIAL_PLACEHOLDER = "REPLACE_WITH_CREDENTIALS";

/**
 * Replaces every header value with {@link CREDENTIAL_PLACEHOLDER}. `source.headers`/
 * `target.headers` can carry a credential under any name the remote server expects — not just
 * `Authorization` (e.g. `X-Auth-CouchDB-Token`, `Cookie`, or a custom-named token header from
 * the auth panel's "Custom headers" mode) — so masking must be key-generic, not a lookup for
 * one specific header name. Keys pass through untouched; only values are replaced.
 */
export function maskHeaderValues(headers: unknown): unknown {
  if (!headers || typeof headers !== "object") return headers;
  const masked: Record<string, unknown> = { ...(headers as Record<string, unknown>) };
  for (const key of Object.keys(masked)) {
    masked[key] = CREDENTIAL_PLACEHOLDER;
  }
  return masked;
}

/** Masks a `_replicator` endpoint (bare URL string, or `{url, headers, ...}`) for display. */
function maskEndpoint(endpoint: unknown): unknown {
  if (typeof endpoint === "string") return maskUrlCredentials(endpoint);
  if (endpoint && typeof endpoint === "object") {
    const e = endpoint as Record<string, unknown>;
    return {
      ...e,
      ...(typeof e.url === "string" ? { url: maskUrlCredentials(e.url) } : {}),
      ...("headers" in e ? { headers: maskHeaderValues(e.headers) } : {}),
    };
  }
  return endpoint;
}

/**
 * Build a ready-to-run `curl` command that POSTs a raw replicator document to
 * the hosting CouchDB's `_replicator` database, reproducing the replication
 * outside CCA (#682).
 *
 * `_id`/`_rev` are stripped: a POST creates a fresh document and either field
 * would 409 against the original. The app never hands a stored credential
 * back out: endpoint URL userinfo is masked with the same `***` sentinel used
 * everywhere else ({@link maskUrlCredentials}), and every entry in
 * `source.headers`/`target.headers` is replaced with the
 * `REPLACE_WITH_CREDENTIALS` placeholder ({@link maskHeaderValues}) — a
 * credential can ride under any header name (`Authorization`,
 * `X-Auth-CouchDB-Token`, `Cookie`, a custom token header, ...), not just
 * `Authorization`, so masking is not a lookup for one specific name. The
 * admin running this command supplies the real value(s) themselves.
 * Everything else — every other document field — is emitted verbatim. The
 * `_replicator` write itself needs server-admin credentials the frontend
 * never sees, hence the `$COUCHDB_USER`/`$COUCHDB_PASSWORD` placeholders.
 * The quoted heredoc keeps the shell from expanding anything inside the JSON
 * body.
 */
export function buildReplicatorCurl(serverUrl: string, doc: Record<string, unknown>): string {
  const body: Record<string, unknown> = { ...doc };
  delete body._id;
  delete body._rev;
  if ("source" in body) body.source = maskEndpoint(body.source);
  if ("target" in body) body.target = maskEndpoint(body.target);
  const base = serverUrl.replace(/\/+$/, "");
  return [
    `curl -X POST "${base}/_replicator" \\`,
    '  -H "Content-Type: application/json" \\',
    '  -u "$COUCHDB_USER:$COUCHDB_PASSWORD" \\',
    "  --data-binary @- <<'JSON'",
    JSON.stringify(body, null, 2),
    "JSON"
  ].join("\n");
}
