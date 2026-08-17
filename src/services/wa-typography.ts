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
 * Resolves the Web Awesome typography tokens Monaco needs to concrete JS values.
 *
 * Monaco's options take a number of pixels and a font-family string — it cannot consume
 * CSS custom properties, and the `--wa-font-size-*` tokens bottom out in `round(calc(…))`
 * chains that `getPropertyValue()` hands back unevaluated. So each token is resolved the
 * way wa-color.ts resolves colours: a hidden probe element gets the token on the real
 * longhand, and reading the *computed* longhand back makes the engine evaluate the chain
 * down to `14px` / a concrete family list.
 *
 * `--wa-font-size-s` is the size the editor used when it was hardcoded to 14 —
 * `--wa-font-size-m` is body text, and code panes conventionally sit one step below it.
 * `--wa-font-family-code` is the mono family every theme declares.
 *
 * A value that cannot be resolved — no theme loaded (test env), a longhand the engine
 * refuses to substitute — is **omitted** from the result rather than guessed at. Callers
 * are expected to fall back per missing key.
 */

/** What the app's Monaco editors read their type from. */
export interface WaTypography {
  /** Resolved `--wa-font-size-s` in CSS pixels. */
  fontSize?: number;
  /** Resolved `--wa-font-family-code` family list. */
  fontFamily?: string;
}

export function resolveWaTypography(): WaTypography {
  const resolved: WaTypography = {};

  const probe = document.createElement('div');
  probe.style.position = 'absolute';
  probe.style.visibility = 'hidden';
  probe.style.pointerEvents = 'none';
  probe.style.fontSize = 'var(--wa-font-size-s)';
  probe.style.fontFamily = 'var(--wa-font-family-code)';
  document.body.append(probe);

  try {
    const computed = getComputedStyle(probe);

    // Substitution gate: an undefined token makes the longhand guaranteed-invalid, and the
    // computed value silently falls back to the inherited one — 16px would come back looking
    // perfectly plausible. Only trust the longhands when the tokens themselves are declared.
    const sizeToken = computed.getPropertyValue('--wa-font-size-s').trim();
    const familyToken = computed.getPropertyValue('--wa-font-family-code').trim();

    if (sizeToken) {
      const fontSize = Number.parseFloat(computed.fontSize);
      if (Number.isFinite(fontSize) && fontSize > 0) resolved.fontSize = fontSize;
    }

    if (familyToken) {
      const fontFamily = computed.fontFamily;
      // An engine that declares the token but does not substitute it into the longhand
      // (happy-dom) would hand Monaco the literal `var(…)` text; omit instead.
      if (fontFamily && !fontFamily.includes('var(')) resolved.fontFamily = fontFamily;
    }
  } finally {
    probe.remove();
  }

  return resolved;
}
