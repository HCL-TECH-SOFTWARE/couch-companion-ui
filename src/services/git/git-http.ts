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

import { getLogger } from '../log-service.js';

const log = getLogger('services/git/git-http');

/**
 * Why a git request failed, in the terms the UI branches on.
 *
 * `blocked` is the load-bearing one: the request was never dispatched, so there is no status, no
 * headers, and nothing in the network tab to inspect. A browser reports every such refusal — a CSP
 * `connect-src` denial, a DNS failure, a dead host, a rejected preflight — as the same bare
 * `TypeError`, so this file can say *that* the request never left and *where* it was headed, but
 * never *why*. Deciding what to advise needs to know who wrote the page's policy, which only a
 * component can answer (`getContext().deployment.mode`) — see `git-sync-ui.ts`.
 *
 * `http-error` is everything else: a real response the git host actually sent.
 */
export type GitHttpFailure = 'http-error' | 'blocked';

/** An error from a git host. Deliberately not `ApiError`: a GitHub 401 is not a CouchDB 401. */
export class GitHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly rateLimited = false,
    readonly kind: GitHttpFailure = 'http-error',
    /** Host the request was headed for; set only for `kind: 'blocked'`, where there is no response to name it. */
    readonly host: string | null = null,
  ) {
    super(message);
    this.name = 'GitHttpError';
  }
}

/** Host for the diagnostic, or the whole URL if it will not parse — an ugly name beats none. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export interface GitHttpOptions {
  /** Resolve 404 to `null` instead of throwing. Used where absence is a normal answer. */
  allowNotFound?: boolean;
  body?: unknown;
}

/**
 * The second sanctioned HTTP boundary, and the only one that speaks to a foreign origin.
 *
 * It exists because `ApiClient` cannot be reused, for reasons that are mechanical rather than
 * stylistic:
 *
 *   1. `ApiClient` sends `credentials: "include"`. GitHub answers with
 *      `Access-Control-Allow-Origin: *`, and the Fetch spec makes a wildcard ACAO invalid in
 *      credentialed mode — the browser would discard every response.
 *   2. `ApiClient` treats 401 as "the CouchDB session expired" and drives the centralized
 *      logout. A revoked GitHub PAT must not sign the user out of their database.
 *   3. GitHub's error body is `{message, documentation_url}`; CouchDB's is `{error, reason}`.
 *   4. `ApiClient` has one base URL; git hosts are addressed absolutely, per account.
 *
 * Sending the CouchDB session cookie to GitHub would also be a real leak, which `credentials:
 * "omit"` below prevents structurally rather than by convention.
 */
export class GitHttp {
  constructor(private readonly token: () => string | null) {}

  async request<T>(
    method: string,
    url: string,
    opts: GitHttpOptions = {},
  ): Promise<T | null> {
    const headers = new Headers({
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    });
    const token = this.token();
    if (token) headers.set('Authorization', `Bearer ${token}`);
    if (opts.body !== undefined) headers.set('Content-Type', 'application/json');

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        credentials: 'omit',
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });
    } catch (err) {
      // `fetch` only rejects before a response exists, so whatever was thrown, nothing was sent.
      // Left unclassified this reached every call site as "Failed to fetch" — a message that names
      // neither the host nor the reason the network tab is empty. Deliberately NOT a 401: see
      // `isMissingTokenError` in `git-sync-ui.ts`, which would otherwise ask the user to fix a
      // Content-Security-Policy by typing a new access token.
      const host = hostOf(url);
      // The URL is logged, the token never is — it lives only in the Headers object above.
      log.debug(`git ${method} ${url} -> not sent`, err as Error);
      throw new GitHttpError(
        0,
        `The request to ${host} was never sent, so it does not appear in the network tab. The ` +
          `host may be unreachable, or this page's Content-Security-Policy may not allow ` +
          `connections to it.`,
        false,
        'blocked',
        host,
      );
    }

    if (response.status === 404 && opts.allowNotFound) return null;

    if (!response.ok) {
      const remaining = response.headers.get('X-RateLimit-Remaining');
      const rateLimited = response.status === 403 && remaining === '0';
      let detail = response.statusText;
      try {
        const parsed = (await response.json()) as { message?: string };
        if (parsed?.message) detail = parsed.message;
      } catch {
        /* a non-JSON error body is still an error; the status text stands in */
      }
      // The URL is logged, the token never is — it lives only in the Headers object above.
      log.debug(`git ${method} ${url} -> ${response.status}`);
      throw new GitHttpError(
        response.status,
        rateLimited ? `GitHub API rate limit exceeded. ${detail}` : detail,
        rateLimited,
      );
    }

    if (response.status === 204) return null;
    return (await response.json()) as T;
  }
}
