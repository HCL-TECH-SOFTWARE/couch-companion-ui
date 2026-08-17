#!/usr/bin/env node
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
 * Post-build smoke check: a real browser, a real Vite build, a real Worker, a real CSP.
 *
 * WHY THIS EXISTS. `npm test` cannot catch the class of bug #30 was. The view tester shipped
 * broken in *every* production build — `ReferenceError: runMapReduce is not defined` from the
 * Worker, every time — while the suite stayed green, for two independent reasons: vitest runs
 * unminified source, and happy-dom implements no `Worker`, so nothing ever executed a minified
 * Worker. No unit test can be added that would have caught it. Only this can.
 *
 * #140 was the same shape for a different reason, which is why it is asserted here too: Web
 * Awesome's *internal* icons resolved to `data:` URIs that `<wa-icon>` FETCHES, so CouchDB's
 * `/_utils` policy — `default-src 'self'`, no `connect-src` — blocked every one of them, silently,
 * in every tarball. happy-dom has no CSP, so again no unit test could state it. This gate already
 * serves that exact policy, and it is the only browser gate that needs no credentials and so
 * actually runs in CI; the credential-gated SPA gate would have skipped there.
 *
 * #148 added a third of the same shape: Monaco 0.56's granular entry points replaced
 * `import 'monaco-editor'` with an explicit list of what to register, and every way that list can
 * be wrong is silent. A contribution nobody imported does not throw — the suggest widget just never
 * opens, the icons are just blank boxes. `test/cca-monaco-editor.test.ts` mocks the editor away to
 * be able to test the component at all, and every other suite mocks the component. So what the
 * editor can actually do is asserted here, in `test/smoke/editor.ts`, or nowhere.
 *
 * WHAT IT DOES.
 *   1. Builds the pages in `PAGES` with the repo's own `vite.config.ts` — same worker format, same
 *      minifier, same plugins — into `.smoke/`. A second, tiny build rather than extra entries in
 *      `dist/`, so no test scaffolding is ever shipped to an operator.
 *   2. Serves `.smoke/` over HTTP under a Content-Security-Policy. The default is the header
 *      CouchDB 3.5.2 actually sends for `/_utils/`, so the gate asserts the feature works under
 *      the policy of the primary deployment target, not under no policy at all.
 *   3. Drives headless Chrome over the DevTools Protocol (Node's built-in WebSocket, no new
 *      dependency), loads each page in turn in the same tab, and reads back what its browser-side
 *      half — `test/smoke/view-runner.ts`, `test/smoke/editor.ts` — asserted.
 *
 * Console output, uncaught exceptions and browser log entries — from the page *and* from
 * auto-attached Worker targets — are captured and printed on failure, since a CSP violation or a
 * worker-side throw is the evidence that matters when this goes red.
 *
 * Finding Chrome, serving a directory under a policy, speaking CDP and tearing it all down again
 * live in `scripts/lib/browser.mjs`, shared with `scripts/spa-check.mjs` (#37). What stays here is
 * only what this gate asserts.
 *
 * USAGE
 *   node scripts/smoke.mjs                 build, serve under CouchDB's /_utils CSP, assert
 *   node scripts/smoke.mjs --csp '<policy>'  serve under a policy of your choosing
 *   node scripts/smoke.mjs --no-csp        serve with no CSP header at all
 *   node scripts/smoke.mjs --verbose       print browser console/log output even on success
 *   node scripts/smoke.mjs --no-build      reuse the existing .smoke/ build
 *
 * Set CHROME_PATH if Chrome is not in one of the usual places.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import {
  attachToPage,
  cleanUp,
  cleanups,
  COUCHDB_UTILS_CSP,
  fail,
  findChrome,
  launchChrome,
  recordBrowserEvents,
  serve,
  usageFrom,
  waitForResult
} from './lib/browser.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, '.smoke');

/**
 * The harness pages, driven in order in one browser against one build.
 *
 * Vite writes an HTML entry to its path relative to `root`, so each page keeps its source layout
 * and its URL is its own relative path.
 */
const PAGES = [
  { rel: 'test/smoke/view-runner.html', what: 'view tester, Web Awesome icons' },
  { rel: 'test/smoke/editor.html', what: 'Monaco: languages, features, icons' }
];

function parseArgs(argv) {
  const opts = { csp: COUCHDB_UTILS_CSP, verbose: false, doBuild: true };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--csp':
        opts.csp = argv[++i];
        if (opts.csp === undefined) fail('--csp needs a policy string');
        break;
      case '--no-csp':
        opts.csp = null;
        break;
      case '--verbose':
        opts.verbose = true;
        break;
      case '--no-build':
        opts.doBuild = false;
        break;
      case '-h':
      case '--help':
        // Anchored on the text, not on line numbers: check.sh and package.sh print their help
        // with a hardcoded `sed -n 'N,Mp'`, and an edit above the block silently truncates it.
        process.stdout.write(usageFrom(import.meta.url));
        process.exit(0);
        break;
      default:
        fail(`unknown argument ${argv[i]} (try --help)`);
    }
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const chrome = findChrome();

  if (opts.doBuild) {
    // The repo's own config file, overridden only in where it reads from, writes to, and resolves
    // URLs against. Anything that changes how the app is bundled — worker format, minification,
    // chunking — changes this build the same way, which is the whole reason this is worth running.
    //
    // `base: '/'` and not the repo's `./`: the harness serves the build's root at the web root and
    // this page sits two directories down, so a `./`-relative `import.meta.env.BASE_URL` would
    // resolve `<wa-icon>`'s icon path against `/test/smoke/` and 404 every icon — which would fail
    // the icon checks for a reason that has nothing to do with the policy they are about. (Vite's
    // own emitted asset URLs are computed per-file and were always right either way.) Same
    // override, same reason, as `scripts/spa-check.mjs`.
    await build({
      configFile: path.join(ROOT, 'vite.config.ts'),
      root: ROOT,
      base: '/',
      logLevel: 'warn',
      build: {
        outDir: OUT_DIR,
        emptyOutDir: true,
        rollupOptions: { input: PAGES.map((page) => path.join(ROOT, page.rel)) }
      }
    });
  }
  for (const page of PAGES) {
    if (!fs.existsSync(path.join(OUT_DIR, page.rel))) {
      fail(`${path.relative(ROOT, path.join(OUT_DIR, page.rel))} is missing — build first`);
    }
  }

  const server = await serve(OUT_DIR, { csp: opts.csp });
  cleanups.push(() => server.close());

  const events = [];
  const results = new Map();
  try {
    const client = await launchChrome(chrome);
    recordBrowserEvents(client, events);
    const sessionId = await attachToPage(client);

    await client.send('Runtime.enable', {}, sessionId);
    await client.send('Log.enable', {}, sessionId);
    await client.send('Page.enable', {}, sessionId);
    // Worker targets: their console and their CSP violations do not surface on the page.
    await client.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId);

    // One page at a time in the same tab. Each navigation replaces the document, so the previous
    // page's `__smokeResult` goes with it and cannot be mistaken for this one's.
    for (const page of PAGES) {
      await client.send('Page.navigate', { url: `http://127.0.0.1:${server.port}/${page.rel}` }, sessionId);
      results.set(page.rel, await waitForResult(client, sessionId, '__smokeResult'));
    }
    client.close();
  } finally {
    cleanUp();
  }

  const dump = () => {
    if (events.length === 0) process.stdout.write('  (the browser logged nothing)\n');
    for (const e of events) process.stdout.write(`  ${e}\n`);
  };

  process.stdout.write(`\nCSP: ${opts.csp ?? '(none sent)'}\n`);

  const failures = [];
  for (const page of PAGES) {
    const result = results.get(page.rel);
    process.stdout.write(`\n${page.rel} — ${page.what}\n`);
    if (result === undefined) {
      process.stdout.write('browser output:\n');
      dump();
      fail(`${page.rel} never published a result — the page did not finish (see above)`);
    }
    for (const check of result.checks) {
      process.stdout.write(`${check.ok ? '\x1b[32m  ok  \x1b[0m' : '\x1b[31m FAIL \x1b[0m'} ${check.name}: ${check.detail}\n`);
    }
    failures.push(...result.failed.map((name) => `${path.basename(page.rel, '.html')}/${name}`));
  }

  if (opts.verbose || failures.length > 0) {
    process.stdout.write('browser output:\n');
    dump();
  }
  // Asserted on the view-runner result specifically: it is the page whose whole point is that a
  // minified Worker really ran (#30). A browser without `Worker` would pass it vacuously.
  if (!results.get('test/smoke/view-runner.html')?.workerConstructor) {
    fail('this browser has no Worker constructor, so the check proved nothing');
  }
  if (failures.length > 0) fail(`failing checks: ${failures.join(', ')}`);
  process.stdout.write(
    '\n\x1b[32mview tester, Web Awesome icons and the Monaco editor all work in a real browser, ' +
      'against a real build, under CouchDB’s own policy.\x1b[0m\n'
  );
}

await main();
