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
 * The logout confirmation (#24).
 *
 * The one rule this file exists to protect: the "Full logout from IdP" checkbox appears if and
 * only if there is an identity-provider session that can actually be ended. Offering it
 * otherwise sends the user to a 404; hiding it when it applies is the silent local-only logout
 * the issue is about.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fixture, html } from '@open-wc/testing';
import * as oidc from '../src/services/oidc-service';
import '../src/components/cca-logout-dialog';
import {
  FULL_IDP_LOGOUT_STORAGE_KEY,
  fullIdpLogoutPreference,
  type CcaLogoutDialog,
} from '../src/components/cca-logout-dialog';

const RP: oidc.RpLogout = {
  end_session_endpoint: 'http://localhost:8080/realms/couch/protocol/openid-connect/logout',
  client_id: 'couch-companion-ui',
};

/**
 * Mounts the dialog with a given IdP session.
 *
 * `null` is every session that has no provider to sign out of — a cookie login, a pasted
 * token, and a PKCE login against a provider that publishes no `end_session_endpoint`. The
 * service collapses all three to `null` on purpose, so the dialog has one question to answer.
 */
async function makeDialog(rp: oidc.RpLogout | null): Promise<CcaLogoutDialog> {
  vi.spyOn(oidc, 'readRpLogout').mockReturnValue(rp);
  const el = (await fixture(html`<cca-logout-dialog></cca-logout-dialog>`)) as CcaLogoutDialog;
  el.open();
  await el.updateComplete;
  return el;
}

const checkbox = (el: CcaLogoutDialog) =>
  el.shadowRoot!.querySelector<HTMLElement & { checked: boolean }>('wa-checkbox[data-everywhere]');

/** The answer the shell acts on, captured from the confirm click. */
async function confirmAndCapture(el: CcaLogoutDialog): Promise<{ everywhere: boolean } | null> {
  let detail: { everywhere: boolean } | null = null;
  el.addEventListener('logout-confirmed', (e) => {
    detail = (e as CustomEvent<{ everywhere: boolean }>).detail;
  });
  el.shadowRoot!.querySelector<HTMLElement>('wa-button[data-confirm]')!.click();
  await el.updateComplete;
  return detail;
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('cca-logout-dialog', () => {
  it('always asks for confirmation', async () => {
    const el = await makeDialog(null);

    expect(el.shadowRoot!.querySelector('[data-question]')?.textContent).toMatch(
      /are you sure you want to log out/i,
    );
  });

  describe('an IdP session that can be ended', () => {
    it('offers the "Full logout from IdP" checkbox', async () => {
      const el = await makeDialog(RP);

      expect(checkbox(el)).not.toBeNull();
      expect(checkbox(el)!.textContent).toMatch(/full logout from idp/i);
    });

    it('checks it by default', async () => {
      const el = await makeDialog(RP);

      expect(checkbox(el)!.checked).toBe(true);
      expect(await confirmAndCapture(el)).toEqual({ everywhere: true });
    });
  });

  /**
   * The degrade-silently rule. A provider that advertises no `end_session_endpoint` leaves
   * `readRpLogout()` null, and a control that leads to a 404 must not render at all.
   */
  describe('no IdP session to end', () => {
    it('renders a plain confirm with no checkbox', async () => {
      const el = await makeDialog(null);

      expect(checkbox(el)).toBeNull();
    });

    it('confirms a local-only logout', async () => {
      const el = await makeDialog(null);

      expect(await confirmAndCapture(el)).toEqual({ everywhere: false });
    });

    /** Nothing was asked, so there is nothing to remember — and nothing to overwrite. */
    it('remembers nothing, leaving an existing preference intact', async () => {
      localStorage.setItem(FULL_IDP_LOGOUT_STORAGE_KEY, 'true');
      const el = await makeDialog(null);

      await confirmAndCapture(el);

      expect(localStorage.getItem(FULL_IDP_LOGOUT_STORAGE_KEY)).toBe('true');
    });
  });

  describe('the remembered choice', () => {
    it('pre-selects the checkbox from a stored "off"', async () => {
      localStorage.setItem(FULL_IDP_LOGOUT_STORAGE_KEY, 'false');
      const el = await makeDialog(RP);

      expect(checkbox(el)!.checked).toBe(false);
      expect(await confirmAndCapture(el)).toEqual({ everywhere: false });
    });

    it('pre-selects the checkbox from a stored "on"', async () => {
      localStorage.setItem(FULL_IDP_LOGOUT_STORAGE_KEY, 'true');
      const el = await makeDialog(RP);

      expect(checkbox(el)!.checked).toBe(true);
    });

    it('defaults to on when nothing was ever stored', () => {
      expect(fullIdpLogoutPreference()).toBe(true);
    });

    /** A lost or garbled value is a user whose choice we cannot honour, not a user who said no. */
    it('defaults to on for an unparsable value', () => {
      localStorage.setItem(FULL_IDP_LOGOUT_STORAGE_KEY, 'perhaps');

      expect(fullIdpLogoutPreference()).toBe(true);
    });

    it('records the choice made on confirm', async () => {
      const el = await makeDialog(RP);

      await confirmAndCapture(el);

      expect(localStorage.getItem(FULL_IDP_LOGOUT_STORAGE_KEY)).toBe('true');
    });

    /**
     * The full loop the decision asks for: turn it off, confirm, and the next logout opens
     * with it already off.
     */
    it('round-trips a turned-off choice into the next logout', async () => {
      const first = await makeDialog(RP);
      toggle(first, false);
      await first.updateComplete;

      expect(await confirmAndCapture(first)).toEqual({ everywhere: false });
      expect(localStorage.getItem(FULL_IDP_LOGOUT_STORAGE_KEY)).toBe('false');

      const second = await makeDialog(RP);
      expect(checkbox(second)!.checked).toBe(false);
    });

    /** And back again, so "remembered" does not quietly mean "stuck". */
    it('round-trips a turned-back-on choice', async () => {
      localStorage.setItem(FULL_IDP_LOGOUT_STORAGE_KEY, 'false');
      const first = await makeDialog(RP);
      toggle(first, true);
      await first.updateComplete;

      expect(await confirmAndCapture(first)).toEqual({ everywhere: true });

      const second = await makeDialog(RP);
      expect(checkbox(second)!.checked).toBe(true);
    });
  });

  /**
   * The event-name trap, asserted against the real component rather than a hand-dispatched
   * `change`. A sibling control in this codebase (`wa-radio-group`) is the reason `@wa-change`
   * looks like the right binding; on `wa-checkbox` it never fires, and the checkbox would
   * appear to work while the answer never changed. This test fails if the binding is wrong.
   */
  it('follows a real wa-checkbox click, not a hand-dispatched event', async () => {
    const el = await makeDialog(RP);
    const box = checkbox(el)!;
    expect(customElements.get('wa-checkbox')).toBeDefined();

    box.click();
    // `handleClick` defers its `change` until after its own render settles.
    await (box as unknown as { updateComplete: Promise<unknown> }).updateComplete;
    await el.updateComplete;

    expect(box.checked).toBe(false);
    expect(await confirmAndCapture(el)).toEqual({ everywhere: false });
  });

  describe('cancelling', () => {
    it('emits nothing', async () => {
      const el = await makeDialog(RP);
      const handler = vi.fn();
      el.addEventListener('logout-confirmed', handler);

      el.shadowRoot!.querySelector<HTMLElement>('wa-button[data-cancel]')!.click();
      await el.updateComplete;

      expect(handler).not.toHaveBeenCalled();
    });
  });

  /**
   * The shell mounts one dialog for the app's lifetime, so everything the dialog shows has to
   * be re-read on each open — a value captured at connect time would describe whichever
   * session happened to be current then.
   */
  it('re-reads the IdP session on every open', async () => {
    const el = await makeDialog(RP);
    expect(checkbox(el)).not.toBeNull();

    vi.spyOn(oidc, 'readRpLogout').mockReturnValue(null);
    el.open();
    await el.updateComplete;

    expect(checkbox(el)).toBeNull();
  });
});

/**
 * Flips the checkbox the way a user does.
 *
 * `wa-checkbox` dispatches a **native** `change` — verified in the component's own source,
 * where `handleClick` does `dispatchEvent(new Event('change', …))`. Binding `wa-change`, the
 * name the sibling `wa-radio-group` trap makes tempting, would never fire.
 */
function toggle(el: CcaLogoutDialog, to: boolean): void {
  const box = checkbox(el)!;
  box.checked = to;
  box.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
}
