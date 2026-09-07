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
import { describe, expect, it } from 'vitest';

import rule, {
  ENTRY_STYLESHEETS,
  collectDeclaredTokens,
} from '../lint-rules/no-undefined-wa-token.js';
import { GRAPH_TOKENS } from '../src/plugins/server-mgmt/topology-graph.js';

// vitest runs with `globals: false` (vitest.config.ts), so RuleTester cannot find
// describe/it on its own.
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

describe('the declared-token set', () => {
  // An empty set would make the rule fire on every token in the tree. That failure is
  // loud, but it reads as "92 typos" rather than "the theme moved". Pin the shape.
  it('resolves the @import closure of the five entry stylesheets', () => {
    const declared = collectDeclaredTokens();

    expect(ENTRY_STYLESHEETS).toHaveLength(5);
    expect(declared.size).toBeGreaterThan(300);

    // Declared in themes/default.css.
    expect(declared.has('--wa-border-radius-m')).toBe(true);
    expect(declared.has('--wa-color-text-quiet')).toBe(true);
    // Declared only in color/variants/*.css and utilities/variants.css — the eight tokens
    // a themes/default.css-only guard would wrongly reject. This is the regression #718
    // exists to prevent.
    expect(declared.has('--wa-color-danger')).toBe(true);
    expect(declared.has('--wa-color-fill-quiet')).toBe(true);
    expect(declared.has('--wa-color-neutral-50')).toBe(true);
    expect(declared.has('--wa-color-border-quiet')).toBe(true);

    // The two typos that started #718.
    expect(declared.has('--wa-border-radius-medium')).toBe(false);
    expect(declared.has('--wa-color-danger-border')).toBe(false);
  });

  // If this fails, someone added `src/themes/enchanted.css` to ENTRY_STYLESHEETS — reasonable on
  // its face, since the app does load it. It reopens #580. Enchanted declares these ramps inside
  // `.wa-palette-enchanted`, where they exist only while enchanted is the active theme; the Web
  // Awesome themes have no equivalent. Listing the file unions them onto the allow-list, and a
  // component that then reaches for one renders the guaranteed-invalid value under the other three
  // themes — square corners, `currentcolor` borders — with lint green. Component code may only
  // name tokens every theme declares.
  it('excludes tokens only the enchanted palette declares', () => {
    const declared = collectDeclaredTokens();

    expect(declared.has('--wa-color-teal-50')).toBe(false);
    expect(declared.has('--wa-color-lime-50')).toBe(false);
    expect(declared.has('--wa-color-hcl-blue-50')).toBe(false);
    expect(declared.has('--wa-color-cool-gray-50')).toBe(false);
  });

  it('throws rather than returning an empty set when an entry is missing', () => {
    expect(() => collectDeclaredTokens(['/nonexistent/theme.css'])).toThrow();
  });
});

// The rule above only sees `var(--wa-…)` inside CSS text. `topology-graph.ts` holds bare token
// *names* in a plain object, because d3 takes literal colours and the names are resolved through a
// probe element at runtime (`wa-color.ts`) rather than written into a stylesheet. Nothing lints
// them, and an unresolvable name does not fail — it silently falls back to `currentColor`, so a
// typo shows up as "why is that node the same colour as the text?" and nothing else. Checking the
// set directly is the only guard available. #43.
describe('token names held outside CSS', () => {
  it('names only tokens the theme declares, in the topology graph', () => {
    const declared = collectDeclaredTokens();

    const undeclared = Object.values(GRAPH_TOKENS).filter(
      (token) => !declared.has(token)
    );
    expect(undeclared).toEqual([]);
    // Guards the guard: an empty or renamed GRAPH_TOKENS would pass the filter vacuously.
    expect(Object.values(GRAPH_TOKENS).length).toBeGreaterThan(5);
  });
});

// The two report-location fixtures. Their expected columns are DERIVED from the source rather
// than hardcoded, so the cases keep asserting "points at `var(`" rather than "points at 20".
const IN_TEMPLATE = ['const s = css`', '  div {', '    border-radius: var(--wa-border-radius-medium);', '  }', '`;'].join(
  '\n',
);
const IN_TEMPLATE_COLUMN = IN_TEMPLATE.split('\n')[2].indexOf('var(--wa-border-radius-medium') + 1;

const PAST_ESCAPE = String.raw`const s = "\t\tcolor:var(--wa-border-radius-medium)";`;
const PAST_ESCAPE_COLUMN = PAST_ESCAPE.indexOf('var(--wa-border-radius-medium') + 1;

const ruleTester = new RuleTester({
  eslintCompat: true,
  languageOptions: { sourceType: 'module' },
});

// This is the guard observed to FAIL, not merely to pass (issue #718, AC #2). A rule whose
// reference extractor silently matches nothing cannot get past the `invalid` cases below —
// which is the vacuity hole a `expect(referenced.size).toBe(10)` count pin only papers over.
ruleTester.run('no-undefined-wa-token', rule, {
  valid: [
    { code: 'const s = css`div { border-radius: var(--wa-border-radius-m); }`;' },
    { code: 'const s = css`div { border: 1px solid var(--wa-color-danger-border-quiet); }`;' },
    // Declared only outside themes/default.css.
    { code: 'const s = css`div { background: var(--wa-color-fill-quiet); }`;' },
    // A dead fallback on a valid token is not this rule's business.
    { code: 'const s = css`div { color: var(--wa-color-text-normal, #1f2a35); }`;' },
    // Plain string literals carry tokens too (inline style= attributes).
    { code: 'const s = "color:var(--wa-color-text-link)";' },
    // Not a --wa- token.
    { code: 'const s = css`div { color: var(--cca-text-muted); }`;' },
    // Interpolation that does not cut a token name is fine.
    { code: 'const s = css`div { color: var(--wa-color-text-quiet); ${extra} }`;' },
    // Fully dynamic and prefix-less: the rule has no opinion, since `p` may name a --cca- property.
    { code: 'const s = css`div { background: var(${p}); }`;' },
  ],
  invalid: [
    // A `static styles = css`...`` block is one template literal spanning hundreds of lines.
    // Reporting the node would point every violation at line 1. The offsets must resolve to the
    // line the token is actually on.
    {
      code: IN_TEMPLATE,
      errors: [
        {
          message: /'--wa-border-radius-medium' is not declared/,
          line: 3,
          column: IN_TEMPLATE_COLUMN,
        },
      ],
    },
    // The literal's cooked value collapses each `\t` to one character, while its source spans
    // two. Scanning the cooked value would report the column two places early.
    {
      code: PAST_ESCAPE,
      errors: [{ message: /--wa-border-radius-medium/, line: 1, column: PAST_ESCAPE_COLUMN }],
    },
    {
      code: 'const s = css`div { border-radius: var(--wa-border-radius-medium); }`;',
      errors: [{ messageId: 'undefinedToken', data: { token: '--wa-border-radius-medium' } }],
    },
    {
      code: 'const s = css`div { border: 1px solid var(--wa-color-danger-border); }`;',
      errors: [{ messageId: 'undefinedToken' }],
    },
    {
      code: 'const s = "color:var(--wa-color-brand-fill-solid,#0065cc)";',
      errors: [{ messageId: 'undefinedToken' }],
    },
    {
      code: 'const s = css`div { background: var(--wa-color-${palette}-fill-quiet); }`;',
      errors: [{ messageId: 'interpolatedToken' }],
    },
    // The interpolation starts right after the `--wa-` prefix, so there are no name characters
    // for TOKEN_REFERENCE to match. The cut must still be reported.
    {
      code: 'const s = css`div { background: var(--wa-${p}-fill-quiet); }`;',
      errors: [{ messageId: 'interpolatedToken' }],
    },
    {
      code: 'const s = css`div { background: var(--wa-${p}); }`;',
      errors: [{ messageId: 'interpolatedToken' }],
    },
    // Two independent violations in one template must both report.
    {
      code: 'const s = css`div { border-radius: var(--wa-border-radius-medium); color: var(--wa-color-text-muted); }`;',
      errors: [{ messageId: 'undefinedToken' }, { messageId: 'undefinedToken' }],
    },
    // A quasi holding both a complete undefined token and a trailing cut must report exactly one
    // of each — not a double count on the cut.
    {
      code: 'const s = css`div { border-radius: var(--wa-border-radius-medium); background: var(--wa-color-${p}-fill-quiet); }`;',
      errors: [{ messageId: 'undefinedToken' }, { messageId: 'interpolatedToken' }],
    },
  ],
});
