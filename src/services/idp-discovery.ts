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

import { ApiClient } from "./api-client";
import { DEFAULT_SCOPES, dedupeByIssuer } from "./oidc-ini.js";
import { getLogger } from "./log-service.js";

const log = getLogger("services/idp-discovery");

/** One usable IdP, normalized to the spec §5 shape (docs/derivate-creation.md). */
export interface DiscoveredIdp {
  name: string;
  issuer: string;
  client_id: string;
  well_known_url: string | null;
  authorization_endpoint: string | null;
  token_endpoint: string | null;
  /** Where a sign-out redirect goes, when the provider published one (#24). */
  end_session_endpoint: string | null;
  scopes: string[];
  roles_claim: string | null;
  /** This deployment signs in through identity providers only — the login screen hides the
   *  username/password form when any discovered IdP says so (#119). */
  idp_only: boolean;
}

export interface IdpDiscovery {
  idps: DiscoveredIdp[];
  source: "_idp" | "idp/config" | "none";
  jwtHandlerEnabled: boolean;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/**
 * Keeps only entries carrying the three fields a PKCE flow cannot invent, then **de-duplicates
 * by `issuer`**.
 *
 * The de-duplication is required by the `[oidc]` key format (#32): metadata is stored once per
 * `rsa:<kid>`, so a provider that publishes two signing keys is written twice. Two entries for
 * one issuer are one provider — rendering them as two identical login buttons would be a bug
 * the operator cannot fix from the UI. Applied here rather than only where the document is
 * written, so a hand-edited `idp/config` and a future native `/_idp` get the same treatment.
 *
 * The endpoint and `scopes` overrides survive #119's slimming even though nothing writes them
 * any more: that is exactly the hand-edited case above, and it is the only escape hatch an IdP
 * whose well-known document is not CORS-readable has. Absent, as they now are on every
 * app-written entry, they fall back to null / {@link DEFAULT_SCOPES} and `resolveEndpoints`
 * fetches the discovery document instead.
 */
function normalize(raw: unknown): DiscoveredIdp[] {
  const list = (raw as { idps?: unknown })?.idps;
  if (!Array.isArray(list)) return [];
  const idps: DiscoveredIdp[] = [];
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const name = str(e.name);
    const issuer = str(e.issuer);
    const clientId = str(e.client_id);
    if (!name || !issuer || !clientId) continue;
    idps.push({
      name,
      issuer,
      client_id: clientId,
      well_known_url: str(e.well_known_url),
      authorization_endpoint: str(e.authorization_endpoint),
      token_endpoint: str(e.token_endpoint),
      end_session_endpoint: str(e.end_session_endpoint),
      scopes: Array.isArray(e.scopes) && e.scopes.every((s) => typeof s === "string") && e.scopes.length > 0
        ? (e.scopes as string[])
        : DEFAULT_SCOPES,
      roles_claim: str(e.roles_claim),
      idp_only: e.idp_only === true,
    });
  }
  return dedupeByIssuer(idps);
}

/**
 * The discovery chain (spec D8/§5): `GET /_idp` (future native CouchDB
 * endpoint, shape defined by us) → `GET /idp/config` (database `idp`,
 * document `config` — works on today's CouchDB) → none. Every failure
 * degrades silently to the next step. `jwtHandlerEnabled` reports whether
 * `GET /_session` lists the `jwt` handler, best-effort.
 *
 * Every read goes through {@link ApiClient.requestPreAuth}, never `request`: this runs on the
 * login screen with no session, and CouchDB answers the reserved `/_idp` path with **401**
 * rather than 404 (verified live against 3.5.2). Through the ordinary path that 401 would
 * trip the centralized logout and log a spurious "session expired" on every login page view.
 */
export async function discoverIdps(api: ApiClient): Promise<IdpDiscovery> {
  let idps: DiscoveredIdp[] = [];
  let source: IdpDiscovery["source"] = "none";
  for (const [path, name] of [
    ["/_idp", "_idp"],
    ["/idp/config", "idp/config"],
  ] as const) {
    try {
      const found = normalize(await api.requestPreAuth<unknown>(path));
      if (found.length > 0) {
        idps = found;
        source = name;
        break;
      }
    } catch (err) {
      log.debug?.(`idp discovery miss on ${path}`, err as Error);
    }
  }

  let jwtHandlerEnabled = false;
  try {
    const session = await api.requestPreAuth<{ info?: { authentication_handlers?: string[] } }>(
      "/_session",
    );
    jwtHandlerEnabled = session?.info?.authentication_handlers?.includes("jwt") ?? false;
  } catch {
    jwtHandlerEnabled = false;
  }

  return { idps, source, jwtHandlerEnabled };
}
