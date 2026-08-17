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
 * Web Awesome ships no SVG files. Its default icon library resolves every `<wa-icon>` to
 * `https://ka-f.fontawesome.com`, so without this the app fetches every icon from a third-party CDN
 * and cannot run air-gapped. `setIconPath()` redirects Web Awesome's stock resolver at the Font
 * Awesome Free SVGs that `vite.config.ts` copies into the build output under `/icons`. See #741.
 *
 * This has to be its own module rather than a call at the top of `webawesome.ts`: ESM hoists
 * `import` statements, so a `setIconPath()` call written above the component imports would still
 * execute after them. Importing it first is the only ordering that holds — and the same goes for
 * the `registerIconLibrary()` call below.
 */
import { setIconPath } from '@awesome.me/webawesome/dist/utilities/base-path.js';
import { registerIconLibrary } from '@awesome.me/webawesome/dist/components/icon/library.js';
import { icons as systemIcons } from '@awesome.me/webawesome/dist/components/icon/library.system.js';

// Relative to BASE_URL, so the app keeps resolving icons if it is served under a sub-path.
const ICON_PATH = `${import.meta.env.BASE_URL}icons`;
setIconPath(ICON_PATH);

/**
 * `setIconPath()` above redirects only the *default* library. Web Awesome's **system** library —
 * the icons its own components render: the `wa-select` chevron, the tick on a selected
 * `wa-option`, the eye on a password `wa-input`, the × on `wa-dialog` — is resolved separately,
 * and it does not fetch anything remote at all: it hard-codes each SVG as a `data:` URI. That
 * still breaks on the drop-in, for a different reason. `<wa-icon>` retrieves every icon with
 * `fetch`, a `fetch` of a `data:` URI is governed by `connect-src` (falling back to
 * `default-src`), and CouchDB serves `/_utils` with `default-src 'self'` and no `connect-src`. So
 * every internal icon is blocked, and blocked silently — no broken-image placeholder, no error a
 * user or a console reader would recognise as being about icons. See #140.
 *
 * The fix is Web Awesome's own documented escape hatch: re-register `system` with a resolver of
 * ours, pointing at the same-origin copies `vite.config.ts` serves and ships under
 * `{ICON_PATH}/system/`. Doing that makes providing *every* system icon our responsibility, which
 * is why neither side names any: the emitter reads the vendored `icons` object, and so does the
 * lookup below. The two cannot disagree about which icons exist, and a Web Awesome upgrade moves
 * both at once.
 */
const SYSTEM_ICON_PATH = `${ICON_PATH}/system`;

/**
 * Web Awesome's own fallback chain, with `dataUri()` swapped for a URL — see the `resolver` in
 * `dist/components/icon/library.system.ts`. The chain is not incidental: `<wa-icon name="eye"
 * library="system">` (the password-reveal toggle) asks for the default `solid` variant of an icon
 * that only exists in `regular`, so dropping the fallback would blank exactly the control this
 * issue is about.
 */
export function resolveSystemIcon(name: string, variant = 'solid'): string {
  if (systemIcons[variant]?.[name] !== undefined) return `${SYSTEM_ICON_PATH}/${variant}/${name}.svg`;
  if (systemIcons.regular?.[name] !== undefined) return `${SYSTEM_ICON_PATH}/regular/${name}.svg`;
  return `${SYSTEM_ICON_PATH}/regular/circle-question.svg`;
}

registerIconLibrary('system', {
  resolver: (name, _family, variant) => resolveSystemIcon(name, variant)
});
