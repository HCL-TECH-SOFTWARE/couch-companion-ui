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

import { ApiError } from "../../services/api-error.js";
import { describeDbAccessError } from "../../services/db-enumeration.js";

/** In-repo guide the error dialog links to; written for exactly these failures. */
export const CORS_HELP_URL =
  "https://github.com/HCL-TECH-SOFTWARE/couch-companion-ui/blob/main/docs/cors.md";
export const COUCHDB_CORS_DOCS_URL =
  "https://docs.couchdb.org/en/stable/config/http.html#cross-origin-resource-sharing";

/**
 * User-facing explanation for a failed request against a replication endpoint's
 * server. Three stories, because three different people fix them:
 * - 401/403: credentials — fixable right here in the Authentication dialog.
 * - a fetch TypeError: the browser was refused before HTTP happened. CORS not
 *   being enabled on that server and the server being unreachable produce the
 *   same opaque error, and the copy says so instead of guessing.
 * - 404: the tailored not-found copy from `describeDbAccessError`.
 * - anything else: the server answered; relay what it said, with its HTTP status.
 */
export function describeEndpointFailure(err: unknown): {
  title: string;
  detail: string;
  corsRelated: boolean;
} {
  if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
    return {
      title: "The server refused the request",
      detail: `${describeDbAccessError(err)} Check the credentials entered in the Authentication dialog for this endpoint.`,
      corsRelated: false,
    };
  }
  if (err instanceof ApiError && err.status === 404) {
    return {
      title: "Not found on that server",
      detail: describeDbAccessError(err),
      corsRelated: false,
    };
  }
  if (err instanceof TypeError) {
    return {
      title: "Could not reach the server",
      detail:
        "The browser could not complete the request. Either the server is unreachable from this machine, or it does not allow cross-origin (CORS) requests from this app — a browser cannot tell these two apart. If the server is up, enabling CORS on it is usually the fix. Note that the replication itself runs server-to-server and needs no CORS; only browsing from this screen does.",
      corsRelated: true,
    };
  }
  const message =
    err instanceof Error && err.message.trim()
      ? err.message
      : "The server returned an unexpected response.";
  return {
    title: "The request failed",
    detail: err instanceof ApiError ? `HTTP ${err.status}: ${message}` : message,
    corsRelated: false,
  };
}
