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

/**
 * Resolves Web Awesome design tokens to concrete sRGB hex.
 *
 * Monaco's theme API takes hex and nothing else: `Color.fromHex` returns *red* for
 * any string it cannot parse. Web Awesome tokens are not hex — they are `var()`
 * chains that bottom out in `color-mix(in oklab, …)` or relative colour syntax, and
 * reading a custom property back with `getPropertyValue()` yields that expression
 * unevaluated. So the token is resolved in two hops:
 *
 *   1. A hidden probe element gets `color: var(<token>)`. Reading the computed
 *      `color` longhand makes the engine evaluate the chain down to a real colour.
 *   2. That colour string — serialised as `rgb()`, `oklab()` or `color(srgb …)`
 *      depending on the engine — is painted into a 1×1 canvas and read back as
 *      sRGB bytes, alpha included. The browser does every colour-space conversion.
 *
 * A fully opaque pixel (alpha byte 255) resolves to `#rrggbb`; anything less opaque
 * resolves to `#rrggbbaa`, so a token that carries its own transparency is not
 * silently flattened to solid — Monaco's `Color.fromHex` accepts both forms.
 */

/**
 * Two sentinels, because a canvas silently *ignores* a `fillStyle` assignment it cannot
 * parse, leaving the previous value in place. Assigning the candidate over each sentinel
 * in turn tells the two cases apart: a parseable colour normalises to the same string
 * both times, while an unparseable one leaves each sentinel untouched, so they differ.
 *
 * A single sentinel cannot distinguish "unparseable" from "genuinely `#000000`", and
 * would drop a legitimately black token.
 */
const SENTINELS = ['#000000', '#ffffff'] as const;

/** Formats one sRGB channel byte as two lowercase hex digits. */
function channel(value: number): string {
  return value.toString(16).padStart(2, '0');
}

/**
 * Assigns `color` to the context, returning its normalised form, or `null` if the canvas
 * rejected it.
 */
function normalise(ctx: CanvasRenderingContext2D, color: string): string | null {
  // `fillStyle` is typed `string | CanvasGradient | CanvasPattern`; it is always a string
  // here, since only strings are ever assigned to it.
  const [first, second] = SENTINELS.map((sentinel) => {
    ctx.fillStyle = sentinel;
    ctx.fillStyle = color;
    return String(ctx.fillStyle);
  });
  return first === second ? first : null;
}

/**
 * Maps each token to `#rrggbb` (opaque) or `#rrggbbaa` (translucent).
 *
 * A token that cannot be resolved — no 2D canvas (test env, SSR), or a computed
 * colour the canvas refuses — is **omitted** from the result rather than guessed at.
 * Callers are expected to fall back per missing key.
 */
export function resolveWaColors(
  tokens: readonly string[]
): Record<string, string> {
  const resolved: Record<string, string> = {};
  if (tokens.length === 0) return resolved;

  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return resolved;

  const probe = document.createElement('div');
  probe.style.position = 'absolute';
  probe.style.visibility = 'hidden';
  probe.style.pointerEvents = 'none';
  document.body.append(probe);

  try {
    for (const token of tokens) {
      probe.style.color = `var(${token})`;
      const computed = getComputedStyle(probe).color;
      const normalised = computed ? normalise(ctx, computed) : null;
      if (normalised === null) continue;

      // Paint the normalised candidate — not whatever `fillStyle` happens to still
      // hold from inside `normalise` — and read the pixel back.
      ctx.fillStyle = normalised;
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      if (r === undefined || g === undefined || b === undefined || a === undefined) {
        continue;
      }

      const hex = `#${channel(r)}${channel(g)}${channel(b)}`;
      resolved[token] = a === 255 ? hex : `${hex}${channel(a)}`;
    }
  } finally {
    probe.remove();
  }

  return resolved;
}
