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

import { Linter, RuleTester } from 'eslint';
import { describe, expect, it } from 'vitest';

import rule from '../eslint-rules/no-hardcoded-typography.js';

// vitest runs with `globals: false` (vitest.config.ts), so RuleTester cannot find describe/it.
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

describe('report location', () => {
  // A `static styles = css`...`` block is one template literal spanning hundreds of lines.
  // Reporting the node would point every violation at line 1.
  it('points at the declaration, not at the top of the template literal', () => {
    const code = ['const s = css`', '  div {', '    font-size: 0.875rem;', '  }', '`;'].join('\n');

    const messages = new Linter().verify(code, {
      plugins: { cca: { rules: { 'no-hardcoded-typography': rule } } },
      rules: { 'cca/no-hardcoded-typography': 'error' },
      languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
    });

    expect(messages).toHaveLength(1);
    expect(messages[0].line).toBe(3);
    expect(code.split('\n')[2].slice(messages[0].column - 1)).toMatch(/^font-size/);
    expect(messages[0].message).toContain("'font-size: 0.875rem'");
  });
});

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
});

// The rule must be observed to REPORT, not merely to pass. A rule whose matcher silently finds
// nothing would sail through a suite made only of `valid` cases — the vacuity hole #718 found.
ruleTester.run('no-hardcoded-typography', rule, {
  valid: [
    { code: 'const s = css`div { font-size: var(--wa-font-size-s); }`;' },
    // A literal inside a var() fallback is fine — the token still wins when the theme declares it.
    { code: 'const s = css`div { font-size: var(--wa-font-size-s, 0.875rem); }`;' },
    { code: 'const s = css`div { font-size: calc(var(--wa-font-size-m) * 1.5); }`;' },
    { code: "const s = css`div { font-family: var(--wa-font-family-code, 'IBM Plex Mono'); }`;" },
    // Inheriting IS the token-driven cascade; every CSS-wide keyword stays legal.
    { code: 'const s = css`button { font: inherit; }`;' },
    { code: 'const s = css`div { font-family: inherit; }`;' },
    // letter-spacing has no Web Awesome token to point at; deliberately out of scope.
    { code: 'const s = css`div { letter-spacing: 0.03em; }`;' },
    // Setting a Web Awesome component token is a declaration OF a token, not a hardcoded value.
    { code: 'const s = css`wa-input { --wa-form-control-value-line-height: 1.2; }`;' },
    { code: 'const s = css`wa-input { --wa-font-size-m: 1rem; }`;' },
    // Tokenless properties this rule has no opinion about.
    { code: 'const s = css`div { font-style: italic; }`;' },
    { code: 'const s = css`div { font-variant: small-caps; }`;' },
    // A value cut by interpolation cannot be judged from its literal half.
    { code: 'const s = css`div { font-size: ${size}; }`;' },
    // A commented-out declaration is prose, not a stylesheet.
    { code: 'const s = css`/* font-size: 14px is what this used to be */ div { color: red; }`;' },
    // Non-CSS strings that merely mention fonts.
    { code: "const key = 'fontSize';" },
    { code: "const monacoOption = 'fontFamily';" },
  ],
  invalid: [
    {
      code: 'const s = css`div { font-size: 0.875rem; }`;',
      errors: [{ messageId: 'hardcodedTypography', data: { property: 'font-size', value: '0.875rem', hint: '--wa-font-size-{3xs…5xl}, or --wa-font-size-smaller/-larger to size relative to the parent' } }],
    },
    {
      code: 'const s = css`div { font-weight: 700; }`;',
      errors: [{ messageId: 'hardcodedTypography' }],
    },
    {
      code: 'const s = css`div { line-height: 1.4; }`;',
      errors: [{ messageId: 'hardcodedTypography' }],
    },
    // line-height: 1 is still a literal; icon boxes take --wa-line-height-condensed.
    {
      code: 'const s = css`div { line-height: 1; }`;',
      errors: [{ messageId: 'hardcodedTypography' }],
    },
    {
      code: 'const s = css`div { font-family: monospace; }`;',
      errors: [{ messageId: 'hardcodedTypography' }],
    },
    // A quoted family stack: the value opens with a quote and must still report.
    {
      code: 'const s = css`div { font-family: "IBM Plex Mono", monospace; }`;',
      errors: [{ messageId: 'hardcodedTypography', data: { property: 'font-family', value: '"IBM Plex Mono", monospace', hint: '--wa-font-family-{body, heading, code, longform}' } }],
    },
    // The shorthand packs family, size and weight into one literal.
    {
      code: 'const s = css`div { font: 600 14px sans-serif; }`;',
      errors: [{ messageId: 'hardcodedTypography', data: { property: 'font', value: '600 14px sans-serif', hint: "'font: inherit', or the longhand properties each set from their token" } }],
    },
    // Inline style= attributes are how several components carry CSS. Nothing ends the last
    // declaration before the closing quote; the clip must not swallow the markup after it.
    {
      code: 'const s = html`<div style="font-size:14px">x</div>`;',
      errors: [{ messageId: 'hardcodedTypography', data: { property: 'font-size', value: '14px', hint: '--wa-font-size-{3xs…5xl}, or --wa-font-size-smaller/-larger to size relative to the parent' } }],
    },
    // A plain string literal assigned to a style property.
    {
      code: "const s = 'font-weight: bold';",
      errors: [{ messageId: 'hardcodedTypography' }],
    },
    // Two in one quasi must both report.
    {
      code: 'const s = css`div { font-size: 0.875rem; font-weight: 600; }`;',
      errors: [{ messageId: 'hardcodedTypography' }, { messageId: 'hardcodedTypography' }],
    },
  ],
});
