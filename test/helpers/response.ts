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
 * Response fixtures for tests that mock `fetch` (#16/#17).
 *
 * These return **real `Response` objects**, not duck types. That is the whole point: a
 * hand-rolled `{ ok, status, text }` is complete only until the code under test reads the
 * other accessor, and then it throws *before* the branch being tested — leaving a green test
 * that asserted nothing.
 *
 * `ApiClient` reads the body two different ways depending on the branch:
 *
 * | Branch                              | Accessor      |
 * |-------------------------------------|---------------|
 * | `resp.ok === false` (error path)    | `resp.json()` |
 * | success, `text` present             | `resp.text()` |
 * | success, `text` absent              | `resp.json()` |
 * | 204 / `content-length: 0`           | `headers.get()` |
 *
 * A real `Response` satisfies all of them by construction and cannot drift as `ApiClient`
 * changes. Prefer these helpers; hand-roll only when the *shape* is the thing under test, and
 * say so in a comment when you do.
 */

/**
 * A JSON response. Sets `Content-Type: application/json` and serialises `body`.
 *
 * @param body - serialised with `JSON.stringify`; pass a string to send it verbatim
 * @param status - HTTP status; `ok` follows from it
 * @param headers - merged over the default content type
 */
export function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(text, {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

/**
 * CouchDB's error shape — `{error, reason}` — at the given status. What `ApiClient` parses
 * out of a non-2xx response to build its {@link ApiError} message.
 */
export function couchError(status: number, error: string, reason: string): Response {
  return jsonResponse({ error, reason }, status);
}

/** `204 No Content`, the shape `ApiClient` short-circuits on without reading a body. */
export function noContent(): Response {
  return new Response(null, { status: 204 });
}

/**
 * A `fetch` implementation that routes by URL, for tests standing in for more than one
 * endpoint. Anything unrouted 404s rather than falling through to the real network — an
 * unrouted URL is a test bug, and it should look like one.
 *
 * @param routes - substring or exact URL → response factory (called per request, so each
 *   call gets a fresh `Response`; a `Response` body can only be consumed once)
 */
export function routedFetch(routes: Record<string, () => Response>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : String((input as Request).url ?? input);
    for (const [pattern, make] of Object.entries(routes)) {
      if (url === pattern || url.includes(pattern)) return make();
    }
    return jsonResponse({ error: 'not_found', reason: `unrouted in test: ${url}` }, 404);
  }) as typeof fetch;
}
