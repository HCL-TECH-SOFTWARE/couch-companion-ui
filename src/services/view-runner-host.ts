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

import ViewRunnerWorker from './view-runner.worker?worker';
import { runMapReduce } from './view-runner.js';
import type { RunRequest, RunResult } from './view-runner.js';

/** `terminate()`s a runaway map/reduce function after this long. */
const DEFAULT_TIMEOUT_MS = 2000;

/**
 * Without a Worker, the only thing this fallback can bound is how much work it *starts* — once a
 * synchronous call begins, nothing can interrupt it before it returns (see {@link runInPage}).
 * Kept well above what a hand-typed or `_fetchSampledProperties`-sourced sample set realistically
 * contains, so it only ever engages as a backstop against an unreasonably large request.
 */
const FALLBACK_MAX_DOCS = 200;

/**
 * Runs the view in a Worker so an infinite loop in a map function costs a terminated worker
 * rather than a frozen tab, then falls back to in-page execution where no Worker exists.
 *
 * The fallback is not merely a test accommodation, though it is what makes this testable under
 * happy-dom (which implements no Worker). It is also the honest degradation: with no worker there
 * is no way to interrupt a runaway function, so the fallback caps the document count and says in
 * its returned error that the timeout was not enforced, instead of pretending it was.
 *
 * The two paths differ in more than just timeout enforcement: the fallback runs the map/reduce
 * source directly on the main thread, with full access to `window`, `document`, and
 * `localStorage` — a same-origin Worker's global scope has none of that. (Both can `fetch`, so
 * this is a DOM/storage isolation difference, not a network sandbox either way.)
 *
 * CSP, measured rather than reasoned about (`node scripts/smoke.mjs --csp '<policy>'`, Chrome,
 * production build):
 *
 *   - `script-src` must include `'unsafe-eval'` wherever the policy reaches the runner, because
 *     {@link runMapReduce} compiles the user's map/reduce source with `new Function`. Under
 *     `script-src 'self'` the result is `Could not compile the map function: Evaluating a string
 *     as JavaScript violates the following Content Security Policy directive…`. CouchDB's shipped
 *     /_utils policy grants it. That applies to BOTH paths below — the fallback compiles under
 *     the document's policy, the Worker under the policy served with its own script response.
 *     A Worker fetched from a network URL does not inherit the creating document's CSP, so a
 *     header sent only on the HTML leaves the Worker path unaffected (also measured).
 *   - `child-src`/`worker-src` need only `'self'`. The worker is a bundled same-origin module
 *     (`?worker`), not a `blob:` URL as it was before #30, so the `blob:` in CouchDB's default
 *     `child-src 'self' data: blob:` is no longer load-bearing for this app.
 */
export function runViewIsolated(
  mapSource: string,
  docs: unknown[],
  reduceSource?: string | null,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<RunResult> {
  if (typeof Worker === 'undefined') {
    return runInPage(mapSource, docs, reduceSource);
  }
  return runInWorker(mapSource, docs, reduceSource, timeoutMs);
}

/**
 * No Worker available: runs {@link runMapReduce} directly on the main thread. A genuinely
 * endless loop still freezes the page — that is inherent to a single JS thread, not something any
 * amount of bookkeeping here can change, so this makes no attempt to pretend otherwise. What it
 * *can* do honestly is bound the worst case of an unexpectedly large sample set by capping how
 * many documents it will even start on, and say plainly, when it does, that this cap is standing
 * in for a timeout it cannot actually enforce.
 *
 * `runMapReduce` is documented, and now actually guaranteed (see `applyReduce`'s own try/catch
 * around grouping in `view-runner.ts`), to never throw — a non-JSON-safe reduce key (a circular
 * reference, a `BigInt`) is caught there and turned into `{rows: mapRows, error}`, the same as any
 * other reduce failure. The try/catch below is belt-and-braces, not what the "never rejects"
 * guarantee actually rests on: if `runMapReduce`'s contract were ever violated by a future change,
 * this still keeps `runViewIsolated` (and therefore `testView`) resolving a `RunResult`-shaped
 * error instead of rejecting, mirroring how the Worker path turns an uncaught throw into a graceful
 * `worker.onerror` message rather than a rejection.
 */
function runInPage(mapSource: string, docs: unknown[], reduceSource?: string | null): Promise<RunResult> {
  const capped = docs.length > FALLBACK_MAX_DOCS;
  const limited = capped ? docs.slice(0, FALLBACK_MAX_DOCS) : docs;

  let result: RunResult;
  try {
    result = runMapReduce(mapSource, limited, reduceSource);
  } catch (err) {
    return Promise.resolve({
      rows: [],
      error: `In-page execution error: ${err instanceof Error ? err.message : String(err)}`
    });
  }
  if (!capped) return Promise.resolve(result);

  const note =
    `Ran only the first ${FALLBACK_MAX_DOCS} of ${docs.length} sample documents — no Worker is ` +
    'available in this environment, so execution time cannot be bounded by a timeout the way it ' +
    'is when a Worker runs this; limiting the document count is the closest available substitute.';
  return Promise.resolve({ rows: result.rows, error: result.error ? `${result.error} ${note}` : note });
}

/**
 * Starts `view-runner.worker.ts` — a real bundled Worker entry point, not a blob assembled from
 * stringified functions — posts the request, and resolves on the first response, terminating the
 * worker the instant either side settles so neither a slow worker after a timeout nor a timer
 * after a real response can fire a second resolution.
 *
 * A fresh worker per call is deliberate: `terminate()` is the only thing that can stop a runaway
 * map function, so the worker that ran one request must not be reused for the next.
 */
function runInWorker(
  mapSource: string,
  docs: unknown[],
  reduceSource: string | null | undefined,
  timeoutMs: number
): Promise<RunResult> {
  return new Promise((resolve) => {
    let settled = false;
    let worker: Worker;
    try {
      worker = new ViewRunnerWorker();
    } catch (err) {
      resolve({ rows: [], error: `Could not start the view-test worker: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }

    const finish = (result: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({ rows: [], error: `Timed out after ${timeoutMs} ms — check for an endless loop.` });
    }, timeoutMs);

    worker.onmessage = (event: MessageEvent<RunResult>) => finish(event.data);
    worker.onerror = (event: ErrorEvent) => finish({ rows: [], error: `Worker error: ${event.message || 'unknown error'}` });

    // Typed as RunRequest rather than an inline object literal, so the field names here and the
    // ones the worker destructures off `event.data` are checked against one interface.
    const request: RunRequest = { mapSource, docs, reduceSource: reduceSource ?? null };
    try {
      worker.postMessage(request);
    } catch (err) {
      finish({ rows: [], error: `Could not send the sample documents to the worker: ${err instanceof Error ? err.message : String(err)}` });
    }
  });
}
