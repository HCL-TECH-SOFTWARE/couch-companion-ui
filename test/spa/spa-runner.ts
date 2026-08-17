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
 * Browser-side half of the SPA-mode gate (`scripts/spa-check.mjs`, issue #37).
 *
 * SPA mode — this bundle hosted anywhere, pointed at a remote CouchDB (spec D5) — is the
 * deployment where cross-origin requests, CORS preflights, cross-site cookies and a page CSP all
 * actually apply, and it had no test coverage of any kind. It cannot get any from `npm test`:
 * happy-dom has no CORS, no cookie jar and no CSP, and under Node's fetch `credentials: "include"`
 * is inert. The sentence "in SPA mode, logging in leaves you logged in" is not expressible there.
 * It is expressible here, because here is a real browser talking to a real CouchDB on a real
 * different origin.
 *
 * Nothing in this file is mocked. It drives the shipped {@link AuthService}, the shipped
 * {@link ApiClient} and the shipped `<cca-login>` against whatever CouchDB the driver was
 * configured with. The scenario to run arrives in `?scenario=`; the credentials arrive on
 * `window.__spaConfig`, injected over CDP so they never travel over the wire or sit in a URL.
 *
 * Results are published on `window.__spaResult` for the driver to read back.
 */

import '../../src/webawesome.js';
import '../../src/components/cca-login.js';
import { getContext } from '../../src/context.js';
import { ApiError } from '../../src/services/api-error.js';
import { CrossSiteSessionError } from '../../src/services/auth-service.js';
import { detectDeployment } from '../../src/services/deployment-mode.js';
import { STORAGE_KEY } from '../../src/services/recent-servers.js';
import type { SessionResponse } from '../../src/types/api.js';

interface SpaConfig {
  /** Base URL of the CouchDB under test — a different origin from this page, always. */
  couchUrl: string;
  user: string;
  password: string;
  /** A server that must never be logged into. Stands in for a stale MRU entry. */
  staleUrl: string;
}

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

interface SpaResult {
  scenario: string;
  origin: string;
  checks: Check[];
  failed: string[];
}

declare global {
  interface Window {
    __spaConfig?: SpaConfig;
    __spaResult?: SpaResult;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What an error *is*, in the words the assertions care about. */
function describe(err: unknown): string {
  if (err instanceof CrossSiteSessionError) return `CrossSiteSessionError(${err.message.slice(0, 60)}…)`;
  if (err instanceof ApiError) return `ApiError(${err.status}: ${err.message})`;
  if (err instanceof Error) return `${err.name}(${err.message})`;
  return String(err);
}

/** A raw, un-instrumented read. Deliberately not through {@link ApiClient}: a 401 there would
 *  engage the centralized session probe, and this is asking a question about the cookie jar. */
async function rawStatus(url: string): Promise<string> {
  try {
    const resp = await fetch(url, { credentials: 'include' });
    return `status=${resp.status}`;
  } catch (err) {
    return `threw ${describe(err)}`;
  }
}

/** Every scenario starts from a browser that remembers nothing. Cookies are the driver's job —
 *  they are per-profile, not per-origin-storage, and it clears them between navigations. */
function resetStorage(): void {
  localStorage.clear();
  sessionStorage.clear();
}

/**
 * The headline scenario: log in against a cross-origin CouchDB and then read something that only
 * an authenticated caller can read.
 *
 * `expect` is what this page's origin makes possible, decided by the driver:
 *   - `session` — the page is cross-*origin* but same-*site* (cookies ignore ports), so the
 *     session cookie is kept and the session survives. This is the property #37 is about.
 *   - `cross-site` — the page is on a different *site*, so the cookie needs `SameSite=None;
 *     Secure`, and over plain HTTP CouchDB cannot emit `Secure` at all. The login must fail with
 *     the diagnosis of #35, not report success and bounce.
 *   - `csp-blocked` — the page is served under CouchDB's own `/_utils` CSP, which has no
 *     `connect-src`, so `default-src 'self'` forbids reaching another origin at all.
 */
async function sessionScenario(cfg: SpaConfig, expect: 'session' | 'cross-site' | 'csp-blocked'): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  resetStorage();

  const ctx = getContext();

  // Real detection, not a hand-set deployment: `/_up` on this page's origin is served by the
  // harness's static server, which is not CouchDB, so SPA mode is what the app must conclude.
  const deployment = await detectDeployment(ctx.api);
  add(
    'deployment-detection',
    deployment.mode === 'spa' && deployment.baseUrl === '',
    `mode=${deployment.mode} baseUrl=${JSON.stringify(deployment.baseUrl)}`
  );
  ctx.setDeployment(deployment);

  const before = await rawStatus(`${cfg.couchUrl}/_all_dbs`);
  if (expect === 'csp-blocked') {
    add('pre-login-read-blocked', before.startsWith('threw'), `GET /_all_dbs before login: ${before}`);
  } else {
    add('pre-login-unauthorized', before === 'status=401', `GET /_all_dbs before login: ${before}`);
  }

  let loginError: unknown;
  try {
    await ctx.auth.login(cfg.couchUrl, cfg.user, cfg.password);
  } catch (err) {
    loginError = err;
  }

  if (expect === 'session') {
    add('login', loginError === undefined, loginError ? `threw ${describe(loginError)}` : 'resolved');

    let read = 'not attempted';
    let ok = false;
    try {
      const dbs = await ctx.api.request<string[]>('GET', '/_all_dbs');
      ok = Array.isArray(dbs) && dbs.includes('_users');
      read = `${Array.isArray(dbs) ? `${dbs.length} databases` : typeof dbs}`;
    } catch (err) {
      read = `threw ${describe(err)}`;
    }
    add('authenticated-read', ok, `GET /_all_dbs after login: ${read}`);

    let identity = 'not attempted';
    let named = false;
    try {
      const session = await ctx.api.request<SessionResponse>('GET', '/_session');
      named = session?.userCtx?.name === cfg.user;
      identity = `userCtx.name=${JSON.stringify(session?.userCtx?.name ?? null)}`;
    } catch (err) {
      identity = `threw ${describe(err)}`;
    }
    add('session-identity', named, `${identity} (expected ${JSON.stringify(cfg.user)})`);

    const state = ctx.auth.state;
    add(
      'auth-state',
      state.authenticated && state.companionServer === cfg.couchUrl.replace(/\/+$/, ''),
      `authenticated=${state.authenticated} companionServer=${JSON.stringify(state.companionServer)}`
    );
    return checks;
  }

  if (expect === 'cross-site') {
    add(
      'cross-site-session-refused',
      loginError instanceof CrossSiteSessionError,
      loginError ? `threw ${describe(loginError)}` : 'login RESOLVED — the app believes it is signed in'
    );
    const after = await rawStatus(`${cfg.couchUrl}/_all_dbs`);
    add('cross-site-leaves-no-session', after === 'status=401', `GET /_all_dbs after the refused login: ${after}`);
    add(
      'cross-site-not-authenticated',
      !ctx.auth.state.authenticated,
      `auth.state.authenticated=${ctx.auth.state.authenticated}`
    );
    return checks;
  }

  // csp-blocked. A policy without `connect-src` stops the request in the browser, so the failure
  // is a network-level TypeError — emphatically not an ApiError (that would mean CouchDB answered
  // and the policy is not being enforced, i.e. this whole gate proves nothing).
  add(
    'csp-blocks-cross-origin-fetch',
    loginError instanceof TypeError,
    loginError ? `threw ${describe(loginError)}` : 'login RESOLVED under a policy that forbids the request'
  );
  return checks;
}

/**
 * The `wa-select` branch of the login form, which only exists once the MRU has entries
 * (`cca-login.ts`: empty MRU renders a `wa-input`, a populated one a `wa-select`), and the
 * precedence rule in `handleSubmit` — `this.companionServer || submittedCompanion`.
 *
 * A real browser is the only place this is testable: `wa-select` is a form-associated custom
 * element, so "what the form would submit" comes from `ElementInternals.setFormValue`, which
 * happy-dom does not implement (`test/setup.ts` stubs it to a no-op). Under the unit suite the
 * submitted value is always empty and the precedence rule is unobservable in either direction.
 */
async function mruScenario(cfg: SpaConfig): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  resetStorage();

  const ctx = getContext();
  ctx.setDeployment(await detectDeployment(ctx.api));

  // The stale entry is the MRU *head*, so `getLastServer()` offers it and the component
  // pre-selects it — the exact arrangement in which a stale entry could win.
  const now = Date.now();
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify([
      { url: cfg.staleUrl, last_used: now },
      { url: cfg.couchUrl, last_used: now - 60_000 }
    ])
  );

  const el = document.createElement('cca-login') as HTMLElement & {
    updateComplete: Promise<boolean>;
    companionServer: string;
    error: string;
  };
  document.body.append(el);
  await el.updateComplete;

  const root = el.shadowRoot;
  if (!root) {
    add('mru-mounted', false, 'cca-login rendered no shadow root');
    return checks;
  }

  const select = root.querySelector('wa-select') as (HTMLElement & { value: string; open: boolean; updateComplete: Promise<boolean> }) | null;
  const input = root.querySelector('wa-input[name="companion_server"]');
  const options = Array.from(root.querySelectorAll('wa-option')) as (HTMLElement & { value: string })[];
  add(
    'mru-renders-select',
    select !== null && input === null,
    `wa-select=${select !== null} wa-input[name=companion_server]=${input !== null} options=${JSON.stringify(options.map((o) => o.value))}`
  );
  if (!select) return checks;

  add(
    'mru-preselects-head',
    select.value === cfg.staleUrl,
    `select.value=${JSON.stringify(select.value)} (MRU head is the stale ${JSON.stringify(cfg.staleUrl)})`
  );

  // Pick the real server the way a user does: open the listbox, press the option.
  //
  // `mouseup`, not `click`. `wa-select` binds its listbox to `@mouseup` (WA 3.10,
  // `chunk.ORUBIIWK.js`), so `option.click()` selects nothing at all and every assertion after it
  // would be measuring an untouched form. Same family as the `wa-dropdown` trap already known
  // here; a real browser is the only place either one shows up.
  select.open = true;
  await select.updateComplete;
  const wanted = options.find((o) => o.value === cfg.couchUrl);
  wanted?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, composed: true }));
  // The control dispatches its own `change` from a `then` on its update cycle, so the component
  // that listens for it has not run by the time the dispatch returns.
  await select.updateComplete;
  await el.updateComplete;
  await select.updateComplete;
  await el.updateComplete;
  add(
    'mru-select-follows-click',
    el.companionServer === cfg.couchUrl,
    `after picking ${JSON.stringify(cfg.couchUrl)}: componentState=${JSON.stringify(el.companionServer)} select.value=${JSON.stringify(select.value)}`
  );

  // Force the divergence the precedence rule exists for: the control's form value says the stale
  // server, the component's state says the one the user picked. Guarded, not assumed — if setting
  // `value` also moved the component's state, this check goes red and says so rather than letting
  // the next one pass without ever exercising the rule.
  select.value = cfg.staleUrl;
  await select.updateComplete;
  await el.updateComplete;
  add(
    'mru-form-value-can-diverge',
    el.companionServer === cfg.couchUrl && select.value === cfg.staleUrl,
    `componentState=${JSON.stringify(el.companionServer)} select.value=${JSON.stringify(select.value)}`
  );

  for (const [name, value] of [
    ['username', cfg.user],
    ['password', cfg.password]
  ]) {
    const field = root.querySelector(`wa-input[name="${name}"]`) as (HTMLElement & { value: string; updateComplete: Promise<boolean> }) | null;
    if (field) {
      field.value = value;
      await field.updateComplete;
    }
  }

  const form = root.querySelector('form');
  if (!form) {
    add('mru-form-present', false, 'the password form is not rendered');
    return checks;
  }

  // Capture on the shadow root, so this runs before the form's own (lit-registered) handler and
  // reads exactly what the browser would have submitted.
  let submitted: string | null = null;
  let submitSeen = false;
  root.addEventListener(
    'submit',
    () => {
      submitSeen = true;
      submitted = new FormData(form).get('companion_server') as string | null;
    },
    true
  );

  form.requestSubmit();
  for (let i = 0; i < 150 && !ctx.auth.state.authenticated && !el.error; i++) await sleep(100);

  add('mru-form-submits', submitSeen, `submit observed=${submitSeen} formValidity=${form.checkValidity()}`);
  add(
    'mru-submits-stale-value',
    submitted === cfg.staleUrl,
    `FormData companion_server=${JSON.stringify(submitted)} (the stale entry, by construction)`
  );
  add(
    'mru-stale-entry-does-not-win',
    ctx.auth.state.authenticated && ctx.auth.state.companionServer === cfg.couchUrl.replace(/\/+$/, ''),
    `authenticated=${ctx.auth.state.authenticated} companionServer=${JSON.stringify(ctx.auth.state.companionServer)} error=${JSON.stringify(el.error)}`
  );

  let read = 'not attempted';
  let ok = false;
  try {
    const dbs = await ctx.api.request<string[]>('GET', '/_all_dbs');
    ok = Array.isArray(dbs) && dbs.includes('_users');
    read = `${Array.isArray(dbs) ? `${dbs.length} databases` : typeof dbs}`;
  } catch (err) {
    read = `threw ${describe(err)}`;
  }
  add('mru-session-usable', ok, `GET /_all_dbs after the form login: ${read}`);

  return checks;
}

void (async () => {
  const scenario = new URLSearchParams(window.location.search).get('scenario') ?? 'session';
  const cfg = window.__spaConfig;
  let checks: Check[];
  try {
    if (!cfg) throw new Error('window.__spaConfig was never injected');
    checks =
      scenario === 'mru'
        ? await mruScenario(cfg)
        : await sessionScenario(cfg, scenario as 'session' | 'cross-site' | 'csp-blocked');
  } catch (err) {
    checks = [{ name: 'threw', ok: false, detail: err instanceof Error ? (err.stack ?? err.message) : String(err) }];
  }
  const result: SpaResult = {
    scenario,
    origin: window.location.origin,
    checks,
    failed: checks.filter((c) => !c.ok).map((c) => c.name)
  };
  const out = document.getElementById('out');
  if (out) out.textContent = JSON.stringify(result, null, 2);
  window.__spaResult = result;
})();
