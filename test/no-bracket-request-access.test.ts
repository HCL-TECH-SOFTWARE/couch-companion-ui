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

import rule from '../lint-rules/no-bracket-request-access.js';

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
// This rule has no exemptions anywhere: even auth-service.ts, excused from the session-key rule,
// is held to it.
ruleTester.run('no-bracket-request-access', rule, {
  valid: [
    { name: 'the ordinary dot call', code: 'this.api.request({});' },
    { name: 'bracket access to something else', code: 'this.api["get"]({});' },
    // A computed key that is not a string literal has no `property.value` to match. Reporting it
    // would mean flagging every dynamic member access in the codebase.
    { name: 'a dynamic computed key', code: 'this.api[method]({});' },
    { name: 'an array index', code: 'const first = items[0];' },
    { name: 'a near-miss string', code: 'this.api["requestAll"]({});' },
  ],
  invalid: [
    {
      name: 'bracket access to request',
      code: 'this.api["request"]({ path: "/db" });',
      errors: [{ message: /Bracket access was a workaround for `private`/ }],
    },
    {
      name: 'bracket access to requestWithHeaders',
      code: 'this.api["requestWithHeaders"]({});',
      errors: [{ message: /See #683/ }],
    },
    {
      // Reported on the member access itself, so it fires even without a call.
      name: 'bracket access that is never called',
      code: 'const fn = this.api["request"];',
      errors: 1,
    },
  ],
});
