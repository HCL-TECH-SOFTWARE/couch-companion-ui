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

import { describe, it, expect, vi } from "vitest";
import { discoverIdps } from "../src/services/idp-discovery";
import { ApiError } from "../src/services/api-error";
import type { ApiClient } from "../src/services/api-client";

const IDP = {
  name: "Dev Keycloak",
  issuer: "http://localhost:8080/realms/couch",
  client_id: "couch-companion-ui",
  well_known_url: "http://localhost:8080/realms/couch/.well-known/openid-configuration",
  authorization_endpoint: null,
  token_endpoint: null,
  end_session_endpoint: null,
  scopes: ["openid", "profile", "email"],
  roles_claim: "roles",
  idp_only: false,
};

// Discovery reads via `requestPreAuth`, not `request`: it runs on the login screen with no
// session, and CouchDB answers the reserved `/_idp` path with 401, which the ordinary path
// would treat as an expired session.
const apiWith = (routes: Record<string, unknown | Error>) =>
  ({
    requestPreAuth: vi.fn((path: string) => {
      const hit = routes[path];
      if (hit === undefined) return Promise.reject(new ApiError(404, "not_found"));
      if (hit instanceof Error) return Promise.reject(hit);
      return Promise.resolve(hit);
    }),
  }) as unknown as ApiClient;

describe("discoverIdps", () => {
  it("prefers the native /_idp endpoint", async () => {
    const api = apiWith({ "/_idp": { idps: [IDP] }, "/_session": { info: { authentication_handlers: ["jwt", "cookie", "default"] } } });
    const d = await discoverIdps(api);
    expect(d.source).toBe("_idp");
    expect(d.idps).toEqual([IDP]);
    expect(d.jwtHandlerEnabled).toBe(true);
  });

  it("falls back to the idp/config document and strips CouchDB doc fields", async () => {
    const api = apiWith({
      "/idp/config": { _id: "config", _rev: "1-abc", idps: [IDP] },
      "/_session": { info: { authentication_handlers: ["cookie", "default"] } },
    });
    const d = await discoverIdps(api);
    expect(d.source).toBe("idp/config");
    expect(d.idps).toEqual([IDP]);
    expect(d.jwtHandlerEnabled).toBe(false);
  });

  it("returns none when neither source answers", async () => {
    const d = await discoverIdps(apiWith({}));
    expect(d).toEqual({ idps: [], source: "none", jwtHandlerEnabled: false });
  });

  it("drops malformed entries and fills defaulted fields", async () => {
    const api = apiWith({
      "/_idp": { idps: [{ name: "ok", issuer: "https://i", client_id: "c" }, { name: "no-issuer" }, "junk"] },
      "/_session": {},
    });
    const d = await discoverIdps(api);
    expect(d.idps).toEqual([
      {
        name: "ok", issuer: "https://i", client_id: "c",
        well_known_url: null, authorization_endpoint: null, token_endpoint: null,
        end_session_endpoint: null,
        scopes: ["openid", "profile", "email"], roles_claim: null,
        idp_only: false,
      },
    ]);
  });

  /**
   * The slim document #119 publishes carries none of the endpoint overrides, so the fallbacks
   * above are now the ordinary path rather than the exception — and `scopes` in particular is
   * `.includes()`-ed unguarded by `beginLogin`, so it must never come back undefined.
   */
  it("fills the endpoint and scope fallbacks for a slim #119 entry", async () => {
    const api = apiWith({
      "/_idp": {
        idps: [
          {
            name: "Slim",
            issuer: "https://i",
            client_id: "c",
            well_known_url: "https://i/.well-known/openid-configuration",
            roles_claim: "roles",
            idp_only: true,
          },
        ],
      },
      "/_session": {},
    });
    const d = await discoverIdps(api);
    expect(d.idps[0].scopes).toEqual(["openid", "profile", "email"]);
    expect(d.idps[0].authorization_endpoint).toBeNull();
    expect(d.idps[0].token_endpoint).toBeNull();
    expect(d.idps[0].end_session_endpoint).toBeNull();
    expect(d.idps[0].idp_only).toBe(true);
  });

  /**
   * The hand-edited escape hatch (#24): an operator whose provider is not CORS-readable can
   * name the logout endpoint here, and it must survive normalization to reach `resolveEndpoints`.
   */
  it("keeps a hand-written end_session_endpoint", async () => {
    const api = apiWith({
      "/_idp": {
        idps: [
          {
            name: "Hand-edited",
            issuer: "https://i",
            client_id: "c",
            end_session_endpoint: "https://i/protocol/openid-connect/logout",
          },
        ],
      },
      "/_session": {},
    });
    const d = await discoverIdps(api);
    expect(d.idps[0].end_session_endpoint).toBe("https://i/protocol/openid-connect/logout");
  });

  /** Hiding the password form must take a real boolean, never a truthy-looking string. */
  it("defaults idp_only to false for anything that is not boolean true", async () => {
    for (const idp_only of [undefined, "true", 1]) {
      const api = apiWith({
        "/_idp": { idps: [{ name: "n", issuer: "https://i", client_id: "c", idp_only }] },
        "/_session": {},
      });
      const d = await discoverIdps(api);
      expect(d.idps[0].idp_only).toBe(false);
    }
  });

  it("network errors on the chain degrade silently to none", async () => {
    const api = apiWith({ "/_idp": new TypeError("net"), "/idp/config": new TypeError("net") });
    const d = await discoverIdps(api);
    expect(d.source).toBe("none");
  });

  /**
   * The `rsa:<kid>` key format (#32) writes one discovery entry per signing key, so a
   * provider that rotated to a second key is published twice with identical metadata.
   * Rendering that as two login buttons would be a bug the operator has no way to fix from
   * the UI, so `discoverIdps` de-duplicates by `issuer` regardless of which source answered.
   */
  it("de-duplicates two entries that share an issuer, keeping the first", async () => {
    const rotated = { ...IDP, well_known_url: "https://second-kid-published-again" };
    const api = apiWith({
      "/_idp": { idps: [IDP, rotated] },
      "/_session": { info: { authentication_handlers: ["jwt", "cookie", "default"] } },
    });
    const d = await discoverIdps(api);
    expect(d.idps).toEqual([IDP]);
  });
});
