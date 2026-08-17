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

import { describe, it, expect, afterEach, vi } from 'vitest';
import { runMapReduce, type RunResult } from '../src/services/view-runner.js';
import { runViewIsolated } from '../src/services/view-runner-host.js';

describe('runViewIsolated — no-Worker fallback (this suite runs under happy-dom, which has none)', () => {
  it('matches runMapReduce directly for an ordinary, small sample set', async () => {
    const mapSource = 'function(doc){ emit(doc._id, doc.n); }';
    const docs = [{ _id: 'a', n: 1 }, { _id: 'b', n: 2 }];
    const result = await runViewIsolated(mapSource, docs);
    expect(result).toEqual(runMapReduce(mapSource, docs));
  });

  it('caps the document count and says so, without pretending a timeout was enforced', async () => {
    const docs = Array.from({ length: 201 }, (_, i) => ({ _id: `doc${i}` }));
    const result = await runViewIsolated('function(doc){ emit(doc._id, 1); }', docs);
    expect(result.rows).toHaveLength(200);
    expect(result.error).toMatch(/worker/i);
    expect(result.error).toMatch(/200/);
  });

  it('still reports a real compile error through the fallback path', async () => {
    const result = await runViewIsolated('not a function', [{ _id: 'a' }]);
    expect(result.rows).toEqual([]);
    expect(result.error).toBeTruthy();
  });

  it('resolves (never rejects) with the map rows intact when a circular emit key defeats reduce grouping', async () => {
    // A reduce groups rows by JSON.stringify(key) (see groupRowsByKey in view-runner.ts); a
    // circular key reaches that call. applyReduce now catches this itself and returns the
    // already-computed map rows alongside the error (fix round 2) — runMapReduce genuinely never
    // throws for this input, so this exercises runInPage's normal (non-catch) path, not its
    // belt-and-braces try/catch. Pinned here anyway: it's what "the two paths must agree" means in
    // practice — a fallback that resolved `rows: []` while the row data actually existed would be
    // its own, quieter way of losing the map output.
    const mapSource = 'function(doc){ var o={}; o.self=o; emit(o,1); }';
    const result = await runViewIsolated(mapSource, [{ _id: 'a' }], '_count');
    expect(result.error).toMatch(/circular/i);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ id: 'a', value: 1 });
  });
});

/**
 * These cover the host's bookkeeping — settle-once, terminate, timeout — and nothing about what a
 * Worker actually executes. Stubbing the global still reaches `runInWorker` because Vite's
 * `?worker` wrapper is itself a `new Worker(...)` call; what it can never reach is the built,
 * minified worker chunk, which is exactly the gap #30 lived in. `scripts/smoke.mjs` covers that,
 * in a real browser, and it is a gate step — not an optional extra.
 */
describe('runViewIsolated — Worker path (stubbed Worker; happy-dom has no real one to exercise)', () => {
  class FakeWorker {
    static instances: FakeWorker[] = [];
    onmessage: ((event: MessageEvent<RunResult>) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    terminated = false;
    respondWith: RunResult | null;

    constructor(_url: string) {
      this.respondWith = FakeWorker.nextResponse;
      FakeWorker.instances.push(this);
    }

    postMessage(_data: unknown) {
      if (this.respondWith) {
        const response = this.respondWith;
        queueMicrotask(() => this.onmessage?.({ data: response } as MessageEvent<RunResult>));
      }
      // A null respondWith simulates a worker that never answers, exercising the timeout path.
    }

    terminate() {
      this.terminated = true;
    }

    static nextResponse: RunResult | null = null;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    FakeWorker.instances = [];
    FakeWorker.nextResponse = null;
  });

  it('resolves with the worker\'s response and terminates it', async () => {
    FakeWorker.nextResponse = { rows: [{ key: 'x', value: 1, id: 'a' }], error: null };
    vi.stubGlobal('Worker', FakeWorker as unknown as typeof Worker);

    const result = await runViewIsolated('function(doc){ emit(doc._id, 1); }', [{ _id: 'a' }]);

    expect(result).toEqual(FakeWorker.nextResponse);
    expect(FakeWorker.instances).toHaveLength(1);
    expect(FakeWorker.instances[0].terminated).toBe(true);
  });

  it('terminates a non-responding worker after the timeout and reports it, not a fake success', async () => {
    vi.useFakeTimers();
    FakeWorker.nextResponse = null; // never responds
    vi.stubGlobal('Worker', FakeWorker as unknown as typeof Worker);

    const pending = runViewIsolated('function(doc){ while(true) {} }', [{ _id: 'a' }], null, 50);
    await vi.advanceTimersByTimeAsync(50);
    const result = await pending;

    expect(result.rows).toEqual([]);
    expect(result.error).toMatch(/timed out/i);
    expect(FakeWorker.instances[0].terminated).toBe(true);
  });
});
