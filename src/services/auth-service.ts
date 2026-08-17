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
import type { Deployment } from "./deployment-mode";
import type { SessionResponse } from "../types/api";
import { recordRecentServer } from "./recent-servers.js";
import { forgetRpLogout } from "./oidc-service.js";
import { getLogger } from "./log-service.js";

const log = getLogger("services/auth-service");

// The two session-storage keys this file owns (see eslint SESSION_KEY_LITERALS).
const USER_KEY = "cca_user";
const TOKEN_KEY = "cca_token";

/** How the current session authenticates. Absent in stored users written before Phase 6,
 *  which are cookie sessions by construction — hence `?? "cookie"` on every read. */
export type SessionKind = "cookie" | "jwt";

interface StoredUser {
  name: string;
  roles: string[];
  companionServer: string;
  kind?: SessionKind;
}

export interface AuthState {
  authenticated: boolean;
  username: string | null;
  companionServer: string | null;
  roles: string[];
  kind: SessionKind;
}

/**
 * CouchDB authenticated the credentials, but the browser refused to keep the session cookie
 * (issue #35). Its own class so the login screen can show the diagnosis instead of collapsing
 * it into "Unable to connect to server" — the credentials were fine, and saying otherwise sends
 * the operator hunting for a password problem that does not exist.
 */
export class CrossSiteSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CrossSiteSessionError";
  }
}

/**
 * Both causes, in one message, because the app genuinely cannot tell them apart: `Set-Cookie`
 * is `HttpOnly` and arrives cross-origin, so nothing in the browser will say which attribute
 * was missing. Naming only one of them would send half of the readers down the wrong path.
 */
const CROSS_SITE_DIAGNOSIS =
  "CouchDB accepted the sign-in, but the browser discarded the session cookie. " +
  "The app and CouchDB are on different sites, so that cookie has to carry both " +
  "SameSite=None and Secure. Either [chttpd_auth] same_site is unset, or it is none " +
  "while CouchDB sits behind a TLS-terminating proxy and so never emits Secure. Which " +
  "of the two is not visible from here — the cookie is HttpOnly and cross-origin. " +
  "docs/install.md covers both, including the proxy-side fix.";

/**
 * Reads the payload of a JWT without verifying it — CouchDB is the verifier, and this app
 * only wants a human-readable name out of it (P6-4). Returns null for anything unparseable;
 * a malformed token is not an error here, it just means falling back to `userCtx.name`.
 */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const segments = token.split(".");
  if (segments.length !== 3) return null;
  try {
    const base64 = segments[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const parsed: unknown = JSON.parse(atob(padded));
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * The name to show as "signed in as".
 *
 * CouchDB's `jwt_authentication_handler` sets `userCtx.name` to the JWT's `sub` claim — a
 * Keycloak UUID, not a username. Preferring the token's own human claims is P6-4.
 */
function displayName(payload: Record<string, unknown> | null, fallback: string): string {
  for (const claim of ["preferred_username", "name", "email"]) {
    const value = payload?.[claim];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return fallback;
}

/**
 * CouchDB-native session auth (spec D8/D9): cookie `_session` login against
 * the deployment's base URL. Any valid CouchDB user may log in — admin-only
 * screens gate on `roles`/`isAdmin`, not on login. The cookie itself is
 * HttpOnly; sessionStorage mirrors only the user identity for synchronous
 * `state` reads, and `restore()` re-validates it against GET /_session.
 */
export class AuthService {
  private listeners = new Set<(state: AuthState) => void>();

  constructor(
    private readonly api: ApiClient,
    private readonly deployment: () => Deployment,
  ) {}

  get state(): AuthState {
    const stored = this.readUser();
    return stored
      ? {
          authenticated: true,
          username: stored.name,
          companionServer: stored.companionServer,
          roles: stored.roles,
          kind: stored.kind ?? "cookie",
        }
      : {
          authenticated: false,
          username: null,
          companionServer: null,
          roles: [],
          kind: "cookie",
        };
  }

  get roles(): string[] {
    return this.state.roles;
  }

  get isAdmin(): boolean {
    return this.state.roles.includes("_admin");
  }

  subscribe(listener: (state: AuthState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Cookie login via POST /_session. In same-origin mode the target is the
   * page origin and `companionServer` is ignored; in SPA mode the (normalized)
   * argument becomes the client base and lands in the recent-servers MRU.
   *
   * A 200 from POST /_session only says CouchDB liked the password; in SPA mode it does not
   * say the browser kept the cookie, so that mode confirms the session before declaring
   * victory (see {@link confirmCrossSiteSession}).
   *
   * @throws {CrossSiteSessionError} in SPA mode when the session does not round-trip
   */
  async login(companionServer: string, username: string, password: string): Promise<void> {
    const dep = this.deployment();
    const target =
      dep.mode === "same-origin" ? dep.baseUrl : companionServer.trim().replace(/\/+$/, "");
    this.api.setBaseUrl(target);
    const resp = await this.api.request<SessionResponse>("POST", "/_session", {
      name: username,
      password,
    });
    if (dep.mode === "spa") {
      await this.confirmCrossSiteSession();
      recordRecentServer(target);
    }
    this.writeUser({
      name: resp?.name ?? username,
      roles: resp?.roles ?? [],
      companionServer: target,
    });
    this.notify();
  }

  /**
   * SPA mode only (spec D5): the session cookie is a cross-site cookie, and the browser drops
   * it silently unless CouchDB marks it `SameSite=None; Secure`. Left undetected, the login
   * reports success, the first real request 401s, and `confirmSessionDeadThenLogout` bounces
   * the user back to the form — indistinguishable from a wrong password (issue #35).
   *
   * This asserts *behaviour*, not configuration: reading `[chttpd_auth] same_site` would report
   * a healthy `none` in exactly the broken case where a TLS-terminating proxy stops CouchDB
   * ever emitting `Secure`. A session that round-trips is the only proof that survives both.
   *
   * The drop-in has no cross-site cookie, so it never pays for this extra round trip.
   */
  private async confirmCrossSiteSession(): Promise<void> {
    const resp = await this.api.request<SessionResponse>("GET", "/_session");
    if (!resp?.userCtx?.name) {
      throw new CrossSiteSessionError(CROSS_SITE_DIAGNOSIS);
    }
  }

  /**
   * Bearer login (spec D8/§5): attaches a JWT obtained by the PKCE flow, then confirms
   * CouchDB actually accepts it by reading `GET /_session`. Roles come from CouchDB, never
   * from the token's own claims — the token can say anything, CouchDB decides.
   *
   * Ending this session locally does not by itself end it at the identity provider; the logout
   * dialog offers the RP-initiated round trip that does (#24), and `oidc-service.ts` owns it.
   *
   * @param token - the access token from {@link completeLogin}
   * @throws if CouchDB does not recognise the token, leaving the user logged out
   */
  async loginWithToken(token: string): Promise<void> {
    this.api.setToken(token);
    try {
      const resp = await this.api.request<SessionResponse>("GET", "/_session");
      const couchName = resp?.userCtx?.name ?? null;
      if (!couchName) {
        throw new Error("CouchDB did not accept the identity provider's token.");
      }
      sessionStorage.setItem(TOKEN_KEY, token);
      this.writeUser({
        name: displayName(decodeJwtPayload(token), couchName),
        roles: resp?.userCtx?.roles ?? [],
        companionServer: this.deployment().baseUrl,
        kind: "jwt",
      });
    } catch (err) {
      this.clearSession();
      throw err;
    }
    this.notify();
  }

  /**
   * Clears the local session synchronously and best-effort deletes the
   * server-side cookie session. Never throws, never navigates — the auth
   * subscription swaps the UI (a hard nav here broke /_utils hosting).
   *
   * A JWT session has no server-side cookie, so the DELETE is skipped: it would 401 and log
   * noise for a session that was never there.
   *
   * Ending the session at the identity provider is a *redirect*, so it cannot happen here — see
   * the "never navigates" above. `cca-logout-dialog.ts` asks, and `cca-shell.ts` performs it
   * after this has run (#24).
   */
  logout(): void {
    if (this.state.kind === "cookie") {
      void this.api.request("DELETE", "/_session").catch((err) => {
        log.warn("session delete failed (ignored)", err as Error);
      });
    }
    this.clearSession();
    this.notify();
  }

  /**
   * Boot-time re-validation of the cookie session against GET /_session.
   * Same-origin always checks (a cookie may exist from a previous visit);
   * SPA mode checks only when a stored user names the server to ask.
   * Does not notify — bootstrap reads `state` synchronously afterwards.
   */
  async restore(): Promise<void> {
    const dep = this.deployment();
    const stored = this.readUser();
    if (dep.mode === "spa") {
      if (!stored) return;
      this.api.setBaseUrl(stored.companionServer);
    }

    // A JWT session authenticates by header, not cookie, so the token has to be back on the
    // client before the probe — otherwise the probe 401s and logs the user out on every boot.
    const kind: SessionKind = stored?.kind ?? "cookie";
    const token = kind === "jwt" ? sessionStorage.getItem(TOKEN_KEY) : null;
    if (kind === "jwt") {
      if (!token) {
        this.clearSession();
        return;
      }
      this.api.setToken(token);
    }

    try {
      const resp = await this.api.request<SessionResponse>("GET", "/_session");
      const name = resp?.userCtx?.name ?? null;
      if (name) {
        this.writeUser({
          name: kind === "jwt" ? displayName(decodeJwtPayload(token!), name) : name,
          roles: resp?.userCtx?.roles ?? [],
          companionServer: dep.mode === "same-origin" ? dep.baseUrl : stored!.companionServer,
          kind,
        });
      } else if (kind === "jwt") {
        this.clearSession();
      } else {
        this.clearUser();
      }
    } catch (err) {
      log.warn("session restore failed", err as Error);
      if (kind === "jwt") {
        this.clearSession();
      } else {
        this.clearUser();
      }
    }
  }

  /**
   * Drops a session everywhere this app holds one: the client header, storage, the stored user,
   * and the identity provider this browser could have signed out of (#24).
   *
   * The single teardown point on purpose. Every way a session can end — the user asking, a
   * rejected token, a failed restore, ApiClient's centralized 401 — arrives here, so none of
   * them can leave a fragment of the last session behind for the next one to inherit.
   */
  private clearSession(): void {
    this.api.setToken(null);
    sessionStorage.removeItem(TOKEN_KEY);
    forgetRpLogout();
    this.clearUser();
  }

  private notify() {
    const snapshot = this.state;
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  private readUser(): StoredUser | null {
    const raw = sessionStorage.getItem(USER_KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as StoredUser;
      const valid =
        typeof parsed?.name === "string" &&
        Array.isArray(parsed?.roles) &&
        typeof parsed?.companionServer === "string";
      return valid ? parsed : null;
    } catch {
      return null;
    }
  }

  private writeUser(user: StoredUser) {
    sessionStorage.setItem(USER_KEY, JSON.stringify(user));
  }

  private clearUser() {
    sessionStorage.removeItem(USER_KEY);
  }
}
