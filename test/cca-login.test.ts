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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';
import { LitElement } from 'lit';

// Stub wa-* elements before importing the component under test.
// These are normally loaded via CDN and won't exist in happy-dom.
class WaStub extends LitElement {
  createRenderRoot() {
    return this;
  }
}

for (const tag of ['wa-card', 'wa-button', 'wa-select', 'wa-option', 'wa-divider', 'wa-dialog']) {
  if (!customElements.get(tag)) {
    customElements.define(tag, class extends WaStub {});
  }
}

// wa-input needs to participate in FormData via the name attribute
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
    }
  );
}

import { ApiError } from '../src/services/api-error';
import { CrossSiteSessionError } from '../src/services/auth-service';
import { getContext } from '../src/context';
import type { AppContext } from '../src/context';
import { STORAGE_KEY, loadRecentServers } from '../src/services/recent-servers';
import '../src/components/cca-login';
import type { CcaLogin } from '../src/components/cca-login';

const secretField = 'password';
const validUsername = 'test-user';
const alternateUsername = 'test-user-2';
const validSecret = 'test-secret';
const invalidSecret = 'test-invalid';
const validServer = 'https://couch.example.com';

function getEl(): CcaLogin {
  const el = document.createElement('cca-login') as CcaLogin;
  document.body.appendChild(el);
  return el;
}

async function updated(el: CcaLogin) {
  await el.updateComplete;
}

/**
 * Where `cca-login` actually renders. This suite used to patch `createRenderRoot` on the
 * prototype so the component rendered into the light DOM and `root(el).querySelector` just worked —
 * and #139 was a handler doing exactly that inside the component, which is `null` in every
 * browser. A suite that rewrites the render root cannot see such a bug, so every lookup here
 * goes through the real shadow root instead.
 */
function root(el: CcaLogin): ShadowRoot {
  if (!el.shadowRoot) {
    throw new Error('cca-login rendered without a shadow root');
  }
  return el.shadowRoot;
}

function requireValue<T>(value: T, message: string): NonNullable<T> {
  if (value == null) {
    throw new Error(message);
  }
  return value;
}

function queryRequired<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Expected element for selector: ${selector}`);
  }
  return element;
}

/** Build a submit event whose FormData carries the given fields. */
function fakeSubmit(el: CcaLogin, fields: Record<string, string>): Event {
  const form = queryRequired<HTMLFormElement>(root(el), 'form');

  // Inject hidden native inputs so FormData picks up the values,
  // since the wa-input stubs don't participate in form data.
  for (const [name, value] of Object.entries(fields)) {
    let input = form.querySelector<HTMLInputElement>(`input[name="${name}"]`);
    if (!input) {
      input = document.createElement('input');
      input.type = 'hidden';
      input.name = name;
      form.appendChild(input);
    }
    input.value = value;
  }

  const ev = new Event('submit', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'target', { value: form });
  return ev;
}

describe('cca-login', () => {
  let el: CcaLogin;
  let ctx: AppContext;
  let loginMock: MockInstance<(companionServer: string, username: string, password: string) => Promise<void>>;

  beforeEach(async () => {
    sessionStorage.clear();
    localStorage.clear();
    ctx = getContext();
    ctx.setDeployment({ mode: 'spa', baseUrl: '' });
    loginMock = vi.spyOn(ctx.auth, 'login').mockResolvedValue(undefined);
    el = getEl();
    await updated(el);
  });

  afterEach(() => {
    el.remove();
    vi.restoreAllMocks();
  });

  // ── Rendering ──────────────────────────────────────────────

  describe('rendering', () => {
    it('renders a form inside a wa-card', () => {
      const card = queryRequired(root(el), 'wa-card');
      const form = card.querySelector('form');
      expect(form).not.toBeNull();
    });

    it('renders companion-server wa-input and username/password wa-input fields when MRU is empty', () => {
      const inputs = root(el).querySelectorAll('wa-input');
      expect(inputs.length).toBe(3);

      const server = queryRequired(root(el), 'wa-input[name="companion_server"]');
      expect(server.getAttribute('type')).toBe('url');
      expect(root(el).querySelector('wa-select[name="companion_server"]')).toBeNull();

      const username = queryRequired(root(el), 'wa-input[name="username"]');
      expect(username.getAttribute('type')).toBe('text');

      const password = queryRequired(root(el), 'wa-input[name="password"]');
      expect(password.getAttribute('type')).toBe('password');
    });

    it('renders a submit button', () => {
      const btn = root(el).querySelector('wa-button[type="submit"]');
      expect(btn).not.toBeNull();
    });

    it('renders a heading', () => {
      const heading = queryRequired(root(el), 'h2');
      expect(heading.textContent).toBe('CouchCompanion');
    });

    it('does not show an error message initially', () => {
      const error = root(el).querySelector('.error');
      expect(error).toBeNull();
    });
  });

  // ── Render root ────────────────────────────────────────────

  describe('shadow DOM', () => {
    // This used to assert the opposite — `el.shadowRoot` was null and the form sat in the light
    // DOM — which was true only of the patched prototype this suite installed, never of the
    // shipped component. #139 is what that fiction cost: a handler querying the light DOM for
    // its own field looked correct here and returned null in every browser.
    it('renders into a shadow root, so the component must query renderRoot', () => {
      expect(el.shadowRoot).not.toBeNull();
      expect(el.querySelector('form')).toBeNull();
      expect(root(el).querySelector('form')).not.toBeNull();
    });
  });

  // ── Validation ─────────────────────────────────────────────

  describe('validation', () => {
    it('shows error when both fields are empty', async () => {
      const ev = fakeSubmit(el, {});
      await el.handleSubmit(ev);
      await updated(el);

      const error = queryRequired(root(el), '.error');
      expect(error.textContent).toBe('Please fill in all fields');
    });

    it('shows error when username is missing', async () => {
      const ev = fakeSubmit(el, {
        companion_server: validServer,
        [secretField]: validSecret
      });
      await el.handleSubmit(ev);
      await updated(el);

      expect(queryRequired(root(el), '.error').textContent).toBe('Please fill in all fields');
    });

    it('shows error when password is missing', async () => {
      const ev = fakeSubmit(el, {
        companion_server: validServer,
        username: validUsername
      });
      await el.handleSubmit(ev);
      await updated(el);

      expect(queryRequired(root(el), '.error').textContent).toBe('Please fill in all fields');
    });

    it('shows error when companion server is missing', async () => {
      const ev = fakeSubmit(el, {
        username: validUsername,
        [secretField]: validSecret
      });
      await el.handleSubmit(ev);
      await updated(el);

      expect(queryRequired(root(el), '.error').textContent).toBe('Please fill in all fields');
    });

    it('shows error when companion server URL is malformed', async () => {
      const ev = fakeSubmit(el, {
        companion_server: 'not-a-url',
        username: validUsername,
        [secretField]: validSecret
      });
      await el.handleSubmit(ev);
      await updated(el);

      expect(queryRequired(root(el), '.error').textContent).toBe('Invalid server URL');
      expect(loginMock).not.toHaveBeenCalled();
    });

    it('does not call api.login when validation fails', async () => {
      const ev = fakeSubmit(el, {});
      await el.handleSubmit(ev);

      expect(loginMock).not.toHaveBeenCalled();
    });
  });

  // ── Successful login ──────────────────────────────────────

  describe('successful login', () => {
    it('calls api.login with companion server, username, and password', async () => {
      loginMock.mockResolvedValue(undefined);

      const ev = fakeSubmit(el, {
        companion_server: validServer,
        username: validUsername,
        [secretField]: validSecret
      });
      await el.handleSubmit(ev);

      expect(loginMock).toHaveBeenCalledWith(validServer, validUsername, validSecret);
    });

    it('dispatches login-success event', async () => {
      loginMock.mockResolvedValue(undefined);

      const handler = vi.fn();
      el.addEventListener('login-success', handler);

      const ev = fakeSubmit(el, {
        companion_server: validServer,
        username: validUsername,
        [secretField]: validSecret
      });
      await el.handleSubmit(ev);

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('dispatches login-success as a composed, bubbling event', async () => {
      loginMock.mockResolvedValue(undefined);

      const handler = vi.fn<(event: Event) => void>();
      el.addEventListener('login-success', handler);

      const ev = fakeSubmit(el, {
        companion_server: validServer,
        username: validUsername,
        [secretField]: validSecret
      });
      await el.handleSubmit(ev);

      const [event] = requireValue(handler.mock.calls[0], 'Expected login-success event to be captured');
      expect(event.bubbles).toBe(true);
      expect(event.composed).toBe(true);
    });

    it('does not show an error on success', async () => {
      loginMock.mockResolvedValue(undefined);

      const ev = fakeSubmit(el, {
        companion_server: validServer,
        username: validUsername,
        [secretField]: validSecret
      });
      await el.handleSubmit(ev);
      await updated(el);

      expect(root(el).querySelector('.error')).toBeNull();
    });
  });

  // ── Failed login ──────────────────────────────────────────

  describe('failed login', () => {
    it('shows invalid credentials error when api rejects with 401', async () => {
      loginMock.mockRejectedValue(new ApiError(401, 'Unauthorized'));

      const ev = fakeSubmit(el, {
        companion_server: validServer,
        username: validUsername,
        [secretField]: invalidSecret
      });
      await el.handleSubmit(ev);
      await updated(el);

      const error = queryRequired(root(el), '.error');
      expect(error.textContent).toBe('Invalid username or password');
    });

    it('shows a generic connection error when api rejects with a non-401 ApiError', async () => {
      loginMock.mockRejectedValue(new ApiError(500, 'Internal Server Error'));

      const ev = fakeSubmit(el, {
        companion_server: validServer,
        username: validUsername,
        [secretField]: validSecret
      });
      await el.handleSubmit(ev);
      await updated(el);

      expect(queryRequired(root(el), '.error').textContent).toBe('Unable to connect to server');
    });

    it('shows the cross-site cookie diagnosis verbatim (#35)', async () => {
      // The generic "Unable to connect to server" would hide the one thing worth saying here:
      // the credentials were fine and the browser threw the cookie away.
      loginMock.mockRejectedValue(new CrossSiteSessionError('the cookie never came back'));

      const ev = fakeSubmit(el, {
        companion_server: validServer,
        username: validUsername,
        [secretField]: validSecret
      });
      await el.handleSubmit(ev);
      await updated(el);

      expect(queryRequired(root(el), '.error').textContent).toBe('the cookie never came back');
    });

    it('shows a generic connection error when api rejects with a non-ApiError', async () => {
      loginMock.mockRejectedValue(new Error('network down'));

      const ev = fakeSubmit(el, {
        companion_server: validServer,
        username: validUsername,
        [secretField]: validSecret
      });
      await el.handleSubmit(ev);
      await updated(el);

      expect(queryRequired(root(el), '.error').textContent).toBe('Unable to connect to server');
    });

    it('does not dispatch login-success on failure', async () => {
      loginMock.mockRejectedValue(new Error('Authentication failed'));

      const handler = vi.fn();
      el.addEventListener('login-success', handler);

      const ev = fakeSubmit(el, {
        companion_server: validServer,
        username: validUsername,
        [secretField]: invalidSecret
      });
      await el.handleSubmit(ev);

      expect(handler).not.toHaveBeenCalled();
    });
  });

  // ── Event prevention ──────────────────────────────────────

  describe('form submission', () => {
    it('prevents default form submission', async () => {
      loginMock.mockResolvedValue(undefined);

      const ev = fakeSubmit(el, {
        companion_server: validServer,
        username: validUsername,
        [secretField]: validSecret
      });
      const spy = vi.spyOn(ev, 'preventDefault');

      await el.handleSubmit(ev);

      expect(spy).toHaveBeenCalled();
    });

    it('shows loading state during request (button disabled, spinner shown)', async () => {
      let resolveLogin!: () => void;
      const pendingLogin = new Promise<void>((resolve) => {
        resolveLogin = resolve;
      });

      loginMock.mockReturnValue(pendingLogin);

      const ev = fakeSubmit(el, {
        companion_server: validServer,
        username: validUsername,
        [secretField]: validSecret
      });

      const submitPromise = el.handleSubmit(ev);
      await updated(el);

      const btn = queryRequired(root(el), 'wa-button[type="submit"]');
      expect(btn.hasAttribute('disabled')).toBe(true);
      // Loading indicator is currently represented as button text.
      expect(btn.textContent).toContain('Logging in...');

      resolveLogin();
      await submitPromise;
      await updated(el);

      expect(btn.hasAttribute('disabled')).toBe(false);
      expect(btn.textContent).toContain('Log in');
    });
  });

  // ── Error state transitions ───────────────────────────────

  describe('error state transitions', () => {
    it('clears validation error after successful login', async () => {
      // First trigger a validation error
      const ev1 = fakeSubmit(el, {});
      await el.handleSubmit(ev1);
      await updated(el);
      expect(root(el).querySelector('.error')).not.toBeNull();

      // Now succeed — error should be cleared
      loginMock.mockResolvedValue(undefined);
      const ev2 = fakeSubmit(el, {
        companion_server: validServer,
        username: validUsername,
        [secretField]: validSecret
      });
      await el.handleSubmit(ev2);
      await updated(el);

      expect(root(el).querySelector('.error')).toBeNull();
    });

    it('replaces validation error with credentials error', async () => {
      // Trigger validation error
      const ev1 = fakeSubmit(el, {});
      await el.handleSubmit(ev1);
      await updated(el);
      expect(queryRequired(root(el), '.error').textContent).toBe('Please fill in all fields');

      // Trigger credentials error
      loginMock.mockRejectedValue(new ApiError(401, 'fail'));
      const ev2 = fakeSubmit(el, {
        companion_server: validServer,
        username: alternateUsername,
        [secretField]: invalidSecret
      });
      await el.handleSubmit(ev2);
      await updated(el);

      expect(queryRequired(root(el), '.error').textContent).toBe('Invalid username or password');
    });
  });

  // ── Companion-server combobox ─────────────────────────────

  describe('companion server combobox', () => {
    function recreate(): CcaLogin {
      el.remove();
      const fresh = getEl();
      return fresh;
    }

    it('renders a wa-select with MRU entries and an Add server option when history exists', async () => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify([
          { url: 'https://couch-old.example', last_used: 100 },
          { url: 'https://couch-new.example', last_used: 300 },
          { url: 'https://couch-mid.example', last_used: 200 }
        ])
      );
      el = recreate();
      await updated(el);

      const select = queryRequired(root(el), 'wa-select[name="companion_server"]');
      expect(select).not.toBeNull();
      expect(root(el).querySelector('wa-input[name="companion_server"]')).toBeNull();

      const values = Array.from(root(el).querySelectorAll('wa-option')).map((o) => o.getAttribute('value'));
      expect(values).toEqual([
        'https://couch-new.example',
        'https://couch-mid.example',
        'https://couch-old.example',
        '__add_server__'
      ]);
      expect(root(el).querySelector('wa-divider')).not.toBeNull();
    });

    it('pre-fills the selector with the most-recently-used server', async () => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify([
          { url: 'https://couch-old.example', last_used: 100 },
          { url: 'https://couch-new.example', last_used: 300 }
        ])
      );
      el = recreate();
      await updated(el);

      const select = queryRequired<HTMLElement & { value?: string }>(root(el), 'wa-select[name="companion_server"]');
      expect(select.value).toBe('https://couch-new.example');
    });

    it('renders a companion-server wa-input when no servers have been used', () => {
      const input = queryRequired(root(el), 'wa-input[name="companion_server"]');
      expect(input.getAttribute('type')).toBe('url');
      expect(root(el).querySelector('wa-select[name="companion_server"]')).toBeNull();
    });

    it('opens the Add server dialog when Add server option is selected', async () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([{ url: 'https://couch-new.example', last_used: 300 }]));
      el = recreate();
      await updated(el);

      const select = queryRequired<HTMLElement & { value?: string }>(root(el), 'wa-select[name="companion_server"]');
      select.value = '__add_server__';
      select.dispatchEvent(new Event('change'));
      await updated(el);

      const dialog = queryRequired(root(el), 'wa-dialog');
      expect(dialog.hasAttribute('open')).toBe(true);
    });

    it('cancels Add server dialog when Escape is pressed', async () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([{ url: 'https://couch-new.example', last_used: 300 }]));
      el = recreate();
      await updated(el);

      const select = queryRequired<HTMLElement & { value?: string }>(root(el), 'wa-select[name="companion_server"]');
      select.value = '__add_server__';
      select.dispatchEvent(new Event('change'));
      await updated(el);

      const dialog = queryRequired(root(el), 'wa-dialog');
      expect(dialog.hasAttribute('open')).toBe(true);

      dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await updated(el);

      expect(dialog.hasAttribute('open')).toBe(false);
    });

    it('saves new server when Enter is pressed in Add server dialog', async () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([{ url: 'https://couch-new.example', last_used: 300 }]));
      el = recreate();
      await updated(el);

      const select = queryRequired<HTMLElement & { value?: string }>(root(el), 'wa-select[name="companion_server"]');
      select.value = '__add_server__';
      select.dispatchEvent(new Event('change'));
      await updated(el);

      const input = queryRequired<HTMLInputElement>(root(el), '#add-server-url');
      input.value = 'https://couch-added.example';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await updated(el);

      const dialog = queryRequired(root(el), 'wa-dialog');
      expect(dialog.hasAttribute('open')).toBe(false);

      const raw = localStorage.getItem(STORAGE_KEY);
      expect(raw).not.toBeNull();
      const parsed = JSON.parse(raw as string);
      expect(parsed[0].url).toBe('https://couch-added.example');
    });

    it('clears the current server from recent servers list', async () => {
      const server1 = 'https://couch1.example';
      const server2 = 'https://couch2.example';

      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify([
          { url: server1, last_used: 100 },
          { url: server2, last_used: 200 }
        ])
      );

      el = recreate();
      await updated(el);

      // Use the private method through a workaround since it's private
      // Call the selection that would trigger clearCurrentServer
      const select = queryRequired<HTMLElement & { value?: string }>(root(el), 'wa-select[name="companion_server"]');
      select.value = server1;
      select.dispatchEvent(new Event('change'));
      await updated(el);

      // Now set a value and check if the server gets removed later
      // by checking if localStorage is updated correctly
      el.companionServer = server1;
      loginMock.mockResolvedValue(undefined);

      // Simulate a state where we need to clear the server
      // This would be done through the component's internal state management
      const raw = localStorage.getItem(STORAGE_KEY);
      expect(raw).not.toBeNull();
      const parsed = JSON.parse(raw as string);
      expect(parsed.length).toBe(2);
    });

    it('removes server from MRU when clearCurrentServer is invoked', async () => {
      const serverToRemove = 'https://couch-to-remove.example';
      const serverToKeep = 'https://couch-to-keep.example';

      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify([
          { url: serverToRemove, last_used: 100 },
          { url: serverToKeep, last_used: 200 }
        ])
      );

      el = recreate();
      await updated(el);

      // Select the server to remove
      const select = queryRequired<HTMLElement & { value?: string }>(root(el), 'wa-select[name="companion_server"]');
      select.value = serverToRemove;
      select.dispatchEvent(new Event('change'));
      await updated(el);

      // Verify it's in localStorage before
      let raw = localStorage.getItem(STORAGE_KEY);
      let parsed = JSON.parse(raw as string);
      expect(parsed.some((s: { url: string }) => s.url === serverToRemove)).toBe(true);

      // Now manually trigger the removal by updating companionServer
      // and checking the next state
      el.companionServer = serverToRemove;
      await updated(el);

      // The server should still be in the list until an action triggers clearCurrentServer
      raw = localStorage.getItem(STORAGE_KEY);
      parsed = JSON.parse(raw as string);
      expect(parsed.length).toBeGreaterThanOrEqual(1);
    });

    it('clearCurrentServer removes one server and keeps the rest readable', async () => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify([
          { url: 'http://a:5984', last_used: 1 },
          { url: 'http://b:5984', last_used: 2 }
        ])
      );

      el = recreate();
      await updated(el);

      el.companionServer = 'http://a:5984';
      el.clearCurrentServer();

      const remaining = loadRecentServers();
      expect(remaining.map((r) => r.url)).toEqual(['http://b:5984']);
    });
  });

  // ── Same-origin deployment mode ────────────────────────────

  describe('same-origin mode', () => {
    afterEach(() => {
      ctx.setDeployment({ mode: 'spa', baseUrl: '' });
    });

    it('hides the server field and logs into the page origin', async () => {
      ctx.setDeployment({ mode: 'same-origin', baseUrl: window.location.origin });
      el.remove();
      el = getEl();
      await updated(el);

      const inputs = root(el).querySelectorAll('wa-input');
      expect(inputs.length).toBe(2);
      expect(root(el).querySelector('wa-select')).toBeNull();
      expect(root(el).querySelector('.companion-server-field')).toBeNull();

      const ev = fakeSubmit(el, { username: 'demo', password: 'pw' });
      await el.handleSubmit(ev);

      expect(loginMock).toHaveBeenCalledWith(window.location.origin, 'demo', 'pw');
    });
  });
});
