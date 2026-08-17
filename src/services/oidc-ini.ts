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
 * The `[oidc]` ini section: where identity-provider metadata lives (#32).
 *
 * Keys mirror CouchDB's own `[jwt_keys]` **one for one** — `rsa:<kid>` in both sections — so
 * correlating them is a plain set difference in either direction:
 *
 * - a `[jwt_keys]` entry with no `[oidc]` twin is a signing key left behind by a deleted
 *   identity provider;
 * - an `[oidc]` entry with no `[jwt_keys]` twin is a provider whose key is not installed.
 *
 * The cost of that literal correspondence is that a provider publishing two signing keys is
 * written twice, once under each kid, with identical metadata. Nothing that shows providers to
 * a human may render that twice, so everything here groups by {@link OidcEntry.issuer} — see
 * {@link groupByIssuer} and {@link dedupeByIssuer}.
 *
 * What is stored is deliberately small (#119): the identity of the provider, how to reach its
 * discovery document, and the two things discovery cannot tell us — the client id we were
 * issued and how this deployment wants to be signed into. Everything the IdP itself publishes
 * (`authorization_endpoint`, `token_endpoint`, `end_session_endpoint`, `jwks_uri`, the
 * supported algorithms, the scopes it honours) is *its* to publish and is re-read from
 * `well_known_url` when a login needs it; copying it into the ini file only creates a second
 * copy that goes stale silently. Entries written before #119 still carry those fields —
 * {@link parseEntry} ignores them rather than choking.
 *
 * ```ini
 * [jwt_keys]
 * rsa:abc123 = -----BEGIN PUBLIC KEY-----\nMIIB…\n-----END PUBLIC KEY-----\n
 *
 * [oidc]
 * log = false
 * rsa:abc123 = {"name":"Corporate Entra ID","issuer":"https://login.example.com/v2.0", …}
 * ```
 */

import type { NodeConfig } from "../plugins/config/types.js";

/** Lowercase, like every CouchDB built-in section — section names are case-sensitive. */
export const OIDC_SECTION = "oidc";

/** CouchDB's own signing-key section. Read to correlate, written by an apply. */
export const JWT_KEYS_SECTION = "jwt_keys";

/**
 * The one key in `[oidc]` that is not a provider: the activity-log switch.
 * Absent means **off** — see {@link logEnabled}.
 */
export const LOG_KEY = "log";

/** Every `[oidc]`/`[jwt_keys]` provider key starts here. HMAC keys are out of scope (#32). */
const KEY_PREFIX = "rsa:";

/** The ini key both sections use for one signing key. */
export const oidcKey = (kid: string): string => `${KEY_PREFIX}${kid}`;

/**
 * The kid inside an ini key, or `null` when the key is not a signing-key entry at all —
 * `log`, an `hmac:` key, or anything an operator added by hand.
 *
 * A kid is an opaque IdP-chosen string that may itself contain a colon, so everything after
 * the first `rsa:` belongs to the kid.
 */
export function kidFromKey(key: string): string | null {
  if (!key.startsWith(KEY_PREFIX)) return null;
  const kid = key.slice(KEY_PREFIX.length);
  return kid.length > 0 ? kid : null;
}

/**
 * One `[oidc]` value, as stored: what *this deployment* decided about a provider, and nothing
 * the provider's own discovery document already says (#119). There is no secret here — a PKCE
 * public client has none.
 *
 * Everything else a login needs comes back from {@link well_known_url} at the moment it is
 * needed (`resolveEndpoints` in `oidc-service.ts` already does that fetch), so there is no
 * second copy here to drift out of date when the IdP rotates an endpoint.
 *
 * Every field is treated as optional on read (see {@link parseEntry}): an operator can write
 * this section by hand, and a hand-written entry that omits one must not crash the screen that
 * renders it.
 */
export interface OidcEntry {
  name: string;
  issuer: string;
  client_id: string | null;
  well_known_url: string;
  roles_claim: string;
  /** Hides the username/password form on the login screen — this deployment signs in through
   *  identity providers only. A deployment decision, not something discovery can answer. */
  idp_only: boolean;
  /** The JWS algorithm of **this** kid — the one field that differs between an issuer's
   *  otherwise identical entries, and the one thing here that is per-key rather than
   *  per-provider, so it cannot be re-derived from the discovery document. */
  alg: string;
  last_refreshed: string | null;
  created_at: string;
}

/**
 * The scopes a login asks for when nothing said otherwise. No longer stored (#119) — the ini
 * entry has no `scopes` field — but still the fallback a discovery entry that names none gets;
 * see `normalize` in `idp-discovery.ts`.
 */
export const DEFAULT_SCOPES = ["openid", "profile", "email"];

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/**
 * Parses one `[oidc]` value. Returns `null` for anything that is not usable metadata — bad
 * JSON, a non-object, or an entry naming no issuer — because an entry with no issuer cannot be
 * grouped, correlated, or offered as a login button.
 *
 * Unknown keys are dropped rather than rejected, which is what makes an entry written before
 * #119 — carrying `scopes`, `jwks_uri`, the endpoints — parse as a perfectly good slim entry.
 * Real deployments have those, and they must keep working without a migration.
 */
export function parseEntry(raw: string): OidcEntry | null {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof doc !== "object" || doc === null) return null;

  const e = doc as Record<string, unknown>;
  const issuer = str(e.issuer);
  if (!issuer) return null;

  return {
    name: str(e.name) ?? issuer,
    issuer,
    client_id: str(e.client_id),
    well_known_url: str(e.well_known_url) ?? "",
    roles_claim: str(e.roles_claim) ?? "roles",
    idp_only: e.idp_only === true,
    alg: str(e.alg) ?? "RS256",
    last_refreshed: str(e.last_refreshed),
    created_at: str(e.created_at) ?? "",
  };
}

/**
 * Renders one entry as the config value to PUT. `JSON.stringify` already emits line breaks
 * inside strings as the two-character `\n`, so there is nothing left for
 * `escapeForCouchConfig` to do here — but CouchDB rejecting literal newlines
 * (apache/couchdb#5091) is the reason this function exists rather than a bare `JSON.stringify`
 * at every call site.
 */
export function serializeEntry(entry: OidcEntry): string {
  return JSON.stringify(entry).replace(/\n/g, "\\n");
}

/** One `rsa:<kid>` entry, paired with the kid its key named. */
export interface OidcKeyEntry {
  kid: string;
  entry: OidcEntry;
}

/**
 * One identity provider, aggregated from every `rsa:<kid>` entry that named its issuer.
 * This is the de-duplication the `rsa:<kid>` key format makes necessary.
 */
export interface OidcProvider {
  issuer: string;
  /** Every kid this issuer signs with, in section order. Never empty. */
  keys: OidcKeyEntry[];
  /** Metadata from the first entry; the rest are copies of it apart from {@link OidcEntry.alg}. */
  entry: OidcEntry;
}

/** Every parsable `rsa:<kid>` entry of a `[oidc]` section, in the order CouchDB returned them. */
export function parseSection(section: Record<string, string> | undefined): OidcKeyEntry[] {
  const found: OidcKeyEntry[] = [];
  for (const [key, raw] of Object.entries(section ?? {})) {
    const kid = kidFromKey(key);
    if (!kid) continue;
    const entry = parseEntry(raw);
    if (entry) found.push({ kid, entry });
  }
  return found;
}

/**
 * Groups entries into one provider per issuer. First entry wins for the shared metadata; the
 * kids accumulate. An IdP that rotated to a second signing key is one provider with two keys,
 * never two providers.
 */
export function groupByIssuer(entries: OidcKeyEntry[]): OidcProvider[] {
  const byIssuer = new Map<string, OidcProvider>();
  for (const found of entries) {
    const existing = byIssuer.get(found.entry.issuer);
    if (existing) existing.keys.push(found);
    else
      byIssuer.set(found.entry.issuer, {
        issuer: found.entry.issuer,
        keys: [found],
        entry: found.entry,
      });
  }
  return [...byIssuer.values()];
}

/** Every provider configured in a node config dump, de-duplicated by issuer. */
export function providersFrom(config: NodeConfig): OidcProvider[] {
  return groupByIssuer(parseSection(config[OIDC_SECTION]));
}

/**
 * First-wins de-duplication by `issuer`, for anything already normalized to the §5 login
 * shape. Applied where providers are *presented*: two signing keys must never render as two
 * login buttons, whichever source the list came from.
 */
export function dedupeByIssuer<T extends { issuer: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.issuer)) return false;
    seen.add(item.issuer);
    return true;
  });
}

/**
 * `[oidc] log`. **Default off** (#32): the IdP activity log is the one thing an ini section
 * genuinely cannot hold, so enabling it is what creates `couchcompanion` documents (D13) — an
 * opt-in, never a side effect of registering a provider.
 *
 * Anything that is not an affirmative value, including an absent key and an unparsable one,
 * means off.
 */
export function logEnabled(raw: string | undefined | null): boolean {
  if (typeof raw !== "string") return false;
  const value = raw.trim().toLowerCase();
  return value === "true" || value === "1" || value === "yes" || value === "on";
}

/**
 * `[jwt_keys]` kids with no `[oidc]` twin — signing keys CouchDB still trusts that no
 * configured provider claims. Deleting an identity provider deliberately leaves its key
 * installed (already-issued tokens stay verifiable), so this is the read-back that makes the
 * leftover visible instead of invisible.
 */
export function orphanKeyKids(config: NodeConfig): string[] {
  const claimed = new Set(parseSection(config[OIDC_SECTION]).map((found) => found.kid));
  const installed = Object.keys(config[JWT_KEYS_SECTION] ?? {});
  return installed.flatMap((key) => {
    const kid = kidFromKey(key);
    return kid && !claimed.has(kid) ? [kid] : [];
  });
}
