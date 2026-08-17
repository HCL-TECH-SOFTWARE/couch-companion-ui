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
 * SPA-mode gate: a real browser, a real build, a real CouchDB, on a real different origin (#37).
 *
 * WHY THIS EXISTS. SPA mode — the bundle hosted anywhere, pointed at a remote CouchDB (spec D5) —
 * is one of the two shipped deployments, and the one where CORS preflights, cross-site cookies and
 * a page CSP all actually apply. Every one of those mechanisms has already produced a bug here
 * (#35, #36, #13). None of them is expressible in `npm test`: happy-dom has no CORS, no cookie jar
 * and no CSP, and under Node's fetch `credentials: "include"` does nothing at all. The suite could
 * not state the sentence "in SPA mode, logging in leaves you logged in", let alone check it.
 *
 * WHAT IT DOES. Builds `test/spa/spa-runner.html` with the repo's own `vite.config.ts`, serves it
 * on a fixed port under a Content-Security-Policy, and drives headless Chrome over the DevTools
 * Protocol through four scenarios. Two are decided in the page (`test/spa/spa-runner.ts`); two can
 * only be decided from outside it, because a preflight is not observable from JavaScript and a
 * rejected `Set-Cookie` is `HttpOnly` and cross-origin:
 *
 *   session       the app on the same *site* as CouchDB but a different origin (cookies ignore
 *                 ports; CORS does not). Login must stick and an authenticated read must work.
 *                 The driver adds: `POST /_session` IS preflighted (it has a JSON body) and
 *                 `GET /_all_dbs` is NOT (#36 — bodyless requests carry no `Content-Type`).
 *   mru           the `wa-select` login branch, which only renders once the MRU has entries, and
 *                 `handleSubmit`'s rule that the component's own state beats the submitted value.
 *   cross-site    the app on a different *site*. Over plain HTTP the session cookie cannot
 *                 survive, and the app must SAY so (#35) rather than report success and bounce.
 *                 The driver reads Chrome's own reason for rejecting the cookie.
 *   csp-blocked   the same build under CouchDB's `/_utils` policy, which has no `connect-src`.
 *                 The cross-origin request must be blocked — which is also the control proving the
 *                 CSP in the other scenarios is genuinely enforced and not just a header we send.
 *
 * CREDENTIAL-GATED. With nothing configured this SKIPS visibly and exits 0, so `npm test` and the
 * merge gate stay hermetic — the same bargain `npm run test:e2e` makes. See `.env.example`.
 *
 * The CouchDB it is pointed at must have CORS enabled for the app's origin; the check reads the
 * config first and says exactly what to set if not. It never writes CouchDB config.
 *
 * USAGE
 *   node scripts/spa-check.mjs             build, then run every scenario the setup allows
 *   node scripts/spa-check.mjs --verbose   print browser console/log output even on success
 *   node scripts/spa-check.mjs --no-build  reuse the existing .spa/ build
 *
 * Set CHROME_PATH if Chrome is not in one of the usual places.
 */

import fs from 'node:fs';
import net from 'node:net';
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
  skip,
  usageFrom,
  waitForResult
} from './lib/browser.mjs';
import { loadEnvLocal } from './lib/env-local.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, '.spa');
const ENTRY_REL = 'test/spa/spa-runner.html';
const ENTRY = path.join(ROOT, ENTRY_REL);
const PAGE = ENTRY_REL;

/** The port the app is served on. Fixed, because an operator's `[cors] origins` has to name it. */
const DEFAULT_PORT = 5173;

/**
 * A server the harness must never end up signed in to. `.invalid` is reserved by RFC 2606 and
 * resolves nowhere, so if the precedence rule in `handleSubmit` ever inverts, the failure is a
 * failed login rather than a real request to somebody's machine.
 */
const STALE_SERVER = 'http://stale.invalid:5984';

/** Loopback names that this harness can bind a server to, and so can build an origin out of. */
const LOOPBACK = new Set(['localhost', '127.0.0.1']);

function parseArgs(argv) {
  const opts = { verbose: false, doBuild: true };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--verbose':
        opts.verbose = true;
        break;
      case '--no-build':
        opts.doBuild = false;
        break;
      case '-h':
      case '--help':
        process.stdout.write(usageFrom(import.meta.url));
        process.exit(0);
        break;
      default:
        fail(`unknown argument ${argv[i]} (try --help)`);
    }
  }
  return opts;
}

/**
 * Credentials and target, from the environment or `.env.local`.
 *
 * No fallback to the E2E suite's `CCA_E2E_ADMIN_*`: in its default `jwt` mode those are *Keycloak*
 * credentials, and quietly posting them to `POST /_session` would fail in a way that reads like a
 * bug in this gate. The CouchDB account is named separately because it is a different thing.
 *
 * The *URL* does fall back to `CCA_E2E_COUCH_URL`: which CouchDB to talk to is the one setting the
 * two harnesses genuinely share, and a machine that has one of them working has already answered
 * it. The account is still required explicitly, so nothing runs on a fallback alone.
 */
function readConfig() {
  loadEnvLocal(ROOT);
  const couchUrl = (process.env.CCA_SPA_COUCH_URL || process.env.CCA_E2E_COUCH_URL || '').replace(/\/+$/, '');
  const user = process.env.CCA_SPA_USER || '';
  const password = process.env.CCA_SPA_PASSWORD || '';

  const missing = [
    ['CCA_SPA_COUCH_URL', couchUrl],
    ['CCA_SPA_USER', user],
    ['CCA_SPA_PASSWORD', password]
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0) {
    skip(
      `${missing.join(', ')} not set. This gate needs a real CouchDB on a real different origin; ` +
        'nothing about SPA mode is observable without one. Copy .env.example to .env.local and ' +
        'fill in the CCA_SPA_* block to run it.'
    );
  }

  let couch;
  try {
    couch = new URL(couchUrl);
  } catch {
    fail(`CCA_SPA_COUCH_URL is not a URL: ${JSON.stringify(couchUrl)}`);
  }
  const port = Number(process.env.CCA_SPA_APP_PORT || DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`CCA_SPA_APP_PORT is not a port: ${process.env.CCA_SPA_APP_PORT}`);
  if (couch.hostname === 'localhost' || couch.hostname === '127.0.0.1') {
    if (Number(couch.port || (couch.protocol === 'https:' ? 443 : 80)) === port) {
      fail(`CCA_SPA_APP_PORT ${port} is CouchDB's own port — the app has to be a different origin`);
    }
  }
  return { couchUrl, couch, user, password, port };
}

/**
 * The app's port is fixed rather than free-chosen, because CouchDB's `[cors] origins` has to name
 * it — so a port someone else already owns has to be reported as the configuration problem it is,
 * not as a bind error out of the middle of the harness. A Vite dev server on 5173 is the likely
 * culprit and is exactly what the default collides with.
 */
async function assertPortFree(port) {
  for (const host of ['127.0.0.1', '::1']) {
    const err = await new Promise((resolve) => {
      const probe = net.createServer();
      probe.once('error', (e) => resolve(e));
      probe.listen(port, host, () => probe.close(() => resolve(null)));
    });
    if (err && err.code === 'EADDRINUSE') {
      fail(
        `something is already listening on ${host}:${port}. This gate serves the app there because ` +
          "CouchDB's [cors] origins has to name the origin. Stop it, or set CCA_SPA_APP_PORT to a " +
          'free port and add that origin to [cors] origins.'
      );
    }
  }
}

/** A read of CouchDB's own config, which is where every precondition of this gate is written. */
async function couchConfig(cfg, section) {
  const resp = await fetch(`${cfg.couchUrl}/_node/_local/_config/${section}`, {
    headers: { Authorization: `Basic ${Buffer.from(`${cfg.user}:${cfg.password}`).toString('base64')}` }
  }).catch((err) => fail(`could not reach ${cfg.couchUrl}: ${err.message}`));
  if (resp.status === 401) {
    fail(
      `${cfg.couchUrl} rejected ${JSON.stringify(cfg.user)}. CCA_SPA_USER must be a CouchDB server ` +
        'admin: the check reads `[cors]` config and does an admin-only read to prove the session works.'
    );
  }
  if (!resp.ok) fail(`GET /_node/_local/_config/${section} answered ${resp.status}`);
  return resp.json();
}

/**
 * Everything about the target that has to be true before any of this means anything, checked
 * against the live server rather than assumed. A misconfigured `[cors]` presents in the browser as
 * an opaque `TypeError: Failed to fetch`, indistinguishable from the CSP scenario's expected
 * failure — so it gets diagnosed here, once, in words.
 */
async function preconditions(cfg, origins) {
  const chttpd = await couchConfig(cfg, 'chttpd');
  const cors = await couchConfig(cfg, 'cors');
  const auth = await couchConfig(cfg, 'couch_httpd_auth');

  if (chttpd.enable_cors !== 'true') {
    fail(
      'CouchDB has CORS disabled ([chttpd] enable_cors is ' +
        `${JSON.stringify(chttpd.enable_cors ?? null)}), so no page on another origin can talk to ` +
        'it at all. Enable it in Setup → CORS, or:\n' +
        `  curl -X PUT ${cfg.couchUrl}/_node/_local/_config/chttpd/enable_cors -d '"true"'`
    );
  }
  if (cors.credentials !== 'true') {
    fail(
      `[cors] credentials is ${JSON.stringify(cors.credentials ?? null)}. The session cookie only ` +
        'travels cross-origin when it is "true".'
    );
  }
  const allowed = (cors.origins ?? '').split(',').map((s) => s.trim());
  const missing = origins.filter((o) => !allowed.includes(o) && !allowed.includes('*'));
  if (missing.length > 0) {
    fail(
      `[cors] origins does not allow ${missing.join(' or ')} — it is ${JSON.stringify(cors.origins ?? null)}.\n` +
        'This gate serves the app from those origins on purpose (one same-site with CouchDB, one ' +
        'not). Add them, and put the value back afterwards:\n' +
        `  curl -X PUT ${cfg.couchUrl}/_node/_local/_config/cors/origins -H 'Content-Type: application/json' \\\n` +
        `       -d '${JSON.stringify([...new Set([...allowed.filter(Boolean), ...origins])].join(', '))}'`
    );
  }
  return { sameSite: auth.same_site ?? null, corsOrigins: cors.origins ?? '' };
}

/** The site a cookie would be scoped to. Ports are irrelevant to cookies; the scheme is not. */
function siteOf(url) {
  const u = new URL(url);
  return `${u.protocol}//${u.hostname}`;
}

/**
 * Which scenarios this setup can actually construct.
 *
 * The `session` scenario needs an origin that is cross-*origin* but same-*site* with CouchDB,
 * which only exists when CouchDB is on a name this harness can also bind (loopback). Against a
 * remote CouchDB every local page is already cross-site, so `session` runs from `localhost` and is
 * a genuine cross-site login — which is exactly right: a remote SPA deployment where the session
 * does not survive is broken, and the gate should say so.
 */
function planScenarios(cfg, port, spaCsp) {
  const couchHost = cfg.couch.hostname;
  const loopbackCouch = LOOPBACK.has(couchHost);
  const sameSiteHost = loopbackCouch ? couchHost : 'localhost';
  const crossSiteHost = couchHost === 'localhost' ? '127.0.0.1' : 'localhost';

  const plan = [
    { scenario: 'session', host: sameSiteHost, csp: spaCsp },
    { scenario: 'mru', host: sameSiteHost, csp: spaCsp },
    { scenario: 'csp-blocked', host: sameSiteHost, csp: COUCHDB_UTILS_CSP }
  ];
  // Only when a *different* site is constructible. Against a remote CouchDB the `session` run
  // above is already the cross-site one and this would be the same pair of origins twice, with
  // opposite expectations.
  if (loopbackCouch) plan.push({ scenario: 'cross-site', host: crossSiteHost, csp: spaCsp });

  for (const s of plan) {
    s.origin = `http://${s.host}:${port}`;
    s.url = `${s.origin}/${PAGE}?scenario=${s.scenario}`;
    s.sameSite = siteOf(s.origin) === siteOf(cfg.couchUrl);
  }
  return plan;
}

/** Requests Chrome made during one scenario, in the shape the assertions ask questions of. */
function networkRecorder(client) {
  const state = { requests: [], responses: [], extra: new Map() };
  client.on((msg) => {
    if (msg.method === 'Network.requestWillBeSent') {
      state.requests.push({
        id: msg.params.requestId,
        url: msg.params.request.url,
        method: msg.params.request.method,
        type: msg.params.type ?? msg.params.initiator?.type ?? ''
      });
    } else if (msg.method === 'Network.responseReceived') {
      state.responses.push({ id: msg.params.requestId, url: msg.params.response.url, status: msg.params.response.status });
    } else if (msg.method === 'Network.responseReceivedExtraInfo') {
      // The only place a cross-origin, HttpOnly `Set-Cookie` — and Chrome's reason for refusing
      // it — is visible to anything. Nothing in the page can see either.
      state.extra.set(msg.params.requestId, {
        setCookie: msg.params.headers?.['set-cookie'] ?? msg.params.headers?.['Set-Cookie'] ?? null,
        blocked: msg.params.blockedCookies ?? []
      });
    }
  });
  return {
    state,
    reset() {
      state.requests.length = 0;
      state.responses.length = 0;
      state.extra.clear();
    }
  };
}

/** What the browser did with the `Set-Cookie` on `POST /_session`, in Chrome's own words. */
function sessionCookieVerdict(net, couchUrl) {
  const post = net.requests.find((r) => r.method === 'POST' && r.url === `${couchUrl}/_session`);
  if (!post) return { found: false, kept: false, detail: 'no POST /_session was made' };
  const extra = net.extra.get(post.id);
  if (!extra) return { found: false, kept: false, detail: 'no response headers were reported for POST /_session' };
  if (!extra.setCookie) return { found: false, kept: false, detail: 'POST /_session set no cookie at all' };
  const attrs = extra.setCookie.replace(/AuthSession=[^;]*/, 'AuthSession=…');
  const reasons = extra.blocked.flatMap((b) => b.blockedReasons ?? []);
  return {
    found: true,
    kept: reasons.length === 0,
    detail: reasons.length === 0 ? `browser kept ${attrs}` : `browser REFUSED ${attrs} — ${reasons.join(', ')}`
  };
}

/** Driver-side checks: the things no assertion inside the page could ever see. */
function driverChecks(plan, net, couchUrl, securityLog) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });
  const optionsTo = (url) => net.requests.filter((r) => r.method === 'OPTIONS' && r.url === url);
  const cookie = sessionCookieVerdict(net, couchUrl);

  if (plan.scenario === 'session' || plan.scenario === 'mru') {
    // The positive control. If Chrome did not report the preflight it certainly does make for
    // `POST /_session` (a JSON body is not a CORS-simple content type), then "no OPTIONS seen"
    // below would be measuring the harness's blindness rather than the client's behaviour.
    const preflights = optionsTo(`${couchUrl}/_session`);
    add(
      'preflight-observable',
      preflights.length > 0,
      `OPTIONS ${couchUrl}/_session seen ${preflights.length}× (a JSON body must be preflighted)`
    );
    // #36: `ApiClient` sends `Content-Type` only when there is a body, precisely so a bodyless
    // read stays in the CORS-simple set and costs one round trip instead of two.
    //
    // The GET itself is part of the assertion, not an assumption: "no OPTIONS was sent" is also
    // true of a request that was never made, and this check has to fail when the read stops
    // happening rather than quietly congratulate the client for it.
    const gets = net.requests.filter((r) => r.method === 'GET' && r.url === `${couchUrl}/_all_dbs`);
    const onGet = optionsTo(`${couchUrl}/_all_dbs`);
    add(
      'no-preflight-on-bodyless-get',
      gets.length > 0 && onGet.length === 0,
      `GET ${couchUrl}/_all_dbs seen ${gets.length}×, OPTIONS for it ${onGet.length}× ` +
        '(expected at least one GET and no OPTIONS — a request with no body sends no Content-Type)'
    );
    add('session-cookie-kept', cookie.kept, cookie.detail);
  }

  if (plan.scenario === 'cross-site') {
    add('session-cookie-refused-by-browser', cookie.found && !cookie.kept, cookie.detail);
  }

  if (plan.scenario === 'csp-blocked') {
    const violations = securityLog.filter((line) => /refused to connect|Content Security Policy/i.test(line));
    add(
      'csp-violation-reported',
      violations.length > 0,
      violations[0] ?? 'the browser logged no CSP violation — is the policy actually being sent?'
    );
    add(
      'csp-stopped-the-request-before-the-wire',
      !net.requests.some((r) => r.url.startsWith(`${couchUrl}/`)),
      `requests to ${couchUrl}: ${net.requests.filter((r) => r.url.startsWith(`${couchUrl}/`)).length}`
    );
  }

  return checks;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cfg = readConfig();
  const chrome = findChrome();

  const couchOrigin = new URL(cfg.couchUrl).origin;
  /**
   * What a static host would have to send for SPA mode to work: CouchDB's own `/_utils` policy —
   * the strictest one this app is known to run under — plus the one directive that deployment
   * cannot do without. Spelling it out here is how the `csp-blocked` scenario stays meaningful:
   * the difference between the two policies is a single `connect-src`, and it is the difference
   * between a working SPA deployment and a page that cannot reach its database.
   *
   * `data:` used to be in here, and its removal is the evidence for #140. Web Awesome's *system*
   * icon library — the chevron on `wa-select`, the tick on a selected `wa-option`, the eye on a
   * password field, the × on a dialog — resolved to `data:` URIs, and `<wa-icon>` FETCHES them, so
   * a `connect-src` without `data:` blocked every one of them. That was survivable here and fatal
   * on the drop-in, whose policy nobody gets to edit. `src/icons.ts` now serves those icons from
   * this origin instead, so an SPA host needs no `data:`.
   *
   * That the icons really do render is asserted in `scripts/smoke.mjs`, not here, and deliberately
   * so: it serves the byte-identical `COUCHDB_UTILS_CSP`, so a copy here would restate one fact
   * twice — and this gate is credential-gated and skips in CI, which is where a regression guard
   * for a bug that shipped in every tarball has to run.
   */
  const spaCsp = `${COUCHDB_UTILS_CSP} connect-src 'self' ${couchOrigin};`;

  const plan = planScenarios(cfg, cfg.port, spaCsp);
  await assertPortFree(cfg.port);
  const observed = await preconditions(cfg, [...new Set(plan.map((s) => s.origin))]);

  process.stdout.write(
    `\nCouchDB      ${cfg.couchUrl}  (site ${siteOf(cfg.couchUrl)})\n` +
      `as           ${cfg.user}\n` +
      `[cors]       origins = ${observed.corsOrigins}\n` +
      `[couch_httpd_auth] same_site = ${observed.sameSite ?? '(unset — cookies default to SameSite=Lax)'}\n`
  );

  if (opts.doBuild) {
    // The repo's own config, overridden only in where it reads from, writes to, and resolves URLs
    // against. `base: '/'` and not the repo's `./`: the harness serves the build's root at the web
    // root, and the runner page sits two directories down, so relative asset URLs would resolve
    // against the wrong prefix and `<wa-icon>` would 404 its way through every render.
    await build({
      configFile: path.join(ROOT, 'vite.config.ts'),
      root: ROOT,
      base: '/',
      logLevel: 'warn',
      build: { outDir: OUT_DIR, emptyOutDir: true, rollupOptions: { input: ENTRY } }
    });
  }
  if (!fs.existsSync(path.join(OUT_DIR, PAGE))) {
    fail(`${path.relative(ROOT, path.join(OUT_DIR, PAGE))} is missing — build first`);
  }

  // Flipped between scenarios rather than baked in: the whole point of `csp-blocked` is to serve
  // the *same* build from the *same* origin under a different policy.
  let policy = spaCsp;
  const server = await serve(OUT_DIR, { csp: () => policy, port: cfg.port, hosts: ['127.0.0.1', '::1'] });
  cleanups.push(() => server.close());
  if (server.port !== cfg.port) fail(`could not serve on port ${cfg.port}`);

  const events = [];
  const results = [];
  try {
    const client = await launchChrome(chrome);
    recordBrowserEvents(client, events);
    const net = networkRecorder(client);
    const sessionId = await attachToPage(client);

    await client.send('Runtime.enable', {}, sessionId);
    await client.send('Log.enable', {}, sessionId);
    await client.send('Page.enable', {}, sessionId);
    await client.send('Network.enable', {}, sessionId);
    // Not about stale assets. CouchDB answers a preflight with `Access-Control-Max-Age: 600`, and
    // Chrome's preflight cache is per-profile and outlives a navigation — so the second scenario
    // to sign in would make its `POST /_session` with no `OPTIONS` in front of it, and both
    // preflight assertions would be reading a cache rather than the client. Disabling the cache
    // takes the preflight cache with it (`LOAD_DISABLE_CACHE` bypasses it), which makes "an
    // OPTIONS was sent" and "no OPTIONS was sent" both mean what they say, every time.
    await client.send('Network.setCacheDisabled', { cacheDisabled: true }, sessionId);
    // The credentials go in over CDP, not in the URL and not in a file the server hands out:
    // an injected script is evaluated before the page's own and never touches the wire.
    await client.send(
      'Page.addScriptToEvaluateOnNewDocument',
      {
        source: `window.__spaConfig = ${JSON.stringify({
          couchUrl: cfg.couchUrl,
          user: cfg.user,
          password: cfg.password,
          staleUrl: STALE_SERVER
        })};`
      },
      sessionId
    );

    for (const s of plan) {
      policy = s.csp;
      net.reset();
      const eventsBefore = events.length;
      // Every scenario starts from a browser that has never signed in — the cookie jar is
      // per-profile, so without this the second scenario would inherit the first one's session.
      await client.send('Network.clearBrowserCookies', {}, sessionId);
      await client.send('Page.navigate', { url: s.url }, sessionId);
      const result = await waitForResult(client, sessionId, '__spaResult', {
        accept: (value) => value.scenario === s.scenario && value.origin === s.origin
      });
      const scenarioEvents = events.slice(eventsBefore);
      results.push({
        plan: s,
        result,
        checks: result ? [...result.checks, ...driverChecks(s, net.state, cfg.couchUrl, scenarioEvents)] : [],
        events: scenarioEvents,
        // Truncated: URLs here can be long enough to bury the four requests this gate is
        // actually about.
        requests: net.state.requests.map(
          (r) => `${r.method} ${r.url.length > 120 ? `${r.url.slice(0, 120)}…` : r.url}${r.type ? ` (${r.type})` : ''}`
        )
      });
    }
    client.close();
  } finally {
    cleanUp();
  }

  let failed = 0;
  for (const run of results) {
    process.stdout.write(`\n\x1b[1m${run.plan.scenario}\x1b[0m — app on ${run.plan.origin}, ${run.plan.sameSite ? 'same site as' : 'a different site from'} CouchDB\n`);
    process.stdout.write(`  CSP: ${run.plan.csp}\n`);
    if (!run.result) {
      failed++;
      process.stdout.write('\x1b[31m FAIL \x1b[0m the page never published a result\n');
    }
    for (const check of run.checks) {
      if (!check.ok) failed++;
      process.stdout.write(`${check.ok ? '\x1b[32m  ok  \x1b[0m' : '\x1b[31m FAIL \x1b[0m'} ${check.name}: ${check.detail}\n`);
    }
    if (opts.verbose || !run.result || run.checks.some((c) => !c.ok)) {
      process.stdout.write('  requests:\n');
      for (const r of run.requests) process.stdout.write(`    ${r}\n`);
      process.stdout.write('  browser output:\n');
      if (run.events.length === 0) process.stdout.write('    (the browser logged nothing)\n');
      for (const e of run.events) process.stdout.write(`    ${e}\n`);
    }
  }

  if (failed > 0) fail(`${failed} failing check${failed === 1 ? '' : 's'} (see above)`);
  process.stdout.write('\n\x1b[32mSPA mode works in a real browser against a real cross-origin CouchDB.\x1b[0m\n');
}

await main();
