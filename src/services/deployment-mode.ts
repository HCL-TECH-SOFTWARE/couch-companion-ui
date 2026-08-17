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

import type { ApiClient } from "./api-client";

/**
 * How this bundle is being served (spec D5).
 * - `same-origin`: served BY CouchDB (e.g. replacing Fauxton at /_utils) —
 *   the API base is the page origin and the server picker is hidden.
 * - `spa`: static hosting — the user picks the CouchDB URL at login.
 */
export interface Deployment {
  mode: "same-origin" | "spa";
  baseUrl: string;
}

/** Probes `{origin}/_up` once at boot; anything but a CouchDB answer means SPA mode. */
export async function detectDeployment(api: ApiClient): Promise<Deployment> {
  const origin = window.location.origin;
  const up = await api.probeUp(origin);
  return up ? { mode: "same-origin", baseUrl: origin } : { mode: "spa", baseUrl: "" };
}
