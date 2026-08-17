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

import { beforeEach, vi } from 'vitest';
import '../src/components/cca-router-provider.js';
import { registerIconLibrary } from '@awesome.me/webawesome/dist/components/icon/library.js';

/**
 * Resolve <wa-icon> from a sprite sheet instead of the network.
 *
 * Component modules register the real WaIcon as an import side effect, so test files that
 * stub wa-* tags behind an `if (!customElements.get(tag))` guard silently keep the real one.
 * Its default library resolves every icon name via a network request that never completes
 * under `vitest run` (no dev server), and happy-dom logs the failed/aborted request to the
 * console even when the rejection is caught. Sprite-sheet mode resolves inline, no request.
 */
registerIconLibrary('default', { resolver: (name: string) => `#${name}`, spriteSheet: true });

/**
 * Mock ElementInternals for happy-dom which doesn't support it natively.
 * This prevents WaButton (and other form-associated custom elements) from
 * throwing unhandled errors during tests.
 */

const noop = () => {};

class MockElementInternals {
  form = null;
  labels = [];
  shadowRoot = null;
  validationMessage = '';
  validity = {
    badInput: false,
    customError: false,
    patternMismatch: false,
    rangeOverflow: false,
    rangeUnderflow: false,
    stepMismatch: false,
    tooLong: false,
    tooShort: false,
    typeMismatch: false,
    valid: true,
    valueMissing: false
  };
  willValidate = false;
  states = new Set();

  checkValidity() {
    return true;
  }
  reportValidity() {
    return true;
  }
  setFormValue = noop;
  setValidity = noop;
}

if (typeof HTMLElement.prototype.attachInternals === 'undefined') {
  HTMLElement.prototype.attachInternals = function () {
    return new MockElementInternals() as unknown as ElementInternals;
  };
}

/**
 * Polyfill `getAnimations` for happy-dom which doesn't implement it.
 * Some Web Awesome components call `el.getAnimations()` during teardown,
 * causing unhandled errors when running under happy-dom.
 */
if (typeof HTMLElement.prototype.getAnimations === 'undefined') {
  HTMLElement.prototype.getAnimations = function () {
    return [];
  };
}

/**
 * Polyfill `localStorage` for tests.
 *
 * Node 22+ exposes an experimental `globalThis.localStorage` that requires
 * `--localstorage-file` to actually work. When it's left undefined it shadows
 * happy-dom's window storage, so we install a simple in-memory implementation
 * here. `sessionStorage` is provided by happy-dom and works fine.
 */
if (typeof globalThis.localStorage === 'undefined') {
  const memory = new Map<string, string>();
  const stub: Storage = {
    get length() {
      return memory.size;
    },
    clear() {
      memory.clear();
    },
    getItem(key: string) {
      return memory.has(key) ? (memory.get(key) as string) : null;
    },
    key(index: number) {
      return Array.from(memory.keys())[index] ?? null;
    },
    removeItem(key: string) {
      memory.delete(key);
    },
    setItem(key: string, value: string) {
      memory.set(key, String(value));
    },
  };
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: stub,
  });
}

/**
 * Make an unmocked `fetch` fail loudly instead of reaching the real world.
 *
 * Nothing here talks to a network on purpose, but the devcontainer usually IS
 * running (CouchDB on :5984, Keycloak on :8080). Without this, a test that
 * forgets to mock `fetch` — or believes it has and hasn't — gets a genuine
 * answer back, and the suite behaves differently depending on whether the
 * stack happens to be up. That failure is invisible to whoever has those ports
 * closed, which is the worst possible way to distribute a broken test.
 *
 * Found the hard way (#15): four tests posted a fake authorization code to the
 * live Keycloak and failed with `invalid_grant: Code not valid` — a real
 * response, indistinguishable at a glance from a bug in the code under test.
 * The cause was `vi.spyOn(globalThis, 'fetch')` in a `beforeEach`, which
 * leaves a call-through wrapper that a later `globalThis.fetch = …` does not
 * displace.
 *
 * Two mocking styles work with this guard, and both are fine:
 *   globalThis.fetch = vi.fn().mockResolvedValue(response)     // plain assignment
 *   vi.spyOn(globalThis, 'fetch').mockResolvedValue(response)  // spy WITH an implementation
 *
 * The one that does not is a BARE `vi.spyOn(globalThis, 'fetch')` with no
 * implementation, which now calls this and throws — by design. If you want to
 * assert `fetch` was never called, spy on it bare and assert
 * `not.toHaveBeenCalled()`; the throw only fires if something actually calls it,
 * which is the failure you were asserting against anyway.
 */
beforeEach(() => {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    throw new Error(
      `Unmocked fetch in a test: ${typeof input === 'string' ? input : String((input as Request).url ?? input)}\n` +
        'Assign globalThis.fetch = vi.fn().mockResolvedValue(...), or assert against the ' +
        'service instead of the network. See test/setup.ts and issue #15.',
    );
  }) as unknown as typeof fetch;
});
