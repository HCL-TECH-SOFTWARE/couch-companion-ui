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
import { GitHttp, GitHttpError, type GitHttpOptions } from '../src/services/git/git-http.js';
import { isMissingTokenError } from '../src/plugins/design-mgmt/git-sync-ui.js';
import { Logger, Level } from '../src/services/log-service.js';
import { jsonResponse as sharedJsonResponse } from './helpers/response.js';

// Was a local copy of what `test/helpers/response.ts` now owns (#17). Kept as a
// thin alias so this file's many call sites keep their argument order.
const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  sharedJsonResponse(body, status, headers);

describe('GitHttp', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { fetchSpy = vi.spyOn(globalThis, 'fetch'); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('never sends credentials — a wildcard ACAO makes include-mode responses unreadable', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, { login: 'octocat' }));
    await new GitHttp(() => 'tok').request('GET', 'https://api.github.com/user');
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    expect(init.credentials).toBe('omit');
  });

  it('attaches the bearer token and the GitHub API version', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, {}));
    await new GitHttp(() => 'ghp_secret').request('GET', 'https://api.github.com/user');
    const headers = new Headers((fetchSpy.mock.calls[0][1] as RequestInit).headers);
    expect(headers.get('Authorization')).toBe('Bearer ghp_secret');
    expect(headers.get('Accept')).toBe('application/vnd.github+json');
    expect(headers.get('X-GitHub-Api-Version')).toBe('2022-11-28');
  });

  it('omits Authorization entirely when there is no token', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, {}));
    await new GitHttp(() => null).request('GET', 'https://api.github.com/user');
    const headers = new Headers((fetchSpy.mock.calls[0][1] as RequestInit).headers);
    expect(headers.has('Authorization')).toBe(false);
  });

  it("maps GitHub's error shape, which is {message}, not CouchDB's {error, reason}", async () => {
    fetchSpy.mockResolvedValue(jsonResponse(401, { message: 'Bad credentials' }));
    await expect(new GitHttp(() => 'bad').request('GET', 'https://api.github.com/user'))
      .rejects.toMatchObject({ status: 401, message: 'Bad credentials' });
  });

  /**
   * The `rateLimited` FLAG, not the message.
   *
   * The previous version of this test asserted `/rate limit/i` against a body the test itself
   * supplied (`message: 'API rate limit exceeded'`), so deleting the
   * `X-RateLimit-Remaining === '0'` check in git-http.ts still passed. These two assert the
   * flag and pin the header's contribution, so removing the check fails the second one (#7).
   */
  it('flags a 403 with X-RateLimit-Remaining: 0 as rate limited', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(403, { message: 'API rate limit exceeded' }, { 'X-RateLimit-Remaining': '0' }),
    );
    await expect(new GitHttp(() => 't').request('GET', 'https://api.github.com/user'))
      .rejects.toMatchObject({ status: 403, rateLimited: true });
  });

  it('does NOT flag an ordinary 403 that has quota remaining', async () => {
    fetchSpy.mockResolvedValue(
      // Same status, same message shape — only the header differs. This is the assertion the
      // old test was missing, and the one that makes the header check load-bearing.
      jsonResponse(403, { message: 'Resource not accessible by personal access token' }, {
        'X-RateLimit-Remaining': '4999',
      }),
    );
    await expect(new GitHttp(() => 't').request('GET', 'https://api.github.com/user'))
      .rejects.toMatchObject({ status: 403, rateLimited: false });
  });

  /**
   * `err instanceof GitHttpError` is load-bearing at two call sites, so the constructor
   * identity — not just the shape — has to be pinned. `toMatchObject` elsewhere in this file
   * would pass for a plain object.
   */
  it('throws GitHttpError instances, not shape-alike objects', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(500, { message: 'boom' }));
    const err = await new GitHttp(() => 't')
      .request('GET', 'https://api.github.com/user')
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GitHttpError);
    expect(err).toBeInstanceOf(Error);
    expect((err as GitHttpError).name).toBe('GitHttpError');
    expect((err as GitHttpError).status).toBe(500);
  });

  it('requests the exact URL it was given, with the method it was given', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, {}));
    await new GitHttp(() => 't').request('PATCH', 'https://ghe.example.com/api/v3/repos/o/r', {
      body: { name: 'x' },
    });

    expect(fetchSpy.mock.calls[0][0]).toBe('https://ghe.example.com/api/v3/repos/o/r');
    expect((fetchSpy.mock.calls[0][1] as RequestInit).method).toBe('PATCH');
    expect((fetchSpy.mock.calls[0][1] as RequestInit).body).toBe(JSON.stringify({ name: 'x' }));
  });

  it('falls back to statusText when the error body is not JSON', async () => {
    fetchSpy.mockResolvedValue(new Response('<html>gateway</html>', { status: 502, statusText: 'Bad Gateway' }));
    await expect(new GitHttp(() => 't').request('GET', 'https://api.github.com/user'))
      .rejects.toMatchObject({ status: 502, message: 'Bad Gateway' });
  });

  /**
   * There is no raw-body mode, and re-adding one would be a silent type lie (#6, item 19).
   *
   * `GitHttpOptions.raw` used to exist for a Bitbucket-style raw file endpoint, which D11
   * excludes — v1 is GitHub only. It had no caller anywhere in `src/`, so the branch was
   * unreachable, and `request<T>` casting a `string` to `T` meant a future caller who passed
   * it would get a string back through a `Promise<T | null>` that promised an object.
   *
   * This asserts the parse is unconditional: an unrecognised option cannot divert it.
   */
  it('always parses JSON — a stray raw option cannot divert the parse', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, { login: 'octocat' }));

    // Deliberately off-interface: the point is that the option no longer means anything.
    const got = await new GitHttp(() => 't').request(
      'GET', 'https://api.github.com/user', { raw: true } as GitHttpOptions,
    );

    expect(got).toEqual({ login: 'octocat' });
    expect(typeof got).toBe('object');
  });

  it('returns null for 404 when allowNotFound is set', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(404, { message: 'Not Found' }));
    const got = await new GitHttp(() => 't')
      .request('GET', 'https://api.github.com/x', { allowNotFound: true });
    expect(got).toBeNull();
  });

  /**
   * The single most safety-critical assertion in this phase, and until now it could not fail.
   *
   * `Logger.logTarget[Level.DEBUG]` captures `console.debug` **by reference** at module load, so
   * `vi.spyOn(console, 'debug')` — which replaces the property on `console`, not the reference the
   * logger already holds — never saw a single call: `seen` was always empty and the assertion was
   * vacuous. Interpolating the token into `git-http.ts`'s `log.debug` would have written a live
   * PAT to the console with this suite green.
   *
   * Swapping `Logger.logTarget[Level.DEBUG]` itself is the only way to intercept what the logger
   * actually writes — the same technique `git-credential-store.test.ts` already uses for WARN.
   * Verified by temporarily interpolating the token into `git-http.ts:81`: this test then fails
   * (and, unlike before, fails on the token assertion rather than on the guard below).
   */
  it('never logs the token', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(401, { message: 'Bad credentials' }));
    const seen: string[] = [];
    const savedDebugTarget = Logger.logTarget[Level.DEBUG];
    Logger.logTarget[Level.DEBUG] = (...a: unknown[]) => { seen.push(a.join(' ')); };
    try {
      await new GitHttp(() => 'ghp_supersecret')
        .request('GET', 'https://api.github.com/user').catch(() => {});
    } finally {
      Logger.logTarget[Level.DEBUG] = savedDebugTarget;
    }
    // Guard against the exact failure this test used to have: an empty capture proves nothing.
    expect(seen.join('\n')).toContain('https://api.github.com/user');
    expect(seen.join('\n')).not.toContain('ghp_supersecret');
  });

  /**
   * A request the browser refuses to dispatch (#28).
   *
   * `fetch` rejects with a bare `TypeError` — no status, no headers, and no entry in the network
   * tab, because nothing was sent. Until this block existed the rejection escaped `request()`
   * unclassified and every call site printed "Failed to fetch", which names neither the host nor
   * the fact that there is nothing to look at.
   */
  describe('a request that never leaves the browser', () => {
    const blocked = () =>
      new GitHttp(() => 'tok').request('GET', 'https://api.github.com/user').catch((e: unknown) => e);

    beforeEach(() => {
      // Exactly what a browser hands back for a CSP `connect-src` refusal, a DNS failure, a dead
      // host or a rejected preflight — the four are indistinguishable from inside the page.
      fetchSpy.mockRejectedValue(new TypeError('Failed to fetch'));
    });

    it('becomes a GitHttpError with status 0, so callers see one error type, not two', async () => {
      const err = await blocked();
      expect(err).toBeInstanceOf(GitHttpError);
      expect((err as GitHttpError).status).toBe(0);
      expect((err as GitHttpError).kind).toBe('blocked');
    });

    it('names the host it could not reach — "Failed to fetch" names nothing', async () => {
      const err = await blocked();
      expect((err as GitHttpError).host).toBe('api.github.com');
      expect((err as Error).message).toContain('api.github.com');
      expect((err as Error).message).not.toBe('Failed to fetch');
    });

    it('keeps the host of a self-hosted instance, not a hardcoded github.com', async () => {
      const err = await new GitHttp(() => 't')
        .request('GET', 'https://ghe.example.com/api/v3/user')
        .catch((e: unknown) => e);
      expect((err as GitHttpError).host).toBe('ghe.example.com');
      expect((err as Error).message).toContain('ghe.example.com');
    });

    /**
     * The regression this whole classification has to survive: `isMissingTokenError` matches any
     * `GitHttpError` with `status === 401`, and `GitTokenPrompt.run()` acts on it by asking the
     * user for a new access token. A Content-Security-Policy problem is not fixed by typing a
     * token, and prompting for one sends the operator to the wrong place entirely.
     */
    it('is NOT a missing-token error — a CSP problem must not open the token prompt', async () => {
      expect(isMissingTokenError(await blocked())).toBe(false);
    });

    it('still classifies a real 401 as a missing token', async () => {
      fetchSpy.mockReset();
      fetchSpy.mockResolvedValue(jsonResponse(401, { message: 'Bad credentials' }));
      const err = await new GitHttp(() => 'stale')
        .request('GET', 'https://api.github.com/user')
        .catch((e: unknown) => e);
      expect(isMissingTokenError(err)).toBe(true);
    });

    it('never logs the token when the request is blocked either', async () => {
      const seen: string[] = [];
      const savedDebugTarget = Logger.logTarget[Level.DEBUG];
      Logger.logTarget[Level.DEBUG] = (...a: unknown[]) => { seen.push(a.join(' ')); };
      try {
        await new GitHttp(() => 'ghp_supersecret')
          .request('GET', 'https://api.github.com/user').catch(() => {});
      } finally {
        Logger.logTarget[Level.DEBUG] = savedDebugTarget;
      }
      expect(seen.join('\n')).toContain('https://api.github.com/user');
      expect(seen.join('\n')).not.toContain('ghp_supersecret');
    });
  });
});
