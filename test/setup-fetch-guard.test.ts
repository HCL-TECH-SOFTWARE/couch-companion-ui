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
 * Tests the guard in `test/setup.ts` that makes an unmocked `fetch` fail (#15).
 *
 * A guard that silently stopped working would be the same class of defect it exists to
 * prevent — the suite would go back to reaching the live devcontainer and nobody would know.
 * So the guard gets its own tests, and they must fail if it is removed.
 */

import { describe, it, expect, vi } from 'vitest';

describe('unmocked fetch', () => {
  it('throws instead of reaching the network', async () => {
    await expect(fetch('http://localhost:5984/_up')).rejects.toThrow(/Unmocked fetch/);
  });

  it('names the URL it refused, so the culprit is obvious', async () => {
    await expect(fetch('http://localhost:8080/realms/couch')).rejects.toThrow(
      /localhost:8080\/realms\/couch/,
    );
  });

  it('points at the fix rather than just complaining', async () => {
    await expect(fetch('http://example.test/')).rejects.toThrow(/globalThis\.fetch = vi\.fn/);
  });

  it('is reinstalled for every test, not just the first', async () => {
    // Proves the guard lives in `beforeEach`. If it were installed once at module load, a
    // previous test's `globalThis.fetch = …` would leak into this one and this would resolve.
    await expect(fetch('http://example.test/')).rejects.toThrow(/Unmocked fetch/);
  });
});

describe('supported mocking styles still work', () => {
  it('plain assignment displaces the guard', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 }));

    await expect((await fetch('http://example.test/')).json()).resolves.toEqual({ ok: true });
  });

  it('vi.spyOn WITH an implementation displaces the guard', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));

    await expect(fetch('http://example.test/')).resolves.toMatchObject({ status: 200 });
  });

  it('a bare vi.spyOn still supports asserting fetch was never called', async () => {
    // The guard throws only if something actually calls fetch — which is the very thing this
    // assertion is checking does not happen, so the two do not conflict.
    const spy = vi.spyOn(globalThis, 'fetch');

    expect(spy).not.toHaveBeenCalled();
  });
});
