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

import type { E2eEnv } from './env.js';

/**
 * Obtains a JWT for the admin user via a Keycloak Resource Owner Password Credentials grant —
 * the devcontainer's `couch-companion-ui` client is public with `directAccessGrantsEnabled: true`
 * (`.devcontainer/keycloak-realm.json`), so no client secret is involved.
 *
 * Used only in `CCA_E2E_AUTH_MODE=jwt` (the default). It requires CouchDB's `[jwt_keys]` to be
 * wired to this same Keycloak realm, which `scripts/seed-dev.sh` does — so a JWT minted here is
 * one CouchDB actually accepts, through the real Bearer path the product uses in production, not
 * a test-only shortcut. Against a CouchDB with no IdP, use `CCA_E2E_AUTH_MODE=basic` instead;
 * `credentials: "include"` remains unusable either way, being inert under Node's fetch (#11).
 *
 * Known quirk (documented, not fixed here): CouchDB's `jwt_authentication_handler` sets
 * `userCtx.name` to the JWT's `sub` claim — a Keycloak UUID — not to "hariseldon".
 */
export async function fetchAdminJwt(
  env: Pick<E2eEnv, 'keycloakUrl' | 'keycloakRealm' | 'keycloakClientId' | 'adminUser' | 'adminPassword'>,
): Promise<string> {
  const tokenUrl =
    `${env.keycloakUrl.replace(/\/+$/, '')}/realms/${encodeURIComponent(env.keycloakRealm)}` +
    '/protocol/openid-connect/token';

  const body = new URLSearchParams({
    grant_type: 'password',
    client_id: env.keycloakClientId,
    username: env.adminUser,
    password: env.adminPassword,
    scope: 'openid',
  });

  const resp = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!resp.ok) {
    // The token endpoint's error body may itself echo `password`/`client_id` back — surface only
    // the HTTP status, never the response body, so a misconfigured grant can't leak input.
    throw new Error(`Keycloak password grant failed: ${resp.status} ${resp.statusText}`);
  }

  const data = (await resp.json()) as { access_token?: string };
  if (!data.access_token) {
    throw new Error('Keycloak token response had no access_token.');
  }
  return data.access_token;
}
