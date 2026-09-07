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

import rule from '../lint-rules/no-session-key-literals.js';

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
ruleTester.run('no-session-key-literals', rule, {
  valid: [
    { name: 'an unrelated string', code: 'const k = "cca_theme";' },
    { name: 'a near-miss that merely contains the key', code: 'const k = "my_cca_token_backup";' },
    { name: 'an identifier of the same name', code: 'const cca_token = 1;' },
    // The regression that matters. `SESSION_KEYS` is keyed by whatever literal the linted file
    // contains, so a plain object literal resolved these through Object.prototype and reported
    // them as session keys. cca-element.ts contains literals that do exactly this.
    { name: 'a literal named after an Object.prototype member', code: 'const a = "toString";' },
    { name: 'the literal "constructor"', code: 'const a = "constructor";' },
    { name: 'the literal "hasOwnProperty"', code: 'const a = "hasOwnProperty";' },
    { name: 'the literal "valueOf"', code: 'const a = "valueOf";' },
    { name: 'a non-string literal', code: 'const a = 5;' },
  ],
  invalid: [
    {
      name: 'the token key, wherever it is written',
      code: 'const TOKEN_KEY = "cca_token";',
      errors: [{ message: /session token is AuthService's to hold/ }],
    },
    {
      name: 'the username key',
      code: 'const USER_KEY = "cca_user";',
      errors: [{ message: /ctx\.auth\.state\.username/ }],
    },
    {
      // The alias is the point: matching the storage CALL would miss this entirely.
      name: 'the key passed straight to sessionStorage',
      code: 'sessionStorage.getItem("cca_token");',
      errors: [{ message: /See #678/ }],
    },
    {
      name: 'both keys in one file',
      code: 'const a = "cca_token";\nconst b = "cca_user";',
      errors: [
        { message: /session token/, line: 1 },
        { message: /username/, line: 2 },
      ],
    },
  ],
});
