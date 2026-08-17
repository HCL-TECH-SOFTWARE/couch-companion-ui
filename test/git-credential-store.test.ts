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
import {
  GitCredentialStore, CREDENTIAL_MODE_COPY, type CouchTokenIo,
} from '../src/services/git/git-credential-store.js';
import { Logger, Level } from '../src/services/log-service.js';

const fakeCouch = (): CouchTokenIo & { store: Map<string, string | null> } => {
  const store = new Map<string, string | null>();
  return {
    store,
    readToken: async (id) => store.get(id) ?? null,
    writeToken: async (id, token) => { store.set(id, token); },
  };
};

describe('GitCredentialStore', () => {
  beforeEach(() => { vi.unstubAllGlobals(); });

  describe("mode 'none'", () => {
    it('keeps a remembered token for the session and never persists it', async () => {
      const couch = fakeCouch();
      const store = new GitCredentialStore(couch);
      store.remember('acct1', 'ghp_live');
      expect(await store.get('acct1', 'none')).toBe('ghp_live');
      expect(couch.store.size).toBe(0);
    });

    it('returns null when nothing was remembered, so the caller must prompt', async () => {
      expect(await new GitCredentialStore(fakeCouch()).get('acct1', 'none')).toBeNull();
    });

    it('refuses to persist under put()', async () => {
      const couch = fakeCouch();
      await new GitCredentialStore(couch).put('acct1', 'none', 'ghp_x');
      expect(couch.store.size).toBe(0);
    });
  });

  describe("mode 'couchdb'", () => {
    it('round-trips through the injected port', async () => {
      const couch = fakeCouch();
      const store = new GitCredentialStore(couch);
      await store.put('acct1', 'couchdb', 'ghp_couch');
      expect(await store.get('acct1', 'couchdb')).toBe('ghp_couch');
    });
  });

  describe("mode 'indexeddb'", () => {
    it('falls back to the session cache when IndexedDB is unavailable', async () => {
      vi.stubGlobal('indexedDB', undefined);
      const store = new GitCredentialStore(fakeCouch());
      await store.put('acct1', 'indexeddb', 'ghp_idb');
      expect(await store.get('acct1', 'indexeddb')).toBe('ghp_idb');
    });
  });

  describe('withStore failure handling', () => {
    let warnSpy: ReturnType<typeof vi.fn>;
    let savedWarnTarget: typeof Logger.logTarget[typeof Level.WARN];

    beforeEach(() => {
      savedWarnTarget = Logger.logTarget[Level.WARN];
      warnSpy = vi.fn();
      Logger.logTarget[Level.WARN] = warnSpy;
    });

    afterEach(() => {
      Logger.logTarget[Level.WARN] = savedWarnTarget;
    });

    it('closes the connection and warns, instead of leaking the handle or silently skipping the write, when starting a transaction throws synchronously', async () => {
      const close = vi.fn();
      const fakeDb = {
        transaction: () => { throw new Error('InvalidStateError: connection is closing'); },
        close,
      };
      const openRequest: {
        result?: typeof fakeDb;
        onsuccess?: () => void;
        onerror?: () => void;
        onupgradeneeded?: () => void;
      } = {};
      vi.stubGlobal('indexedDB', {
        open: () => {
          queueMicrotask(() => {
            openRequest.result = fakeDb;
            openRequest.onsuccess?.();
          });
          return openRequest;
        },
      });

      // put() must still resolve — the failure is swallowed, not thrown — and it must not
      // silently pretend the write reached the store.
      await expect(new GitCredentialStore(fakeCouch()).put('acct1', 'indexeddb', 'ghp_idb')).resolves.toBeUndefined();

      expect(close).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toMatch(/acct1/);
      expect(warnSpy.mock.calls[0][0]).not.toMatch(/ghp_idb/);
    });
  });

  describe('forget', () => {
    it('clears the session cache and the CouchDB copy together', async () => {
      const couch = fakeCouch();
      const store = new GitCredentialStore(couch);
      await store.put('acct1', 'couchdb', 'ghp_couch');
      store.remember('acct1', 'ghp_live');
      await store.forget('acct1');
      expect(await store.get('acct1', 'none')).toBeNull();
      expect(await store.get('acct1', 'couchdb')).toBeNull();
    });
  });

  describe('copy', () => {
    it('states each trade-off, because the user is choosing a security posture', () => {
      expect(CREDENTIAL_MODE_COPY.none.caution).toMatch(/re-enter/i);
      expect(CREDENTIAL_MODE_COPY.indexeddb.caution).toMatch(/browser profile/i);
      expect(CREDENTIAL_MODE_COPY.couchdb.caution).toMatch(/every server admin/i);
    });

    it('never claims a stored token is encrypted', () => {
      const all = Object.values(CREDENTIAL_MODE_COPY).map((c) => `${c.label} ${c.caution}`).join(' ');
      expect(all).not.toMatch(/encrypt/i);
    });
  });
});
