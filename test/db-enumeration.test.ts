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
 * CouchDB refuses database access in three different ways that are trivially confused and
 * mean opposite things. The statuses and bodies below were measured live against CouchDB
 * 3.5.2 on 2026-08-07 and are the ground truth these tests encode:
 *
 *   GET /_all_dbs   as any non-admin      401 {"error":"unauthorized","reason":"You are not a server admin."}
 *   GET /{db}       as a non-member       403 {"error":"forbidden","reason":"You are not allowed to access this db."}
 *   GET /{db}       that does not exist   404 {"error":"not_found","reason":"Database does not exist."}
 *
 * The assertions deliberately test the *distinction* — that each status yields its own copy,
 * naming the thing that status actually means — rather than pinning exact sentences, which
 * would only make this file a mirror of the implementation.
 */

import { describe, it, expect } from 'vitest';

import { ApiError } from '../src/services/api-error';
import { describeDbAccessError, isEnumerationDenied } from '../src/services/db-enumeration';

/** Verbatim CouchDB 3.5.2 refusals, shaped exactly as `ApiClient` raises them. */
const allDbsUnauthorized = () =>
  new ApiError(401, 'You are not a server admin.', {
    error: 'unauthorized',
    reason: 'You are not a server admin.'
  });

const dbForbidden = () =>
  new ApiError(403, 'You are not allowed to access this db.', {
    error: 'forbidden',
    reason: 'You are not allowed to access this db.'
  });

const dbNotFound = () =>
  new ApiError(404, 'Database does not exist.', {
    error: 'not_found',
    reason: 'Database does not exist.'
  });

/**
 * The same 401 status, but from a per-database read (`GET /{db}/_all_docs` with credentials the
 * database does not accept) rather than from `GET /_all_dbs`. Nothing in the error distinguishes
 * it from the one above — which is the whole reason the caller passes a scope (#66).
 */
const dbUnauthorized = () =>
  new ApiError(401, 'You are not authorized to access this db.', {
    error: 'unauthorized',
    reason: 'You are not authorized to access this db.'
  });

describe('isEnumerationDenied', () => {
  it('is true for the 401 a non-admin gets from GET /_all_dbs', () => {
    expect(isEnumerationDenied(allDbsUnauthorized())).toBe(true);
  });

  it('is true for a 403, which a proxy or a hardened config can substitute for the 401', () => {
    expect(isEnumerationDenied(dbForbidden())).toBe(true);
  });

  it('is false for 404 — a missing database is not a permission refusal', () => {
    expect(isEnumerationDenied(dbNotFound())).toBe(false);
  });

  it('is false for a 500, which is a genuine server fault and must keep surfacing as one', () => {
    expect(isEnumerationDenied(new ApiError(500, 'Internal server error'))).toBe(false);
  });

  it('is false for a plain Error', () => {
    expect(isEnumerationDenied(new Error('boom'))).toBe(false);
  });

  it('is false for a network failure', () => {
    expect(isEnumerationDenied(new TypeError('Failed to fetch'))).toBe(false);
  });

  it('is false for undefined and null', () => {
    expect(isEnumerationDenied(undefined)).toBe(false);
    expect(isEnumerationDenied(null)).toBe(false);
  });

  it('is false for a non-ApiError that merely looks like one', () => {
    // Only `ApiClient` mints `ApiError`, so a status-carrying POJO came from somewhere
    // else and has not been through the response handling this module reasons about.
    expect(isEnumerationDenied({ status: 401, message: 'You are not a server admin.' })).toBe(
      false
    );
  });
});

describe('describeDbAccessError', () => {
  const copy401 = () => describeDbAccessError(allDbsUnauthorized());
  const copy403 = () => describeDbAccessError(dbForbidden(), 'orders');
  const copy404 = () => describeDbAccessError(dbNotFound(), 'ordrs');

  it('gives 401, 403 and 404 three different explanations', () => {
    const all = [copy401(), copy403(), copy404()];
    expect(new Set(all).size).toBe(3);
    for (const text of all) expect(text.length).toBeGreaterThan(0);
  });

  it('explains a 401 as the database list being administrator-only, not as a lost session', () => {
    const text = copy401();
    expect(text).toMatch(/administrator/i);
    expect(text).toMatch(/list/i);
    expect(text).not.toMatch(/sign in again|log in again|session (has )?expired/i);
  });

  it('does not blame a database for a 401, which refuses the endpoint rather than a database', () => {
    expect(describeDbAccessError(allDbsUnauthorized(), 'orders')).not.toMatch(/orders/);
  });

  it('explains a 403 as this database not being open to the user, and names it', () => {
    const text = copy403();
    expect(text).toContain('orders');
    expect(text).toMatch(/member|access/i);
    // The trap: telling someone a database they cannot read is missing.
    expect(text).not.toMatch(/does not exist|no database|spelling/i);
  });

  it('explains a 404 as no such database, and names it', () => {
    const text = copy404();
    expect(text).toContain('ordrs');
    expect(text).toMatch(/exist|no database/i);
    // The mirror trap: telling someone a typo is a permission problem.
    expect(text).not.toMatch(/member|permission|not allowed/i);
  });

  it('still explains 403 and 404 when no database name is available', () => {
    const forbidden = describeDbAccessError(dbForbidden());
    const missing = describeDbAccessError(dbNotFound());

    expect(forbidden).toMatch(/member|access/i);
    expect(missing).toMatch(/exist|no database/i);
    expect(forbidden).not.toBe(missing);
    expect(`${forbidden}${missing}`).not.toMatch(/undefined|\bnull\b/);
  });

  it('falls back to the error’s own message for a status the table does not cover', () => {
    const text = describeDbAccessError(new ApiError(500, 'Internal server error'), 'orders');
    expect(text).toContain('Internal server error');
    expect([copy401(), copy403(), copy404()]).not.toContain(text);
  });

  it('falls back to the message of a plain Error', () => {
    expect(describeDbAccessError(new Error('boom'))).toContain('boom');
  });

  it('returns readable copy for undefined and null rather than leaking the value', () => {
    for (const value of [undefined, null]) {
      const text = describeDbAccessError(value);
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toMatch(/undefined|\bnull\b/);
    }
  });
});

/**
 * #66. A 401 is two different refusals wearing one status, and the error body cannot tell them
 * apart — only the caller knows whether it asked for `_all_dbs` or for one database's documents.
 * These two branches were a single sentence written for `_all_dbs`, so the document list told
 * people that "listing the databases on this server" was administrator-only when what had
 * actually been refused was a read of the database they were looking at. A test per scope, so
 * they cannot quietly collapse back into one.
 */
describe('describeDbAccessError — the 401 follows the scope of the refused call (#66)', () => {
  const serverScope = () => describeDbAccessError(allDbsUnauthorized(), undefined, 'server');
  const databaseScope = () => describeDbAccessError(dbUnauthorized(), 'orders', 'database');

  it('keeps the administrator-only listing copy for a server-wide endpoint', () => {
    const text = serverScope();
    expect(text).toMatch(/listing the databases/i);
    expect(text).toMatch(/administrator/i);
  });

  it('defaults to server scope, so the endpoints this module was written for are unchanged', () => {
    expect(describeDbAccessError(allDbsUnauthorized())).toBe(serverScope());
  });

  it('explains a per-database 401 as that database being unreadable', () => {
    const text = databaseScope();
    expect(text).toMatch(/read/i);
    // The defect itself: nothing about enumerating the server's databases was refused here.
    expect(text).not.toMatch(/listing the databases|list them for you/i);
  });

  it('names the database at database scope, where a database really was refused', () => {
    expect(databaseScope()).toContain('orders');
  });

  it('still reads cleanly at database scope with no name to weave in', () => {
    const text = describeDbAccessError(dbUnauthorized(), undefined, 'database');
    expect(text).toMatch(/this database/i);
    expect(text).not.toMatch(/undefined|\bnull\b|""/);
  });

  it('gives the two scopes genuinely different copy', () => {
    expect(databaseScope()).not.toBe(serverScope());
  });

  it('never reads as an expired session at either scope', () => {
    // `ApiClient` proves the session is alive before it would log anyone out and only then
    // rethrows, so "sign in again" is the one thing a 401 reaching here does not mean.
    for (const text of [serverScope(), databaseScope()]) {
      expect(text).not.toMatch(/sign in again|log in again|session (has )?expired/i);
    }
  });

  it('leaves 403 and 404 identical at both scopes — only the 401 is ambiguous', () => {
    for (const err of [dbForbidden(), dbNotFound()]) {
      expect(describeDbAccessError(err, 'orders', 'database')).toBe(
        describeDbAccessError(err, 'orders', 'server')
      );
    }
  });

  it('leaves the fallback identical at both scopes', () => {
    const err = new ApiError(500, 'Internal server error');
    expect(describeDbAccessError(err, 'orders', 'database')).toBe(
      describeDbAccessError(err, 'orders', 'server')
    );
  });
});
