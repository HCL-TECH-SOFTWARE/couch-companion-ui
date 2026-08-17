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

import { describe, it, expect, vi, beforeEach } from "vitest";
import { AuthService, CrossSiteSessionError } from "../src/services/auth-service";
import { ApiError } from "../src/services/api-error";
import type { ApiClient } from "../src/services/api-client";
import type { Deployment } from "../src/services/deployment-mode";
import { STORAGE_KEY as RECENT_SERVERS_KEY } from "../src/services/recent-servers";

const USER_KEY = "cca_user";
const sameOrigin: Deployment = { mode: "same-origin", baseUrl: "http://couch.local" };
const spa: Deployment = { mode: "spa", baseUrl: "" };

const fakeApi = () =>
  ({ request: vi.fn(), setBaseUrl: vi.fn(), setToken: vi.fn() }) as unknown as ApiClient & {
    request: ReturnType<typeof vi.fn>;
    setBaseUrl: ReturnType<typeof vi.fn>;
    setToken: ReturnType<typeof vi.fn>;
  };

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});

describe("state", () => {
  it("starts unauthenticated with empty roles", () => {
    const svc = new AuthService(fakeApi(), () => sameOrigin);
    expect(svc.state).toEqual({ authenticated: false, username: null, companionServer: null, roles: [], kind: "cookie" });
    expect(svc.isAdmin).toBe(false);
  });

  it("derives from the stored user JSON", () => {
    sessionStorage.setItem(USER_KEY, JSON.stringify({ name: "kai", roles: ["_admin"], companionServer: "http://couch.local" }));
    const svc = new AuthService(fakeApi(), () => sameOrigin);
    // A stored user written before Phase 6 carries no `kind`; it is a cookie session by
    // construction, and must keep working across the upgrade.
    expect(svc.state).toEqual({ authenticated: true, username: "kai", companionServer: "http://couch.local", roles: ["_admin"], kind: "cookie" });
    expect(svc.isAdmin).toBe(true);
  });

  it("treats corrupted storage as logged out", () => {
    sessionStorage.setItem(USER_KEY, "{not json");
    expect(new AuthService(fakeApi(), () => sameOrigin).state.authenticated).toBe(false);
  });

  it("treats a stored user missing roles/companionServer as logged out (fails closed)", () => {
    sessionStorage.setItem(USER_KEY, JSON.stringify({ name: "x" }));
    expect(new AuthService(fakeApi(), () => sameOrigin).state.authenticated).toBe(false);
  });
});

describe("login", () => {
  it("same-origin: POSTs /_session, stores user+roles, notifies", async () => {
    const api = fakeApi();
    api.request.mockResolvedValue({ ok: true, name: "kai", roles: ["user"] });
    const svc = new AuthService(api, () => sameOrigin);
    const seen: unknown[] = [];
    svc.subscribe((s) => seen.push(s));
    await svc.login("ignored-in-same-origin", "kai", "pw");
    expect(api.setBaseUrl).toHaveBeenCalledWith("http://couch.local");
    expect(api.request).toHaveBeenCalledWith("POST", "/_session", { name: "kai", password: "pw" });
    expect(JSON.parse(sessionStorage.getItem(USER_KEY)!)).toEqual({ name: "kai", roles: ["user"], companionServer: "http://couch.local" });
    expect(seen).toHaveLength(1);
    expect(svc.state.roles).toEqual(["user"]);
  });

  it("spa: normalizes the server, points the client at it, records the MRU", async () => {
    const api = fakeApi();
    api.request
      .mockResolvedValueOnce({ ok: true, name: "kai", roles: [] })
      .mockResolvedValueOnce({ ok: true, userCtx: { name: "kai", roles: [] } });
    const svc = new AuthService(api, () => spa);
    await svc.login("http://db.example:5984///", "kai", "pw");
    expect(api.setBaseUrl).toHaveBeenCalledWith("http://db.example:5984");
    expect(svc.state.companionServer).toBe("http://db.example:5984");
    const mru = JSON.parse(localStorage.getItem(RECENT_SERVERS_KEY)!);
    expect(mru[0].url).toBe("http://db.example:5984");
  });

  it("failure propagates and leaves state clean", async () => {
    const api = fakeApi();
    api.request.mockRejectedValue(new ApiError(401, "Name or password is incorrect."));
    const svc = new AuthService(api, () => sameOrigin);
    await expect(svc.login("", "kai", "bad")).rejects.toBeInstanceOf(ApiError);
    expect(svc.state.authenticated).toBe(false);
    expect(sessionStorage.getItem(USER_KEY)).toBeNull();
  });

  it("non-admin users may log in (D9)", async () => {
    const api = fakeApi();
    api.request.mockResolvedValue({ ok: true, name: "demo", roles: [] });
    const svc = new AuthService(api, () => sameOrigin);
    await svc.login("", "demo", "pw");
    expect(svc.state.authenticated).toBe(true);
    expect(svc.isAdmin).toBe(false);
  });
});

/**
 * Issue #35. In SPA mode the CouchDB session cookie is a cross-site cookie: unless CouchDB
 * marks it `SameSite=None; Secure`, the browser accepts the 200 from POST /_session and then
 * drops the cookie. Without the confirming read the app declares victory, the next request
 * 401s, and the user is bounced back to this same form as if the password had been wrong.
 */
describe("login: cross-site cookie confirmation", () => {
  it("spa: an anonymous confirming GET /_session rejects with the cross-site diagnosis", async () => {
    const api = fakeApi();
    api.request
      .mockResolvedValueOnce({ ok: true, name: "kai", roles: ["user"] }) // POST — CouchDB is happy
      .mockResolvedValueOnce({ ok: true, userCtx: { name: null, roles: [] } }); // GET — cookie gone
    const svc = new AuthService(api, () => spa);
    const seen: unknown[] = [];
    svc.subscribe((s) => seen.push(s));

    await expect(svc.login("http://db.example:5984", "kai", "pw")).rejects.toBeInstanceOf(
      CrossSiteSessionError,
    );

    expect(api.request).toHaveBeenNthCalledWith(2, "GET", "/_session");
    // Nothing may survive a login that did not actually take.
    expect(sessionStorage.getItem(USER_KEY)).toBeNull();
    expect(svc.state.authenticated).toBe(false);
    expect(seen).toHaveLength(0);
    expect(localStorage.getItem(RECENT_SERVERS_KEY)).toBeNull();
  });

  it("spa: names both causes and the docs, since the app cannot tell them apart", async () => {
    const api = fakeApi();
    api.request
      .mockResolvedValueOnce({ ok: true, name: "kai", roles: [] })
      .mockResolvedValueOnce({ ok: true, userCtx: { name: null, roles: [] } });
    const svc = new AuthService(api, () => spa);

    const err = await svc.login("http://db.example:5984", "kai", "pw").catch((e: unknown) => e);

    const message = (err as Error).message;
    expect(message).toContain("same_site"); // cause (a): not set at all
    expect(message).toContain("Secure"); // cause (b): set to none, but behind a TLS-terminating proxy
    expect(message).toContain("docs/install.md");
  });

  it("spa: a confirmed session logs in exactly as before", async () => {
    const api = fakeApi();
    api.request
      .mockResolvedValueOnce({ ok: true, name: "kai", roles: ["user"] })
      .mockResolvedValueOnce({ ok: true, userCtx: { name: "kai", roles: ["user"] } });
    const svc = new AuthService(api, () => spa);
    const seen: unknown[] = [];
    svc.subscribe((s) => seen.push(s));

    await svc.login("http://db.example:5984", "kai", "pw");

    expect(JSON.parse(sessionStorage.getItem(USER_KEY)!)).toEqual({
      name: "kai",
      roles: ["user"],
      companionServer: "http://db.example:5984",
    });
    expect(seen).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem(RECENT_SERVERS_KEY)!)[0].url).toBe(
      "http://db.example:5984",
    );
  });

  it("same-origin: issues no confirming GET — there is no cross-site cookie to lose", async () => {
    const api = fakeApi();
    api.request.mockResolvedValue({ ok: true, name: "kai", roles: ["user"] });
    const svc = new AuthService(api, () => sameOrigin);

    await svc.login("", "kai", "pw");

    expect(api.request).toHaveBeenCalledTimes(1);
    expect(api.request).not.toHaveBeenCalledWith("GET", "/_session");
    expect(svc.state.authenticated).toBe(true);
  });
});

describe("logout", () => {
  it("DELETEs the session, clears storage, notifies — and never throws", async () => {
    const api = fakeApi();
    api.request.mockResolvedValueOnce({ ok: true, name: "kai", roles: [] });
    const svc = new AuthService(api, () => sameOrigin);
    await svc.login("", "kai", "pw");
    api.request.mockRejectedValue(new ApiError(401, "gone"));
    const seen: unknown[] = [];
    svc.subscribe(() => seen.push(1));
    expect(() => svc.logout()).not.toThrow();
    expect(api.request).toHaveBeenLastCalledWith("DELETE", "/_session");
    expect(sessionStorage.getItem(USER_KEY)).toBeNull();
    expect(seen).toHaveLength(1);
    await Promise.resolve(); // rejected DELETE must not surface
  });
});

describe("restore", () => {
  it("same-origin with a live cookie: adopts the session", async () => {
    const api = fakeApi();
    api.request.mockResolvedValue({ ok: true, userCtx: { name: "kai", roles: ["_admin"] } });
    const svc = new AuthService(api, () => sameOrigin);
    await svc.restore();
    expect(api.request).toHaveBeenCalledWith("GET", "/_session");
    expect(svc.state).toMatchObject({ authenticated: true, username: "kai", roles: ["_admin"] });
  });

  it("anonymous userCtx clears any stale stored user", async () => {
    sessionStorage.setItem(USER_KEY, JSON.stringify({ name: "old", roles: [], companionServer: "http://couch.local" }));
    const api = fakeApi();
    api.request.mockResolvedValue({ ok: true, userCtx: { name: null, roles: [] } });
    const svc = new AuthService(api, () => sameOrigin);
    await svc.restore();
    expect(svc.state.authenticated).toBe(false);
  });

  it("spa with no stored user does nothing (no network)", async () => {
    const api = fakeApi();
    const svc = new AuthService(api, () => spa);
    await svc.restore();
    expect(api.request).not.toHaveBeenCalled();
  });

  it("spa with a stored user re-points the client then validates", async () => {
    sessionStorage.setItem(USER_KEY, JSON.stringify({ name: "kai", roles: [], companionServer: "http://db.example:5984" }));
    const api = fakeApi();
    api.request.mockResolvedValue({ ok: true, userCtx: { name: "kai", roles: [] } });
    const svc = new AuthService(api, () => spa);
    await svc.restore();
    expect(api.setBaseUrl).toHaveBeenCalledWith("http://db.example:5984");
    expect(svc.state.authenticated).toBe(true);
  });

  it("network failure clears state instead of throwing", async () => {
    sessionStorage.setItem(USER_KEY, JSON.stringify({ name: "kai", roles: [], companionServer: "http://couch.local" }));
    const api = fakeApi();
    api.request.mockRejectedValue(new TypeError("net down"));
    const svc = new AuthService(api, () => sameOrigin);
    await expect(svc.restore()).resolves.toBeUndefined();
    expect(svc.state.authenticated).toBe(false);
  });
});
