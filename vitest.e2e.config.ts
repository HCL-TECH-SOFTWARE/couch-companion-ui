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

import { defineConfig } from 'vitest/config';

/**
 * Config for the on-demand E2E harness (`npm run test:e2e`) — real GitHub, real CouchDB, no
 * mocks. Deliberately separate from `vitest.config.ts`:
 *
 *   - `environment: 'node'`. This suite never touches the DOM; `happy-dom` (and the default
 *     suite's `test/setup.ts`, which registers icon libraries and DOM polyfills a real service
 *     layer has no use for) would be pure overhead here.
 *   - No coverage thresholds — `vitest.config.ts`'s 65% floor is ratcheted against the mocked
 *     unit suite; gating an on-demand, credential-gated suite on coverage would either force it
 *     into every `npm test` run (breaking hermeticity) or report a meaningless number on the
 *     runs where it skips outright.
 *   - A generous timeout — every test in here does real network I/O (GitHub Enterprise commits,
 *     a Keycloak password grant, real CouchDB writes), an order of magnitude slower than the
 *     mocked suite's assertions.
 *   - `globalSetup` loads `.env.local` (gitignored) into `process.env` before anything else runs,
 *     so a human's local credentials reach the suite without ever touching a committed file. CI
 *     sets real env vars directly and has no `.env.local`; `global-setup.ts` skips the file
 *     without error and CI's own values are used as-is.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/e2e/**/*.e2e.test.ts'],
    globals: false,
    globalSetup: ['test/e2e/global-setup.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
