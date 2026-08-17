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
 * Browser-side half of the post-build smoke check (`scripts/smoke.mjs`, wired into
 * `scripts/check.sh` and `.github/workflows/ci.yml`). A real browser, a real Vite build, and
 * CouchDB's real `/_utils` Content-Security-Policy — the three things the unit suite has none of.
 *
 * It guards two unrelated bugs that share that one blind spot, and the shape of both is the same:
 * green everywhere `npm test` can see, broken in every tarball.
 *
 *   view tester (#30)   `ReferenceError: runMapReduce is not defined` out of the Worker, in every
 *                       production build. vitest runs unminified source and happy-dom has no
 *                       `Worker`, so nothing ever executed a minified one.
 *
 *   system icons (#140) Web Awesome's *internal* icons — the `wa-select` chevron, the tick on a
 *                       selected `wa-option`, the eye on a password `wa-input`, the × on
 *                       `wa-dialog` — resolved to `data:` URIs, which `<wa-icon>` FETCHES. That
 *                       makes them a `connect-src` matter, and CouchDB serves `/_utils` with
 *                       `default-src 'self'` and no `connect-src` at all, so every one of them was
 *                       blocked. happy-dom has no CSP, so no unit test can state this either.
 *
 * Results are published on `window.__smokeResult` for the driver to read over CDP.
 */

// The app's own side-effect module, imported whole and not piecemeal: it is what fixes the order
// (`src/icons.js` first, before any component), and that order is itself the thing #140's fix
// depends on. Reaching past it for two component imports would test an arrangement nothing ships.
import '../../src/webawesome.js';
import { getIconLibrary } from '@awesome.me/webawesome/dist/components/icon/library.js';
import { icons as systemIcons } from '@awesome.me/webawesome/dist/components/icon/library.system.js';
import { runViewIsolated } from '../../src/services/view-runner-host.js';

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Every icon Web Awesome's own components draw, under the policy CouchDB actually sends.
 *
 * The assertion is about CONTENT, not existence. A blocked `<wa-icon>` is still in the DOM and
 * still the right size — that is precisely why #140 went unnoticed: no broken-image placeholder,
 * no error a console reader would recognise as being about icons, just controls that are blank.
 * `<wa-icon>` renders an empty `<svg>` placeholder before its fetch resolves and renders nothing
 * at all after a failed one, so "an `<svg>` with children" is false in both failure modes and true
 * only when the fetch really returned SVG markup.
 *
 * All of them, not a sample, and the list is read out of the vendored package rather than written
 * here: re-registering the `system` library (`src/icons.ts`) made providing every one of them our
 * responsibility, and a Web Awesome upgrade must not be able to add an icon this gate ignores.
 */
async function systemIconChecks(): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

  const url = getIconLibrary('system')?.resolver('check', 'classic', 'solid', false);
  add(
    'system-icons-are-not-data-uris',
    typeof url === 'string' && url.length > 0 && !url.startsWith('data:'),
    `system resolver gave ${JSON.stringify(typeof url === 'string' ? url.slice(0, 60) : url)}`
  );

  const pairs = Object.entries(systemIcons).flatMap(([variant, collection]) =>
    Object.keys(collection).map(name => ({ variant, name }))
  );

  const box = document.createElement('div');
  // Rendered, just not where anyone has to look at it. `display: none` would still update, but
  // off-screen keeps this closest to what a real component does.
  box.style.cssText = 'position:absolute;left:-9999px;top:0';
  document.body.append(box);

  // `wa-load`/`wa-error` both bubble and are composed, and `<wa-icon>` fires exactly one of them
  // per icon — including on a CSP-blocked fetch, which surfaces as a rejected `fetch`. Counting
  // them rather than polling for content means a pass costs milliseconds and only a real hang
  // costs the timeout.
  let settled = 0;
  const allSettled = new Promise<void>(resolve => {
    const tick = () => {
      if (++settled >= pairs.length) resolve();
    };
    box.addEventListener('wa-load', tick);
    box.addEventListener('wa-error', tick);
  });

  const mounted = pairs.map(({ variant, name }) => {
    const el = document.createElement('wa-icon');
    el.setAttribute('library', 'system');
    el.setAttribute('variant', variant);
    el.setAttribute('name', name);
    box.append(el);
    return { variant, name, el };
  });

  await Promise.race([allSettled, sleep(15_000)]);
  for (const { el } of mounted) await (el as HTMLElement & { updateComplete: Promise<boolean> }).updateComplete;

  const blank = mounted.filter(({ el }) => {
    const svg = el.shadowRoot?.querySelector('svg');
    return !svg || svg.children.length === 0;
  });
  add(
    'system-icons-render',
    mounted.length > 40 && blank.length === 0,
    `${mounted.length - blank.length}/${mounted.length} system icons have SVG content` +
      (blank.length > 0 ? ` — blank: ${blank.map(b => `${b.variant}/${b.name}`).join(', ')}` : '')
  );

  // The same question asked of a real control rather than a hand-built `<wa-icon>`: `wa-select`
  // draws its caret from the system library inside its own shadow root, which is where a user
  // would have met this bug.
  const select = document.createElement('wa-select') as HTMLElement & { updateComplete: Promise<boolean> };
  select.innerHTML = '<wa-option value="a">a</wa-option>';
  box.append(select);
  await select.updateComplete;
  const caret = select.shadowRoot?.querySelector('wa-icon') as HTMLElement | null;
  for (let i = 0; i < 50 && !caret?.shadowRoot?.querySelector('svg')?.children.length; i++) await sleep(20);
  const caretSvg = caret?.shadowRoot?.querySelector('svg');
  add(
    'wa-select-caret-renders',
    caretSvg !== null && caretSvg !== undefined && caretSvg.children.length > 0,
    `wa-select's caret: wa-icon=${caret !== null && caret !== undefined} svg children=${caretSvg?.children.length ?? 'none'}`
  );

  box.remove();
  return checks;
}

/**
 * Two checks for the view tester, because either one alone can pass while the feature is broken,
 * then the icon checks above.
 *
 * `rows` is the headline assertion — the one that fails with
 * `Worker error: Uncaught ReferenceError: runMapReduce is not defined` on the pre-#30 code.
 *
 * `worker-isolation` exists because {@link runViewIsolated} falls back to running in the page when
 * no `Worker` is available, and that fallback returns byte-identical results for a small sample
 * set. Without this check, a build that broke worker creation outright would still show green
 * rows. `window` is the discriminator: a dedicated Worker's global scope has none, the page does.
 */
async function runChecks(): Promise<Check[]> {
  const checks: Check[] = [];

  const mapSource = 'function (doc) { emit(doc.type, doc.n); }';
  const docs = [
    { _id: 'a', type: 'fruit', n: 2 },
    { _id: 'b', type: 'fruit', n: 3 },
    { _id: 'c', type: 'veg', n: 5 }
  ];
  const summed = await runViewIsolated(mapSource, docs, '_sum');
  const rowsAsText = JSON.stringify(summed.rows);
  checks.push({
    name: 'rows',
    ok: summed.error === null && rowsAsText === '[{"key":"fruit","value":5,"id":""},{"key":"veg","value":5,"id":""}]',
    detail: `error=${JSON.stringify(summed.error)} rows=${rowsAsText}`
  });

  const probe = await runViewIsolated('function (doc) { emit(typeof window, doc._id); }', [{ _id: 'a' }]);
  const scope = probe.rows[0]?.key;
  checks.push({
    name: 'worker-isolation',
    ok: probe.error === null && scope === 'undefined',
    detail: `error=${JSON.stringify(probe.error)} typeof-window-inside-runner=${JSON.stringify(scope)}`
  });

  checks.push(...(await systemIconChecks()));

  return checks;
}

interface SmokeResult {
  checks: Check[];
  workerConstructor: boolean;
  failed: string[];
}

declare global {
  interface Window {
    __smokeResult?: SmokeResult;
  }
}

void (async () => {
  let checks: Check[];
  try {
    checks = await runChecks();
  } catch (err) {
    checks = [{ name: 'threw', ok: false, detail: err instanceof Error ? err.stack ?? err.message : String(err) }];
  }
  const result: SmokeResult = {
    checks,
    workerConstructor: typeof Worker !== 'undefined',
    failed: checks.filter((c) => !c.ok).map((c) => c.name)
  };
  const out = document.getElementById('out');
  if (out) out.textContent = JSON.stringify(result, null, 2);
  window.__smokeResult = result;
})();
