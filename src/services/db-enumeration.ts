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

import { ApiError } from "./api-error.js";

/**
 * The single definition of "CouchDB refused us a database", shared by every screen that has to
 * degrade gracefully when the signed-in user is not a server admin (#5).
 *
 * CouchDB 3.5.2 refuses in three ways that look alike and mean opposite things (measured live
 * against 3.5.2 on 2026-08-07):
 *
 * | Request                         | Status | `error`        | `reason`                              | Means                               |
 * | ------------------------------- | ------ | -------------- | ------------------------------------- | ----------------------------------- |
 * | `GET /_all_dbs` as a non-admin  | 401    | `unauthorized` | You are not a server admin.           | this **endpoint** is admin-only     |
 * | `GET /{db}` as a non-member     | 403    | `forbidden`    | You are not allowed to access this db.| you may not touch this **database** |
 * | `GET /{db}` that does not exist | 404    | `not_found`    | Database does not exist.              | no such database, or a typo         |
 *
 * Two things this module exists to stop each call site getting wrong:
 *
 *  1. **The 401 does not mean the session expired.** CouchDB answers 401 — not 403 — when an
 *     *authenticated* non-admin reads an admin-only endpoint. `ApiClient` already proves the
 *     session is alive before it would log anyone out, and then rethrows (see the 401 branch of
 *     `ApiClient.requestWithHeaders`), so by the time an error reaches here, "sign in again" is
 *     the one thing it is not.
 *  2. **404 is not a permission problem, and 403 is not a missing database.** Telling someone
 *     their database is gone when they simply are not a member of it — or the reverse — sends
 *     them to the wrong person for help.
 *
 * The one thing the *status* alone cannot say is which of two refusals a 401 is: a per-database
 * read (`GET /{db}/_all_docs` and friends) answers 401 too when the caller carries no credentials
 * the database accepts, and there "listing the databases on this server" describes nothing that
 * happened (#66). The caller knows what it called, so it says so — see {@link DbAccessScope}.
 *
 * Pure by design: no I/O, no `getContext()`. Callers must react to the error they actually got
 * and must never pre-gate on `isAdmin` — the endpoint is *not* unconditionally admin-only.
 * `[chttpd] admin_only_all_dbs = false` (note the section; `[couchdb]` is silently ignored)
 * makes a non-admin's `GET /_all_dbs` return 200, and a UI that hid the list from every
 * non-admin would then be hiding a list the server was willing to serve.
 */

/**
 * The 401 at `"server"` scope, and only there — this sentence is true of `GET /_all_dbs` and of
 * nothing under `/{db}/...`.
 *
 * Phrased around the *list* rather than the account: the user has not done anything wrong, and
 * the restriction may well be lifted by an operator (`admin_only_all_dbs`). Matches the tone of
 * the existing admin-only degradations in the design-mgmt plugin.
 */
const ENUMERATION_DENIED =
  "Listing the databases on this server is a server-administrator action by CouchDB's own " +
  "default security. You can still open a database directly by typing its name, or ask a " +
  "server administrator to list them for you.";

/**
 * What CouchDB was asked for, and therefore what a 401 back from it means:
 *
 *  * `"server"` — a server-wide endpoint (`_all_dbs`, `_active_tasks`, `_node/...`). The
 *    **endpoint** is admin-only; no database is implicated, and naming one would misdirect.
 *  * `"database"` — a call under `/{db}/...` (the database document itself, `_all_docs`,
 *    `_find`, …). The refusal is about that **one database**, which is readable by someone —
 *    just not by whoever is (or is not) signed in right now.
 *
 * 403 and 404 need no such hint: both only ever come back from a per-database call, so the
 * scope changes the 401 branch and nothing else.
 */
export type DbAccessScope = "server" | "database";

/**
 * True when CouchDB refused on *permission* grounds and the caller should fall back to a
 * degraded path (ask for a database by name) instead of showing an error.
 *
 * 401 is what CouchDB itself returns for `GET /_all_dbs`; 403 is accepted too because a
 * reverse proxy or a hardened deployment may substitute it for the same refusal. Everything
 * else — a network failure, a 404, a 500, a plain `Error` — is a genuine fault and stays an
 * error rather than being reinterpreted as "you lack permission".
 *
 * Only `ApiClient` mints {@link ApiError}, so a status-carrying object from anywhere else has
 * not been through the response handling this module reasons about and is not treated as one.
 */
export function isEnumerationDenied(err: unknown): boolean {
  const status = httpStatusOf(err);
  return status === 401 || status === 403;
}

/**
 * User-facing copy for a refused database read — a different sentence per row of the table
 * above, each naming what that status actually means and what the reader can do next.
 *
 * @param dbName - the database that was being opened, woven into the 403 and 404 copy, and into
 *   a 401 at `"database"` scope. A `"server"` scope 401 refuses the *endpoint* rather than a
 *   database, so its copy deliberately names none even when one is supplied: blaming the
 *   database the user typed for an admin-only listing would be misleading.
 * @param scope - what was called, per {@link DbAccessScope}. Defaults to `"server"` because the
 *   server-wide listing is where this module started; every per-database call site passes
 *   `"database"` explicitly, since it is precisely the distinction being drawn.
 * @returns copy for 401/403/404; for any other error, the error's own message, or a plain
 *   sentence when it carries none (a bare `String(err)` would put "undefined" on screen).
 */
export function describeDbAccessError(
  err: unknown,
  dbName?: string,
  scope: DbAccessScope = "server",
): string {
  switch (httpStatusOf(err)) {
    case 401:
      if (scope === "server") return ENUMERATION_DENIED;
      return dbName
        ? `The database "${dbName}" is not readable without signing in, or your account is not allowed to read it. Sign in with an account that has access, or ask a server administrator to add you to its members.`
        : "This database is not readable without signing in, or your account is not allowed to read it. Sign in with an account that has access, or ask a server administrator to add you to its members.";
    case 403:
      return dbName
        ? `Your account is not a member of the database "${dbName}", so CouchDB will not open it. Ask a server administrator to add you to its members.`
        : "Your account is not a member of this database, so CouchDB will not open it. Ask a server administrator to add you to its members.";
    case 404:
      return dbName
        ? `There is no database named "${dbName}" on this server. Check the spelling, or ask a server administrator whether it still exists.`
        : "There is no database by that name on this server. Check the spelling, or ask a server administrator whether it still exists.";
    default:
      return fallbackMessage(err);
  }
}

/** The HTTP status of a CouchDB response failure, or `null` for anything that is not one. */
function httpStatusOf(err: unknown): number | null {
  return err instanceof ApiError ? err.status : null;
}

function fallbackMessage(err: unknown): string {
  const message =
    err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return (
    message.trim() ||
    "The database could not be reached. Try again in a moment."
  );
}
