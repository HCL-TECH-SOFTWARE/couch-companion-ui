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
 * Which origins an identity provider needs the browser to be allowed to reach (#149).
 *
 * A separate module from `csp-policy.ts`, which owns CSP *syntax*, for two reasons. This is
 * domain knowledge about OIDC — which endpoints are fetched and which are navigated to — and it
 * says nothing about policies. And it is reached from the eager graph: `context.ts` constructs
 * `IdpService`, which reaches `oidc-ini.ts`, so anything these functions import is downloaded
 * before first paint. Putting them in `csp-policy.ts` measurably did that — 4,335 raw / 1,532
 * gzip of policy parser on the critical path, which `scripts/bundle-budget.mjs` is there to
 * notice (#150).
 */

/** Origins of the URLs given, in order, de-duplicated. Anything unparseable is skipped, not guessed. */
function uniqueOrigins(urls: (string | null | undefined)[]): string[] {
  const origins: string[] = [];
  for (const url of urls) {
    const trimmed = url?.trim();
    if (!trimmed) continue;
    let origin: string;
    try {
      origin = new URL(trimmed).origin;
    } catch {
      continue;
    }
    if (!origins.includes(origin)) origins.push(origin);
  }
  return origins;
}

/**
 * The origins ONE identity provider needs on `connect-src`, computed from its discovery document
 * at registration — the only moment every one of them is known (#149).
 *
 * THREE FETCHES LEAVE THE BROWSER FOR AN IDP, AND THEY NEED NOT SHARE A HOST. Discovery and JWKS
 * go through `fetchJson`, the PKCE code exchange through `postForm`. Google's live document, read
 * while writing this:
 *
 *     issuer          https://accounts.google.com
 *     jwks_uri        https://www.googleapis.com
 *     token_endpoint  https://oauth2.googleapis.com
 *
 * A policy built from the issuer alone therefore permits one of three, and sign-in dies at the
 * token exchange with nothing in the network tab — the invisible failure this whole feature
 * exists to prevent.
 *
 * `authorization_endpoint` and `end_session_endpoint` are deliberately absent. Those are top-level
 * navigations (`location.assign`), which `connect-src` does not govern; listing them would widen
 * the policy for requests that never happen. A bogus entry in a CSP is worse than a missing one.
 */
export function idpConnectOrigins(discovery: {
  well_known_url?: string | null;
  jwks_uri?: string | null;
  token_endpoint?: string | null;
}): string[] {
  return uniqueOrigins([discovery.well_known_url, discovery.jwks_uri, discovery.token_endpoint]);
}

/**
 * The union across every configured provider — what `connect-src` must permit for single sign-on
 * to work at all.
 *
 * `csp_origins` is written at registration and rewritten at every refresh. An entry from before
 * that field existed carries none, and the other two endpoints cannot be recovered without
 * re-reading the discovery document over the network — from a screen whose entire problem may be
 * that the network is what the policy is blocking. So a legacy entry contributes the one origin it
 * can prove, its `well_known_url`, and a refresh fills in the rest. Partial and honest beats
 * complete and guessed.
 */
export function requiredIdpOrigins(
  idps: { csp_origins?: string[] | null; well_known_url?: string | null }[]
): string[] {
  const origins: string[] = [];
  for (const idp of idps) {
    const stored = Array.isArray(idp.csp_origins) ? idp.csp_origins : [];
    const contributed = stored.length > 0 ? uniqueOrigins(stored) : uniqueOrigins([idp.well_known_url]);
    for (const origin of contributed) {
      if (!origins.includes(origin)) origins.push(origin);
    }
  }
  return origins;
}

/**
 * What may safely come back out of `connect-src` when one provider goes away: the origins it
 * contributed, minus everything still required by the providers that remain (#149).
 *
 * The subtraction is the whole point. Two providers on one host — a Keycloak realm per tenant, an
 * issuer and its own jwks on the same domain — are ordinary, and removing the second one's origin
 * because the first was deleted would break a working login silently, which is the same class of
 * bug as never adding it.
 */
export function releasableIdpOrigins(
  removed: { csp_origins?: string[] | null; well_known_url?: string | null },
  remaining: { csp_origins?: string[] | null; well_known_url?: string | null }[]
): string[] {
  const stillNeeded = requiredIdpOrigins(remaining);
  return requiredIdpOrigins([removed]).filter((origin) => !stillNeeded.includes(origin));
}
