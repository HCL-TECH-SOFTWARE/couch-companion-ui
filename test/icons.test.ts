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
 * Guards the air-gap: Web Awesome ships no SVGs and its default icon library falls back to
 * ka-f.fontawesome.com, so `src/icons.ts` repoints it at our locally-served copy. See #741.
 *
 * And guards the second, separate icon trap below: Web Awesome's *system* library resolves to
 * `data:` URIs, which `<wa-icon>` FETCHES — so CouchDB's `/_utils` policy (`default-src 'self'`,
 * no `connect-src`) blocks every internal icon. See #140.
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { getIconPath, setIconPath } from '@awesome.me/webawesome/dist/utilities/base-path.js';
import defaultLibrary from '@awesome.me/webawesome/dist/components/icon/library.default.js';
import { getIconLibrary } from '@awesome.me/webawesome/dist/components/icon/library.js';
import { icons as systemIcons } from '@awesome.me/webawesome/dist/components/icon/library.system.js';

// Importing for its side effects is half the point: this is what calls setIconPath() and
// registerIconLibrary('system', …).
import { resolveSystemIcon } from '../src/icons.js';

const require = createRequire(import.meta.url);
const FA_PACKAGE_JSON = '@fortawesome/fontawesome-free/package.json';
const FA_SVG_DIR = path.join(path.dirname(require.resolve(FA_PACKAGE_JSON)), 'svgs');

const resolve = (name: string, family = 'classic', variant = 'solid') =>
  defaultLibrary.resolver(name, family, variant);

describe('local icon library', () => {
  it('points the default icon library at a same-origin path', () => {
    expect(getIconPath()).toBe('/icons');
  });

  it('resolves classic icons to local SVGs', () => {
    expect(resolve('circle-info')).toBe('/icons/solid/circle-info.svg');
  });

  it('resolves brand icons to local SVGs', () => {
    expect(resolve('github', 'brands')).toBe('/icons/brands/github.svg');
  });

  it('never resolves an icon to the Font Awesome CDN', () => {
    const names = ['circle-info', 'bars', 'trash-can', 'github', 'wand-magic-sparkles'];
    const urls = names.map(name => resolve(name, name === 'github' ? 'brands' : 'classic'));

    // Assert the collection is non-empty too, or "none of them hit the CDN" passes vacuously.
    expect(urls).toHaveLength(names.length);
    expect(urls.every(url => url.length > 0)).toBe(true);
    expect(urls.filter(url => url.includes('fontawesome.com'))).toEqual([]);
  });

  it('ships the icons that no scan of our source could find', () => {
    // `bars` is rendered inside wa-page's shadow DOM; `tasks` and `x` are FA5 aliases that only
    // exist as real files in the package. A curated allowlist would have missed all three.
    const missing = [
      'solid/bars.svg',
      'solid/tasks.svg',
      'solid/x.svg',
      'brands/github.svg'
    ].filter(file => !fs.existsSync(path.join(FA_SVG_DIR, file)));

    expect(missing).toEqual([]);
  });

  it('pins Font Awesome to the version Web Awesome resolves against', () => {
    // Web Awesome hardcodes the FA version into its CDN URL. If it bumps that and our pin does not
    // follow, newly-added icons 404 — and the server's SPA fallback answers a 404 with index.html
    // and HTTP 200, so it would fail silently. Read the version back out of the CDN URL by
    // temporarily clearing the icon path, which is the only thing suppressing it.
    const restore = getIconPath();
    try {
      setIconPath('');
      const cdnUrl = resolve('circle-info');
      const waVersion = /releases\/v([\d.]+)\//.exec(cdnUrl)?.[1];
      const faVersion = (require(FA_PACKAGE_JSON) as { version: string }).version;

      expect(cdnUrl).toContain('fontawesome.com');
      expect(waVersion).toBeDefined();
      expect(faVersion).toBe(waVersion);
    } finally {
      setIconPath(restore);
    }
  });
});

/**
 * Every (variant, name) the vendored package defines, read out of the package rather than listed
 * here. A Web Awesome upgrade that adds an icon extends these tests by itself, which is the point:
 * re-registering `system` makes providing *all* of them our responsibility, and a missing one is a
 * blank control with nothing in the console.
 */
const systemPairs = Object.entries(systemIcons).flatMap(([variant, collection]) =>
  Object.keys(collection).map(name => [variant, name] as const)
);

describe('Web Awesome system icon library', () => {
  it('is registered, replacing the stock data:-URI resolver', () => {
    const library = getIconLibrary('system');

    expect(library).toBeDefined();
    // The stock resolver answers with `data:image/svg+xml,…`, which <wa-icon> fetches and
    // `default-src 'self'` blocks. Ours must answer with a same-origin URL instead.
    expect(library?.resolver('check', 'classic', 'solid', false)).toBe('/icons/system/solid/check.svg');
  });

  it('resolves no system icon to a data: URI', () => {
    const urls = systemPairs.map(([variant, name]) => resolveSystemIcon(name, variant));

    // Assert the collection is non-empty and covers both variants, or this passes vacuously.
    expect(urls.length).toBeGreaterThan(40);
    expect(Object.keys(systemIcons).sort()).toEqual(['regular', 'solid']);
    expect(urls.filter(url => url.startsWith('data:'))).toEqual([]);
  });

  it('resolves every icon Web Awesome defines to the file the build emits for it', () => {
    // The build writes one file per entry of the same vendored object, at exactly these
    // coordinates (`vite.config.ts`, systemIconFiles). This is the join between the two.
    const wrong = systemPairs
      .map(([variant, name]) => ({ variant, name, url: resolveSystemIcon(name, variant) }))
      .filter(({ variant, name, url }) => url !== `/icons/system/${variant}/${name}.svg`);

    expect(wrong).toEqual([]);
  });

  it('never resolves to a file the build would not emit', () => {
    // Includes the fallbacks, which are the only URLs not covered by the test above: a URL naming
    // a (variant, name) that is not in the vendored object is a 404 in dev and — because the
    // drop-in answers a missing path with index.html and HTTP 200 — a silent blank in production.
    const probes = [
      ...systemPairs.map(([variant, name]) => resolveSystemIcon(name, variant)),
      resolveSystemIcon('eye'),
      resolveSystemIcon('star', 'regular'),
      resolveSystemIcon('no-such-icon'),
      resolveSystemIcon('check', 'no-such-variant')
    ];

    const unbacked = probes.filter(url => {
      const [, variant, file] = /^\/icons\/system\/([^/]+)\/(.+)\.svg$/.exec(url) ?? [];
      return systemIcons[variant]?.[file] === undefined;
    });

    expect(unbacked).toEqual([]);
  });

  it('keeps the cross-variant fallback the password toggle depends on', () => {
    // `<wa-icon name="eye" library="system">` names no variant, so it asks for the default
    // `solid` — and `eye` exists only in `regular`. Web Awesome's own resolver falls through;
    // dropping that would blank the password-reveal toggle, which is one of the controls #140 is
    // about. Guarded against the package, so it fails loudly if `eye` ever gains a solid variant.
    expect(systemIcons.solid.eye).toBeUndefined();
    expect(systemIcons.regular.eye).toBeDefined();
    expect(resolveSystemIcon('eye')).toBe('/icons/system/regular/eye.svg');
  });

  it('resolves an unknown name to the same last-resort icon Web Awesome uses', () => {
    expect(resolveSystemIcon('no-such-icon')).toBe('/icons/system/regular/circle-question.svg');
  });
});
