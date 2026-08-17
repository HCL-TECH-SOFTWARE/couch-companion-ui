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
 * D15's paste-JWKS fallback and D9's admin gating on the Add IdP screen (phase 6, T5/T6).
 *
 * The fallback exists because an IdP whose JWKS endpoint sends no CORS header cannot be
 * fetched from a browser at all — no retry, no proxy, nothing this app can do about it. The
 * operator pastes the JWKS instead. It must appear ONLY for that failure: offering it after a
 * 404 would paper over a mistyped URL.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getContext } from '../src/context';
import { OidcHttpError } from '../src/services/oidc-http';
import '../src/plugins/idp/idp-add';
import { normalizeWellKnownUrl } from '../src/plugins/idp/idp-add';
import type { CcaIdpAdd } from '../src/plugins/idp/idp-add';

let mounted: HTMLElement[] = [];

async function mount(): Promise<CcaIdpAdd> {
  const el = document.createElement('cca-idp-add') as CcaIdpAdd;
  document.body.appendChild(el);
  mounted.push(el);
  await el.updateComplete;
  return el;
}

function submit(el: CcaIdpAdd, fields: Record<string, string>) {
  const form = el.shadowRoot!.querySelector('form')!;
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
  form.dispatchEvent(ev);
}

const VALID_FIELDS = {
  name: 'Dev Keycloak',
  well_known_url: 'http://localhost:8080/realms/couch/.well-known/openid-configuration',
  client_id: 'couch-companion-ui',
  roles_claim: 'roles',
};

const corsBlocked = () =>
  new OidcHttpError(
    'cors-blocked',
    'http://localhost:8080/realms/couch/protocol/openid-connect/certs',
    'blocked',
  );

beforeEach(() => {
  vi.spyOn(getContext().serverMgmt, 'listServers').mockResolvedValue({ servers: [] } as never);
  vi.spyOn(getContext().auth, 'isAdmin', 'get').mockReturnValue(true);
  // Apply now runs automatically right after a successful create (#115) — give every test a
  // clean default so only the tests about that behavior need to override it.
  vi.spyOn(getContext().idp, 'applyIdp').mockResolvedValue({
    applied_to: ['single-server'],
    removed_from: [],
    errors: [],
  });
  vi.spyOn(getContext().idp, 'restartNode').mockResolvedValue({
    target_servers: ['single-server'],
    errors: [],
  });
});

afterEach(() => {
  for (const el of mounted) el.remove();
  mounted = [];
  vi.restoreAllMocks();
});

describe('admin gating (D9)', () => {
  it('refuses the screen to a non-admin, naming the reason', async () => {
    vi.spyOn(getContext().auth, 'isAdmin', 'get').mockReturnValue(false);

    const el = await mount();

    expect(el.shadowRoot?.textContent).toMatch(/administrator/i);
    expect(el.shadowRoot?.querySelector('form')).toBeNull();
  });

  it('renders the form for an admin', async () => {
    const el = await mount();

    expect(el.shadowRoot?.querySelector('form')).not.toBeNull();
  });
});

describe('.well-known URL field (#102)', () => {
  it('disables browser autocomplete, so a shorter history-suggested URL cannot be offered', async () => {
    const el = await mount();

    const input = el.shadowRoot!.querySelector('wa-input[name="well_known_url"]')!;
    expect(input.getAttribute('autocomplete')).toBe('off');
  });
});

describe('normalizeWellKnownUrl (#102)', () => {
  it('leaves an already-complete discovery URL untouched', () => {
    expect(normalizeWellKnownUrl('https://example.com/.well-known/openid-configuration')).toBe(
      'https://example.com/.well-known/openid-configuration',
    );
  });

  it('extends a URL ending on ".well-known" to the discovery document', () => {
    expect(normalizeWellKnownUrl('https://example.com/.well-known')).toBe(
      'https://example.com/.well-known/openid-configuration',
    );
  });

  it('extends a URL ending on ".well-known/" without doubling the slash', () => {
    expect(normalizeWellKnownUrl('https://example.com/.well-known/')).toBe(
      'https://example.com/.well-known/openid-configuration',
    );
  });

  it('appends the whole path to a bare issuer', () => {
    expect(normalizeWellKnownUrl('https://example.com')).toBe(
      'https://example.com/.well-known/openid-configuration',
    );
  });

  it('appends the whole path to a bare issuer with a trailing slash, without doubling it', () => {
    expect(normalizeWellKnownUrl('https://example.com/')).toBe(
      'https://example.com/.well-known/openid-configuration',
    );
  });

  it('appends the whole path to an issuer with its own path segment', () => {
    expect(normalizeWellKnownUrl('https://example.com/realms/couch')).toBe(
      'https://example.com/realms/couch/.well-known/openid-configuration',
    );
  });

  it('does not special-case a bare "openid-configuration" with no ".well-known" before it', () => {
    // Neither rule matches this (it's missing the ".well-known" directory, not just
    // trailing slashes), so it falls through to "append the whole path" like any other
    // non-matching URL. Redundant, but not "//", and it 404s clearly rather than
    // silently guessing the operator meant to insert ".well-known" themselves.
    expect(normalizeWellKnownUrl('https://example.com/openid-configuration')).toBe(
      'https://example.com/openid-configuration/.well-known/openid-configuration',
    );
  });

  it('is applied to the value submitted for registration', async () => {
    const create = vi
      .spyOn(getContext().idp, 'createIdp')
      .mockResolvedValue({ _id: 'idpconfig:dev-keycloak' } as never);
    const el = await mount();

    submit(el, { ...VALID_FIELDS, well_known_url: 'http://localhost:8080/realms/couch/.well-known' });

    await vi.waitFor(() => {
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          well_known_url: 'http://localhost:8080/realms/couch/.well-known/openid-configuration',
        }),
      );
    });
  });
});

/**
 * #119. The one field on this form that is not about the identity provider at all — it is this
 * deployment deciding whether the login screen still offers a password.
 */
describe('idp_only switch (#119)', () => {
  function idpOnlySwitch(el: CcaIdpAdd) {
    return el.shadowRoot!.querySelector<HTMLInputElement>('[data-idp-only]')!;
  }

  it('defaults to off — registering a provider never hides the password form by itself', async () => {
    const create = vi
      .spyOn(getContext().idp, 'createIdp')
      .mockResolvedValue({ _id: 'https://idp', name: 'Dev Keycloak' } as never);
    const el = await mount();

    submit(el, VALID_FIELDS);

    await vi.waitFor(() => {
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ idp_only: false }));
    });
  });

  it('passes idp_only through to createIdp when switched on', async () => {
    const create = vi
      .spyOn(getContext().idp, 'createIdp')
      .mockResolvedValue({ _id: 'https://idp', name: 'Dev Keycloak' } as never);
    const el = await mount();
    idpOnlySwitch(el).checked = true;

    submit(el, VALID_FIELDS);

    await vi.waitFor(() => {
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ idp_only: true }));
    });
  });

  /** #104: one CouchDB, so "which servers" was never a question this form could ask. */
  it('offers no target-server picker', async () => {
    const el = await mount();

    expect(el.shadowRoot?.textContent).not.toContain('Target Servers');
    expect(el.shadowRoot?.querySelector('input[type="checkbox"]')).toBeNull();
  });
});

describe('paste-JWKS fallback (D15)', () => {
  it('is not offered before anything has failed', async () => {
    const el = await mount();

    expect(el.shadowRoot?.querySelector('[data-jwks-paste]')).toBeNull();
  });

  it('appears when the JWKS endpoint is CORS-blocked', async () => {
    vi.spyOn(getContext().idp, 'createIdp').mockRejectedValue(corsBlocked());
    const el = await mount();

    submit(el, VALID_FIELDS);
    await vi.waitFor(() => {
      expect(el.shadowRoot?.querySelector('[data-jwks-paste]')).not.toBeNull();
    });
  });

  it('names the URL that failed, so the operator knows what to paste', async () => {
    vi.spyOn(getContext().idp, 'createIdp').mockRejectedValue(corsBlocked());
    const el = await mount();

    submit(el, VALID_FIELDS);
    await vi.waitFor(() => {
      expect(el.shadowRoot?.textContent).toContain('openid-connect/certs');
    });
  });

  it('is NOT offered for a 404 — that is a wrong URL, not a CORS wall', async () => {
    vi.spyOn(getContext().idp, 'createIdp').mockRejectedValue(
      new OidcHttpError('not-found', 'http://localhost:8080/nope', 'missing', 404),
    );
    const el = await mount();

    submit(el, VALID_FIELDS);
    await vi.waitFor(() => {
      expect(el.shadowRoot?.textContent).toMatch(/missing|failed/i);
    });
    expect(el.shadowRoot?.querySelector('[data-jwks-paste]')).toBeNull();
  });

  it('rejects pasted text that is not JSON before sending it anywhere', async () => {
    const create = vi.spyOn(getContext().idp, 'createIdp').mockRejectedValue(corsBlocked());
    const el = await mount();
    submit(el, VALID_FIELDS);
    await vi.waitFor(() => {
      expect(el.shadowRoot?.querySelector('[data-jwks-paste]')).not.toBeNull();
    });
    create.mockClear();

    const area = el.shadowRoot!.querySelector<HTMLTextAreaElement>('[data-jwks-paste] textarea')!;
    area.value = 'this is not json';
    el.shadowRoot!.querySelector<HTMLElement>('[data-jwks-retry]')!.click();
    await el.updateComplete;

    expect(create).not.toHaveBeenCalled();
    expect(el.shadowRoot?.textContent).toMatch(/valid JSON/i);
  });

  it('rejects JSON that carries no key array', async () => {
    const create = vi.spyOn(getContext().idp, 'createIdp').mockRejectedValue(corsBlocked());
    const el = await mount();
    submit(el, VALID_FIELDS);
    await vi.waitFor(() => {
      expect(el.shadowRoot?.querySelector('[data-jwks-paste]')).not.toBeNull();
    });
    create.mockClear();

    const area = el.shadowRoot!.querySelector<HTMLTextAreaElement>('[data-jwks-paste] textarea')!;
    area.value = JSON.stringify({ nope: true });
    el.shadowRoot!.querySelector<HTMLElement>('[data-jwks-retry]')!.click();
    await el.updateComplete;

    expect(create).not.toHaveBeenCalled();
    expect(el.shadowRoot?.textContent).toMatch(/keys/i);
  });

  it('retries the registration with the pasted JWKS', async () => {
    const create = vi.spyOn(getContext().idp, 'createIdp').mockRejectedValue(corsBlocked());
    const el = await mount();
    submit(el, VALID_FIELDS);
    await vi.waitFor(() => {
      expect(el.shadowRoot?.querySelector('[data-jwks-paste]')).not.toBeNull();
    });

    create.mockClear();
    create.mockResolvedValue({ _id: 'idpconfig:dev-keycloak' } as never);
    const jwks = { keys: [{ kid: 'k1', kty: 'RSA', alg: 'RS256', n: 'x', e: 'AQAB' }] };
    const area = el.shadowRoot!.querySelector<HTMLTextAreaElement>('[data-jwks-paste] textarea')!;
    area.value = JSON.stringify(jwks);
    el.shadowRoot!.querySelector<HTMLElement>('[data-jwks-retry]')!.click();

    await vi.waitFor(() => {
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ jwks }));
    });
  });
});

describe('auto-apply and restart confirmation (#115)', () => {
  // Only one CouchDB is ever in play (D2/D3) — no "which server" choice to defer Apply for.
  const CREATED = { _id: 'https://issuer.example/', name: 'Dev Keycloak' } as never;

  const openDialog = (el: CcaIdpAdd) =>
    el.shadowRoot!.querySelector('[data-confirm-restart]')?.hasAttribute('open') === true;

  it('applies the JWT configuration right after create, without being asked', async () => {
    const create = vi.spyOn(getContext().idp, 'createIdp').mockResolvedValue(CREATED);
    const el = await mount();

    submit(el, VALID_FIELDS);

    await vi.waitFor(() => {
      expect(create).toHaveBeenCalled();
      expect(getContext().idp.applyIdp).toHaveBeenCalledWith('https://issuer.example/');
    });
  });

  it('asks for permission before restarting, and does not restart on its own', async () => {
    vi.spyOn(getContext().idp, 'createIdp').mockResolvedValue(CREATED);
    const el = await mount();

    submit(el, VALID_FIELDS);

    await vi.waitFor(() => expect(openDialog(el)).toBe(true));
    expect(el.shadowRoot!.textContent).toMatch(/restart/i);
    expect(getContext().idp.restartNode).not.toHaveBeenCalled();
  });

  it('restarts and returns to the IdP list once the operator confirms', async () => {
    vi.spyOn(getContext().idp, 'createIdp').mockResolvedValue(CREATED);
    const nav = vi.spyOn(getContext().router, 'navigate').mockImplementation(() => {});
    const el = await mount();

    submit(el, VALID_FIELDS);
    await vi.waitFor(() => expect(openDialog(el)).toBe(true));

    el.shadowRoot!.querySelector<HTMLElement>('[data-restart-now]')!.click();

    await vi.waitFor(() => {
      expect(getContext().idp.restartNode).toHaveBeenCalledWith('https://issuer.example/');
      expect(nav).toHaveBeenCalledWith('/idp');
    });
  });

  it('skips the restart, but still returns to the IdP list, when the operator picks Later', async () => {
    vi.spyOn(getContext().idp, 'createIdp').mockResolvedValue(CREATED);
    const nav = vi.spyOn(getContext().router, 'navigate').mockImplementation(() => {});
    const el = await mount();

    submit(el, VALID_FIELDS);
    await vi.waitFor(() => expect(openDialog(el)).toBe(true));

    el.shadowRoot!.querySelector<HTMLElement>('[data-restart-later]')!.click();

    expect(getContext().idp.restartNode).not.toHaveBeenCalled();
    expect(nav).toHaveBeenCalledWith('/idp');
  });

  it('reports apply errors and skips the restart prompt entirely', async () => {
    vi.spyOn(getContext().idp, 'createIdp').mockResolvedValue(CREATED);
    vi.spyOn(getContext().idp, 'applyIdp').mockResolvedValue({
      applied_to: [],
      removed_from: [],
      errors: ['jwt_auth PUT failed'],
    });
    const nav = vi.spyOn(getContext().router, 'navigate').mockImplementation(() => {});
    const el = await mount();

    submit(el, VALID_FIELDS);

    await vi.waitFor(() => expect(nav).toHaveBeenCalledWith('/idp'));
    expect(openDialog(el)).toBe(false);
    expect(getContext().idp.restartNode).not.toHaveBeenCalled();
  });
});
