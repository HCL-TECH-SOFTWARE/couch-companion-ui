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

import { ApiClient } from "./api-client.js";
import { ApiError } from "./api-error.js";
import { ConfigService } from "./config-service.js";
import { CouchCompanionStore, ID_PREFIX } from "./git/couchcompanion-store.js";
import { detectNativeIdp } from "./native-idp.js";
import { fetchJson } from "./oidc-http.js";
import {
  escapeForCouchConfig,
  jwkToSpkiPem,
  signingKeys,
  unescapeFromCouchConfig,
  type RsaJwk,
} from "./jwk-to-pem.js";
import {
  JWT_KEYS_SECTION,
  LOG_KEY,
  OIDC_SECTION,
  logEnabled,
  oidcKey,
  orphanKeyKids,
  providersFrom,
  serializeEntry,
  type OidcEntry,
  type OidcProvider,
} from "./oidc-ini.js";
import { SINGLE_SERVER_ID } from "./single-server.js";
import { getLogger } from "./log-service.js";
import type { NodeConfig } from "../plugins/config/types.js";
import type { IdpConfig, IdpLogEntry, JwkKey, OidcDiscovery } from "../plugins/idp/types.js";

const log = getLogger("services/idp-service");

export interface CreateIdpRequest {
  name: string;
  well_known_url: string;
  client_id: string | null;
  roles_claim: string | null;
  /** Hide the password form once this provider is live — see {@link OidcEntry.idp_only}. */
  idp_only: boolean;
  /**
   * A JWKS pasted by the operator, used instead of fetching `jwks_uri` (D15). Optional and
   * additive: every existing caller omits it and gets the fetch. Present when the IdP's JWKS
   * endpoint is not CORS-readable from the browser, which no amount of retrying fixes.
   */
  jwks?: unknown;
}

export interface UpdateIdpRequest {
  client_id: string | null;
  roles_claim: string | null;
  idp_only: boolean;
}

export interface ApplyResult {
  applied_to: string[];
  removed_from: string[];
  errors: string[];
}

export interface RestartResult {
  target_servers: string[];
  errors: string[];
}

export interface DeleteResult {
  idp_id: string;
  errors: string[];
}

/**
 * A second registration of an issuer already in `[oidc]`.
 *
 * An identity provider is now identified by its issuer, not by a document id derived from the
 * name it was given (#32) — two registrations of the same issuer would silently overwrite each
 * other's entries instead of coexisting, so the second one is refused with the reason stated.
 */
export class IdpConflictError extends Error {
  constructor(public readonly issuer: string) {
    super(`An identity provider for issuer ${issuer} is already registered.`);
    this.name = "IdpConflictError";
  }
}

/** The public discovery document login reads before anyone has authenticated (§5). */
const DISCOVERY_DB = "idp";
const DISCOVERY_DOC_ID = "config";

/** The CouchDB config keys an apply owns. `seed-dev.sh` writes exactly these by hand. */
const CONFIG = {
  handlers: { section: "chttpd", key: "authentication_handlers" },
  requiredClaims: { section: "jwt_auth", key: "required_claims" },
  rolesClaimName: { section: "jwt_auth", key: "roles_claim_name" },
  rolesClaimPath: { section: "jwt_auth", key: "roles_claim_path" },
} as const;

/**
 * The handler chain an apply installs. `jwt` first so a Bearer token wins, then `cookie` and
 * `default` so password login keeps working — D8 requires native session auth to remain
 * available, and dropping those two would lock out every user without an IdP account.
 */
const HANDLER_CHAIN =
  "{chttpd_auth, jwt_authentication_handler}, " +
  "{chttpd_auth, cookie_authentication_handler}, " +
  "{chttpd_auth, default_authentication_handler}";

/**
 * Encapsulates all identity-provider work — against CouchDB and the IdP directly, with no
 * backend (phase 6). The parent product served these from `/api/idp…`; this body talks to
 * `_node/_local/_config` for both halves of the configuration and to the IdP for discovery and
 * JWKS.
 *
 * **Storage is the node config, not a document** (#32). Provider metadata lives in `[oidc]`
 * under `rsa:<kid>`, the same key `[jwt_keys]` uses for that provider's signing key, so the two
 * sections correlate one-for-one and a leftover on either side is a plain set difference. The
 * `couchcompanion` database is touched only by the activity log, and only when
 * `[oidc] log = true` — off by default (D13: nothing this app does creates a database the
 * operator did not ask for).
 *
 * Public signatures are unchanged (D6); `IdpConfig._id` is now the provider's **issuer**, which
 * is what identifies it once the metadata is spread across one entry per signing key. The
 * multi-server carry-over fields are gone (#104): `urls` never held anything but
 * {@link SINGLE_SERVER_ID}, so a picker for it was a choice with one option. The result
 * collections (`applied_to`, `removed_from`, `target_servers`) still report that id, because
 * they report what happened rather than asking what should.
 *
 * What is stored is only what discovery cannot tell us (#119) — see {@link OidcEntry}.
 * {@link discover} still reads the whole well-known document; it just stops writing the parts
 * that belong to the identity provider rather than to this deployment.
 *
 * @param api - shared ApiClient (token already set by AuthService)
 * @param store - the `couchcompanion` document store, for the opt-in activity log only
 * @param config - `_node/_local/_config` reads and writes
 */
export class IdpService {
  constructor(
    private api: ApiClient,
    private store: CouchCompanionStore,
    private config: ConfigService,
  ) {}

  /** @returns all registered identity providers, one per issuer however many keys it signs with */
  async listIdps(): Promise<IdpConfig[]> {
    const config = await this.readConfig();
    return providersFrom(config).map((provider) => this.toIdpConfig(provider, config));
  }

  /**
   * Fetches a single identity provider.
   * @param id - the provider's issuer
   */
  async getIdp(id: string): Promise<IdpConfig> {
    const config = await this.readConfig();
    const provider = providersFrom(config).find((p) => p.issuer === id);
    if (!provider) throw new Error(`No identity provider with id ${id}`);
    return this.toIdpConfig(provider, config);
  }

  /**
   * Registers a new IdP and immediately runs OIDC discovery + JWKS fetch — in the browser.
   * Throws rather than storing an IdP whose keys could not be resolved: an IdP with no usable
   * signing key cannot verify a single token, so storing one only defers the failure to a
   * confusing place.
   *
   * Writes **both** twins: the `[oidc]` metadata and the `[jwt_keys]` PEM. They are written
   * together because there is nowhere else for key material to live — the conversion happens in
   * the browser and the JWKS may have been pasted (D15), so a PEM dropped here cannot be
   * recovered later without going back to the identity provider.
   *
   * @param req - IdP registration payload
   * @throws {@link IdpConflictError} when this issuer is already registered
   */
  async createIdp(req: CreateIdpRequest): Promise<IdpConfig> {
    const { oidc, keys } = await this.discover(req.well_known_url, req.jwks);
    const config = await this.readConfig();
    if (providersFrom(config).some((provider) => provider.issuer === oidc.issuer)) {
      throw new IdpConflictError(oidc.issuer);
    }

    const now = new Date().toISOString();
    const entry: OidcEntry = {
      name: req.name,
      issuer: oidc.issuer,
      client_id: req.client_id,
      well_known_url: req.well_known_url,
      roles_claim: req.roles_claim ?? "roles",
      idp_only: req.idp_only,
      alg: "RS256",
      last_refreshed: now,
      created_at: now,
    };

    await this.writeProvider(entry, keys);
    await this.writeLog("info", "created", entry.issuer, req.name, `Registered ${req.name}`);
    return this.buildIdpConfig(entry, keys.map((key) => ({ ...key, installed: true })));
  }

  /**
   * Updates the editable fields of an IdP (client_id, roles_claim, idp_only). Rewrites the
   * metadata under **every** `rsa:<kid>` entry this issuer owns — they are copies of one
   * another, so a partial update would leave the section disagreeing with itself.
   *
   * @param id - the provider's issuer
   * @param req - updated editable fields
   */
  async updateIdp(id: string, req: UpdateIdpRequest): Promise<IdpConfig> {
    const config = await this.readConfig();
    const provider = providersFrom(config).find((p) => p.issuer === id);
    if (!provider) throw new Error(`No identity provider with id ${id}`);

    const entry: OidcEntry = {
      ...provider.entry,
      client_id: req.client_id,
      roles_claim: req.roles_claim ?? provider.entry.roles_claim,
      idp_only: req.idp_only,
    };
    for (const { kid, entry: previous } of provider.keys) {
      await this.putConfig(OIDC_SECTION, oidcKey(kid), serializeEntry({ ...entry, alg: previous.alg }));
    }
    await this.writeLog("info", "updated", id, entry.name, `Updated ${entry.name}`);
    return this.toIdpConfig({ ...provider, entry }, config);
  }

  /**
   * Re-runs OIDC discovery and JWKS fetch for an existing IdP — the way an operator picks up a
   * key rotation without re-registering, and the way a hand-edited `[oidc]` entry whose
   * `[jwt_keys]` twin went missing is repaired.
   *
   * A kid that has disappeared from the JWKS loses its `[oidc]` entry but keeps its
   * `[jwt_keys]` one, for the same reason {@link deleteIdp} does: tokens already signed with
   * the retired key stay verifiable until an operator decides otherwise. The leftover is
   * reported by {@link listOrphanKeys} rather than left invisible.
   *
   * @param id - the provider's issuer
   * @param jwks - a pasted JWKS, when the endpoint is not CORS-readable (D15)
   */
  async refreshIdp(id: string, jwks?: unknown): Promise<IdpConfig> {
    const config = await this.readConfig();
    const provider = providersFrom(config).find((p) => p.issuer === id);
    if (!provider) throw new Error(`No identity provider with id ${id}`);

    const { oidc, keys } = await this.discover(provider.entry.well_known_url, jwks);
    const entry: OidcEntry = {
      ...provider.entry,
      issuer: oidc.issuer,
      last_refreshed: new Date().toISOString(),
    };

    const fresh = new Set(keys.map((key) => key.kid));
    const retired = provider.keys.map(({ kid }) => kid).filter((kid) => !fresh.has(kid));
    await this.writeProvider(entry, keys, retired);
    await this.writeLog(
      "info",
      "refreshed",
      entry.issuer,
      entry.name,
      `Refreshed ${keys.length} signing key(s)`,
    );
    return this.buildIdpConfig(entry, keys.map((key) => ({ ...key, installed: true })));
  }

  /**
   * Wires CouchDB's JWT authentication to this IdP and republishes the public discovery
   * document.
   *
   * Both halves matter (P6-6): the config keys let CouchDB *verify* a JWT, the discovery
   * document lets the login screen *offer* the IdP. Applying one without the other leaves a
   * server that accepts tokens nobody can obtain, or advertises an IdP it will reject.
   *
   * The signing keys themselves were written at registration, so this verifies rather than
   * re-writes them: a kid whose `[jwt_keys]` twin is missing is reported by name, because the
   * PEM is not recoverable from here and only a refresh can restore it.
   *
   * Does not restart (P6-7) — `chttpd` builds its handler pipeline once at startup, so a
   * first-time handler change needs {@link restartNode}, but bouncing the server is the
   * operator's decision to make explicitly.
   *
   * @param id - the provider's issuer
   */
  async applyIdp(id: string): Promise<ApplyResult> {
    const idp = await this.getIdp(id);
    const errors: string[] = [];

    for (const key of idp.jwks_keys) {
      if (key.installed) continue;
      errors.push(
        `Signing key ${oidcKey(key.kid)} is missing from [jwt_keys]. Use Refresh Keys to fetch it again.`,
      );
    }

    try {
      await this.putConfig(CONFIG.requiredClaims.section, CONFIG.requiredClaims.key, "exp");
      await this.putConfig(CONFIG.rolesClaimName.section, CONFIG.rolesClaimName.key, idp.roles_claim);
      await this.putConfig(CONFIG.rolesClaimPath.section, CONFIG.rolesClaimPath.key, idp.roles_claim);
      await this.putConfig(CONFIG.handlers.section, CONFIG.handlers.key, HANDLER_CHAIN);
      await this.publishDiscoveryDocument();
    } catch (err) {
      errors.push((err as Error).message);
    }

    await this.writeLog(
      errors.length ? "error" : "info",
      "applied",
      id,
      idp.name,
      errors.length ? `Apply failed: ${errors.join("; ")}` : `Applied ${idp.name}`,
    );

    return {
      applied_to: errors.length ? [] : [SINGLE_SERVER_ID],
      removed_from: [],
      errors,
    };
  }

  /**
   * `POST /_node/_local/_restart`. Required after a first-time `authentication_handlers`
   * change: a config PUT alone does not re-wire the pipeline (confirmed against 3.5.2, see
   * `scripts/seed-dev.sh`). Documented by CouchDB as an integration-testing facility, which
   * is exactly this use.
   */
  async restartNode(id: string): Promise<RestartResult> {
    const errors: string[] = [];
    try {
      await this.api.request("POST", "/_node/_local/_restart");
    } catch (err) {
      errors.push((err as Error).message);
    }
    await this.writeLog(
      errors.length ? "error" : "info",
      "restarted",
      id,
      null,
      errors.length ? `Restart failed: ${errors.join("; ")}` : "Requested node restart",
    );
    return { target_servers: [SINGLE_SERVER_ID], errors };
  }

  /**
   * Removes the provider's `[oidc]` entries. Deliberately does NOT strip the `[jwt_keys]`
   * entries it installed: tokens already issued stay verifiable until an operator decides
   * otherwise, and silently breaking every signed-in user as a side effect of tidying a list
   * would be worse than leaving a stale public key in place. What is left behind is now
   * visible — see {@link listOrphanKeys}.
   *
   * @param id - the provider's issuer
   */
  async deleteIdp(id: string): Promise<DeleteResult | null> {
    const errors: string[] = [];
    let name: string | null = null;
    try {
      const config = await this.readConfig();
      const provider = providersFrom(config).find((p) => p.issuer === id);
      name = provider?.entry.name ?? null;
      for (const { kid } of provider?.keys ?? []) {
        await this.config.deleteConfigValue(SINGLE_SERVER_ID, OIDC_SECTION, oidcKey(kid));
      }
    } catch (err) {
      errors.push((err as Error).message);
    }
    await this.writeLog(
      errors.length ? "error" : "info",
      "deleted",
      id,
      name,
      errors.length ? `Delete failed: ${errors.join("; ")}` : `Deleted ${name ?? id}`,
    );
    return { idp_id: id, errors };
  }

  /**
   * Signing keys CouchDB still trusts that no `[oidc]` entry claims — what a deleted or
   * refreshed identity provider leaves behind. The correlation the `rsa:<kid>` key format
   * exists to make possible (#32).
   */
  async listOrphanKeys(): Promise<string[]> {
    return orphanKeyKids(await this.readConfig());
  }

  /**
   * Whether `[oidc] log` is on. **Off by default**: with it off nothing is written to
   * `couchcompanion` at all, so screens that show the log have to explain the silence rather
   * than report "nothing happened yet".
   */
  async isLogEnabled(): Promise<boolean> {
    return logEnabled(await this.config.getConfigValue(SINGLE_SERVER_ID, OIDC_SECTION, LOG_KEY));
  }

  /**
   * Fetches IdP activity log entries, newest first. Empty whenever `[oidc] log` has been off
   * for the whole life of the server — nothing was ever written.
   *
   * @param idpId - optional filter by issuer
   */
  async getLogs(idpId?: string): Promise<IdpLogEntry[]> {
    const entries = await this.store.list<IdpLogEntry>(ID_PREFIX.idpLog);
    return entries
      .filter((entry) => !idpId || entry.idp_id === idpId)
      .sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
  }

  /** The whole node config: `[oidc]` and `[jwt_keys]` in one dump, so they can be correlated. */
  private readConfig(): Promise<NodeConfig> {
    return this.config.getConfig(SINGLE_SERVER_ID);
  }

  /**
   * Writes one provider: the `[oidc]` metadata and the `[jwt_keys]` PEM under the same
   * `rsa:<kid>` key, per signing key, plus the `[oidc]` entries of any kid that is no longer
   * in the JWKS.
   */
  private async writeProvider(entry: OidcEntry, keys: JwkKey[], retired: string[] = []): Promise<void> {
    for (const key of keys) {
      await this.putConfig(OIDC_SECTION, oidcKey(key.kid), serializeEntry({ ...entry, alg: key.alg }));
      await this.putConfig(JWT_KEYS_SECTION, oidcKey(key.kid), escapeForCouchConfig(key.value));
    }
    for (const kid of retired) {
      await this.config.deleteConfigValue(SINGLE_SERVER_ID, OIDC_SECTION, oidcKey(kid));
    }
  }

  /**
   * The view `IdpConfig` shape the screens still expect (D6), assembled from the two sections.
   * `jwks_keys[].value` is the PEM **read back out of `[jwt_keys]`**, not a second copy kept
   * beside it, so `installed` reports what CouchDB actually holds.
   */
  private toIdpConfig(provider: OidcProvider, config: NodeConfig): IdpConfig {
    const installed = config[JWT_KEYS_SECTION] ?? {};
    const keys: JwkKey[] = provider.keys.map(({ kid, entry }) => {
      const pem = installed[oidcKey(kid)];
      return {
        kid,
        kty: "RSA",
        alg: entry.alg,
        value: pem ? unescapeFromCouchConfig(pem) : "",
        installed: pem !== undefined,
      };
    });
    return this.buildIdpConfig(provider.entry, keys);
  }

  private buildIdpConfig(entry: OidcEntry, jwks_keys: JwkKey[]): IdpConfig {
    return {
      _id: entry.issuer,
      name: entry.name,
      issuer: entry.issuer,
      well_known_url: entry.well_known_url,
      client_id: entry.client_id,
      roles_claim: entry.roles_claim,
      idp_only: entry.idp_only,
      jwks_keys,
      last_refreshed: entry.last_refreshed,
      created_at: entry.created_at,
    };
  }

  /**
   * OIDC discovery plus signing keys, converted to the PEM CouchDB's `[jwt_keys]` wants.
   *
   * @param wellKnownUrl - the IdP's `.well-known/openid-configuration`
   * @param pastedJwks - used instead of fetching `jwks_uri` when present (D15)
   */
  private async discover(
    wellKnownUrl: string,
    pastedJwks?: unknown,
  ): Promise<{ oidc: OidcDiscovery; keys: JwkKey[] }> {
    const doc = await fetchJson<Record<string, unknown>>(wellKnownUrl);

    const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
    const jwksUri = str(doc.jwks_uri);
    if (!jwksUri && !pastedJwks) {
      throw new Error("The discovery document names no jwks_uri.");
    }

    const oidc: OidcDiscovery = {
      issuer: str(doc.issuer) ?? wellKnownUrl,
      jwks_uri: jwksUri ?? "",
      authorization_endpoint: str(doc.authorization_endpoint),
      token_endpoint: str(doc.token_endpoint),
      end_session_endpoint: str(doc.end_session_endpoint),
      supported_algorithms: Array.isArray(doc.id_token_signing_alg_values_supported)
        ? (doc.id_token_signing_alg_values_supported as string[])
        : [],
    };

    const jwks = pastedJwks ?? (await fetchJson<{ keys?: unknown }>(jwksUri!));
    const raw = (jwks as { keys?: unknown })?.keys;
    if (!Array.isArray(raw)) {
      throw new Error("The JWKS contains no key array.");
    }

    const usable = signingKeys(raw as RsaJwk[]);
    if (usable.length === 0) {
      throw new Error("The JWKS contains no RSA signing key CouchDB could use.");
    }

    const keys: JwkKey[] = [];
    for (const jwk of usable) {
      keys.push({
        kid: jwk.kid,
        kty: jwk.kty,
        alg: jwk.alg ?? "RS256",
        value: await jwkToSpkiPem(jwk),
      });
    }
    return { oidc, keys };
  }

  /**
   * Republishes `idp/config` — the world-readable document the login screen's discovery chain
   * reads before anyone has authenticated (§5). Contains only public OIDC metadata; there is
   * no secret in a PKCE public client to leak here.
   *
   * Emits the slim field set (#119) — the endpoint and scope overrides §5 allows are *read*
   * from this document but no longer written into it, because we would only be writing back
   * what `well_known_url` already answers. An operator adding them by hand to skip the
   * discovery fetch still works; see `normalize` in `idp-discovery.ts`.
   *
   * **Skipped entirely when CouchDB serves `/_idp` natively** (#32). The `idp` database is a
   * stopgap until it does; on a server that already answers the native endpoint, creating a
   * database to duplicate it would be the app inventing state nobody asked for.
   */
  private async publishDiscoveryDocument(): Promise<void> {
    if (await detectNativeIdp(this.api)) {
      log.debug?.("native /_idp endpoint present; leaving the idp database alone");
      return;
    }

    const idps = (await this.listIdps())
      .filter((idp) => idp.client_id)
      .map((idp) => ({
        name: idp.name,
        issuer: idp.issuer,
        client_id: idp.client_id,
        well_known_url: idp.well_known_url,
        roles_claim: idp.roles_claim,
        idp_only: idp.idp_only,
      }));

    await this.ensureDiscoveryDatabase();

    const existing = await this.api
      .request<{ _rev?: string }>("GET", `/${DISCOVERY_DB}/${DISCOVERY_DOC_ID}`)
      .catch(() => null);

    await this.api.request("PUT", `/${DISCOVERY_DB}/${DISCOVERY_DOC_ID}`, {
      ...(existing?._rev ? { _rev: existing._rev } : {}),
      idps,
    });
  }

  /**
   * Creates the `idp` database and opens it to unauthenticated reads.
   *
   * Both steps are needed and neither used to happen: on a stock CouchDB the document PUT
   * simply 404'd into `ApplyResult.errors`, and a database left with CouchDB's admin-only
   * default `_security` cannot be read by the login screen, which by definition has no session.
   * `scripts/seed-dev.sh` has always done both by hand; the app now does the same.
   *
   * The `_security` write is unconditional rather than create-only. This database exists for
   * exactly one purpose — being world-readable public metadata — so an existing one that is not
   * readable is a broken discovery chain, not an operator preference worth preserving.
   */
  private async ensureDiscoveryDatabase(): Promise<void> {
    try {
      await this.api.request("PUT", `/${DISCOVERY_DB}`);
    } catch (err) {
      // 412 file_exists — already there, which is the ordinary case after the first apply.
      if (!(err instanceof ApiError && err.status === 412)) throw err;
    }
    await this.api.request("PUT", `/${DISCOVERY_DB}/_security`, {
      admins: { names: [], roles: [] },
      members: { names: [], roles: [] },
    });
  }

  /** `PUT /_node/_local/_config/{section}/{key}` — admin-only, same-origin friendly (D15). */
  private putConfig(section: string, key: string, value: string): Promise<unknown> {
    return this.config.setConfigValue(SINGLE_SERVER_ID, section, key, value);
  }

  /**
   * Appends an activity-log document — **only when `[oidc] log` is on**, which it is not by
   * default (#32). With the flag off this writes nothing at all, so registering an identity
   * provider never creates the `couchcompanion` database as a side effect (D13).
   *
   * Never throws: a failure to record what happened must not turn a successful apply into a
   * reported failure.
   */
  private async writeLog(
    level: IdpLogEntry["level"],
    event: string,
    idpId: string | null,
    idpName: string | null,
    message: string,
  ): Promise<void> {
    try {
      if (!(await this.isLogEnabled())) return;
      const timestamp = new Date().toISOString();
      const id = `${ID_PREFIX.idpLog}${timestamp}~${event}`;
      await this.store.put(id, {
        _id: id,
        timestamp,
        level,
        event,
        idp_id: idpId,
        idp_name: idpName,
        message,
        details: null,
      });
    } catch (err) {
      log.warn("could not record IdP activity log entry", err as Error);
    }
  }
}
