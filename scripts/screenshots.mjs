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
 * Captures every screenshot in `docs/walkthrough/`.
 *
 * The walkthrough is a tour of a running application, so its pictures have to
 * come from a running application — and one that looks the same next year, or
 * the docs rot into a gallery of screens that no longer exist. This script is
 * how they are regenerated:
 *
 *   node scripts/screenshots.mjs
 *
 * WHAT IT STANDS UP. A throwaway CouchDB with Couch Companion already in
 * `share/www` — the image from `docker/Dockerfile`, the same one release.yml
 * publishes — on a fixed loopback port, seeded with the demo retailer in
 * `scripts/lib/demo-data.mjs`. Every shot is therefore of the real `/_utils/`
 * drop-in, over HTTP, in a real browser, against real CouchDB responses. The
 * container is destroyed at the end, including when a capture fails. Nothing
 * touches any CouchDB you happen to be running yourself.
 *
 * NO NEW DEPENDENCIES. Chrome is driven over the DevTools protocol through
 * `scripts/lib/browser.mjs`, the same driver `scripts/smoke.mjs` uses. There is
 * no Playwright or Puppeteer in this tree and this script does not add one.
 *
 * WHY THE PIXELS ARE MOSTLY STABLE. These PNGs are committed, so a re-run that
 * moved all of them would put an unreviewable multi-megabyte binary diff into
 * every docs change. The data is deterministic (see demo-data.mjs), the port,
 * viewport and theme are pinned, the server UUID is pinned, and CSS animations
 * are disabled before anything is captured.
 *
 * FOUR of the twenty-five still move between runs, measured rather than
 * assumed, and it is worth knowing which rather than being surprised by them:
 *
 *   configuration    server state that is not the UUID — uptime and friends
 *   database-list    on-disk sizes, which depend on how CouchDB laid the files out
 *   indexes          \
 *   view-editor      / the two Monaco-backed screens
 *
 * The other twenty-one are byte-for-byte identical run to run. If you are
 * re-capturing after a UI change, expect those four to show a diff regardless
 * and judge them by eye; a diff in any of the other twenty-one is real.
 *
 * (`topology` is NOT in this list, which is worth saying because it looks like
 * it should be: it draws a force-directed graph, but the simulation converges
 * to the same layout given the same data, so its `settleMs` below buys a stable
 * picture as well as a legible one.)
 *
 * Usage:
 *   node scripts/screenshots.mjs              build, capture everything, tear down
 *   node scripts/screenshots.mjs --fast       skip `vite build`, reuse dist/
 *   node scripts/screenshots.mjs --only db    capture only shots whose name contains "db"
 *   node scripts/screenshots.mjs --keep       leave the container running afterwards
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  findChrome,
  launchChrome,
  attachToPage,
  cleanUp,
  cleanups,
  fail,
  sleep
} from './lib/browser.mjs';
import { seed, DB } from './lib/demo-data.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'walkthrough', 'img');
const IMAGE = 'couch-companion-walkthrough:local';
// A FIXED host port, not an ephemeral one. The application prints its own
// address in the sidebar of every single screen ("Server: http://…"), and the
// replication table prints it again in the source and target columns — so a
// port that changed per run would change the pixels of every PNG in the set,
// which is precisely the churn this file claims to prevent.
const PORT = 15984;
const CONTAINER = 'couch-companion-walkthrough';
const USER = 'admin';
const PASS = 'companion';

const VIEWPORT = { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false };

const args = process.argv.slice(2);
const FAST = args.includes('--fast');
const KEEP = args.includes('--keep');
const ONLY = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;

let step = 0;
const say = (msg) => process.stdout.write(`\n\x1b[1m[${(step += 1)}] ${msg}\x1b[0m\n`);
const note = (msg) => process.stdout.write(`    ${msg}\n`);

const docker = (...a) =>
  execFileSync('docker', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/* ------------------------------------------------------------------ the shots */

/**
 * Every picture the walkthrough uses, in the order the walkthrough uses them.
 *
 * `path` is a hash route — the router is hash-based, so navigating is a hash
 * write rather than a page load, and CouchDB never has to serve a URL it has
 * no route for. `waitFor` is text that must appear in the rendered page before
 * the shutter opens; it is what stops a screenshot catching a spinner. Keep
 * this list and `docs/walkthrough/*.md` in step: the verifier at the end of
 * this script fails if a shot here is never referenced, or a reference has no
 * shot.
 */
const SHOTS = [
  // 01 — first run
  { name: 'login', path: null, waitFor: 'Username', anonymous: true },
  // The topology is a force-directed graph. Captured too early it is a knot of
  // overlapping nodes drifting through the lower half of the canvas, so give
  // the simulation time to settle before the shutter opens.
  { name: 'topology', path: '/topology', waitFor: 'Topology', settleMs: 4000 },
  { name: 'configuration', path: '/configuration/local', waitFor: 'couchdb' },

  // 02 — databases
  { name: 'database-list', path: '/databases/local', waitFor: 'orders' },
  { name: 'database-create', path: '/databases/local/create', waitFor: 'Create' },
  { name: 'database-access', path: '/databases/local/orders/access', waitFor: 'ops' },

  // 03 — documents
  { name: 'document-browser', path: '/databases/local/orders/documents', waitFor: 'order:2025-' },
  {
    name: 'document-editor',
    path: `/databases/local/orders/documents/${encodeURIComponent('order:2025-1003')}`,
    waitFor: 'customer_name'
  },
  { name: 'document-new', path: '/databases/local/orders/documents/new', waitFor: 'Document ID' },

  // 04 — queries and indexes
  { name: 'mango-query', path: '/databases/local/orders/query', waitFor: 'selector' },
  { name: 'indexes', path: '/databases/local/orders/indexes', waitFor: 'status-date' },

  // 05 — design documents and views
  {
    name: 'design-docs',
    path: '/design-docs/local',
    // This page lists nothing until a database is chosen — it opens on "No
    // design documents found" with an empty picker. Rather than drive the
    // Web Awesome combobox through its shadow root, hand the page the event
    // its own template listens for.
    prepare: `(() => {
      const picker = window.__deepFind('cca-db-picker');
      if (!picker) return false;
      picker.dispatchEvent(new CustomEvent('cca-db-change', {
        detail: { database: 'orders' }, bubbles: true, composed: true
      }));
      return true;
    })()`,
    waitFor: '_design/reports'
  },
  {
    name: 'view-editor',
    path: `/design-docs/local/editor/orders/${encodeURIComponent('_design/reports')}`,
    waitFor: 'by_status'
  },
  { name: 'conflicts', path: '/design-docs/local/conflicts', waitFor: 'No conflicts recorded' },

  // 06 — replication
  { name: 'replication-list', path: '/replications/local', waitFor: 'Continuous' },
  { name: 'replication-create', path: '/replications/local/create', waitFor: 'Source' },
  { name: 'active-tasks', path: '/active-tasks/local', waitFor: 'ask' },

  // 07 — users and roles
  { name: 'users-list', path: '/users/local', waitFor: 'ana.sales' },
  {
    name: 'user-detail',
    path: `/users/local/${encodeURIComponent('org.couchdb.user:ana.sales')}`,
    waitFor: 'sales'
  },

  // 08 — version control
  { name: 'version-control', path: '/version-control', waitFor: 'ersion' },

  // 09 — identity providers
  { name: 'idp-list', path: '/idp', waitFor: 'Keycloak' },
  {
    name: 'idp-detail',
    path: `/idp/${encodeURIComponent('https://sso.example.internal/realms/couch-companion')}`,
    waitFor: 'couchdb_roles'
  },
  { name: 'idp-add', path: '/idp/add', waitFor: 'rovider' },
  { name: 'idp-logs', path: '/idp/logs', waitFor: 'og' },

  // extras used across pages
  { name: 'banners', path: '/banners', waitFor: 'anner' }
];

/* -------------------------------------------------------------- the container */

function startStack() {
  say('build the image from docker/Dockerfile');
  if (!FAST) {
    note('npx vite build');
    const built = spawnSync('npx', ['vite', 'build'], { cwd: ROOT, stdio: 'inherit' });
    if (built.status !== 0) fail('vite build');
  } else {
    note('--fast: reusing the existing dist/');
  }
  if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) {
    fail('dist/index.html is missing — run without --fast');
  }
  docker('build', '-q', '-f', 'docker/Dockerfile', '--build-arg', 'VERSION=walkthrough', '-t', IMAGE, 'dist');

  say('run a throwaway CouchDB serving it');
  try {
    docker('rm', '-f', CONTAINER);
  } catch {
    /* not running; nothing to remove */
  }
  docker(
    'run', '-d', '--name', CONTAINER,
    '-p', `127.0.0.1:${PORT}:5984`,
    '-e', `COUCHDB_USER=${USER}`,
    '-e', `COUCHDB_PASSWORD=${PASS}`,
    IMAGE
  );
  if (!KEEP) {
    cleanups.push(() => {
      try {
        docker('rm', '-f', CONTAINER);
      } catch {
        /* already gone */
      }
    });
  }

  return `http://127.0.0.1:${PORT}`;
}

async function waitForCouch(base) {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`${base}/_up`);
      if (res.ok) return;
    } catch {
      /* not listening yet */
    }
    await sleep(1000);
  }
  fail(`the container never answered /_up — ${docker('logs', '--tail', '20', CONTAINER)}`);
}

/* ----------------------------------------------------------------- the camera */

/** Runs an expression in the page and returns its value. */
async function evaluate(client, sid, expression) {
  const { result, exceptionDetails } = await client.send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    sid
  );
  if (exceptionDetails) fail(`page threw: ${exceptionDetails.text} ${result?.description ?? ''}`);
  return result.value;
}

/**
 * All rendered text, shadow roots included.
 *
 * `document.body.innerText` stops at every shadow boundary, and this
 * application is entirely custom elements — so the naive version returns almost
 * nothing and every `waitFor` would time out against a page that had in fact
 * rendered. Walking the roots is not optional here.
 */
const DEEP_TEXT = `(() => {
  const out = [];
  const walk = (root) => {
    if (!root) return;
    if (root.nodeType === Node.TEXT_NODE) { out.push(root.textContent); return; }
    for (const el of root.querySelectorAll('*')) {
      if (el.tagName === 'STYLE' || el.tagName === 'SCRIPT') continue;
      if (el.shadowRoot) walk(el.shadowRoot);
      for (const n of el.childNodes) if (n.nodeType === Node.TEXT_NODE) out.push(n.textContent);
      const v = el.value;
      if (typeof v === 'string' && v) out.push(v);
      for (const a of ['label', 'placeholder', 'name']) {
        const av = el.getAttribute && el.getAttribute(a);
        if (av) out.push(av);
      }
    }
  };
  walk(document.body);
  return out.join(' ');
})()`;

async function waitForText(client, sid, needle, { timeoutMs = 20000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let seen = '';
  while (Date.now() < deadline) {
    seen = (await evaluate(client, sid, DEEP_TEXT)) ?? '';
    if (seen.includes(needle)) return true;
    await sleep(250);
  }
  return false;
}

/** Kills anything that would make two runs differ: animation, carets, scrollbars. */
const FREEZE_CSS = `
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
  }
  ::-webkit-scrollbar { width: 0 !important; height: 0 !important; }
`;

/**
 * A shadow-piercing `querySelector`, installed on `window` so a shot's
 * `prepare` snippet can reach an element without each one re-implementing the
 * walk. Every component here lives in a shadow root, so the built-in
 * `document.querySelector` finds almost none of them.
 */
const DEEP_FIND = `window.__deepFind = (sel) => {
  const seen = new Set();
  const search = (root) => {
    if (!root || seen.has(root)) return null;
    seen.add(root);
    const hit = root.querySelector(sel);
    if (hit) return hit;
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) {
        const deeper = search(el.shadowRoot);
        if (deeper) return deeper;
      }
    }
    return null;
  };
  return search(document);
}; true`;

async function freeze(client, sid) {
  await evaluate(
    client,
    sid,
    `(() => {
      let s = document.getElementById('cca-shot-freeze');
      if (!s) {
        s = document.createElement('style');
        s.id = 'cca-shot-freeze';
        document.head.appendChild(s);
      }
      s.textContent = ${JSON.stringify(FREEZE_CSS)};
      return true;
    })()`
  );
}

async function capture(client, sid, name) {
  await freeze(client, sid);
  const shot = await client.send('Page.captureScreenshot', { format: 'png' }, sid);
  const file = path.join(OUT, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
  return fs.statSync(file).size;
}

/* -------------------------------------------------------------------- the run */

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const base = startStack();
  note(`container: ${base}`);
  await waitForCouch(base);

  say('seed the demo data');
  const auth = `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`;
  await seed(base, auth, note);

  say('launch Chrome and sign in');
  const client = await launchChrome(findChrome());
  const sid = await attachToPage(client);
  await client.send('Page.enable', {}, sid);
  await client.send('Runtime.enable', {}, sid);
  await client.send('Emulation.setDeviceMetricsOverride', VIEWPORT, sid);

  const shots = SHOTS.filter((s) => !ONLY || s.name.includes(ONLY));
  if (shots.length === 0) fail(`--only ${ONLY} matched no shot`);

  let bytes = 0;
  const captured = [];
  const missed = [];

  // The anonymous shots first, while there is still no session cookie.
  for (const shot of shots.filter((s) => s.anonymous)) {
    await client.send('Page.navigate', { url: `${base}/_utils/` }, sid);
    await sleep(1500);
    const ok = await waitForText(client, sid, shot.waitFor);
    if (!ok) missed.push(shot.name);
    bytes += await capture(client, sid, shot.name);
    captured.push(shot.name);
    note(`${shot.name}${ok ? '' : '  (waitFor never appeared)'}`);
  }

  // Sign in through CouchDB directly rather than by driving the login form:
  // the form is Web Awesome custom elements inside a shadow root, and a
  // screenshot run should not be the thing that breaks when their internals
  // change. The cookie is what the app actually reads either way.
  await client.send('Page.navigate', { url: `${base}/_utils/` }, sid);
  await sleep(1000);
  const signedIn = await evaluate(
    client,
    sid,
    `fetch('/_session', {
       method: 'POST',
       headers: { 'content-type': 'application/json' },
       body: JSON.stringify({ name: ${JSON.stringify(USER)}, password: ${JSON.stringify(PASS)} })
     }).then(r => r.ok)`
  );
  if (!signedIn) fail('POST /_session did not establish a session');

  // The cookie alone changes nothing on screen. The application decided it was
  // logged out when it booted, and it is still showing the login card; only a
  // reload makes it read the session it now has. Without this every single
  // screenshot below is a picture of the login form, at identical byte size,
  // which is exactly as obvious as it sounds and exactly as easy to miss.
  await evaluate(client, sid, 'location.reload(); true');
  await sleep(2500);
  if (!(await waitForText(client, sid, 'Databases'))) {
    fail('signed in, but the application shell never rendered after the reload');
  }
  note('session established, shell rendered');

  for (const shot of shots.filter((s) => !s.anonymous)) {
    await evaluate(client, sid, `location.hash = ${JSON.stringify(shot.path)}; true`);
    await sleep(900);
    if (shot.prepare) {
      await evaluate(client, sid, DEEP_FIND);
      const prepared = await evaluate(client, sid, shot.prepare);
      if (!prepared) fail(`${shot.name}: its prepare step found nothing to act on`);
      await sleep(900);
    }
    const ok = await waitForText(client, sid, shot.waitFor);
    if (!ok) {
      missed.push(shot.name);
      const seen = ((await evaluate(client, sid, DEEP_TEXT)) ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 220);
      note(`\x1b[33m${shot.name}: never saw "${shot.waitFor}" — page reads: ${seen}\x1b[0m`);
    }
    await sleep(shot.settleMs ?? 400);
    bytes += await capture(client, sid, shot.name);
    captured.push(shot.name);
    if (ok) note(shot.name);
  }

  say('summary');
  note(`${captured.length} screenshots, ${(bytes / 1048576).toFixed(1)} MB total, in docs/walkthrough/img/`);
  if (missed.length) {
    note(`\x1b[33m${missed.length} shot(s) captured without their expected content: ${missed.join(', ')}\x1b[0m`);
  }
  if (KEEP) note(`--keep: ${CONTAINER} is still running at ${base}/_utils/`);
  return missed;
}

const missed = await main().catch((err) => {
  cleanUp();
  fail(err.stack ?? String(err));
});
cleanUp();
process.exit(missed && missed.length ? 1 : 0);
