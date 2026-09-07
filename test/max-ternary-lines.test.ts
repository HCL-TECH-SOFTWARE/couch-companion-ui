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

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { RuleTester } from 'oxlint/plugins-dev';
import { describe, expect, it } from 'vitest';

import rule from '../lint-rules/max-ternary-lines.js';

// vitest runs with `globals: false` (vitest.config.ts), so RuleTester cannot find describe/it.
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

/**
 * A ternary whose consequent is a string concatenation padded out so the whole expression is
 * exactly `lines` tall. Must stay valid JS — a fixture that fails to parse yields a parse error
 * and would pass a naive "did it report?" assertion for entirely the wrong reason.
 */
function ternaryOfHeight(lines: number): string {
  const consequent = lines - 2; // the `const x = cond` and `  : b;` lines bracket it
  const middle = Array.from({ length: consequent - 2 }, () => "    'x' +");
  return ['const x = cond', "  ? 'x' +", ...middle, "    'x'", '  : b;'].join('\n');
}

/** The common Lit shape: a big html`` template as a branch. */
function templateBranch(name: string): string {
  return ['html`', `  <div>${name}</div>`, '  <span>filler</span>', '  <span>filler</span>', '`'].join('\n');
}

const NESTED = [
  'const x = a',
  "  ? 'x' +",
  ...Array.from({ length: 7 }, () => "    'x' +"),
  "    'x'",
  '  : b', // the inner ternary starts here...
  "    ? 'y' +",
  ...Array.from({ length: 10 }, () => "      'y' +"),
  "      'y'",
  '    : c;', // ...and ends here — 14 lines, over the limit on its own.
].join('\n');

const TAGGED_TEMPLATES = `const x = cond\n  ? ${templateBranch('yes')}\n  : ${templateBranch('no')};`;

// The fixtures carry the whole point of several cases below — "one line over the limit" means
// nothing if the generator quietly produces something else. Pinned separately so a broken
// generator fails loudly here rather than silently weakening the cases.
describe('fixtures', () => {
  it('builds a ternary of exactly the requested height', () => {
    expect(ternaryOfHeight(10).split('\n')).toHaveLength(10);
    expect(ternaryOfHeight(11).split('\n')).toHaveLength(11);
  });

  it('builds a nested fixture whose INNER ternary also breaches the limit', () => {
    // Otherwise the outermost-only guard is never exercised and the case passes with it deleted.
    expect(NESTED.split('\n')).toHaveLength(24);
    const innerHeight = NESTED.split('\n').length - NESTED.split('\n').indexOf('  : b');
    expect(innerHeight).toBeGreaterThan(10);
  });

  it('builds a tagged-template fixture over the limit', () => {
    expect(TAGGED_TEMPLATES.split('\n').length).toBeGreaterThan(10);
  });
});

// The severity is a property of the wiring, not of the rule module: this rule is a smell, not a
// defect, and must not be able to fail the build while the backlog stands. Asserted against the
// config itself because that is where the claim actually lives.
describe('wiring', () => {
  it('is configured at warn, not error, so it cannot fail the build', () => {
    // Not `import.meta.url` — vitest runs this suite under happy-dom, where it is not a file: URL.
    const config = readFileSync(resolve(process.cwd(), '.oxlintrc.json'), 'utf8');
    expect(config).toMatch(/"cca\/max-ternary-lines":\s*\[\s*"warn"/);
  });
});

const ruleTester = new RuleTester({
  eslintCompat: true,
  languageOptions: { sourceType: 'module' },
});

// The rule must be observed to REPORT, not merely to pass. A rule whose matcher silently finds
// nothing would sail through a suite made only of `valid` cases — the vacuity hole #718 found.
ruleTester.run('max-ternary-lines', rule, {
  valid: [
    { name: 'a ternary that fits on one line', code: 'const x = cond ? a : b;' },
    { name: 'a ternary exactly at the limit', code: ternaryOfHeight(10) },
    {
      name: 'non-ternary code that merely spans many lines',
      code: ['function f() {', ...Array.from({ length: 20 }, (_, i) => `  const v${i} = ${i};`), '}'].join('\n'),
    },
    {
      name: 'a tall ternary under a raised custom limit',
      code: ternaryOfHeight(11),
      options: [{ maxLines: 20 }],
    },
  ],
  invalid: [
    {
      // The boundary is the whole rule: "more than 10 lines". 10 is fine, 11 is not.
      name: 'a ternary one line over the limit, reported at its start',
      code: ternaryOfHeight(11),
      errors: [{ message: /spans 11 lines \(limit 10\)/, line: 1 }],
    },
    {
      // A nested ternary is contained by its parent and so can never be taller than it. Reporting
      // both would mean two warnings for one expression, pointing at overlapping regions.
      name: 'only the outermost ternary of a nested chain',
      code: NESTED,
      errors: [{ message: new RegExp(`spans ${NESTED.split('\n').length} lines`), line: 1 }],
    },
    {
      // The ternary is the thing being measured, not the template literals it happens to contain.
      name: 'a ternary whose branches are tagged templates',
      code: TAGGED_TEMPLATES,
      errors: [{ message: new RegExp(`spans ${TAGGED_TEMPLATES.split('\n').length} lines`) }],
    },
    {
      name: 'a lowered custom maxLines',
      code: ternaryOfHeight(11),
      options: [{ maxLines: 5 }],
      errors: [{ message: /spans 11 lines \(limit 5\)/ }],
    },
  ],
});
