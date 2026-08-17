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
 * The half of a real-browser gate that is not about what is being asserted: find Chrome, serve a
 * directory, speak the DevTools Protocol, and tear all of it down again.
 *
 * Extracted from `scripts/smoke.mjs` when `scripts/spa-check.mjs` (#37) needed the same four
 * things. A second copy would have been the obvious way to get them, and the wrong one: the
 * awkward parts here — the `DevToolsActivePort` race, rejecting in-flight commands when the
 * browser dies so a failure reports instead of hanging, tearing down a headless Chrome on a path
 * that calls `process.exit` — are exactly the parts that are wrong in a copy nobody re-derived.
 *
 * No dependencies, on purpose. Driving Chrome over CDP with Node's built-in `WebSocket` is what
 * lets these gates run everywhere `npm ci` runs; `@vitest/browser` was removed in #63 precisely
 * because it cannot do anything without also installing a browser provider.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * What a failure calls itself — `smoke:` / `spa-check:`, taken from the script being run rather
 * than passed in, so a new gate cannot forget to name itself and report under someone else's name.
 */
const LABEL = path.basename(process.argv[1] ?? 'harness', '.mjs');

/**
 * Registered teardown. {@link fail} exits the process outright, so without this a failure part-way
 * through would leave a headless Chrome running and a port bound — on a gate that is meant to be
 * run repeatedly, that turns one red run into a machine nobody can get a green one on.
 */
export const cleanups = [];

export function cleanUp() {
  while (cleanups.length > 0) {
    try {
      cleanups.pop()();
    } catch {
      // Teardown is best-effort; a failure here must not mask the reason we are tearing down.
    }
  }
}

export function fail(message) {
  cleanUp();
  process.stderr.write(`\x1b[31m${LABEL}: ${message}\x1b[0m\n`);
  process.exit(1);
}

/** Prints a visible skip and exits 0 — an unconfigured credential-gated gate, not a green one. */
export function skip(reason) {
  cleanUp();
  process.stdout.write(`\x1b[33m${LABEL}: SKIPPED — ${reason}\x1b[0m\n`);
  process.exit(0);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A script's own `USAGE` block, read back out of its header comment.
 *
 * Anchored on the text and not on line numbers: `check.sh` and `package.sh` print their help with
 * a hardcoded `sed -n 'N,Mp'`, and an edit above the block silently truncates it.
 */
export function usageFrom(fileUrl) {
  const header = fs.readFileSync(fileURLToPath(fileUrl), 'utf8').split('*/')[1] ?? '';
  const lines = header
    .split('\n')
    .filter((line) => line.trimStart().startsWith('*'))
    .map((line) => line.replace(/^\s*\* ?/, ''));
  const from = lines.indexOf('USAGE');
  return from < 0
    ? `see the header comment in ${path.basename(fileURLToPath(fileUrl))}\n`
    : lines.slice(from + 1).join('\n').trim() + '\n';
}

/** Chrome is a hard requirement, not an optional extra: a skipped browser check gates nothing. */
export function findChrome() {
  // An explicit CHROME_PATH that does not exist is an error, not a hint. Falling back to whatever
  // else is installed would run the gate against a browser nobody asked for and say nothing.
  if (process.env.CHROME_PATH && !fs.existsSync(process.env.CHROME_PATH)) {
    fail(`CHROME_PATH is set to ${process.env.CHROME_PATH}, which does not exist`);
  }
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  ].filter(Boolean);
  const found = candidates.find((c) => fs.existsSync(c));
  if (!found) {
    fail(
      'no Chrome found. These checks need a real browser — no unit test can express what they ' +
        'assert (a minified Worker in #30, a cross-origin cookie in #37). Install Chrome, or set ' +
        `CHROME_PATH. Looked in:\n  ${candidates.join('\n  ')}`
    );
  }
  return found;
}

/**
 * What CouchDB 3.5.2 actually sends on `/_utils/` (`csp/utils_header_value`). Read from a live
 * server with `curl -s -i http://localhost:5984/_utils/ | grep -i content-security-policy`, and
 * quoted in `docs/install.md`. Gating on this and not on a hand-picked policy is the point: the
 * `/_utils` drop-in is the primary deployment target, so "works under CouchDB's CSP" is the
 * property worth pinning.
 *
 * Note what is *not* in it: no `connect-src`, so `default-src 'self'` decides, and a page under
 * this policy may only talk to its own origin. That is correct for the drop-in and fatal for SPA
 * mode — `spa-check.mjs` asserts both halves of that sentence.
 */
export const COUCHDB_UTILS_CSP =
  "child-src 'self' data: blob:; default-src 'self'; img-src 'self' data:; font-src 'self'; " +
  "script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; frame-src https://blog.couchdb.org;";

export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2'
};

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve(server.address().port);
    });
  });
}

/**
 * Serves `dir` over HTTP under an optional Content-Security-Policy.
 *
 * @param dir - directory to serve as the web root
 * @param opts.csp - policy sent on **every** response, not just the document: a Worker loaded from
 *   a network URL takes its CSP from its own response headers, so a policy applied to the HTML
 *   alone would be measuring something a real server-wide header does not do. A function is called
 *   per request, for a gate that serves the same build under more than one policy in one run.
 * @param opts.port - `0` picks a free one. A fixed port is what an operator's CouchDB `[cors]
 *   origins` can be configured against, which is why `spa-check.mjs` needs one.
 * @param opts.hosts - addresses to bind. Binding both loopback addresses is not redundancy: the
 *   spa gate serves the same build as `http://localhost:PORT` (same *site* as a CouchDB on
 *   `localhost`, cookies and all) and as `http://127.0.0.1:PORT` (a different site), and which
 *   address `localhost` resolves to is the platform's business, not ours. A host that cannot be
 *   bound after the first one succeeds is skipped rather than fatal — a machine with IPv6 off
 *   still has a working gate.
 * @returns the bound port, the addresses actually serving, and a `close()` for the cleanup stack
 */
export async function serve(dir, { csp = null, port = 0, hosts = ['127.0.0.1'] } = {}) {
  const handler = (req, res) => {
    const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
    const file = path.resolve(dir, `.${urlPath}`);
    if (!file.startsWith(dir + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    const policy = typeof csp === 'function' ? csp(req) : csp;
    if (policy) res.setHeader('Content-Security-Policy', policy);
    res.setHeader('Content-Type', MIME[path.extname(file)] ?? 'application/octet-stream');
    fs.createReadStream(file).pipe(res);
  };

  const servers = [];
  const bound = [];
  let chosen = port;
  for (const host of hosts) {
    const server = http.createServer(handler);
    try {
      chosen = await listen(server, chosen, host);
    } catch (err) {
      server.close();
      if (bound.length === 0) fail(`could not serve on ${host}:${port} — ${err.message}`);
      continue;
    }
    servers.push(server);
    bound.push(host);
  }
  return { port: chosen, hosts: bound, close: () => servers.forEach((s) => s.close()) };
}

/** Minimal CDP client over Node's built-in WebSocket. Flat sessions, so one socket sees workers too. */
export function connect(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  const listeners = [];
  let nextId = 0;

  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id === undefined) {
      for (const fn of listeners) fn(msg);
      return;
    }
    const slot = pending.get(msg.id);
    if (!slot) return;
    pending.delete(msg.id);
    if (msg.error) slot.reject(new Error(`${slot.method}: ${msg.error.message}`));
    else slot.resolve(msg.result);
  });

  // A browser that dies mid-run would otherwise leave every in-flight command pending forever,
  // and the whole check would hang instead of reporting anything.
  ws.addEventListener('close', () => {
    for (const slot of pending.values())
      slot.reject(new Error(`${slot.method}: the browser closed the DevTools connection`));
    pending.clear();
  });

  return {
    ready: new Promise((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error('could not open a DevTools connection')), {
        once: true
      });
    }),
    on: (fn) => listeners.push(fn),
    send(method, params = {}, sessionId) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, method });
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    },
    close: () => ws.close()
  };
}

async function waitForDevToolsPort(userDataDir, chromeExited) {
  const portFile = path.join(userDataDir, 'DevToolsActivePort');
  for (let i = 0; i < 200; i++) {
    if (chromeExited.value) fail(`Chrome exited before it opened a DevTools port:\n${chromeExited.output}`);
    if (fs.existsSync(portFile)) {
      const [port, wsPath] = fs.readFileSync(portFile, 'utf8').trim().split('\n');
      if (port && wsPath) return `ws://127.0.0.1:${port}${wsPath}`;
    }
    await sleep(50);
  }
  fail('Chrome never wrote a DevToolsActivePort file');
}

/**
 * Launches headless Chrome on a throwaway profile and returns a connected CDP client. Registers
 * its own teardown, so a caller that never reaches its own cleanup still does not leak a browser.
 */
export async function launchChrome(chrome, { extraArgs = [] } = {}) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cca-browser-'));
  cleanups.push(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  const chromeExited = { value: false, output: '' };

  const child = spawn(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      `--user-data-dir=${userDataDir}`,
      '--remote-debugging-port=0',
      ...extraArgs,
      'about:blank'
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  cleanups.push(() => child.kill('SIGKILL'));
  child.stdout.on('data', (d) => (chromeExited.output += d));
  child.stderr.on('data', (d) => (chromeExited.output += d));
  child.on('exit', () => (chromeExited.value = true));

  const client = connect(await waitForDevToolsPort(userDataDir, chromeExited));
  await client.ready;
  return client;
}

/** Attaches to the page target Chrome opened for `about:blank`, flat-session style. */
export async function attachToPage(client) {
  const targets = await client.send('Target.getTargets');
  const page = targets.targetInfos.find((t) => t.type === 'page');
  if (!page) fail('Chrome opened no page target');
  const { sessionId } = await client.send('Target.attachToTarget', {
    targetId: page.targetId,
    flatten: true
  });
  return sessionId;
}

/**
 * Records console output, uncaught exceptions and browser log entries into `events`, from the page
 * *and* from any target that auto-attaches (a Worker's console and its CSP violations do not
 * surface on the page). This is the evidence that matters when a browser gate goes red.
 */
export function recordBrowserEvents(client, events) {
  client.on((msg) => {
    const where = msg.sessionId ? `session ${msg.sessionId.slice(0, 8)}` : 'browser';
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = (msg.params.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(' ');
      events.push(`[${where}] console.${msg.params.type}: ${text}`);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      events.push(`[${where}] uncaught: ${d.exception?.description ?? d.text}`);
    } else if (msg.method === 'Log.entryAdded') {
      events.push(`[${where}] log(${msg.params.entry.source}/${msg.params.entry.level}): ${msg.params.entry.text}`);
    } else if (msg.method === 'Target.attachedToTarget') {
      const sid = msg.params.sessionId;
      events.push(`[${where}] attached ${msg.params.targetInfo.type}: ${msg.params.targetInfo.url}`);
      void client.send('Runtime.enable', {}, sid);
      void client.send('Log.enable', {}, sid);
      void client.send('Runtime.runIfWaitingForDebugger', {}, sid);
    }
  });
}

/**
 * Polls the page for a value the browser-side half publishes on `window` when it is done.
 *
 * A poll and not a promise: the navigation swaps execution contexts, so an `evaluate` that lands
 * in the gap throws, and the only robust reading is "ask again".
 *
 * @param opts.accept - a driver that navigates the same tab more than once must be able to say
 *   "not that one": `Page.navigate` resolves before the old document is gone, so the first poll
 *   can still be answered by the *previous* run's result. A predicate on the value itself is the
 *   only reliable discriminator — load events fire for both.
 */
export async function waitForResult(client, sessionId, globalName, { timeoutMs = 30_000, accept = () => true } = {}) {
  for (let waited = 0; waited < timeoutMs; waited += 100) {
    await sleep(100);
    try {
      const evaluated = await client.send(
        'Runtime.evaluate',
        { expression: `window.${globalName} ?? null`, returnByValue: true, awaitPromise: false },
        sessionId
      );
      const value = evaluated.result?.value ?? undefined;
      if (value !== undefined && accept(value)) return value;
    } catch {
      // Expected while the context is being replaced.
    }
  }
  return undefined;
}
