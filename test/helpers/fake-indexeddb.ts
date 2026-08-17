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
 * A minimal in-memory `indexedDB`, enough for `git-credential-store.ts`'s `withStore` (#7).
 *
 * **Why this exists.** happy-dom implements no `indexedDB`, and `withStore` deliberately
 * resolves to `null` when it is missing rather than breaking the screen. The consequence for
 * tests is that every IndexedDB path short-circuits: no write is ever observable, so making
 * mode `none` call `writeIdb` — persisting the token the user asked NOT to store — would keep
 * the whole suite green. That is the gap this closes.
 *
 * Hand-rolled rather than adding `fake-indexeddb`: this repo takes no new dependency for
 * something this small, and the surface actually used is four methods.
 *
 * Supports exactly what `withStore` calls: `open()` with `onupgradeneeded`/`onsuccess`/
 * `onerror`/`onblocked`, `createObjectStore`, `transaction()`, `objectStore()`, and a store's
 * `get`/`put`/`delete`. Callbacks fire asynchronously, as the real API does, so a test that
 * accidentally depends on synchronous completion fails here too.
 */

type Listener = (() => void) | null;

interface FakeRequest<T> {
  result: T;
  onsuccess: Listener;
  onerror: Listener;
}

/** Fires a callback on a later microtask, mirroring IndexedDB's async delivery. */
function later(fn: () => void): void {
  queueMicrotask(fn);
}

function makeRequest<T>(compute: () => T): FakeRequest<T> {
  const request: FakeRequest<T> = { result: undefined as T, onsuccess: null, onerror: null };
  later(() => {
    try {
      request.result = compute();
      request.onsuccess?.();
    } catch {
      request.onerror?.();
    }
  });
  return request;
}

export interface FakeIndexedDb {
  /** Every store's contents, keyed by store name — the assertion surface for tests. */
  data: Map<string, Map<string, unknown>>;
  /** Restores whatever `globalThis.indexedDB` was before {@link installFakeIndexedDb}. */
  uninstall(): void;
}

/**
 * Installs the fake on `globalThis` and returns a handle to its contents.
 *
 * @param options.failTransaction - make `transaction()` throw, to exercise the
 *   "connection opened but the transaction never started" branch of `withStore`
 * @param options.blockOpen - fire `onblocked` and then **nothing else, ever**, as a real
 *   `open()` does while another connection still holds the older version open. Modelling the
 *   silence is the point: a handler-less `withStore` does not fail here, it never settles.
 */
export function installFakeIndexedDb(
  options: { failTransaction?: boolean; blockOpen?: boolean } = {},
): FakeIndexedDb {
  const data = new Map<string, Map<string, unknown>>();
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');

  const objectStore = (name: string) => {
    const store = data.get(name)!;
    return {
      get: (key: string) => makeRequest(() => store.get(key)),
      put: (value: unknown, key: string) => makeRequest(() => void store.set(key, value)),
      delete: (key: string) => makeRequest(() => void store.delete(key)),
    };
  };

  const db = {
    objectStoreNames: {
      contains: (name: string) => data.has(name),
    },
    createObjectStore: (name: string) => {
      data.set(name, new Map());
      return objectStore(name);
    },
    transaction: (name: string, _mode: IDBTransactionMode) => {
      if (options.failTransaction) throw new Error('fake: transaction refused');
      if (!data.has(name)) throw new Error(`fake: no object store named ${name}`);
      return { objectStore: () => objectStore(name) };
    },
    close: () => {},
  };

  const fake = {
    open: (_name: string, _version?: number) => {
      const request: {
        result: typeof db;
        onupgradeneeded: Listener;
        onsuccess: Listener;
        onerror: Listener;
        onblocked: Listener;
      } = { result: db, onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null };
      later(() => {
        if (options.blockOpen) {
          request.onblocked?.();
          return; // and no onsuccess/onerror — the request stays pending indefinitely
        }
        // A real open fires upgradeneeded only when the schema is absent; mirroring that
        // keeps `createObjectStore` from being called on every open.
        if (data.size === 0) request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  };

  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: fake });

  return {
    data,
    uninstall() {
      if (previous) Object.defineProperty(globalThis, 'indexedDB', previous);
      else delete (globalThis as { indexedDB?: unknown }).indexedDB;
    },
  };
}
