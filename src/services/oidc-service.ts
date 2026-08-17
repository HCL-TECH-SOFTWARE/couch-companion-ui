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
 * OIDC authorization-code + PKCE, in the browser (spec D8/§5).
 *
 * This is a public client: no secret exists anywhere in this system, so the `code_verifier`
 * is the only thing binding the redirect back to the app that started it. Two consequences
 * drive the whole file:
 *
 *  - The verifier never leaves `sessionStorage` except in the token-exchange body. The
 *    authorize URL carries only its SHA-256 (RFC 7636 §4.2).
 *  - An attempt is SINGLE-USE. It is cleared the moment a callback is consumed, on every
 *    path — success, forged state, IdP error, failed exchange. A verifier that survives a
 *    failure could authorise the next callback to arrive, which is exactly what PKCE exists
 *    to prevent (P6-9).
 *
 * No refresh tokens and no renewal timer (D14). Expiry surfaces as a CouchDB 401 and rides
 * the centralized logout ApiClient already owns.
 *
 * The second half of the file is the sign-out mirror (#24): a redirect to the provider's
 * `end_session_endpoint` so the session ends *there* too, not just here. It keeps no token —
 * see {@link RpLogout} for why there is no `id_token_hint`.
 */

import { fetchJson, postForm } from './oidc-http.js';
import type { DiscoveredIdp } from './idp-discovery.js';
import { getLogger } from './log-service.js';

const log = getLogger('services/oidc-service');

/** The single session-storage key this file owns. Holds an in-flight attempt, never a token. */
const ATTEMPT_KEY = 'cca_oidc_attempt';

/**
 * Survives the login callback and lasts as long as the session does: the two public values an
 * RP-initiated logout needs (#24). No token, no claim, nothing that authenticates anyone — an
 * endpoint URL the provider publishes to the world, and the client id of a public PKCE client.
 */
const RP_LOGOUT_KEY = 'cca_oidc_logout';

/** One in-flight logout round trip's `state`, held exactly as long as the trip lasts (#24). */
const RP_LOGOUT_STATE_KEY = 'cca_oidc_logout_state';

/** The endpoints a PKCE flow needs, after discovery or the §5 explicit overrides. */
export interface OidcEndpoints {
  authorization_endpoint: string;
  token_endpoint: string;
  /**
   * Where a sign-out redirect goes (#24). `null` is an ordinary answer, not a failure: plenty
   * of providers publish no `end_session_endpoint` at all, and the logout dialog then offers no
   * "log out everywhere" choice rather than a control that leads to a 404.
   */
  end_session_endpoint: string | null;
}

/**
 * What it takes to end the session at the identity provider, kept for the life of the local
 * session (#24).
 *
 * **No `id_token_hint`.** Retaining the ID token purely to populate that parameter would mean
 * holding a credential for no other purpose; it is optional in OpenID Connect RP-Initiated
 * Logout 1.0 §2, and the accepted trade is that a provider may ask the user which session to
 * end. `client_id` is what stands in for it — verified against Keycloak 26, which answers a
 * request carrying neither with **400 "Missing parameters: id_token_hint"**, and answers one
 * carrying `client_id` with the 302 to `post_logout_redirect_uri`.
 */
export interface RpLogout {
  end_session_endpoint: string;
  client_id: string;
}

/**
 * One in-flight login. Carries everything `completeLogin` needs, because the redirect may
 * return to a freshly loaded page where nothing else is in memory.
 */
interface Attempt {
  verifier: string;
  state: string;
  nonce: string;
  clientId: string;
  tokenEndpoint: string;
  redirectUri: string;
  /** Carried through the redirect so a successful exchange can record it; see {@link RpLogout}. */
  endSessionEndpoint: string | null;
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 32 random bytes → 43 base64url chars, the low end of RFC 7636 §4.1's legal range. */
function randomToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/**
 * The redirect URI to register with the IdP and send on both legs of the flow.
 *
 * Query and hash are stripped: the value must be byte-identical in the authorize request and
 * the token exchange (RFC 6749 §4.1.3), and it has to match what an operator registered.
 * A hash route or a leftover `?code=` from a previous attempt would break both.
 */
export function redirectUriFor(href: string): string {
  const url = new URL(href);
  url.search = '';
  url.hash = '';
  return url.toString();
}

/** The parameters an authorization server sends back, and the only ones stripped. */
const CALLBACK_PARAMS = ['code', 'state', 'error', 'error_description', 'error_uri', 'session_state', 'iss'];

/**
 * The current URL with the OAuth callback parameters removed and everything else — including
 * the hash route — intact (§5: "the callback handler consumes and strips it").
 *
 * Feeding this to `history.replaceState` keeps the authorization code out of history, out of
 * bookmarks, and out of any later `location.href` read, without costing the user their route.
 */
export function urlWithoutCallbackParams(href: string): string {
  const url = new URL(href);
  for (const param of CALLBACK_PARAMS) url.searchParams.delete(param);
  return url.toString();
}

/**
 * Whether the current URL is an OAuth callback that must be consumed before the app boots.
 * An error callback counts — it also carries `state` and must clear the attempt.
 */
export function callbackPending(search: string): boolean {
  const p = new URLSearchParams(search);
  return p.has('state') && (p.has('code') || p.has('error'));
}

function readAttempt(): Attempt | null {
  const raw = sessionStorage.getItem(ATTEMPT_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Attempt;
    return typeof parsed?.verifier === 'string' && typeof parsed?.state === 'string'
      ? parsed
      : null;
  } catch {
    return null;
  }
}

/**
 * Resolves the authorize, token and end-session endpoints for an IdP.
 *
 * The §5 `authorization_endpoint`/`token_endpoint` fields exist precisely for providers whose
 * well-known document is not CORS-readable, so when both are present the discovery fetch is
 * skipped outright — fetching it would be the failure the overrides were added to avoid. That
 * path therefore reports only the `end_session_endpoint` the entry itself declares: fetching
 * the document just to look for a *nice-to-have* would reintroduce exactly the failure the
 * overrides exist to dodge, and a missing one costs nothing but the logout checkbox.
 *
 * @throws if neither the overrides nor a reachable well-known document yield both endpoints
 */
export async function resolveEndpoints(idp: DiscoveredIdp): Promise<OidcEndpoints> {
  if (idp.authorization_endpoint && idp.token_endpoint) {
    return {
      authorization_endpoint: idp.authorization_endpoint,
      token_endpoint: idp.token_endpoint,
      end_session_endpoint: idp.end_session_endpoint,
    };
  }

  if (!idp.well_known_url) {
    throw new Error(
      `${idp.name} has no well-known URL and does not declare both endpoints explicitly.`,
    );
  }

  const doc = await fetchJson<{
    authorization_endpoint?: unknown;
    token_endpoint?: unknown;
    end_session_endpoint?: unknown;
  }>(idp.well_known_url);

  const authorize =
    idp.authorization_endpoint ??
    (typeof doc?.authorization_endpoint === 'string' ? doc.authorization_endpoint : null);
  const token =
    idp.token_endpoint ??
    (typeof doc?.token_endpoint === 'string' ? doc.token_endpoint : null);
  const endSession =
    idp.end_session_endpoint ??
    (typeof doc?.end_session_endpoint === 'string' ? doc.end_session_endpoint : null);

  if (!authorize || !token) {
    throw new Error(
      `${idp.name}'s discovery document is missing an authorization or token endpoint.`,
    );
  }
  return {
    authorization_endpoint: authorize,
    token_endpoint: token,
    end_session_endpoint: endSession,
  };
}

/**
 * Starts a login: mints a fresh verifier/state/nonce, persists them, and redirects to the
 * IdP's authorization endpoint.
 *
 * @param idp - the discovered IdP (§5 shape)
 * @param endpoints - resolved authorize/token endpoints
 * @param redirectUri - from {@link redirectUriFor}
 * @param redirect - navigation, injected so tests observe the URL instead of leaving the page
 */
export async function beginLogin(
  idp: DiscoveredIdp,
  endpoints: OidcEndpoints,
  redirectUri: string,
  redirect: (url: string) => void = (url) => window.location.assign(url),
): Promise<void> {
  const attempt: Attempt = {
    verifier: randomToken(),
    state: randomToken(),
    nonce: randomToken(),
    clientId: idp.client_id,
    tokenEndpoint: endpoints.token_endpoint,
    redirectUri,
    endSessionEndpoint: endpoints.end_session_endpoint,
  };
  sessionStorage.setItem(ATTEMPT_KEY, JSON.stringify(attempt));

  // `openid` is what makes this OIDC rather than bare OAuth; an IdP entry that omits it is a
  // configuration slip, not a request to do something else.
  const scopes = idp.scopes.includes('openid') ? idp.scopes : ['openid', ...idp.scopes];

  const url = new URL(endpoints.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', attempt.clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', scopes.join(' '));
  url.searchParams.set('state', attempt.state);
  url.searchParams.set('nonce', attempt.nonce);
  url.searchParams.set('code_challenge', await s256(attempt.verifier));
  url.searchParams.set('code_challenge_method', 'S256');

  log.debug?.(`starting PKCE login with ${idp.name}`);
  redirect(url.toString());
}

/**
 * Consumes an OAuth callback and returns the access token.
 *
 * The attempt is cleared before anything is validated, so every exit from this function —
 * including a throw — leaves no reusable verifier behind.
 *
 * @param search - `window.location.search` at boot
 * @returns the JWT to hand to `AuthService.loginWithToken`
 * @throws if no attempt is in flight, the state does not match, the IdP reported an error,
 *   or the exchange yields no `access_token`
 */
export async function completeLogin(search: string): Promise<string> {
  const attempt = readAttempt();
  sessionStorage.removeItem(ATTEMPT_KEY);

  if (!attempt) {
    throw new Error(
      'No login attempt is in flight — this callback did not originate from this tab.',
    );
  }

  const params = new URLSearchParams(search);

  if (params.get('state') !== attempt.state) {
    throw new Error('The login callback state did not match the attempt this tab started.');
  }

  const error = params.get('error');
  if (error) {
    const detail = params.get('error_description');
    throw new Error(detail ? `${error}: ${detail}` : error);
  }

  const code = params.get('code');
  if (!code) {
    throw new Error('The login callback carried no authorization code.');
  }

  const token = await postForm<{ access_token?: string }>(attempt.tokenEndpoint, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: attempt.redirectUri,
    client_id: attempt.clientId,
    code_verifier: attempt.verifier,
  });

  if (!token?.access_token) {
    throw new Error('The identity provider returned no access_token.');
  }
  rememberRpLogout(attempt);
  return token.access_token;
}

/** Drops any in-flight attempt — used when the user abandons the login screen. */
export function abandonLogin(): void {
  sessionStorage.removeItem(ATTEMPT_KEY);
}

/**
 * Records what a later logout would need, or clears the record when this provider published no
 * `end_session_endpoint` (#24).
 *
 * Clearing matters as much as writing. The logout dialog renders its "Full logout from IdP"
 * checkbox from the presence of this record and nothing else, so a leftover from a *previous*
 * provider would offer a round trip to an endpoint the current session has no business at.
 */
function rememberRpLogout(attempt: Attempt): void {
  if (!attempt.endSessionEndpoint) {
    sessionStorage.removeItem(RP_LOGOUT_KEY);
    return;
  }
  const logout: RpLogout = {
    end_session_endpoint: attempt.endSessionEndpoint,
    client_id: attempt.clientId,
  };
  sessionStorage.setItem(RP_LOGOUT_KEY, JSON.stringify(logout));
}

/**
 * The IdP session this browser could end, or `null` when there is none to end.
 *
 * `null` covers every case that is not "signed in through a provider that publishes an
 * `end_session_endpoint`": a cookie session, a pasted token, and a PKCE session with a provider
 * that advertises no such endpoint. All three must render the plain confirm with no checkbox,
 * and they are indistinguishable here on purpose — the caller needs one question answered, not
 * three.
 */
export function readRpLogout(): RpLogout | null {
  const raw = sessionStorage.getItem(RP_LOGOUT_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as RpLogout;
    return typeof parsed?.end_session_endpoint === 'string' &&
      typeof parsed?.client_id === 'string'
      ? parsed
      : null;
  } catch {
    return null;
  }
}

/**
 * Forgets the IdP session — called by `AuthService` wherever a session ends, including the
 * centralized 401 logout, so a stale record can never outlive the session it described.
 *
 * Deliberately leaves {@link RP_LOGOUT_STATE_KEY} alone: local teardown happens *before* the
 * redirect leaves the page (see {@link beginRpLogout}), so at that moment the logout state is
 * already minted and still needed.
 */
export function forgetRpLogout(): void {
  sessionStorage.removeItem(RP_LOGOUT_KEY);
}

/**
 * Builds and follows the RP-initiated logout redirect (OpenID Connect RP-Initiated Logout 1.0
 * §2), the sign-out mirror of {@link beginLogin}.
 *
 * **Local teardown must already have happened when this is called.** A logout that leaves the
 * page is not guaranteed to come back — the provider may refuse the request, the user may close
 * the tab at the confirmation screen — and a local session that survives that is the very
 * "log out didn't work" this exists to fix. Ending the local session first costs nothing if the
 * round trip does complete, and is the whole difference if it does not.
 *
 * `state` is minted and stored the same way the login attempt's is, and checked on the way back
 * by {@link completeLogout}.
 *
 * @param logout - from {@link readRpLogout}, read *before* teardown forgot it
 * @param postLogoutRedirectUri - from {@link redirectUriFor}; must be pre-registered with the
 *   provider exactly like the login `redirect_uri` (Keycloak answers an unregistered one 400)
 * @param redirect - navigation, injected so tests observe the URL instead of leaving the page
 */
export function beginRpLogout(
  logout: RpLogout,
  postLogoutRedirectUri: string,
  redirect: (url: string) => void = (url) => window.location.assign(url),
): void {
  const state = randomToken();
  sessionStorage.setItem(RP_LOGOUT_STATE_KEY, state);

  const url = new URL(logout.end_session_endpoint);
  url.searchParams.set('post_logout_redirect_uri', postLogoutRedirectUri);
  // Stands in for the id_token_hint this app deliberately cannot supply; see {@link RpLogout}.
  url.searchParams.set('client_id', logout.client_id);
  url.searchParams.set('state', state);

  log.debug?.('starting RP-initiated logout');
  redirect(url.toString());
}

/**
 * Whether a logout round trip left this tab and has not been consumed yet.
 *
 * Takes no URL on purpose. The provider's return leg carries `state` and nothing else — no
 * `code`, no `error` — so it is invisible to {@link callbackPending}, and the only thing that
 * can say a return is expected is the state this tab stored on its way out.
 */
export function logoutReturnPending(): boolean {
  return sessionStorage.getItem(RP_LOGOUT_STATE_KEY) !== null;
}

/**
 * Consumes the return leg. Single-use like the login attempt: the stored state is dropped on
 * every path, so a stale one can never validate a later arrival.
 *
 * @param search - `window.location.search` at boot
 * @returns whether the returned `state` matched the round trip this tab started
 */
export function completeLogout(search: string): boolean {
  const expected = sessionStorage.getItem(RP_LOGOUT_STATE_KEY);
  sessionStorage.removeItem(RP_LOGOUT_STATE_KEY);
  return expected !== null && new URLSearchParams(search).get('state') === expected;
}
