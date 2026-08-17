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
 * The IndexedDB half of `GitCredentialStore` (#7).
 *
 * `test/git-credential-store.test.ts` cannot observe any of this: happy-dom has no
 * `indexedDB`, so `withStore` short-circuits to `null` in every test and no write is ever
 * visible. The consequence is the gap this file closes — **making mode `none` call `writeIdb`,
 * persisting the very token the user asked not to store, would keep that suite green.**
 *
 * Every test here installs a real (if minimal) in-memory `indexedDB` so writes are
 * observable, and asserts on the store's contents rather than on a spy.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GitCredentialStore, type CouchTokenIo } from '../src/services/git/git-credential-store';
import { installFakeIndexedDb, type FakeIndexedDb } from './helpers/fake-indexeddb';

const ACCOUNT = 'gitaccount:acme';
const TOKEN = 'ghp_do_not_persist_me';

let idb: FakeIndexedDb;

/** Whatever `git-credential-store.ts` names its store — read from the fake, not hardcoded. */
const storedTokens = () => [...idb.data.values()].flatMap((store) => [...store.values()]);

function couchIo(): CouchTokenIo & {
  readToken: ReturnType<typeof vi.fn>;
  writeToken: ReturnType<typeof vi.fn>;
} {
  return {
    readToken: vi.fn().mockResolvedValue(null),
    writeToken: vi.fn().mockResolvedValue(undefined),
  } as never;
}

beforeEach(() => {
  idb = installFakeIndexedDb();
});

afterEach(() => {
  idb.uninstall();
  vi.restoreAllMocks();
});

describe('mode "none"', () => {
  it('never writes the token to IndexedDB', async () => {
    const store = new GitCredentialStore(couchIo());

    await store.put(ACCOUNT, 'none', TOKEN);

    // The assertion the old suite could not make: with no indexedDB present, a stray
    // writeIdb() in this branch was invisible.
    expect(storedTokens()).not.toContain(TOKEN);
    expect(storedTokens()).toHaveLength(0);
  });

  it('never writes the token to CouchDB either', async () => {
    const couch = couchIo();
    const store = new GitCredentialStore(couch);

    await store.put(ACCOUNT, 'none', TOKEN);

    expect(couch.writeToken).not.toHaveBeenCalled();
  });

  it('still serves the token from the session cache for this tab', async () => {
    const store = new GitCredentialStore(couchIo());

    await store.put(ACCOUNT, 'none', TOKEN);

    // `none` means "memory only", not "unusable": the session cache is the whole of it, so
    // the same instance keeps serving the token until the tab goes away.
    await expect(store.get(ACCOUNT, 'none')).resolves.toBe(TOKEN);
  });

  it('does not survive a new store instance — memory only means memory only', async () => {
    await new GitCredentialStore(couchIo()).put(ACCOUNT, 'none', TOKEN);

    // A fresh instance stands in for a reload: nothing persisted, nothing to find.
    await expect(new GitCredentialStore(couchIo()).get(ACCOUNT, 'none')).resolves.toBeNull();
  });
});

describe('mode "indexeddb"', () => {
  it('actually persists the token', async () => {
    const store = new GitCredentialStore(couchIo());

    await store.put(ACCOUNT, 'indexeddb', TOKEN);

    expect(storedTokens()).toContain(TOKEN);
  });

  it('reads it back through a fresh store instance, not the session cache', async () => {
    await new GitCredentialStore(couchIo()).put(ACCOUNT, 'indexeddb', TOKEN);

    // A new instance has an empty session cache, so a hit here proves it came off "disk".
    const fresh = new GitCredentialStore(couchIo());
    await expect(fresh.get(ACCOUNT, 'indexeddb')).resolves.toBe(TOKEN);
  });

  it('keys by account, so one account cannot serve another', async () => {
    const store = new GitCredentialStore(couchIo());
    await store.put(ACCOUNT, 'indexeddb', TOKEN);

    const fresh = new GitCredentialStore(couchIo());
    await expect(fresh.get('gitaccount:other', 'indexeddb')).resolves.toBeNull();
  });
});

/**
 * The trap `DesignMgmtService.changeCredentialMode` exists to work around (#9), pinned here at
 * the layer that owns it so the reason for that method's ordering is visible from this file too.
 *
 * `put()` writes under the mode it is handed and touches no other backing store, and `get()`
 * consults the session cache *before* the mode — so switching an account's mode with `put()`
 * alone leaves the old copy in place, and in the tab that made the switch everything keeps
 * working and the leftover is invisible. Only `forget()` clears all three locations.
 *
 * This is characterisation, not a wish: `put()` is given one mode and has no business guessing
 * which of the other two might hold a stale copy. If it ever does gain that responsibility, this
 * test is the thing that should be rewritten to say so.
 */
describe('switching an account to a different mode', () => {
  it('does not purge the old backing store — put() alone leaves the copy behind', async () => {
    const couch = couchIo();
    const store = new GitCredentialStore(couch);
    await store.put(ACCOUNT, 'indexeddb', TOKEN);

    await store.put(ACCOUNT, 'couchdb', TOKEN);

    expect(couch.writeToken).toHaveBeenCalledWith(ACCOUNT, TOKEN);
    // The abandoned copy the caller has to purge itself.
    expect(storedTokens()).toContain(TOKEN);
  });

  it('purges it when forget() runs first, which is what makes the move safe', async () => {
    const couch = couchIo();
    const store = new GitCredentialStore(couch);
    await store.put(ACCOUNT, 'indexeddb', TOKEN);

    await store.forget(ACCOUNT);
    await store.put(ACCOUNT, 'couchdb', TOKEN);

    expect(storedTokens()).not.toContain(TOKEN);
    expect(couch.writeToken).toHaveBeenLastCalledWith(ACCOUNT, TOKEN);
  });
});

describe('forget', () => {
  it('removes the persisted copy', async () => {
    const store = new GitCredentialStore(couchIo());
    await store.put(ACCOUNT, 'indexeddb', TOKEN);
    expect(storedTokens()).toContain(TOKEN);

    await store.forget(ACCOUNT);

    expect(storedTokens()).not.toContain(TOKEN);
  });

  it('clears the session cache too, so the token does not survive in memory', async () => {
    const store = new GitCredentialStore(couchIo());
    await store.put(ACCOUNT, 'indexeddb', TOKEN);

    await store.forget(ACCOUNT);

    await expect(store.get(ACCOUNT, 'indexeddb')).resolves.toBeNull();
  });
});

describe('when IndexedDB is unavailable', () => {
  it('degrades to null instead of throwing — private browsing, happy-dom', async () => {
    idb.uninstall();

    const store = new GitCredentialStore(couchIo());
    await expect(store.put(ACCOUNT, 'indexeddb', TOKEN)).resolves.toBeUndefined();
    await expect(new GitCredentialStore(couchIo()).get(ACCOUNT, 'indexeddb')).resolves.toBeNull();
  });

  it('degrades to null when the transaction cannot start', async () => {
    idb.uninstall();
    idb = installFakeIndexedDb({ failTransaction: true });

    const store = new GitCredentialStore(couchIo());
    await expect(store.put(ACCOUNT, 'indexeddb', TOKEN)).resolves.toBeUndefined();
    await expect(new GitCredentialStore(couchIo()).get(ACCOUNT, 'indexeddb')).resolves.toBeNull();
  });
});

/**
 * `blocked` (#6, item 14) — **future-proofing, not a live bug fix.**
 *
 * `withStore` pins version 1 and nothing in this repo calls `deleteDatabase`, so no open can
 * ever need a version change and `blocked` cannot fire in the shipped app today. What makes
 * the handler worth one line is the shape of the failure it prevents: a blocked open fires
 * neither `onsuccess` nor `onerror`, so the `new Promise` never settles and every caller
 * awaiting a token hangs — including `forget()`, which would then never reach its CouchDB
 * half either. That is strictly worse than the documented degradation, and the module's own
 * docstring already promises the store degrades "when IndexedDB is missing **or blocked**".
 * The day someone bumps the version to add a store, an old tab holding a connection is enough
 * to trigger it.
 *
 * The race below exists because the pre-fix failure is a hang, not a rejection: without it
 * this test would time out the whole file instead of failing on its own assertion.
 */
describe('when the IndexedDB open request is blocked', () => {
  const TIMED_OUT = Symbol('never settled');

  const settledWithin = <T>(work: Promise<T>, ms = 50): Promise<T | typeof TIMED_OUT> =>
    Promise.race([
      work,
      new Promise<typeof TIMED_OUT>((resolve) => setTimeout(() => resolve(TIMED_OUT), ms)),
    ]);

  beforeEach(() => {
    idb.uninstall();
    idb = installFakeIndexedDb({ blockOpen: true });
  });

  it('resolves null rather than hanging forever on a read', async () => {
    const store = new GitCredentialStore(couchIo());

    await expect(settledWithin(store.get(ACCOUNT, 'indexeddb'))).resolves.toBeNull();
  });

  it('lets a write settle too, instead of stalling the caller that awaits it', async () => {
    const store = new GitCredentialStore(couchIo());

    await expect(settledWithin(store.put(ACCOUNT, 'indexeddb', TOKEN))).resolves.toBeUndefined();
  });

  it('does not strand forget() before it reaches the CouchDB copy', async () => {
    const couch = couchIo();
    const store = new GitCredentialStore(couch);

    await expect(settledWithin(store.forget(ACCOUNT))).resolves.toBeUndefined();
    // The assertion that matters: a hang in the IndexedDB half would leave the server-side
    // copy of the token in place, with no error anywhere to say so.
    expect(couch.writeToken).toHaveBeenCalledWith(ACCOUNT, null);
  });
});
