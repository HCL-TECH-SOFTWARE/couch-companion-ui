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

import type { ApiClient } from "./api-client.js";
import { getLogger } from "./log-service.js";

const log = getLogger("services/native-idp");

/** The future native CouchDB endpoint (§5). We defined the shape; nothing serves it yet. */
export const NATIVE_IDP_PATH = "/_idp";

/**
 * Probed once per page load. The answer cannot change without a CouchDB that grew the endpoint
 * mid-session, and the probe runs on the login screen where a repeated request is a visible
 * cost.
 */
let probe: Promise<boolean> | null = null;

/**
 * Whether this CouchDB serves `/_idp` natively.
 *
 * The `idp` database is a **stopgap until CouchDB supports `/_idp`** (#32). When the native
 * endpoint answers, the node config is the only home the metadata needs and this app must
 * never create, secure, or write the `idp` database — see
 * `IdpService.publishDiscoveryDocument`.
 *
 * Read through {@link ApiClient.requestPreAuth}, never `request`: this runs at boot, possibly
 * with no session, and CouchDB answers the reserved `/_idp` path with **401** rather than 404
 * (verified live against 3.5.2). Through the ordinary path that 401 trips the centralized
 * logout.
 *
 * "Present" means a response carrying an `idps` array, not merely a 2xx: a reverse proxy that
 * answers unknown paths with an HTML error page would otherwise read as a native endpoint and
 * silently suppress the stopgap.
 */
export function detectNativeIdp(api: ApiClient): Promise<boolean> {
  probe ??= runProbe(api);
  return probe;
}

async function runProbe(api: ApiClient): Promise<boolean> {
  try {
    const body = await api.requestPreAuth<{ idps?: unknown }>(NATIVE_IDP_PATH);
    const native = Array.isArray(body?.idps);
    log.debug?.(native ? "native /_idp endpoint found" : "/_idp answered, but not with idps");
    return native;
  } catch (err) {
    log.debug?.("no native /_idp endpoint; using the idp database stopgap", err as Error);
    return false;
  }
}

/** Drops the cached answer. For tests, and for nothing else — the probe is per page load. */
export function resetNativeIdpProbe(): void {
  probe = null;
}
