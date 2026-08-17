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

const log = getLogger('services/git/git-credential-store');

/** Where a git personal access token is allowed to live (spec D12). */
export type CredentialMode = 'none' | 'indexeddb' | 'couchdb';

/**
 * The CouchDB half of the store, injected rather than imported, so the credential store does not
 * depend on the `couchcompanion` document layer (and stays testable without it).
 */
export interface CouchTokenIo {
  readToken(accountId: string): Promise<string | null>;
  writeToken(accountId: string, token: string | null): Promise<void>;
}

const DB_NAME = 'couch-companion-ui';
const STORE_NAME = 'git-credentials';

/**
 * User-facing copy for each option. It lives beside the implementation so a change to how a token
 * is stored cannot silently leave the promise about it stale.
 *
 * No option is encrypted, and none of this copy pretends otherwise: nothing in a backend-less app
 * can hold a key the user's browser cannot also read, so encryption here would be decoration.
 */
export const CREDENTIAL_MODE_COPY: Record<CredentialMode, { label: string; caution: string }> = {
  none: {
    label: 'Do not store (recommended)',
    caution: 'Held in memory for this tab only. You re-enter the token each session.',
  },
  indexeddb: {
    label: 'This browser',
    caution:
      'Stored in plain text in this browser profile, for this origin. Anyone with the profile — ' +
      'or any script injected into this origin — can read it.',
  },
  couchdb: {
    label: 'On the CouchDB server',
    caution:
      'Stored in plain text in the couchcompanion database, so it follows you between browsers ' +
      'and is readable by every server admin.',
  },
};

/**
 * Resolves a git token according to the mode the user chose for that account.
 *
 * The session cache backs every mode: it is the whole of `none`, the write-through for
 * `indexeddb`, and a read cache for `couchdb`. It is a plain `Map` — deliberately not
 * `sessionStorage`, which would survive a reload and quietly turn `none` into persistence.
 */
export class GitCredentialStore {
  private readonly session = new Map<string, string>();

  constructor(private readonly couch: CouchTokenIo) {}

  /** Remembers a token for this tab only. Used for `none`, and after any prompt. */
  remember(accountId: string, token: string): void {
    this.session.set(accountId, token);
  }

  async get(accountId: string, mode: CredentialMode): Promise<string | null> {
    const cached = this.session.get(accountId);
    if (cached !== undefined) return cached;
    if (mode === 'none') return null;

    const stored = mode === 'couchdb'
      ? await this.couch.readToken(accountId)
      : await readIdb(accountId);

    if (stored !== null) this.session.set(accountId, stored);
    return stored;
  }

  async put(accountId: string, mode: CredentialMode, token: string): Promise<void> {
    this.session.set(accountId, token);
    if (mode === 'couchdb') await this.couch.writeToken(accountId, token);
    else if (mode === 'indexeddb') await writeIdb(accountId, token);
    // mode 'none': the session cache above is the entire persistence story, by design.
  }

  /** Clears every copy of the token, whichever mode wrote it. */
  async forget(accountId: string): Promise<void> {
    this.session.delete(accountId);
    await writeIdb(accountId, null);
    await this.couch.writeToken(accountId, null);
  }
}

/**
 * IndexedDB accessors. They resolve to `null` rather than rejecting when IndexedDB is missing or
 * blocked (private-browsing modes, happy-dom under vitest): a credential store that cannot reach
 * its cache should send the caller to the prompt, not break the screen.
 *
 * `accountId` is threaded through purely so a failure can be logged with something to point at —
 * it is never the token, and is only used after every avenue to actually reach the store failed.
 */
const withStore = <T>(
  mode: IDBTransactionMode,
  accountId: string,
  work: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | null> =>
  new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(null);
    let open: IDBOpenDBRequest;
    try {
      open = indexedDB.open(DB_NAME, 1);
    } catch {
      return resolve(null);
    }
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains(STORE_NAME)) open.result.createObjectStore(STORE_NAME);
    };
    open.onerror = () => resolve(null);
    // Future-proofing, not a fix for anything reachable today: `open()` above pins version 1
    // and nothing in this repo calls `deleteDatabase`, so no open here can need a version
    // change, and `blocked` cannot fire. It is one line because of how the missing handler
    // fails — a blocked open fires neither `onsuccess` nor `onerror`, so this promise would
    // never settle and every caller awaiting a token would hang, `forget()` included. The
    // day the schema gains a store and the version is bumped, one stale tab is enough.
    open.onblocked = () => resolve(null);
    open.onsuccess = () => {
      try {
        const tx = open.result.transaction(STORE_NAME, mode);
        const request = work(tx.objectStore(STORE_NAME));
        request.onsuccess = () => { resolve(request.result ?? null); open.result.close(); };
        request.onerror = () => { resolve(null); open.result.close(); };
      } catch (err) {
        // The connection opened successfully but starting the transaction (or issuing the
        // request itself) threw synchronously, so `work()` never ran — for `writeIdb`, that
        // means the delete/put was never even attempted. Close the handle so it isn't leaked,
        // and warn so a `forget()` that silently left a copy behind leaves a trace somewhere.
        open.result.close();
        log.warn(
          `IndexedDB ${mode} transaction failed to start for account "${accountId}"; the store was not touched`,
          err instanceof Error ? err : { error: err },
        );
        resolve(null);
      }
    };
  });

const readIdb = (accountId: string): Promise<string | null> =>
  withStore<string>('readonly', accountId, (store) => store.get(accountId) as IDBRequest<string>);

const writeIdb = async (accountId: string, token: string | null): Promise<void> => {
  await withStore('readwrite', accountId, (store) =>
    (token === null ? store.delete(accountId) : store.put(token, accountId)) as unknown as IDBRequest<never>,
  );
};
