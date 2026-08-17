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
 * Env-var plumbing for the real-GitHub/real-CouchDB E2E suite (see `.env.example` for the full,
 * documented list). Split from the test file so `describe.skipIf` can make its decision
 * synchronously, before any network call — a credential-absent run must SKIP, never fail, and
 * never quietly hang trying to reach a service it was never given the address of.
 */

/** Required AND non-empty — a blank value is no credential at all. No sane default exists for
 *  any of them (a token, a specific repository, a specific CouchDB). */
const REQUIRED_NONEMPTY = [
  'CCA_E2E_GIT_TOKEN',
  'CCA_E2E_GIT_REPO',
  'CCA_E2E_COUCH_URL',
] as const;

/**
 * Required to be PRESENT, but legally empty — empty is a meaningful value, not an omission.
 *
 * Fixed here: this used to sit in one `REQUIRED` list whose check rejected `''` alongside
 * `undefined`, while its own comment claimed "presence — not truthiness — is what `REQUIRED`
 * actually needs". The code did the opposite of the comment, and `.env.example` tells the
 * reader to "leave empty to target github.com" — so following the documented instructions
 * made the whole suite skip with "CCA_E2E_GIT_BASE_URL is not set". Nobody could run these
 * tests against github.com, only against Enterprise.
 */
const REQUIRED_PRESENT = ['CCA_E2E_GIT_BASE_URL'] as const;

/**
 * How the harness authenticates against CouchDB (#11).
 *
 * `jwt` (the default) mints a token from the devcontainer Keycloak. `basic` skips Keycloak
 * entirely and sends `Authorization: Basic` — the only way to run against a CouchDB with no
 * `[jwt_keys]`, which is most of them.
 */
export type E2eAuthMode = 'jwt' | 'basic';

export interface E2eEnv {
  gitToken: string;
  gitRepo: string;
  /** Enterprise host, or `null` for github.com. */
  gitBaseUrl: string | null;
  /** Userinfo-stripped — see {@link sanitizeCouchUrl}. */
  couchUrl: string;
  authMode: E2eAuthMode;
  keycloakUrl: string;
  keycloakRealm: string;
  keycloakClientId: string;
  adminUser: string;
  adminPassword: string;
}

/**
 * The first required variable that is missing, or `null` when the run is configured.
 *
 * Two rules, because one does not fit: {@link REQUIRED_PRESENT} needs only to exist (empty is
 * a real value there), while {@link REQUIRED_NONEMPTY} must also be non-blank. In
 * `CCA_E2E_AUTH_MODE=basic` the CouchDB account is required too — see below.
 */
export function missingVar(): string | null {
  // Non-empty first: on a completely unconfigured machine the useful thing to name is a
  // credential, not the Enterprise-host switch.
  const missing = REQUIRED_NONEMPTY.find(
    (name) => process.env[name] === undefined || process.env[name] === '',
  );
  if (missing) return missing;

  const absent = REQUIRED_PRESENT.find((name) => process.env[name] === undefined);
  if (absent) return absent;

  // `basic` mode has no sane default for who to log in as — the devcontainer's
  // `hariseldon`/`password` is a Keycloak identity, not a CouchDB one, so silently defaulting
  // to it would fail with "Name or password is incorrect" against any real server. Requiring
  // both explicitly keeps a credential-absent run a visible SKIP rather than a failure.
  if (authMode() === 'basic') {
    return (
      (['CCA_E2E_ADMIN_USER', 'CCA_E2E_ADMIN_PASSWORD'] as const).find(
        (name) => process.env[name] === undefined || process.env[name] === '',
      ) ?? null
    );
  }
  return null;
}

/** `CCA_E2E_AUTH_MODE`, defaulting to `jwt` so existing devcontainer runs are unchanged. */
export function authMode(): E2eAuthMode {
  const raw = (process.env.CCA_E2E_AUTH_MODE ?? 'jwt').trim().toLowerCase();
  if (raw !== 'jwt' && raw !== 'basic') {
    throw new Error(
      `CCA_E2E_AUTH_MODE must be "jwt" or "basic" (got "${raw}"). See .env.example.`,
    );
  }
  return raw;
}

export function hasCredentials(): boolean {
  return missingVar() === null;
}

/**
 * Strips embedded `user:pass@` userinfo from a CouchDB URL. Node's `fetch` throws
 * "Request cannot be constructed from a URL that includes credentials" the instant it sees one —
 * confirmed against this Node runtime — so a URL copied from a `curl -u` habit must never reach
 * `ApiClient` verbatim. Userinfo here is inert input, never a credential the harness acts on:
 * an account belongs in `CCA_E2E_ADMIN_USER`/`CCA_E2E_ADMIN_PASSWORD` with
 * `CCA_E2E_AUTH_MODE=basic` (#11).
 */
export function sanitizeCouchUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return url.replace(/\/\/[^@/]+@/, '//').replace(/\/+$/, '');
  }
}

/** Throws {@link missingVar}'s message if credentials are absent — callers that reach this point
 *  (inside a `describe.skipIf`-guarded suite) are expected to already know they won't. */
export function loadEnv(): E2eEnv {
  const missing = missingVar();
  if (missing) {
    throw new Error(`E2E env not configured: ${missing} is not set. See .env.example.`);
  }
  const rawBaseUrl = process.env.CCA_E2E_GIT_BASE_URL ?? '';
  return {
    gitToken: process.env.CCA_E2E_GIT_TOKEN!,
    gitRepo: process.env.CCA_E2E_GIT_REPO!,
    gitBaseUrl: rawBaseUrl.trim() === '' ? null : rawBaseUrl.trim(),
    couchUrl: sanitizeCouchUrl(process.env.CCA_E2E_COUCH_URL!),
    authMode: authMode(),
    keycloakUrl: process.env.CCA_E2E_KEYCLOAK_URL ?? 'http://localhost:8080',
    keycloakRealm: process.env.CCA_E2E_KEYCLOAK_REALM ?? 'couch',
    keycloakClientId: process.env.CCA_E2E_KEYCLOAK_CLIENT_ID ?? 'couch-companion-ui',
    adminUser: process.env.CCA_E2E_ADMIN_USER ?? 'hariseldon',
    adminPassword: process.env.CCA_E2E_ADMIN_PASSWORD ?? 'password',
  };
}
