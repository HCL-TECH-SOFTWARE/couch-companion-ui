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

import { Linter } from 'eslint';
import { describe, expect, it } from 'vitest';

import rule from '../eslint-rules/max-ternary-lines.js';

type Options = { maxLines: number };

function lint(code: string, options?: Options) {
  return new Linter().verify(code, {
    plugins: { cca: { rules: { 'max-ternary-lines': rule } } },
    rules: { 'cca/max-ternary-lines': options ? ['warn', options] : 'warn' },
    languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
  });
}

/**
 * A ternary whose consequent is a string concatenation padded out so the whole expression is
 * exactly `lines` tall. Must stay valid JS — a fixture that fails to parse yields a `fatal`
 * message and would pass a naive "did it report?" assertion for entirely the wrong reason.
 */
function ternaryOfHeight(lines: number): string {
  const consequent = lines - 2; // the `const x = cond` and `  : b;` lines bracket it
  const middle = Array.from({ length: consequent - 2 }, () => "    'x' +");
  return ['const x = cond', "  ? 'x' +", ...middle, "    'x'", '  : b;'].join('\n');
}

describe('cca/max-ternary-lines', () => {
  it('ignores a ternary that fits on one line', () => {
    expect(lint('const x = cond ? a : b;')).toEqual([]);
  });

  it('ignores a ternary exactly at the limit', () => {
    const code = ternaryOfHeight(10);
    expect(code.split('\n')).toHaveLength(10);
    expect(lint(code)).toEqual([]);
  });

  // The boundary is the whole rule: "more than 10 lines". 10 is fine, 11 is not.
  it('reports a ternary one line over the limit', () => {
    const code = ternaryOfHeight(11);
    expect(code.split('\n')).toHaveLength(11);

    const messages = lint(code);
    expect(messages).toHaveLength(1);
    expect(messages[0].ruleId).toBe('cca/max-ternary-lines');
    expect(messages[0].message).toContain('spans 11 lines (limit 10)');
  });

  it('warns rather than errors, so it cannot fail the build', () => {
    const messages = lint(ternaryOfHeight(11));
    expect(messages[0].severity).toBe(1);
  });

  it('points at the start of the ternary', () => {
    const messages = lint(ternaryOfHeight(11));
    expect(messages[0].line).toBe(1);
  });

  // A nested ternary is contained by its parent and so can never be taller than it. Reporting both
  // would mean two warnings for one expression, pointing at overlapping regions of the file.
  //
  // The fixture has to be built so the INNER ternary independently breaches the limit too —
  // otherwise the guard is never exercised and this test passes with the guard deleted.
  it('reports only the outermost ternary of a nested chain', () => {
    const code = [
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

    const messages = lint(code);
    expect(messages).toHaveLength(1);
    expect(messages[0].line).toBe(1); // the outer one, not the inner
    expect(messages[0].message).toContain(`spans ${code.split('\n').length} lines`);
  });

  // The common Lit shape: two big html`` templates as the branches. The ternary is the thing being
  // measured, not the template literals it happens to contain.
  it('measures a ternary whose branches are tagged templates', () => {
    const branch = (name: string) =>
      ['html`', `  <div>${name}</div>`, '  <span>filler</span>', '  <span>filler</span>', '`'].join('\n');
    const code = `const x = cond\n  ? ${branch('yes')}\n  : ${branch('no')};`;
    const height = code.split('\n').length;
    expect(height).toBeGreaterThan(10);

    const messages = lint(code);
    expect(messages).toHaveLength(1);
    expect(messages[0].message).toContain(`spans ${height} lines`);
  });

  it('honours a custom maxLines', () => {
    const code = ternaryOfHeight(11);
    expect(lint(code, { maxLines: 20 })).toEqual([]);

    const messages = lint(code, { maxLines: 5 });
    expect(messages).toHaveLength(1);
    expect(messages[0].message).toContain('spans 11 lines (limit 5)');
  });

  it('does not report non-ternary code that merely spans many lines', () => {
    const code = ['function f() {', ...Array.from({ length: 20 }, (_, i) => `  const v${i} = ${i};`), '}'].join('\n');
    expect(lint(code)).toEqual([]);
  });
});
