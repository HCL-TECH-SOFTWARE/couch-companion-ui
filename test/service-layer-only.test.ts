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

import { RuleTester } from 'oxlint/plugins-dev';
import { describe, it } from 'vitest';

import rule from '../lint-rules/service-layer-only.js';

// vitest runs with `globals: false` (vitest.config.ts), so RuleTester cannot find describe/it.
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester({
  eslintCompat: true,
  languageOptions: { sourceType: 'module' },
});

// The rule must be observed to REPORT, not merely to pass. A rule whose matcher silently finds
// nothing would sail through a suite made only of `valid` cases — the vacuity hole #718 found.
//
// Which FILES are exempt is not testable here — that lives in `overrides` in .oxlintrc.json, and
// is covered by linting the real tree. This suite pins what the matcher does.
ruleTester.run('service-layer-only', rule, {
  valid: [
    { name: 'a service method that is not request()', code: 'this.api.get("/x");' },
    { name: 'a bare call of the same name', code: 'request({ path: "/x" });' },
    // Only the CALL is reported. Passing the method as a value is rare enough not to be worth
    // the false positives, and the call is where the layering actually breaks.
    { name: 'the method referenced but not called', code: 'const fn = this.api.request;' },
    { name: 'a similarly-named method', code: 'this.api.requestAll({});' },
    { name: 'a property read', code: 'const n = this.api.requests;' },
  ],
  invalid: [
    {
      name: 'a component calling request()',
      code: 'this.ctx.api.request({ path: "/db" });',
      errors: [{ message: /Only services may call ApiClient\.request\(\)/ }],
    },
    {
      name: 'a component calling requestWithHeaders()',
      code: 'this.ctx.api.requestWithHeaders({ path: "/db" });',
      errors: [{ message: /See #678/ }],
    },
    {
      name: 'the call however the client is reached',
      code: 'getClient().request({});',
      errors: 1,
    },
  ],
});
