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
 * The THIRD sanctioned HTTP boundary — identity providers only.
 *
 * Separate from `api-client.ts` for the same reason `git/git-http.ts` is (P5-1, P6-1):
 *
 *  1. A 401 from an IdP's token endpoint must NOT trigger CouchDB's centralized logout.
 *     `ApiClient` calls `onUnauthorized` on any 401 outside `/_session`; routing a failed
 *     token exchange through it would log the user out of a CouchDB session that is fine.
 *  2. The base URL is per-request. An IdP's authorize, token, and JWKS endpoints can live on
 *     three different hosts, none of them the CouchDB `ApiClient` is pinned to.
 *  3. The error shape is OAuth's `{error, error_description}` (RFC 6749 §5.2), not CouchDB's
 *     `{error, reason}`.
 *  4. `credentials: "omit"`, never `"include"`. The IdP has its own session cookie and this
 *     app has no business sending or receiving it — the PKCE exchange authenticates with the
 *     `code_verifier` alone.
 *
 * The ESLint override that lets this file call `fetch` is declared in `eslint.config.js`
 * alongside the other two. Adding a fourth needs the same justification these three carry.
 */

import { getLogger } from './log-service.js';

const log = getLogger('services/oidc-http');

const DEFAULT_TIMEOUT_MS = 8000;

/**
 * Why a request failed, in the terms the UI actually branches on.
 *
 * `cors-blocked` is the load-bearing one: it is the ONLY condition that should offer the
 * operator D15's paste-JWKS fallback. A browser reports a CORS rejection as a bare
 * `TypeError` with no status and no headers to inspect — indistinguishable, from here, from
 * DNS failure or a dead host, which is why the fallback is offered rather than performed.
 * A 404 means the URL is wrong, and pasting a JWKS would paper over a typo.
 */
export type OidcHttpFailure =
  | 'cors-blocked'
  | 'not-found'
  | 'http-error'
  | 'malformed'
  | 'timeout';

export class OidcHttpError extends Error {
  constructor(
    readonly kind: OidcHttpFailure,
    readonly url: string,
    message: string,
    readonly status?: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'OidcHttpError';
  }
}

/**
 * GETs a JSON document from an identity provider.
 *
 * @param url - absolute URL; well-known documents and JWKS endpoints
 * @param timeoutMs - abort after this long rather than hanging the login screen
 * @throws {OidcHttpError} classified per {@link OidcHttpFailure}
 */
export async function fetchJson<T = unknown>(
  url: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  return request<T>('GET', url, undefined, timeoutMs);
}

/**
 * POSTs `application/x-www-form-urlencoded` to an identity provider and parses the JSON
 * answer — the shape every OAuth token endpoint speaks (RFC 6749 §4.1.3).
 *
 * @param url - the token endpoint
 * @param form - parameters; encoded here, never interpolated into the URL
 */
export async function postForm<T = unknown>(
  url: string,
  form: Record<string, string>,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  return request<T>('POST', url, new URLSearchParams(form), timeoutMs);
}

async function request<T>(
  method: string,
  url: string,
  body: URLSearchParams | undefined,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let resp: Response;
  try {
    resp = await fetch(url, {
      method,
      // The IdP is a foreign origin with its own session; PKCE authenticates with the
      // verifier, so a cookie would add exposure and buy nothing.
      credentials: 'omit',
      headers: body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : undefined,
      body,
      signal: controller.signal,
    });
  } catch (err) {
    const aborted = controller.signal.aborted;
    log.debug?.(`${method} ${url} failed before a response`, err as Error);
    throw new OidcHttpError(
      aborted ? 'timeout' : 'cors-blocked',
      url,
      aborted
        ? `The identity provider did not answer within ${timeoutMs}ms.`
        : 'The request never reached the identity provider — it is unreachable, or its CORS ' +
          'policy does not allow this origin.',
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await resp.text().catch(() => '');
  let parsed: unknown;
  let parseFailed = false;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parseFailed = true;
  }

  if (!resp.ok) {
    throw new OidcHttpError(
      resp.status === 404 ? 'not-found' : 'http-error',
      url,
      describeOAuthError(parsed) ?? `${resp.status} ${resp.statusText || 'Request failed'}`,
      resp.status,
      parseFailed ? undefined : parsed,
    );
  }

  if (parseFailed || parsed === undefined) {
    throw new OidcHttpError(
      'malformed',
      url,
      'The identity provider answered with something that is not JSON.',
      resp.status,
    );
  }

  return parsed as T;
}

/** RFC 6749 §5.2 error body, when the IdP sends one. */
function describeOAuthError(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const e = body as { error?: unknown; error_description?: unknown };
  const code = typeof e.error === 'string' ? e.error : null;
  const detail = typeof e.error_description === 'string' ? e.error_description : null;
  if (code && detail) return `${code}: ${detail}`;
  return detail ?? code;
}
