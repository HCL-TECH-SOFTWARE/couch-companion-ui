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
 * One identity provider as the screens see it, assembled from the node config's `[oidc]` and
 * `[jwt_keys]` sections (#32).
 *
 * `_id` is the provider's **issuer**: metadata is stored once per signing key, so the issuer is
 * what identifies the provider those entries describe.
 */
export interface IdpConfig {
  _id: string;
  name: string;
  issuer: string;
  well_known_url: string;
  client_id: string | null;
  roles_claim: string;
  /** Whether the login screen offers this provider *instead of* the password form (#119). */
  idp_only: boolean;
  jwks_keys: JwkKey[];
  last_refreshed: string | null;
  created_at: string;
}

/**
 * A discovery document, as read. **Not persisted** (#119): `IdpService.discover()` returns one
 * in memory during registration, which is where `issuer` and `jwks_uri` come from, and it is
 * discarded once the signing keys are written. Anything that needs an endpoint later re-reads
 * `well_known_url` rather than trusting a stored copy.
 */
export interface OidcDiscovery {
  issuer: string;
  jwks_uri: string;
  authorization_endpoint: string | null;
  token_endpoint: string | null;
  /** Where a sign-out redirect goes; carried for #24. */
  end_session_endpoint: string | null;
  supported_algorithms: string[];
}

export interface JwkKey {
  kid: string;
  kty: string;
  alg: string;
  value: string;
  /**
   * Whether CouchDB's `[jwt_keys]` currently holds the twin `rsa:<kid>` entry. Absent on a key
   * that was just fetched from the IdP and not yet written.
   */
  installed?: boolean;
}

export interface IdpServer {
  id: string;
  name: string;
}

export interface IdpLogEntry {
  _id: string;
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  event: string;
  idp_id: string | null;
  idp_name: string | null;
  message: string;
  details: unknown | null;
}
