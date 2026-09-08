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

import rule from '../lint-rules/no-cca-custom-property.js';

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
ruleTester.run('no-cca-custom-property', rule, {
  valid: [
    { code: 'const s = css`div { color: var(--wa-color-text-quiet); }`;' },
    { code: 'const s = css`div { border-radius: var(--wa-border-radius-m); }`;' },
    { code: 'const s = "color:var(--wa-color-text-link)";' },
    // Setting a Web Awesome component token is fine; only --cca- is banned.
    { code: 'const s = css`wa-input { --wa-form-control-height: 2.5rem; }`;' },
    // A bare identifier that merely starts with "cca" is not a --cca- custom property.
    { code: 'const s = css`div { background-image: url(/assets/ccalogo.jpg); }`;' },
    { code: 'const key = "ccaTheme";' },
  ],
  invalid: [
    // A `static styles = css`...`` block is one template literal spanning hundreds of lines.
    // Reporting the node would point every violation at line 1, so the rule reports the offset of
    // the property itself. Line and column are the whole point of this case.
    {
      code: ['const s = css`', '  div {', '    color: var(--cca-text-muted);', '  }', '`;'].join('\n'),
      errors: [
        {
          messageId: 'ccaProperty',
          data: { property: '--cca-text-muted' },
          line: 3,
          column: 16, // where `--cca-text-muted` starts on that line, not the template's line 1
        },
      ],
    },
    // A reference.
    {
      code: 'const s = css`div { color: var(--cca-text-muted); }`;',
      errors: [{ messageId: 'ccaProperty', data: { property: '--cca-text-muted' } }],
    },
    // A declaration. Both directions must fail, or the property creeps back in via :root.
    {
      code: 'const s = css`:host { --cca-radius: 6px; }`;',
      errors: [{ messageId: 'ccaProperty' }],
    },
    // Inline style= attribute strings are how several components carry CSS.
    {
      code: 'const s = "color:var(--cca-primary,#0f3460)";',
      errors: [{ messageId: 'ccaProperty' }],
    },
    // Two in one quasi must both report.
    {
      code: 'const s = css`div { color: var(--cca-text); border-radius: var(--cca-radius); }`;',
      errors: [{ messageId: 'ccaProperty' }, { messageId: 'ccaProperty' }],
    },
    // The bridge pattern that #729 removed: a custom property declared inline to carry an asset URL.
    {
      code: 'const s = html`<div style=${`--cca-login-bg: url(${logo});`}></div>`;',
      errors: [{ messageId: 'ccaProperty' }],
    },
  ],
});
