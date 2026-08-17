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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { resolveWaColors } from '../src/services/wa-color';

/**
 * happy-dom has no real 2D canvas. Stub `getContext('2d')` with a context whose
 * `getImageData` returns the bytes the test wants, so the hex-formatting path is
 * exercised without a rendering engine.
 *
 * `fillStyle` must be a *validating* setter, not a plain property: a real canvas
 * silently ignores an assignment it cannot parse, leaving the previous value in place,
 * and that is exactly the behaviour the resolver's two-sentinel check relies on. A
 * plain property would accept `'not-a-colour'` and the check would never fire.
 */
function stubCanvas(pixel: [number, number, number, number] | null) {
  let fill = '';
  const ctx = {
    get fillStyle() {
      return fill;
    },
    set fillStyle(value: string) {
      if (/^(#|rgb|oklab|oklch|color\()/.test(value)) fill = value;
    },
    fillRect: vi.fn(),
    clearRect: vi.fn(),
    getImageData: vi.fn(() => ({ data: Uint8ClampedArray.from(pixel ?? []) })),
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    (pixel === null ? null : ctx) as unknown as CanvasRenderingContext2D,
  );
}

/** Stubs the computed `color` longhand the probe element reads back. */
function stubComputedColor(color: string) {
  vi.spyOn(window, 'getComputedStyle').mockReturnValue({
    color,
  } as unknown as CSSStyleDeclaration);
}

describe('resolveWaColors', () => {
  beforeEach(() => {
    stubComputedColor('rgb(15, 23, 41)');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('normalises a resolved colour to #rrggbb', () => {
    stubCanvas([15, 23, 41, 255]);

    const resolved = resolveWaColors(['--wa-color-surface-default']);

    expect(resolved).toEqual({ '--wa-color-surface-default': '#0f1729' });
  });

  it('pads single-digit channels', () => {
    stubCanvas([1, 2, 3, 255]);

    expect(resolveWaColors(['--wa-color-text-normal'])).toEqual({
      '--wa-color-text-normal': '#010203',
    });
  });

  it('omits every token when there is no 2D context', () => {
    stubCanvas(null);

    expect(resolveWaColors(['--wa-color-surface-default'])).toEqual({});
  });

  it('omits a token whose computed colour the canvas cannot parse', () => {
    // An unparseable assignment leaves `fillStyle` at whichever sentinel was set, so
    // the two sentinels disagree and the resolver must reject the value rather than
    // hand Monaco a sentinel's colour.
    stubComputedColor('not-a-colour');
    stubCanvas([0, 0, 0, 255]);

    expect(resolveWaColors(['--wa-color-surface-default'])).toEqual({});
  });

  it('resolves a token that is legitimately black', () => {
    // Regression guard: a naive single-sentinel check ("did fillStyle stay at #000000?")
    // cannot tell "unparseable" from "genuinely black", and would drop a real colour.
    stubComputedColor('rgb(0, 0, 0)');
    stubCanvas([0, 0, 0, 255]);

    expect(resolveWaColors(['--wa-color-text-normal'])).toEqual({
      '--wa-color-text-normal': '#000000',
    });
  });

  it('leaves no probe element behind', () => {
    stubCanvas([15, 23, 41, 255]);

    resolveWaColors(['--wa-color-surface-default']);

    expect(document.body.children).toHaveLength(0);
  });

  it('emits 6-digit hex for a fully opaque pixel', () => {
    stubCanvas([15, 23, 41, 255]);

    expect(resolveWaColors(['--wa-color-surface-default'])).toEqual({
      '--wa-color-surface-default': '#0f1729',
    });
  });

  it('emits 8-digit hex for a translucent pixel, never flattening it to opaque', () => {
    // 102 === 0x66, the alpha `editor-theme.ts` applies to the diff backgrounds.
    stubCanvas([63, 185, 80, 102]);

    expect(resolveWaColors(['--wa-color-success-fill-normal'])).toEqual({
      '--wa-color-success-fill-normal': '#3fb95066',
    });
  });

  it('returns empty without touching the canvas when there are no tokens', () => {
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext');

    expect(resolveWaColors([])).toEqual({});
    expect(getContext).not.toHaveBeenCalled();
  });
});
