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

import { loadEnvLocal } from '../../scripts/lib/env-local.mjs';

/**
 * Loads `.env.local` (gitignored, human-created) into `process.env` before the E2E suite runs.
 *
 * The parsing lives in `scripts/lib/env-local.mjs` because the SPA-mode gate
 * (`scripts/spa-check.mjs`, #37) needs exactly the same thing from plain Node, with no vitest
 * around it. Two copies would drift, and a drifted `.env.local` parser presents as a credential
 * that is set but not seen — the least debuggable failure this file could have.
 *
 * Vitest's `globalSetup` runs once, before test files are spawned, so its `process.env`
 * mutations are inherited by them.
 */
export function setup(): void {
  loadEnvLocal();
}
