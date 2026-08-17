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

import { ApiError } from "./api-error";
import { getLogger } from "./log-service.js";

const log = getLogger("services/api-client");

/**
 * How a request authenticates, mirroring CouchDB's own handlers (#11).
 *
 * CouchDB offers three: `jwt` (Bearer), `cookie`, and `default` (Basic). The cookie one needs
 * no credential here — `credentials: "include"` makes the browser attach it — so it is
 * represented by the absence of a credential, i.e. `null`.
 *
 * `basic` exists for **non-browser** consumers. Under Node's fetch `credentials: "include"`
 * is inert (there is no cookie jar; a request after a successful `POST /_session` still 401s),
 * so a Node caller could previously reach only a CouchDB with `[jwt_keys]` configured. The
 * browser app must keep using the cookie flow: it never holds a password.
 */
export type CouchCredential =
  | { kind: "bearer"; token: string }
  | { kind: "basic"; username: string; password: string };

/** What a JSON request body is labelled as — the only content type this client serialises. */
const JSON_CONTENT_TYPE = "application/json";

/**
 * What a byte body with no declared type is sent as (#120).
 *
 * A `File` from an `<input type="file">` carries `.type` from the OS's extension mapping, and
 * that mapping has holes: an extension the platform does not know yields `""`. CouchDB stores
 * whatever `Content-Type` the upload carried and hands it straight back on download, so an
 * empty one would make the attachment untyped forever. `application/octet-stream` is what
 * CouchDB itself records when a `PUT` arrives with no `Content-Type` at all (verified against
 * 3.5.2), so this only ever spells out the answer the server would have chosen anyway.
 */
export const DEFAULT_BINARY_CONTENT_TYPE = "application/octet-stream";

/**
 * RFC 7617: the user-pass is encoded as UTF-8 before base64. Bare `btoa` throws above U+00FF,
 * so a non-ASCII password would otherwise fail at the call site rather than being sent.
 */
function basicAuthValue(username: string, password: string): string {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

/**
 * Thin HTTP wrapper — centralises auth headers and error handling so callers don't deal with raw fetch.
 * @param baseUrl - API base URL; defaults to same-origin so the Vite proxy can forward requests
 * @param onUnauthorized - optional callback invoked on 401 errors (except login) for session expiry handling
 */
export class ApiClient {
  private baseUrl: string;
  private credential: CouchCredential | null = null;
  private onUnauthorized?: () => void;
  /** Shares one in-flight session probe across concurrent 401s (see {@link confirmSessionDeadThenLogout}). */
  private authProbe: Promise<void> | null = null;

  constructor(baseUrl: string = "", onUnauthorized?: () => void) {
    this.baseUrl = baseUrl;
    this.onUnauthorized = onUnauthorized;
  }

  /**
   * The headers for one request.
   *
   * `Content-Type` describes a body, so it only rides along when there is one (#36). Sending it
   * on a bodyless GET conveys nothing and costs real latency: it takes the request out of the
   * CORS-simple set, so in SPA mode (app and CouchDB on different origins, spec D5) the browser
   * must send `OPTIONS` before *every* read — doubling the round trips of the deployment mode
   * that already has the highest latency. It is also one more header an operator's `[cors]
   * headers` allowlist has to carry, and a stricter server answers 405 to a preflight naming a
   * header it does not list. Same-origin `/_utils` never preflights, which is why this was
   * invisible for so long.
   *
   * A body decides, not a verb: the CouchDB endpoints that do `validate_ctype` — `POST
   * /_dbs_info`, `POST /{db}`, `_bulk_docs`, `_find`, `_index`, `_session` — are all ones we
   * call with a body, and the two bodyless writes we make (`POST /_node/_local/_restart`,
   * `PUT /{db}`) have handlers that never validate it.
   *
   * `Authorization` is unaffected and keeps riding on every request.
   *
   * The parameter is the content type itself rather than a `hasBody` flag (#120): an attachment
   * upload is a body that is emphatically *not* JSON, and CouchDB stores the `Content-Type` it
   * arrives with and serves it back on download — so the caller with the bytes is the only one
   * that knows what to label them. The #36 rule is unchanged and, if anything, harder to break:
   * a header exists only when a caller passed a type, and a caller passes one only when it has
   * a body to describe.
   *
   * @param contentType - what this request's body is, or `undefined` when it has no body
   */
  private headers(contentType?: string): Record<string, string> {
    const h: Record<string, string> = contentType
      ? { "Content-Type": contentType }
      : {};
    const c = this.credential;
    if (c?.kind === "bearer") {
      h["Authorization"] = `Bearer ${c.token}`;
    } else if (c?.kind === "basic") {
      h["Authorization"] = basicAuthValue(c.username, c.password);
    }
    return h;
  }

  /**
   * Points every subsequent request at a different CouchDB base URL.
   * Same-origin deployments pass the page origin; SPA mode passes the
   * user-chosen server. Trailing slashes are stripped so `${base}${path}`
   * concatenation stays correct.
   */
  setBaseUrl(url: string) {
    this.baseUrl = url.replace(/\/+$/, "");
  }

  /**
   * The base URL every request is currently sent against — the page origin in
   * same-origin mode, or whatever {@link setBaseUrl} last received in SPA mode.
   * Read-only: services need this to synthesize the single virtual server
   * (spec D2/D3) without importing deployment context directly.
   */
  get currentBaseUrl(): string {
    return this.baseUrl;
  }

  /**
   * Unauthenticated CouchDB liveness probe used for deployment-mode detection (spec D5).
   * Never throws; anything that is not a CouchDB answer within the timeout is `false`.
   *
   * Two answers count as "CouchDB is here":
   *
   *  1. **200 with `{status: "ok"}`** — the ordinary case.
   *  2. **401 with CouchDB's `{error: "unauthorized"}` body** — the server is hardened with
   *     `chttpd/require_valid_user = true`, which makes even `/_up` refuse anonymous callers
   *     (verified live against 3.5.2; CouchDB ships `require_valid_user_except_for_up` for
   *     exactly this, but it is off by default and operators do not always set it).
   *
   * Case 2 is #13. Treating that 401 as "not CouchDB" made the app — served from that very
   * server's `/_utils` — decide it was in SPA mode and ask the user to type in a URL for the
   * server they were already looking at. A 401 is stronger evidence than a bare 200: something
   * answered, and it guards its endpoints. The error-body shape is what keeps a foreign SSO
   * wall or reverse proxy from being mistaken for CouchDB.
   *
   * Network failure, timeout, 404 and 500 all still mean `false`.
   */
  async probeUp(baseUrl: string, timeoutMs = 2500): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const resp = await fetch(`${baseUrl.replace(/\/+$/, "")}/_up`, {
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!resp.ok) {
        if (resp.status !== 401) return false;
        const err = await resp.json?.().catch(() => null);
        return (err as { error?: string } | null)?.error === "unauthorized";
      }

      const body = await resp.json().catch(() => null);
      return (body as { status?: string } | null)?.status === "ok";
    } catch {
      return false;
    }
  }

  /**
   * The single HTTP entry point for the whole frontend. Services call this; components call
   * services. Attaches the bearer token, raises {@link ApiError} on a non-2xx response, and
   * triggers the centralised logout on 401 — none of which a raw `fetch` would do.
   *
   * @param method - HTTP verb
   * @param path - absolute API path, already URL-encoded
   * @param body - optional value; JSON-serialised
   * @returns the parsed JSON body, or `undefined` for 204 / empty responses
   * @throws {ApiError} on any non-2xx response
   */
  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const { data } = await this.requestWithHeaders<T>(method, path, body);
    return data;
  }

  /**
   * As {@link request}, but also hands back the response headers. Needed where pagination or
   * caching metadata rides on the headers rather than the body.
   */
  async requestWithHeaders<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ data: T; headers: Headers }> {
    // One expression decides both, so the header can never claim a body that is not there (#36).
    const payload = body ? JSON.stringify(body) : undefined;
    const resp = await this.send(
      method,
      path,
      payload,
      payload !== undefined ? JSON_CONTENT_TYPE : undefined,
    );

    const headers = (resp.headers as Headers | undefined) ?? new Headers();
    const contentLength = headers.get?.("content-length");

    if (resp.status === 204 || contentLength === "0") {
      return { data: undefined as T, headers };
    }

    // Test mocks may provide `json()` but not `text()`/`headers`; support both.
    if (typeof resp.text === "function") {
      const text = await resp.text();
      const data = text ? JSON.parse(text) : undefined;
      return { data, headers };
    }

    if (typeof resp.json === "function") {
      const data = await resp.json();
      return { data, headers };
    }

    return { data: undefined as T, headers };
  }

  /**
   * A request whose **body is bytes** — an attachment upload, and nothing else so far (#120).
   *
   * `PUT /{db}/{docid}/{attname}?rev={rev}` sends the file exactly as the user chose it, so the
   * body must not be `JSON.stringify`d and the `Content-Type` must describe the file rather
   * than claim `application/json`: CouchDB records that header verbatim as the attachment's
   * `content_type` and serves it back on every download, so a wrong one here is a wrong one
   * forever after.
   *
   * The *response* is still JSON — CouchDB answers `{"ok":true,"id":…,"rev":…}` — so only the
   * request half differs from {@link request}. Errors, the 401 session probe and credentials
   * are the shared ones: this goes through the same {@link send} as everything else, which is
   * the point of having a single `fetch` in the codebase.
   *
   * @param method - HTTP verb (`PUT` for an attachment write)
   * @param path - absolute API path, already URL-encoded
   * @param body - the bytes to send, unserialised
   * @param contentType - what those bytes are; defaults to the blob's own type, and to
   *   {@link DEFAULT_BINARY_CONTENT_TYPE} when it has none
   * @returns the parsed JSON body CouchDB answers with
   * @throws {ApiError} on any non-2xx response
   */
  async requestBinary<T>(
    method: string,
    path: string,
    body: Blob,
    contentType?: string,
  ): Promise<T> {
    const resp = await this.send(
      method,
      path,
      body,
      contentType || body.type || DEFAULT_BINARY_CONTENT_TYPE,
    );
    if (typeof resp.text !== "function") return undefined as T;
    const text = await resp.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /**
   * A GET whose **response is bytes** — an attachment download, and nothing else so far (#120).
   *
   * The alternative was a bare `<a href="/{db}/{docid}/{attname}" download>`, which is wrong in
   * every deployment mode this app supports: a browser-initiated navigation carries no
   * `Authorization` header, so a JWT session downloads a 401 error page under the file's name;
   * and in SPA mode (spec D5) the cross-origin navigation is not the app's `fetch` at all, so
   * the CORS and cookie rules it lands under are different again. Reading the bytes through the
   * client that holds the session and handing the resulting blob to the browser is the only
   * path that behaves the same in all three.
   *
   * `GET` only, and deliberately bodyless: a download describes nothing to the server, so it
   * sends no `Content-Type` and stays in the CORS-simple set that #36 is about.
   *
   * @param path - absolute API path, already URL-encoded
   * @returns the response bytes, plus the headers (the blob's own `type` comes from
   *   `Content-Type`, so callers rarely need them)
   * @throws {ApiError} on any non-2xx response
   */
  async requestBlob(
    path: string,
  ): Promise<{ data: Blob; headers: Headers }> {
    const resp = await this.send("GET", path, undefined, undefined);
    const headers = (resp.headers as Headers | undefined) ?? new Headers();
    const data = await resp.blob();
    return { data, headers };
  }

  /**
   * The one `fetch` every request in this file goes through: base URL, credentials, auth
   * header, {@link ApiError} on a non-2xx response, and the D9 session probe on a 401.
   *
   * Split out when binary bodies and blob responses arrived (#120). What varies between the
   * three public entry points is only how the body is serialised on the way out and how it is
   * parsed on the way back; everything between those two ends is identical, and a second copy
   * of it is how one path would quietly stop logging users out or stop reporting CouchDB's
   * `reason`.
   *
   * @returns the response, guaranteed `ok` — a non-2xx one has already been thrown
   */
  private async send(
    method: string,
    path: string,
    body: BodyInit | undefined,
    contentType: string | undefined,
  ): Promise<Response> {
    const resp = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(contentType),
      body,
      credentials: "include",
    });
    if (resp.ok) return resp;

    const err = await resp
      .json()
      .catch(() => ({ reason: resp.statusText || "Request failed" }));
    const apiError = new ApiError(
      resp.status,
      err.reason || err.error || resp.statusText || "Request failed",
      err,
    );

    // A 401 outside /_session is ambiguous: CouchDB 3.5.2 answers 401 (not 403)
    // "You are not a server admin." when an AUTHENTICATED non-admin reads an
    // admin-only endpoint (e.g. _all_dbs, _active_tasks) — exactly what the
    // post-login dashboard does. Confirm the session is actually dead via
    // GET /_session before logging the user out (spec D9); otherwise leave
    // the session alone and just surface the ApiError below.
    if (resp.status === 401 && path !== "/_session" && this.onUnauthorized) {
      await this.confirmSessionDeadThenLogout();
    }

    throw apiError;
  }

  /**
   * A GET made *before* anyone has authenticated, whose 401 carries no information about a
   * session — because there is no session yet.
   *
   * The login screen's IdP discovery (spec §5) is the only caller. It probes `GET /_idp`,
   * which CouchDB 3.5.2 answers **401** rather than 404: every reserved `_`-prefixed
   * top-level path does. Routed through {@link request}, that 401 would trigger
   * {@link confirmSessionDeadThenLogout} — an extra `/_session` round trip and a
   * "Session confirmed expired" warning on every single login page view, describing a session
   * the user never had.
   *
   * Deliberately narrow: same base URL, same credentials, same error type as {@link request}.
   * The *only* difference is that it never engages the centralized logout, which is exactly
   * the thing a pre-auth probe has no business doing.
   *
   * @param path - absolute API path, already URL-encoded
   * @throws {ApiError} on any non-2xx response
   */
  async requestPreAuth<T>(path: string): Promise<T> {
    const resp = await fetch(`${this.baseUrl}${path}`, {
      method: "GET",
      headers: this.headers(),
      credentials: "include",
    });
    if (!resp.ok) {
      const err = await resp
        .json()
        .catch(() => ({ reason: resp.statusText || "Request failed" }));
      throw new ApiError(
        resp.status,
        err.reason || err.error || resp.statusText || "Request failed",
        err,
      );
    }
    const text = typeof resp.text === "function" ? await resp.text() : null;
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /**
   * Confirms a 401 really means "session expired" before invoking {@link onUnauthorized}.
   * Issues a bare `fetch` GET `/_session` — deliberately not routed through
   * {@link request}/{@link requestWithHeaders} so this probe can never re-enter this
   * 401-handling branch. Several 401s arriving together share one in-flight probe.
   */
  private confirmSessionDeadThenLogout(): Promise<void> {
    if (!this.authProbe) {
      this.authProbe = this.probeSessionAndMaybeLogout().finally(() => {
        this.authProbe = null;
      });
    }
    return this.authProbe;
  }

  private async probeSessionAndMaybeLogout(): Promise<void> {
    let alive = false;
    try {
      const resp = await fetch(`${this.baseUrl}/_session`, {
        headers: this.headers(),
        credentials: "include",
      });
      if (resp.ok) {
        const body = await resp.json().catch(() => null);
        alive = !!(body as { userCtx?: { name?: string | null } } | null)?.userCtx
          ?.name;
      }
      // A non-ok probe response (including 401) means the session is dead too.
    } catch {
      alive = false;
    }
    if (!alive) {
      log.warn(
        "Session confirmed expired via /_session probe, invoking logout handler",
      );
      this.onUnauthorized?.();
    }
  }

  /**
   * Sets or clears the credential attached to every subsequent request, replacing whatever
   * was there — the client never sends two schemes.
   *
   * `null` means "no Authorization header", which is the browser's cookie-session path: the
   * cookie rides along via `credentials: "include"`.
   *
   * **`basic` is for non-browser callers** (the E2E harness against a CouchDB with no IdP).
   * The browser app must not use it — it authenticates with `POST /_session` and never holds
   * a password in memory. See {@link CouchCredential}.
   */
  setCredential(credential: CouchCredential | null) {
    this.credential = credential;
  }

  /**
   * Sets or clears the bearer token attached to every subsequent request. A thin wrapper over
   * {@link setCredential} — kept so Phase 6's JWT login and its call sites are untouched.
   * @param token - JWT string, or null to remove authentication
   */
  setToken(token: string | null) {
    this.setCredential(token === null ? null : { kind: "bearer", token });
  }
}
