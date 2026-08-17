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

import { describe, it, expect, afterEach, vi } from 'vitest';

import { resolveWaTypography } from '../src/services/wa-typography';

/**
 * Stubs the computed style the probe element reads back: the two custom properties
 * (the substitution gate) and the two longhands (the values). happy-dom neither loads
 * the theme nor evaluates the round(calc(…)) chains inside the size tokens, so the
 * resolved path is exercised through the same stub seam wa-color.test.ts uses.
 */
function stubComputedStyle(values: {
  tokens?: Record<string, string>;
  fontSize?: string;
  fontFamily?: string;
}) {
  vi.spyOn(window, 'getComputedStyle').mockReturnValue({
    getPropertyValue: (name: string) => values.tokens?.[name] ?? '',
    fontSize: values.fontSize ?? '',
    fontFamily: values.fontFamily ?? '',
  } as unknown as CSSStyleDeclaration);
}

const DECLARED = {
  '--wa-font-size-s': 'round(calc(1rem / 1.125), 1px)',
  '--wa-font-family-code': 'ui-monospace, monospace',
};

describe('resolveWaTypography', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('resolves the evaluated longhands when both tokens are declared', () => {
    stubComputedStyle({
      tokens: DECLARED,
      fontSize: '14px',
      fontFamily: 'ui-monospace, monospace',
    });

    expect(resolveWaTypography()).toEqual({
      fontSize: 14,
      fontFamily: 'ui-monospace, monospace',
    });
  });

  it('omits both keys when no theme declares the tokens', () => {
    // The longhands still *compute* — to the inherited 16px body font — which is exactly
    // the plausible-looking wrong answer the substitution gate exists to reject.
    stubComputedStyle({ fontSize: '16px', fontFamily: 'serif' });

    const resolved = resolveWaTypography();

    expect(resolved).not.toHaveProperty('fontSize');
    expect(resolved).not.toHaveProperty('fontFamily');
  });

  it('omits what the engine declares but refuses to substitute', () => {
    // happy-dom's own behaviour: the custom property is readable, but the longhand
    // hands back the literal var() text instead of evaluating it.
    stubComputedStyle({
      tokens: DECLARED,
      fontSize: 'var(--wa-font-size-s)',
      fontFamily: 'var(--wa-font-family-code)',
    });

    const resolved = resolveWaTypography();

    // parseFloat over var() text is NaN; the guard must omit the key, never carry NaN.
    expect(resolved).not.toHaveProperty('fontSize');
    expect(resolved).not.toHaveProperty('fontFamily');
  });

  it('omits a non-positive font size', () => {
    stubComputedStyle({ tokens: DECLARED, fontSize: '0px', fontFamily: 'monospace' });

    expect(resolveWaTypography()).toEqual({ fontFamily: 'monospace' });
  });

  it('removes the probe element again', () => {
    stubComputedStyle({ tokens: DECLARED, fontSize: '14px', fontFamily: 'monospace' });

    resolveWaTypography();

    expect(document.body.children).toHaveLength(0);
  });
});
