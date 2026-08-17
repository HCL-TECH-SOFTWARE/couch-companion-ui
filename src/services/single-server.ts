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

import type { Server } from "../plugins/server-mgmt/types.js";
import type { ServerWelcome } from "../plugins/server-mgmt/types.js";
import type { SessionResponse } from "../types/api.js";

/**
 * This product manages exactly one CouchDB (spec D2/D3), but the UI was built
 * around a server registry: route params, pickers, breadcrumbs and dashboards
 * all key off a server id. Rather than tear that out, we synthesize one
 * virtual server under a fixed id — every `serverId` parameter in the service
 * layer is inert, and this is the value it carries.
 */
export const SINGLE_SERVER_ID = "local";

/** Derives a human label from the CouchDB base URL ("http://db:5984" -> "db:5984"). */
export function labelFor(baseUrl: string): string {
  if (!baseUrl) return "CouchDB";
  try {
    const url = new URL(baseUrl);
    return url.host || "CouchDB";
  } catch {
    return baseUrl;
  }
}

/**
 * Hostnames that always mean "the machine this CouchDB runs on".
 *
 * `0.0.0.0` is in the list because it is CouchDB's own default `bind_address`, so operators
 * routinely copy it into an endpoint URL; as a *destination* it resolves to the local host.
 */
const LOOPBACK_HOSTNAMES = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "[::1]",
  "::1",
]);

/**
 * A comparable identity for the CouchDB server a URL names: `hostname[:port]`, lowercased, with
 * the scheme's default port dropped, userinfo excluded, and loopback hostnames folded together.
 * Returns `""` for anything that is not an absolute `http(s)` URL.
 *
 * Two URLs naming the same server must produce the same key, because both the topology graph and
 * the replication editor decide "is this endpoint our own server?" by comparing one endpoint
 * against {@link ApiClient.currentBaseUrl} — and a miss there splits one physical database into a
 * "local" node and a "remote" node, or hides the local-server database picker behind a URL that
 * is in fact local. Plain string comparison of the two URLs misses four ways: a differently-cased
 * host, an explicitly written default port, embedded (or `***`-masked) credentials, and loopback
 * aliases such as `127.0.0.1` for `localhost` — the last of which is routine in the devcontainer.
 *
 * The scheme is deliberately *not* part of the key: `http://host:5984` and `https://host:5984` are
 * one server reached two ways, and this module already collapses remote topology nodes by host
 * for the same reason.
 *
 * What this cannot fold, because nothing short of contacting the server could prove it: two
 * genuinely different *names* for one host, such as a Docker Compose service name (`couchdb:5984`)
 * against `localhost:5984`. Spec D10 forbids probing a remote endpoint, so those still read as two
 * servers.
 *
 * Never returns userinfo, so callers that feed masked credentials in (`http://***@host/db`) cannot
 * leak them back out.
 */
export function serverKey(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";

  const hostname = parsed.hostname.toLowerCase();
  if (!hostname) return "";
  const host = LOOPBACK_HOSTNAMES.has(hostname) ? "localhost" : hostname;
  return parsed.port ? `${host}:${parsed.port}` : host;
}

/**
 * Builds the single `Server` record the UI consumes. `welcome` is null when the
 * server could not be reached — the record still exists (screens render an
 * unreachable state rather than an empty list).
 */
export function synthesizeServer(
  welcome: ServerWelcome | null,
  session: SessionResponse | null,
  baseUrl: string,
  now: string,
): Server {
  return {
    id: SINGLE_SERVER_ID,
    name: labelFor(baseUrl),
    url: baseUrl,
    username: session?.userCtx?.name ?? session?.name ?? "",
    location: null,
    reachable: welcome !== null,
    last_checked: now,
    couch_version: welcome?.version ?? null,
    created_at: now,
    updated_at: now,
    configured_idps: null,
    kind: "local",
  };
}
