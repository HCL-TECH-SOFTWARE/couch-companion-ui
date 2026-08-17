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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  beginLogin,
  beginRpLogout,
  completeLogin,
  completeLogout,
  callbackPending,
  forgetRpLogout,
  logoutReturnPending,
  readRpLogout,
  redirectUriFor,
  resolveEndpoints,
  urlWithoutCallbackParams,
  type OidcEndpoints,
} from '../src/services/oidc-service';
import type { DiscoveredIdp } from '../src/services/idp-discovery';
import { jsonResponse } from './helpers/response';

const IDP: DiscoveredIdp = {
  name: 'Dev Keycloak',
  issuer: 'http://localhost:8080/realms/couch',
  client_id: 'couch-companion-ui',
  well_known_url: 'http://localhost:8080/realms/couch/.well-known/openid-configuration',
  authorization_endpoint: null,
  token_endpoint: null,
  end_session_endpoint: null,
  scopes: ['openid', 'profile', 'email'],
  roles_claim: 'roles',
  idp_only: false,
};

const ENDPOINTS: OidcEndpoints = {
  authorization_endpoint: 'http://localhost:8080/realms/couch/protocol/openid-connect/auth',
  token_endpoint: 'http://localhost:8080/realms/couch/protocol/openid-connect/token',
  end_session_endpoint: null,
};

/** The same provider, but one that publishes an `end_session_endpoint` (#24). */
const LOGOUT_ENDPOINT = 'http://localhost:8080/realms/couch/protocol/openid-connect/logout';
const ENDPOINTS_WITH_LOGOUT: OidcEndpoints = {
  ...ENDPOINTS,
  end_session_endpoint: LOGOUT_ENDPOINT,
};

const originalFetch = globalThis.fetch;
let redirected: string[];

beforeEach(() => {
  sessionStorage.clear();
  redirected = [];
  // Plain assignment, never vi.spyOn: spying leaves a call-through wrapper that a later
  // `globalThis.fetch = …` in a test does not displace, and the token exchange then hits the
  // real devcontainer Keycloak — which answers `invalid_grant` and looks like a code bug.
  globalThis.fetch = vi.fn().mockRejectedValue(new Error('unexpected network call in test'));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  sessionStorage.clear();
});

const redirect = (url: string) => {
  redirected.push(url);
};

function authorizeParams(): URLSearchParams {
  expect(redirected).toHaveLength(1);
  return new URL(redirected[0]).searchParams;
}

describe('beginLogin', () => {
  it('redirects to the authorization endpoint', async () => {
    await beginLogin(IDP, ENDPOINTS, 'http://app.example/', redirect);

    expect(redirected[0].startsWith(ENDPOINTS.authorization_endpoint)).toBe(true);
  });

  it('requests an authorization code for the public client', async () => {
    await beginLogin(IDP, ENDPOINTS, 'http://app.example/', redirect);

    const p = authorizeParams();
    expect(p.get('response_type')).toBe('code');
    expect(p.get('client_id')).toBe('couch-companion-ui');
    expect(p.get('redirect_uri')).toBe('http://app.example/');
  });

  it('sends an S256 challenge, never the raw verifier', async () => {
    await beginLogin(IDP, ENDPOINTS, 'http://app.example/', redirect);

    const p = authorizeParams();
    expect(p.get('code_challenge_method')).toBe('S256');
    const challenge = p.get('code_challenge')!;
    expect(challenge).toMatch(/^[A-Za-z0-9\-_]+$/); // base64url, no padding
    expect(redirected[0]).not.toContain('code_verifier');
  });

  it('derives the challenge as base64url(SHA-256(verifier))', async () => {
    await beginLogin(IDP, ENDPOINTS, 'http://app.example/', redirect);

    // Recompute from the stored verifier — this is the one property PKCE actually rests on.
    const stored = JSON.parse(sessionStorage.getItem('cca_oidc_attempt')!);
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(stored.verifier),
    );
    const expected = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    expect(authorizeParams().get('code_challenge')).toBe(expected);
  });

  it('stores a verifier of legal PKCE length (RFC 7636: 43-128 chars)', async () => {
    await beginLogin(IDP, ENDPOINTS, 'http://app.example/', redirect);

    const { verifier } = JSON.parse(sessionStorage.getItem('cca_oidc_attempt')!);
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
  });

  it('generates a fresh verifier and state per attempt', async () => {
    await beginLogin(IDP, ENDPOINTS, 'http://app.example/', redirect);
    const first = JSON.parse(sessionStorage.getItem('cca_oidc_attempt')!);

    await beginLogin(IDP, ENDPOINTS, 'http://app.example/', redirect);
    const second = JSON.parse(sessionStorage.getItem('cca_oidc_attempt')!);

    expect(second.verifier).not.toBe(first.verifier);
    expect(second.state).not.toBe(first.state);
  });

  it('asks for the scopes the IdP declared', async () => {
    await beginLogin(IDP, ENDPOINTS, 'http://app.example/', redirect);

    expect(authorizeParams().get('scope')).toBe('openid profile email');
  });

  it('always requests openid even when the IdP omits it', async () => {
    await beginLogin({ ...IDP, scopes: ['profile'] }, ENDPOINTS, 'http://app.example/', redirect);

    expect(authorizeParams().get('scope')!.split(' ')).toContain('openid');
  });
});

describe('callbackPending', () => {
  it('is true only when both code and state are present', () => {
    expect(callbackPending('?code=abc&state=xyz')).toBe(true);
    expect(callbackPending('?code=abc')).toBe(false);
    expect(callbackPending('?state=xyz')).toBe(false);
    expect(callbackPending('')).toBe(false);
  });

  it('is true for an IdP error callback, which also needs consuming', () => {
    expect(callbackPending('?error=access_denied&state=xyz')).toBe(true);
  });
});

describe('completeLogin', () => {
  async function startAttempt() {
    await beginLogin(IDP, ENDPOINTS, 'http://app.example/', redirect);
    return JSON.parse(sessionStorage.getItem('cca_oidc_attempt')!);
  }

  it('exchanges the code for an access token', async () => {
    const { state } = await startAttempt();
    globalThis.fetch = vi.fn().mockImplementation(async () =>
      jsonResponse({ access_token: 'the-jwt', token_type: 'Bearer' }),
    );

    await expect(completeLogin(`?code=the-code&state=${state}`)).resolves.toBe('the-jwt');
  });

  it('sends the verifier and never the challenge', async () => {
    const attempt = await startAttempt();
    const spy = vi.fn().mockImplementation(async () => jsonResponse({ access_token: 'the-jwt' }));
    globalThis.fetch = spy;

    await completeLogin(`?code=the-code&state=${attempt.state}`);

    const body = spy.mock.calls[0][1].body as URLSearchParams;
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('the-code');
    expect(body.get('code_verifier')).toBe(attempt.verifier);
    expect(body.get('redirect_uri')).toBe('http://app.example/');
    expect(body.get('code_challenge')).toBeNull();
  });

  it('refuses a callback whose state does not match the attempt', async () => {
    await startAttempt();

    await expect(completeLogin('?code=the-code&state=forged')).rejects.toThrow(/state/i);
  });

  it('refuses a callback when no attempt is in flight', async () => {
    await expect(completeLogin('?code=the-code&state=whatever')).rejects.toThrow();
  });

  it('surfaces an IdP error callback', async () => {
    const { state } = await startAttempt();

    await expect(completeLogin(`?error=access_denied&state=${state}`)).rejects.toThrow(
      /access_denied/,
    );
  });

  it('clears the attempt after success, so a verifier is single-use', async () => {
    const { state } = await startAttempt();
    globalThis.fetch = vi.fn().mockImplementation(async () =>
      jsonResponse({ access_token: 'the-jwt' }),
    );

    await completeLogin(`?code=the-code&state=${state}`);

    expect(sessionStorage.getItem('cca_oidc_attempt')).toBeNull();
  });

  it('clears the attempt after a state mismatch, so a stale attempt cannot authorise a later callback', async () => {
    await startAttempt();

    await expect(completeLogin('?code=the-code&state=forged')).rejects.toThrow();

    expect(sessionStorage.getItem('cca_oidc_attempt')).toBeNull();
  });

  it('clears the attempt after a failed token exchange', async () => {
    const { state } = await startAttempt();
    globalThis.fetch = vi.fn().mockImplementation(async () =>
      jsonResponse({ error: 'invalid_grant' }, 400),
    );

    await expect(completeLogin(`?code=the-code&state=${state}`)).rejects.toThrow();

    expect(sessionStorage.getItem('cca_oidc_attempt')).toBeNull();
  });

  it('rejects a token response carrying no access token', async () => {
    const { state } = await startAttempt();
    globalThis.fetch = vi.fn().mockImplementation(async () =>
      jsonResponse({ token_type: 'Bearer' }),
    );

    await expect(completeLogin(`?code=the-code&state=${state}`)).rejects.toThrow(/access_token/);
  });
});

describe('resolveEndpoints', () => {
  const wellKnown = (extra: Record<string, unknown> = {}) =>
    vi.fn().mockImplementation(async () =>
      jsonResponse({
        authorization_endpoint: ENDPOINTS.authorization_endpoint,
        token_endpoint: ENDPOINTS.token_endpoint,
        ...extra,
      }),
    );

  it('reads both endpoints from the well-known document', async () => {
    globalThis.fetch = wellKnown();

    await expect(resolveEndpoints(IDP)).resolves.toEqual(ENDPOINTS);
  });

  /** §5: explicit endpoints exist for IdPs whose well-known document is not CORS-readable,
   *  so they must win outright — and skip the fetch entirely. */
  it('prefers explicit overrides and does not fetch at all', async () => {
    const spy = wellKnown();
    globalThis.fetch = spy;

    await expect(
      resolveEndpoints({
        ...IDP,
        authorization_endpoint: 'https://override.example/auth',
        token_endpoint: 'https://override.example/token',
      }),
    ).resolves.toEqual({
      authorization_endpoint: 'https://override.example/auth',
      token_endpoint: 'https://override.example/token',
      end_session_endpoint: null,
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it('still fetches when only one override is given', async () => {
    const spy = wellKnown();
    globalThis.fetch = spy;

    const resolved = await resolveEndpoints({
      ...IDP,
      authorization_endpoint: 'https://override.example/auth',
    });

    expect(spy).toHaveBeenCalled();
    expect(resolved.authorization_endpoint).toBe('https://override.example/auth');
    expect(resolved.token_endpoint).toBe(ENDPOINTS.token_endpoint);
  });

  it('rejects an IdP with no well_known_url and incomplete overrides', async () => {
    await expect(
      resolveEndpoints({ ...IDP, well_known_url: null }),
    ).rejects.toThrow(/well[- ]known/i);
  });

  it('rejects a well-known document missing the endpoints', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async () => jsonResponse({ issuer: IDP.issuer }));

    await expect(resolveEndpoints(IDP)).rejects.toThrow(/endpoint/i);
  });

  // #24. The `[oidc]` ini section deliberately stores no endpoints (#119), so discovery is the
  // only place this can come from on an app-written entry.
  it('reads end_session_endpoint from the well-known document', async () => {
    globalThis.fetch = wellKnown({ end_session_endpoint: LOGOUT_ENDPOINT });

    await expect(resolveEndpoints(IDP)).resolves.toEqual(ENDPOINTS_WITH_LOGOUT);
  });

  /** Absent is the ordinary case for a large share of providers, and must not be an error. */
  it('reports a null end_session_endpoint when the provider publishes none', async () => {
    globalThis.fetch = wellKnown();

    await expect(resolveEndpoints(IDP)).resolves.toMatchObject({ end_session_endpoint: null });
  });

  /** The paste-JWKS / no-CORS escape hatch: a hand-written entry may name it itself. */
  it('honours an explicit end_session_endpoint on the discovery entry', async () => {
    globalThis.fetch = wellKnown({ end_session_endpoint: 'https://ignored.example/logout' });

    const resolved = await resolveEndpoints({
      ...IDP,
      end_session_endpoint: 'https://override.example/logout',
    });

    expect(resolved.end_session_endpoint).toBe('https://override.example/logout');
  });

  /**
   * The overrides exist because the well-known document is unreachable, so this path must not
   * fetch it just to look for a nice-to-have. No endpoint simply means no logout checkbox.
   */
  it('leaves end_session_endpoint null on the no-fetch override path', async () => {
    const spy = wellKnown({ end_session_endpoint: LOGOUT_ENDPOINT });
    globalThis.fetch = spy;

    const resolved = await resolveEndpoints({
      ...IDP,
      authorization_endpoint: 'https://override.example/auth',
      token_endpoint: 'https://override.example/token',
    });

    expect(resolved.end_session_endpoint).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('urlWithoutCallbackParams', () => {
  /** §5: "the OAuth `?code=&state=` query coexists with hash routing; the callback handler
   *  consumes and strips it". Stripping must not cost the user their route. */
  it('strips the OAuth query but keeps the hash route', () => {
    expect(
      urlWithoutCallbackParams('http://app.example/_utils/?code=abc&state=xyz#/databases/foo'),
    ).toBe('http://app.example/_utils/#/databases/foo');
  });

  it('keeps unrelated query parameters', () => {
    expect(urlWithoutCallbackParams('http://app.example/?debug=1&code=abc&state=xyz')).toBe(
      'http://app.example/?debug=1',
    );
  });

  it('strips an error callback too', () => {
    expect(
      urlWithoutCallbackParams('http://app.example/?error=access_denied&error_description=no&state=x'),
    ).toBe('http://app.example/');
  });

  it('leaves a URL with no callback params alone', () => {
    expect(urlWithoutCallbackParams('http://app.example/#/databases')).toBe(
      'http://app.example/#/databases',
    );
  });
});

describe('redirectUriFor', () => {
  it('drops any existing query and hash so the IdP sees a stable, registered URI', () => {
    expect(redirectUriFor('http://app.example/_utils/?code=old#/databases')).toBe(
      'http://app.example/_utils/',
    );
  });

  it('keeps the deployment path, which is what gets registered with the IdP', () => {
    expect(redirectUriFor('http://localhost:5984/_utils/index.html')).toBe(
      'http://localhost:5984/_utils/index.html',
    );
  });
});

/**
 * RP-initiated logout (#24) — the sign-out mirror of the PKCE login above.
 *
 * The capture half is asserted through the real `beginLogin`/`completeLogin` pair rather than
 * by writing sessionStorage by hand: what matters is that an endpoint resolved at login time
 * survives the redirect and the token exchange, and only a round trip through both proves it.
 */
describe('RP-initiated logout', () => {
  const LOGOUT = { end_session_endpoint: LOGOUT_ENDPOINT, client_id: 'couch-companion-ui' };

  /** Drives a full PKCE login so the logout record is written the way production writes it. */
  async function loginWith(endpoints: OidcEndpoints): Promise<void> {
    await beginLogin(IDP, endpoints, 'http://app.example/_utils/', redirect);
    const { state } = JSON.parse(sessionStorage.getItem('cca_oidc_attempt')!);
    globalThis.fetch = vi
      .fn()
      .mockImplementation(async () => jsonResponse({ access_token: 'the-jwt' }));
    await completeLogin(`?code=the-code&state=${state}`);
  }

  describe('capturing the endpoint at login', () => {
    it('records the endpoint and client id a later logout needs', async () => {
      await loginWith(ENDPOINTS_WITH_LOGOUT);

      expect(readRpLogout()).toEqual(LOGOUT);
    });

    /** No endpoint means no record, which is what makes the dialog hide the checkbox. */
    it('records nothing when the provider publishes no end_session_endpoint', async () => {
      await loginWith(ENDPOINTS);

      expect(readRpLogout()).toBeNull();
    });

    /**
     * The record drives a checkbox that redirects somewhere. A leftover from a provider the
     * current session never used would send the user to a stranger's logout endpoint.
     */
    it('clears a previous provider record when the new one publishes none', async () => {
      await loginWith(ENDPOINTS_WITH_LOGOUT);
      expect(readRpLogout()).not.toBeNull();

      await loginWith(ENDPOINTS);

      expect(readRpLogout()).toBeNull();
    });

    /** A failed exchange establishes no session, so it must leave nothing behind to log out of. */
    it('records nothing when the token exchange fails', async () => {
      await beginLogin(IDP, ENDPOINTS_WITH_LOGOUT, 'http://app.example/_utils/', redirect);
      const { state } = JSON.parse(sessionStorage.getItem('cca_oidc_attempt')!);
      globalThis.fetch = vi.fn().mockImplementation(async () => jsonResponse({}));

      await expect(completeLogin(`?code=the-code&state=${state}`)).rejects.toThrow();

      expect(readRpLogout()).toBeNull();
    });

    it('ignores a corrupted record rather than offering a broken logout', () => {
      sessionStorage.setItem('cca_oidc_logout', '{not json');

      expect(readRpLogout()).toBeNull();
    });

    it('is forgotten on demand, which is how a session teardown drops it', async () => {
      await loginWith(ENDPOINTS_WITH_LOGOUT);

      forgetRpLogout();

      expect(readRpLogout()).toBeNull();
    });
  });

  describe('beginRpLogout', () => {
    function logoutParams(): URLSearchParams {
      expect(redirected).toHaveLength(1);
      return new URL(redirected[0]).searchParams;
    }

    it('redirects to the end_session_endpoint the provider published', () => {
      beginRpLogout(LOGOUT, 'http://app.example/_utils/', redirect);

      expect(redirected[0].startsWith(LOGOUT_ENDPOINT)).toBe(true);
    });

    it('sends post_logout_redirect_uri and a state', () => {
      beginRpLogout(LOGOUT, 'http://app.example/_utils/', redirect);

      const p = logoutParams();
      expect(p.get('post_logout_redirect_uri')).toBe('http://app.example/_utils/');
      expect(p.get('state')).toMatch(/^[A-Za-z0-9\-_]+$/);
    });

    /**
     * `client_id` is what stands in for the `id_token_hint` this app deliberately does not
     * retain. Verified against the devcontainer's Keycloak: a request carrying neither is
     * answered **400 "Missing parameters: id_token_hint"**, one carrying `client_id` gets the
     * 302 to `post_logout_redirect_uri`.
     */
    it('sends client_id, since there is no id_token_hint to send', () => {
      beginRpLogout(LOGOUT, 'http://app.example/_utils/', redirect);

      expect(logoutParams().get('client_id')).toBe('couch-companion-ui');
    });

    /** The decision the issue records: no ID token is kept, so none can leak into a URL. */
    it('never sends an id_token_hint', () => {
      beginRpLogout(LOGOUT, 'http://app.example/_utils/', redirect);

      expect(logoutParams().has('id_token_hint')).toBe(false);
      expect(redirected[0]).not.toContain('id_token');
    });

    /** Keycloak's logout endpoint carries no query of its own, but plenty of providers' do. */
    it('keeps query parameters the endpoint itself carries', () => {
      beginRpLogout(
        { ...LOGOUT, end_session_endpoint: 'https://idp.example/logout?tenant=acme' },
        'http://app.example/_utils/',
        redirect,
      );

      const p = logoutParams();
      expect(p.get('tenant')).toBe('acme');
      expect(p.get('client_id')).toBe('couch-companion-ui');
    });

    it('mints a fresh state per round trip', () => {
      beginRpLogout(LOGOUT, 'http://app.example/_utils/', redirect);
      const first = new URL(redirected[0]).searchParams.get('state');
      beginRpLogout(LOGOUT, 'http://app.example/_utils/', redirect);
      const second = new URL(redirected[1]).searchParams.get('state');

      expect(second).not.toBe(first);
    });
  });

  describe('the return leg', () => {
    /** Starts a round trip and hands back the `state` that went out with it. */
    function departingState(): string {
      beginRpLogout(LOGOUT, 'http://app.example/_utils/', redirect);
      return new URL(redirected[redirected.length - 1]).searchParams.get('state')!;
    }

    it('is not pending until a round trip has started', () => {
      expect(logoutReturnPending()).toBe(false);
    });

    it('is pending once the redirect has been issued', () => {
      departingState();

      expect(logoutReturnPending()).toBe(true);
    });

    /** The same assertion `completeLogin` makes about the login callback's `state`. */
    it('accepts the state it sent', () => {
      const state = departingState();

      expect(completeLogout(`?state=${state}`)).toBe(true);
    });

    it('rejects a forged state', () => {
      departingState();

      expect(completeLogout('?state=forged')).toBe(false);
    });

    it('rejects a return that carries no state at all', () => {
      departingState();

      expect(completeLogout('')).toBe(false);
    });

    it('rejects a return nothing in this tab started', () => {
      expect(completeLogout('?state=whatever')).toBe(false);
    });

    /** Single-use, like the login attempt: a stale state must not validate a later arrival. */
    it('consumes the state on every path, success or failure', () => {
      const state = departingState();

      expect(completeLogout('?state=forged')).toBe(false);
      expect(logoutReturnPending()).toBe(false);
      expect(completeLogout(`?state=${state}`)).toBe(false);
    });

    /**
     * Local teardown runs before the redirect leaves the page, so forgetting the session record
     * must not take the in-flight state with it.
     */
    it('keeps its state when the session record is forgotten', () => {
      const state = departingState();

      forgetRpLogout();

      expect(logoutReturnPending()).toBe(true);
      expect(completeLogout(`?state=${state}`)).toBe(true);
    });

    /**
     * The return leg carries `state` alone. If `callbackPending` claimed it, boot would try to
     * exchange a nonexistent authorization code and toast a failure at someone who had just
     * successfully logged out.
     */
    it('is invisible to the login callback detector', () => {
      expect(callbackPending('?state=abc')).toBe(false);
    });
  });
});
