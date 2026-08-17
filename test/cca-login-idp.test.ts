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
 * The IdP affordances on the login screen (spec D8/§5). The password-login behaviour lives in
 * `cca-login.test.ts`; this file covers what discovery adds, and — just as importantly — that
 * a CouchDB with no IdP still renders exactly the screen it renders today.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LitElement } from 'lit';

class WaStub extends LitElement {
  createRenderRoot() {
    return this;
  }
}
for (const tag of ['wa-card', 'wa-button', 'wa-select', 'wa-option', 'wa-divider', 'wa-dialog', 'wa-icon']) {
  if (!customElements.get(tag)) {
    customElements.define(tag, class extends WaStub {});
  }
}
if (!customElements.get('wa-input')) {
  customElements.define(
    'wa-input',
    class extends WaStub {
      public static readonly formAssociated = true;
      get value() {
        return this.getAttribute('value') ?? '';
      }
      set value(v: string) {
        this.setAttribute('value', v);
      }
    },
  );
}

import { getContext } from '../src/context';
import '../src/components/cca-login';
import type { CcaLogin } from '../src/components/cca-login';
import type { DiscoveredIdp } from '../src/services/idp-discovery';
import * as oidc from '../src/services/oidc-service';

const KEYCLOAK: DiscoveredIdp = {
  name: 'Dev Keycloak',
  issuer: 'http://localhost:8080/realms/couch',
  client_id: 'couch-companion-ui',
  well_known_url: 'http://localhost:8080/realms/couch/.well-known/openid-configuration',
  authorization_endpoint: null,
  token_endpoint: null,
  end_session_endpoint: null,
  scopes: ['openid'],
  roles_claim: 'roles',
  idp_only: false,
};

const ENTRA: DiscoveredIdp = { ...KEYCLOAK, name: 'Corporate Entra ID', client_id: 'entra' };

/** A deployment that has decided its CouchDB is signed into through the IdP and nothing else. */
const KEYCLOAK_ONLY: DiscoveredIdp = { ...KEYCLOAK, idp_only: true };

async function mount(props: Partial<CcaLogin> = {}): Promise<CcaLogin> {
  const el = document.createElement('cca-login') as CcaLogin;
  Object.assign(el, props);
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

/**
 * Where `cca-login` actually renders. This suite used to monkey-patch `createRenderRoot` on the
 * prototype so the component rendered into the light DOM and `el.querySelector` just worked —
 * which meant the suite was constructing the one environment in which #139 (a handler reaching
 * for its field with `this.querySelector`) could not be observed. Every lookup goes through the
 * real shadow root now, so a light-DOM query in the component fails here the way it fails in a
 * browser.
 */
function root(el: CcaLogin): ShadowRoot {
  if (!el.shadowRoot) {
    throw new Error('cca-login rendered without a shadow root');
  }
  return el.shadowRoot;
}

function queryRequired<T extends Element>(el: CcaLogin, selector: string): T {
  const found = root(el).querySelector<T>(selector);
  if (!found) {
    throw new Error(`Expected element for selector: ${selector}`);
  }
  return found;
}

function idpButtons(el: CcaLogin): HTMLElement[] {
  return Array.from(root(el).querySelectorAll<HTMLElement>('[data-idp]'));
}

/** Lets the component's async submit handler run to completion. */
async function settle(el: CcaLogin) {
  await new Promise((r) => setTimeout(r, 0));
  await el.updateComplete;
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  document.body.innerHTML = '';
  // `idp_only` reads the query string; leave no `?password` behind for the next test.
  history.replaceState({}, '', '/');
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  history.replaceState({}, '', '/');
});

describe('with no IdPs discovered', () => {
  it('renders no IdP buttons at all', async () => {
    const el = await mount({ idps: [] });

    expect(idpButtons(el)).toHaveLength(0);
  });

  it('still renders the password form — native session is the fallback (D8)', async () => {
    const el = await mount({ idps: [] });

    expect(root(el).querySelector('wa-input[name="username"]')).not.toBeNull();
    expect(root(el).querySelector('wa-input[name="password"]')).not.toBeNull();
  });

  it('offers no paste-a-token field when CouchDB has no jwt handler', async () => {
    const el = await mount({ idps: [], jwtHandlerEnabled: false });

    expect(root(el).querySelector('[data-paste-token]')).toBeNull();
  });
});

/**
 * #139. Not a behaviour of the login screen so much as a property of the test bed: every other
 * test here would still pass against a component that had quietly given up its shadow root, and
 * a handler querying the light DOM would go on looking correct. Assert the encapsulation once,
 * out loud, so the rest of the suite means what it says.
 */
describe('render root', () => {
  it('renders into a shadow root', async () => {
    const el = await mount({ idps: [] });

    expect(el.shadowRoot).not.toBeNull();
    expect(el.querySelector('form')).toBeNull();
  });
});

describe('with IdPs discovered', () => {
  it('renders one button per IdP, in document order', async () => {
    const el = await mount({ idps: [KEYCLOAK, ENTRA] });

    expect(idpButtons(el).map((b) => b.textContent?.trim())).toEqual([
      'Sign in with Dev Keycloak',
      'Sign in with Corporate Entra ID',
    ]);
  });

  it('keeps the password form visible alongside them (D8/D9)', async () => {
    const el = await mount({ idps: [KEYCLOAK] });

    expect(root(el).querySelector('wa-input[name="password"]')).not.toBeNull();
  });

  it('starts a PKCE login for the IdP whose button was pressed', async () => {
    const begin = vi.spyOn(oidc, 'beginLogin').mockResolvedValue();
    // The full OidcEndpoints shape — end_session_endpoint rides along to the attempt so a
    // later logout can end the IdP session too (#24).
    const endpoints = {
      authorization_endpoint: 'http://idp/auth',
      token_endpoint: 'http://idp/token',
      end_session_endpoint: 'http://idp/logout',
    };
    vi.spyOn(oidc, 'resolveEndpoints').mockResolvedValue(endpoints);
    const el = await mount({ idps: [KEYCLOAK, ENTRA] });

    idpButtons(el)[1].click();
    await el.updateComplete;
    await Promise.resolve();

    expect(begin).toHaveBeenCalledWith(ENTRA, endpoints, expect.any(String));
  });

  it('surfaces an endpoint-resolution failure instead of navigating nowhere', async () => {
    vi.spyOn(oidc, 'resolveEndpoints').mockRejectedValue(new Error('discovery is unreachable'));
    const begin = vi.spyOn(oidc, 'beginLogin').mockResolvedValue();
    const el = await mount({ idps: [KEYCLOAK] });

    idpButtons(el)[0].click();
    await settle(el);

    expect(begin).not.toHaveBeenCalled();
    expect(root(el).textContent).toContain('discovery is unreachable');
  });
});

/**
 * #119. `idp_only` is a deployment saying "sign in through the provider, not with a password".
 * It is presentation, not enforcement — CouchDB keeps accepting the password either way — so
 * the interesting behaviour is entirely about what the screen offers.
 */
describe('idp_only (#119)', () => {
  it('hides the password form when a discovered IdP asks for it', async () => {
    const el = await mount({ idps: [KEYCLOAK_ONLY] });

    expect(root(el).querySelector('wa-input[name="password"]')).toBeNull();
    expect(root(el).querySelector('wa-input[name="username"]')).toBeNull();
    expect(root(el).querySelector('form')).toBeNull();
  });

  it('drops the "or sign in with a username" separator along with the form', async () => {
    const el = await mount({ idps: [KEYCLOAK_ONLY] });

    expect(root(el).textContent).not.toContain('or sign in with a username');
  });

  it('still renders the sign-in button — that is the whole point', async () => {
    const el = await mount({ idps: [KEYCLOAK_ONLY] });

    expect(idpButtons(el).map((b) => b.textContent?.trim())).toEqual(['Sign in with Dev Keycloak']);
  });

  it('keeps the form when no discovered IdP asks to hide it', async () => {
    const el = await mount({ idps: [KEYCLOAK, ENTRA] });

    expect(root(el).querySelector('wa-input[name="password"]')).not.toBeNull();
    expect(root(el).textContent).toContain('or sign in with a username');
  });

  /** One provider deciding for the deployment is enough — they all share the one CouchDB. */
  it('hides the form when any one of several IdPs asks for it', async () => {
    const el = await mount({ idps: [ENTRA, KEYCLOAK_ONLY] });

    expect(root(el).querySelector('wa-input[name="password"]')).toBeNull();
    expect(idpButtons(el)).toHaveLength(2);
  });

  /**
   * The escape hatch that keeps `idp_only` from being a footgun: the flag is stored in the very
   * CouchDB it locks, so an IdP that expires, moves, or is misconfigured would otherwise leave
   * the admin with no way in to fix it.
   */
  it('always shows the form when ?password is on the URL', async () => {
    history.replaceState({}, '', '/?password');

    const el = await mount({ idps: [KEYCLOAK_ONLY] });

    expect(root(el).querySelector('wa-input[name="password"]')).not.toBeNull();
    expect(root(el).querySelector('wa-input[name="username"]')).not.toBeNull();
  });

  it('honours ?password among other query parameters', async () => {
    history.replaceState({}, '', '/?foo=bar&password=');

    const el = await mount({ idps: [KEYCLOAK_ONLY] });

    expect(root(el).querySelector('wa-input[name="password"]')).not.toBeNull();
  });

  /**
   * The error line used to live inside the password form. With that form gone, a failed
   * redirect is the only thing left that can go wrong — and the one the operator most needs
   * spelled out, since the button is now their only way in.
   */
  it('still shows a failed IdP redirect with the password form hidden', async () => {
    vi.spyOn(oidc, 'resolveEndpoints').mockRejectedValue(new Error('discovery is unreachable'));
    const el = await mount({ idps: [KEYCLOAK_ONLY] });

    idpButtons(el)[0].click();
    await settle(el);

    expect(root(el).querySelector('.error')?.textContent).toContain('discovery is unreachable');
  });
});

describe('paste-a-token affordance (§5 step 3)', () => {
  const TOKEN = 'eyJhbGciOiJSUzI1NiIs.payload.signature';

  /** Fills the field and submits the form the way the "Sign in with token" button does. */
  async function pasteAndSubmit(el: CcaLogin, token: string) {
    queryRequired<HTMLInputElement>(el, '#pasted-token').value = token;
    queryRequired<HTMLFormElement>(el, '[data-paste-token]').dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    await settle(el);
  }

  it('appears when CouchDB accepts JWTs but discovery found nothing', async () => {
    const el = await mount({ idps: [], jwtHandlerEnabled: true });

    expect(root(el).querySelector('[data-paste-token]')).not.toBeNull();
  });

  it('does not appear when an IdP was discovered — the button is the better path', async () => {
    const el = await mount({ idps: [KEYCLOAK], jwtHandlerEnabled: true });

    expect(root(el).querySelector('[data-paste-token]')).toBeNull();
  });

  /**
   * #139. The handler used to reach for its field with `this.querySelector`, which searches the
   * light DOM — always `null` here — so the only reachable outcome was "Paste a token first",
   * whatever the operator pasted. Sign-in-with-token could not work at all.
   */
  it('signs in with the token that was pasted', async () => {
    const loginWithToken = vi.spyOn(getContext().auth, 'loginWithToken').mockResolvedValue();
    const el = await mount({ idps: [], jwtHandlerEnabled: true });

    await pasteAndSubmit(el, `  ${TOKEN}  `);

    expect(loginWithToken).toHaveBeenCalledWith(TOKEN);
    expect(root(el).querySelector('.error')).toBeNull();
  });

  it('announces the sign-in so the shell can leave the login screen', async () => {
    vi.spyOn(getContext().auth, 'loginWithToken').mockResolvedValue();
    const el = await mount({ idps: [], jwtHandlerEnabled: true });
    const handler = vi.fn();
    el.addEventListener('login-success', handler);

    await pasteAndSubmit(el, TOKEN);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('says so when CouchDB rejects the token', async () => {
    vi.spyOn(getContext().auth, 'loginWithToken').mockRejectedValue(new Error('nope'));
    const el = await mount({ idps: [], jwtHandlerEnabled: true });

    await pasteAndSubmit(el, TOKEN);

    expect(root(el).querySelector('.error')?.textContent).toBe(
      'That token was not accepted by this server',
    );
  });

  it('asks for a token only when the field is genuinely empty', async () => {
    const loginWithToken = vi.spyOn(getContext().auth, 'loginWithToken').mockResolvedValue();
    const el = await mount({ idps: [], jwtHandlerEnabled: true });

    await pasteAndSubmit(el, '   ');

    expect(loginWithToken).not.toHaveBeenCalled();
    expect(root(el).querySelector('.error')?.textContent).toBe('Paste a token first');
  });
});
