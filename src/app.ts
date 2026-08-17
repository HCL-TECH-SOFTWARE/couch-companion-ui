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

import { getContext } from './context.js';
import { initLogConfig } from './services/log-config.js';
import { getLogger } from './services/log-service.js';
import { initTheme } from './services/theme-service.js';
import { detectDeployment } from './services/deployment-mode.js';
import { discoverIdps, type IdpDiscovery } from './services/idp-discovery.js';
import { detectNativeIdp } from './services/native-idp.js';
import {
  callbackPending,
  completeLogin,
  completeLogout,
  logoutReturnPending,
  urlWithoutCallbackParams,
} from './services/oidc-service.js';
import { toast } from './components/cca-toast.js';
import './webawesome.js';
import './components/cca-toast.js';
import './components/cca-shell.js';
import './components/cca-data-table.js';
import './components/cca-router-provider.js';

initLogConfig();
// Apply the stored/OS colour scheme before the shell mounts to avoid a flash.
initTheme();
const log = getLogger('app');

// Initialize shared context before shell mounts
const ctx = getContext();

const nukeElement = (selector: string) => {
  const el = document.querySelector(selector);
  if (el) {
    el.remove();
  }
};

const addElement = (selector: string) => {
  let routerProvider = document.querySelector('cca-router-provider');
  if (!routerProvider) {
    routerProvider = document.createElement('cca-router-provider');
    document.body.appendChild(routerProvider);
  }

  if (!document.querySelector(selector)) {
    routerProvider?.appendChild(document.createElement(selector));
  }
};

/**
 * The one <cca-toast> for the whole page, mounted directly under <body> — a sibling of
 * `cca-router-provider`, never touched by the login/shell swap above. It has to exist before
 * `consumeOidcCallback()` gets a chance to fail: that runs before either screen has mounted for
 * the first time, and `toast()` only buffers a message no host exists yet to show — it never
 * flushes on its own. Without this, a failed IdP callback bounces the user back to a plain
 * login screen with no explanation at all (#115).
 */
const ensureToastMounted = () => {
  if (!document.querySelector('cca-toast')) {
    document.body.appendChild(document.createElement('cca-toast'));
  }
};

/**
 * What the discovery chain (§5) found, cached for the lifetime of the page. Bootstrap fills
 * it before the login screen mounts; `initLogin` reads it. Stays at the "nothing found"
 * default when discovery is skipped or fails, which renders the pre-Phase-6 login screen.
 */
let discovery: IdpDiscovery = { idps: [], source: 'none', jwtHandlerEnabled: false };

const initLogin = () => {
  log.debug('User is not authenticated');
  nukeElement('cca-shell');
  addElement('cca-login');
  const login = document.querySelector('cca-login');
  if (login) {
    Object.assign(login, {
      idps: discovery.idps,
      jwtHandlerEnabled: discovery.jwtHandlerEnabled,
    });
  }
};

const initApp = () => {
  log.debug('Initializing app shell');
  nukeElement('cca-login');
  addElement('cca-shell');
};

/**
 * Subscribes once to auth-state changes so the shell/login swap keeps working
 * for the app's whole lifetime — not just after a boot that started on the
 * login screen. A restored-session boot mounts `cca-shell` directly without
 * ever calling `initLogin()`, so this must be installed unconditionally
 * before `bootstrap()` branches on the initial auth state, or logout (and
 * the central 401 handler) has nothing to notify and the shell stays
 * mounted forever.
 */
const subscribeToAuth = () => {
  ctx.auth.subscribe((state) => {
    if (state.authenticated) {
      initApp();
    } else {
      initLogin();
    }
  });
};

/**
 * Consumes an OAuth callback (§5). Runs before `auth.restore()`, because a successful
 * exchange establishes the very session `restore()` would otherwise find missing.
 *
 * The query is stripped on every path, success or failure: leaving a spent `?code=` in the
 * address bar means a reload re-submits it, and the second attempt always fails — an
 * authorization code is single-use — which would look like a broken login.
 */
async function consumeOidcCallback(): Promise<void> {
  try {
    const token = await completeLogin(window.location.search);
    await ctx.auth.loginWithToken(token);
    log.debug?.('PKCE login completed');
  } catch (err) {
    log.warn('OIDC callback could not be completed', err as Error);
    toast((err as Error).message || 'Sign-in did not complete', 'error');
  } finally {
    window.history.replaceState(null, '', urlWithoutCallbackParams(window.location.href));
  }
}

/**
 * Consumes the return leg of an RP-initiated logout (#24).
 *
 * There is nothing left to do here but check and tidy: the local session was already torn down
 * before the redirect left, precisely so that this leg never becoming reachable cannot strand
 * anyone signed in. A mismatched `state` is worth a line in the log — it says this arrival is
 * not the round trip this tab started — but it changes nothing either way, and the `?state=` is
 * stripped on both paths so a reload does not look like a second return.
 */
function consumeLogoutReturn(): void {
  if (completeLogout(window.location.search)) {
    log.debug?.('RP-initiated logout completed');
  } else {
    log.warn('The logout callback did not carry the state this tab sent to the identity provider');
  }
  window.history.replaceState(null, '', urlWithoutCallbackParams(window.location.href));
}

/**
 * Bootstrap the application by checking authentication state and rendering the appropriate component (login or shell).
 * Fails closed: any error along the way lands on the login screen rather than leaving a half-mounted page.
 */
async function bootstrap() {
  ensureToastMounted();
  subscribeToAuth();
  try {
    const deployment = await detectDeployment(ctx.api);
    ctx.setDeployment(deployment);

    // Does this CouchDB serve `/_idp` itself? Probed once, at boot, and cached for the page:
    // when it does, the `idp` database stopgap is never created or written (#32). Deliberately
    // not awaited — nothing on the boot path needs the answer, an admin action is the first
    // thing that does, and a failed probe simply means "no native endpoint".
    void detectNativeIdp(ctx.api);

    // Mutually exclusive by construction: a login callback carries `code` or `error` alongside
    // `state`, a logout return carries `state` alone — and only when this tab stored one.
    if (callbackPending(window.location.search)) {
      await consumeOidcCallback();
    } else if (logoutReturnPending()) {
      consumeLogoutReturn();
    }

    await ctx.auth.restore();
    const authState = ctx.auth.state;

    // Discovery only matters for someone about to log in, and it costs up to three requests.
    // A restored session skips it entirely. Failure is not fatal: `discoverIdps` already
    // degrades to "nothing found", which is the pre-Phase-6 login screen.
    if (!authState.authenticated) {
      discovery = await discoverIdps(ctx.api).catch((err) => {
        log.warn('IdP discovery failed; offering password login only', err as Error);
        return { idps: [], source: 'none', jwtHandlerEnabled: false } as IdpDiscovery;
      });
    }
    log.debug?.("bootstrap", { deployment, authenticated: authState.authenticated });
    if (authState.authenticated) {
      initApp();
    } else {
      initLogin();
    }
  } catch (err) {
    log.warn("bootstrap failed; falling back to login", err as Error);
    initLogin();
  }
}

// Loading script after DOM is loaded
if (document.readyState != 'loading') {
  void bootstrap();
} else {
  document.addEventListener('DOMContentLoaded', () => {
    void bootstrap();
  });
}
