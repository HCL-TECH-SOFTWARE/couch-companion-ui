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
 * Unit tests for cca-csp-check — the Content-Security-Policy check on the version-control
 * screen (#34).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getContext } from '../src/context';
import type { Deployment } from '../src/services/deployment-mode';
import '../src/components/cca-csp-check';
import type { CcaCspCheck } from '../src/components/cca-csp-check';

/** What CouchDB 3.5.2 sends on `/_utils/` — the policy with no `connect-src` at all. */
const COUCHDB_DEFAULT =
  "child-src 'self' data: blob:; default-src 'self'; img-src 'self' data:; font-src 'self'; " +
  "script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; frame-src https://blog.couchdb.org;";

/** The same header once the toggle has been switched on — what `docs/install.md` documents. */
const EXTENDED =
  "child-src 'self' data: blob:; default-src 'self'; img-src 'self' data:; font-src 'self'; " +
  "script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; " +
  "frame-src https://blog.couchdb.org; connect-src 'self' https://api.github.com;";

const GITHUB = 'https://api.github.com';

let mounted: CcaCspCheck[] = [];
let savedDeployment: Deployment;

/** Mounts the component with a policy the server "sends" and the origins git sync needs. */
async function mount(policy: string | null, origins: string[] = [GITHUB]): Promise<CcaCspCheck> {
  vi.spyOn(getContext().csp, 'readUtilsPolicy').mockResolvedValue(policy);
  const el = document.createElement('cca-csp-check') as CcaCspCheck;
  el.origins = origins;
  // What repo-overview.ts passes. The component's copy and its second switch are per-screen since
  // #149, so a mount with the defaults would be testing a configuration nothing ships.
  el.subject = 'git sync';
  el.blockedSymptom = 'git sync fails with "Failed to fetch" and nothing appears in the network tab';
  el.emptyMessage = 'No git accounts are connected yet, so there is nothing for the policy to allow.';
  el.viewTester = true;
  document.body.appendChild(el);
  mounted.push(el);
  await el.reload();
  await el.updateComplete;
  return el;
}

const q = (el: CcaCspCheck, selector: string) => el.shadowRoot!.querySelector(selector);
const text = (el: CcaCspCheck) => el.shadowRoot!.textContent ?? '';

describe('cca-csp-check', () => {
  let write: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    savedDeployment = getContext().deployment;
    getContext().deployment = { mode: 'same-origin', baseUrl: 'http://localhost:5984' };
    vi.spyOn(getContext().auth, 'isAdmin', 'get').mockReturnValue(true);
    write = vi.spyOn(getContext().csp, 'writeUtilsPolicy').mockResolvedValue(undefined);
  });

  afterEach(() => {
    for (const el of mounted) el.remove();
    mounted = [];
    getContext().deployment = savedDeployment;
  });

  // ---------------------------------------------------------------------------
  // Detection
  // ---------------------------------------------------------------------------
  describe('detection', () => {
    it('reads the live response header, not the [csp] config section', async () => {
      // The trap this whole feature turns on: an empty [csp] section does NOT mean "no policy",
      // it means CouchDB's built-in default — the one missing connect-src. A component that
      // consulted the config would report "nothing set" on exactly the server that is broken.
      const config = vi.spyOn(getContext().config, 'getConfigValue');
      const el = await mount(COUCHDB_DEFAULT);

      expect(getContext().csp.readUtilsPolicy).toHaveBeenCalled();
      expect(config).not.toHaveBeenCalled();
      expect(q(el, '[data-live-policy]')!.textContent).toBe(COUCHDB_DEFAULT);
    });

    it("warns that CouchDB's default refuses the git host before the request is sent", async () => {
      const el = await mount(COUCHDB_DEFAULT);

      expect(q(el, '[data-csp-check]')!.getAttribute('variant')).toBe('warning');
      expect(text(el)).toContain(GITHUB);
      expect(text(el)).toMatch(/nothing appears in the network tab/i);
    });

    it('says nothing at all when the server sends no policy', async () => {
      const el = await mount(null);
      expect(q(el, '[data-csp-check]')).toBeNull();
    });

    it('does not raise its own error when the header cannot be read', async () => {
      vi.spyOn(getContext().csp, 'readUtilsPolicy').mockRejectedValue(new Error('nope'));
      const el = document.createElement('cca-csp-check') as CcaCspCheck;
      document.body.appendChild(el);
      mounted.push(el);
      await el.reload();
      await el.updateComplete;

      expect(q(el, '[data-csp-check]')).toBeNull();
    });

    it('adopts the policy a real violation report carries, and names the refused host', async () => {
      const el = await mount(null);

      // `originalPolicy` is the exact header the browser enforced; `blockedURI` is proof that a
      // request really was refused, which no amount of header-reading can establish.
      el.dispatchEvent(
        Object.assign(new CustomEvent('securitypolicyviolation', { bubbles: true, composed: true }), {
          originalPolicy: COUCHDB_DEFAULT,
          blockedURI: 'https://api.github.com/user',
          effectiveDirective: 'connect-src'
        })
      );
      await el.updateComplete;

      expect(q(el, '[data-live-policy]')!.textContent).toBe(COUCHDB_DEFAULT);
      expect(q(el, '[data-blocked-host]')!.textContent).toBe('api.github.com');
    });
  });

  // ---------------------------------------------------------------------------
  // The toggle
  // ---------------------------------------------------------------------------
  describe('the toggle', () => {
    it('writes exactly the header docs/install.md documents, keeping every other directive', async () => {
      const el = await mount(COUCHDB_DEFAULT);
      expect((q(el, '[data-origin-access]') as HTMLInputElement).checked).toBe(false);

      await el.setOriginAccess(true);

      expect(write).toHaveBeenCalledWith(getContext().selectedServer, EXTENDED);
    });

    it('turning it off restores the header byte for byte', async () => {
      const el = await mount(EXTENDED);
      expect((q(el, '[data-origin-access]') as HTMLInputElement).checked).toBe(true);

      await el.setOriginAccess(false);

      expect(write).toHaveBeenCalledWith(getContext().selectedServer, COUCHDB_DEFAULT);
    });

    it('re-reads the header after writing rather than assuming the write took', async () => {
      const el = await mount(COUCHDB_DEFAULT);
      const read = vi.spyOn(getContext().csp, 'readUtilsPolicy').mockResolvedValue(EXTENDED);

      await el.setOriginAccess(true);
      await el.updateComplete;

      expect(read).toHaveBeenCalled();
      expect(q(el, '[data-live-policy]')!.textContent).toBe(EXTENDED);
      expect((q(el, '[data-origin-access]') as HTMLInputElement).checked).toBe(true);
    });

    it('does not write the config when the policy already says what is being asked for', async () => {
      const el = await mount(EXTENDED);
      await el.setOriginAccess(true);
      expect(write).not.toHaveBeenCalled();
    });

    it('offers nothing when no git account is connected', async () => {
      const el = await mount(COUCHDB_DEFAULT, []);

      expect(q(el, '[data-nothing-configured]')).not.toBeNull();
      expect(q(el, '[data-origin-access]')).toBeNull();
      await el.setOriginAccess(true);
      expect(write).not.toHaveBeenCalled();
    });

    it('derives an Enterprise origin from the account, never a hardcoded github.com', async () => {
      const el = await mount(COUCHDB_DEFAULT, ['https://ghe.example.com']);
      await el.setOriginAccess(true);

      expect(write).toHaveBeenCalledWith(
        getContext().selectedServer,
        expect.stringContaining("connect-src 'self' https://ghe.example.com;")
      );
      expect(write).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining('api.github.com'));
    });
  });

  // ---------------------------------------------------------------------------
  // A policy that already permits the host
  // ---------------------------------------------------------------------------
  describe('a policy that already permits the host', () => {
    it('shows no offer and no warning when a wildcard already covers it', async () => {
      const el = await mount("default-src 'self'; connect-src *;");

      expect(q(el, '[data-csp-check]')!.getAttribute('variant')).toBe('neutral');
      expect(q(el, '[data-origin-access]')).toBeNull();
      expect(q(el, '[data-copy-only]')).toBeNull();
      expect(q(el, '[data-already-allowed]')).not.toBeNull();
    });

    it('shows the switch already on when the origin is listed literally', async () => {
      const el = await mount(EXTENDED);

      expect(q(el, '[data-csp-check]')!.getAttribute('variant')).toBe('neutral');
      expect((q(el, '[data-origin-access]') as HTMLInputElement).checked).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // script-src 'unsafe-eval' — a separate decision, never folded in
  // ---------------------------------------------------------------------------
  describe("script-src 'unsafe-eval'", () => {
    it('is its own switch, and the git-access write never touches script-src', async () => {
      const el = await mount(COUCHDB_DEFAULT);
      expect((q(el, '[data-unsafe-eval]') as HTMLInputElement).checked).toBe(true);

      await el.setOriginAccess(true);

      const written = write.mock.calls[0][1] as string;
      expect(written).toContain("script-src 'self' 'unsafe-eval'");
    });

    it('writes only the script-src change when the view-tester switch is used', async () => {
      const el = await mount(COUCHDB_DEFAULT);

      await el.setViewTesterAllowed(false);

      const written = write.mock.calls[0][1] as string;
      expect(written).toContain("script-src 'self';");
      expect(written).not.toContain('unsafe-eval');
      // The connect-src question is untouched: still absent, still unanswered.
      expect(written).not.toContain('connect-src');
    });

    it('states the consequence, measured against a real browser', async () => {
      const el = await mount(COUCHDB_DEFAULT);
      expect(text(el)).toMatch(/Run Test/);
      expect(text(el)).toMatch(/new Function/);
    });

    it('reports the broken state when an operator has already removed it', async () => {
      const el = await mount("default-src 'self'; script-src 'self'; connect-src 'self' https://api.github.com;");
      expect((q(el, '[data-unsafe-eval]') as HTMLInputElement).checked).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Degrades
  // ---------------------------------------------------------------------------
  describe('degrades', () => {
    it('is hidden entirely in SPA mode', async () => {
      // The policy comes from whoever serves the page, not from CouchDB, so neither the
      // diagnosis nor the fix would be true — and CouchDB's config key is the wrong file.
      getContext().deployment = { mode: 'spa', baseUrl: 'https://couch.example.com' };
      const read = vi.spyOn(getContext().csp, 'readUtilsPolicy').mockResolvedValue(COUCHDB_DEFAULT);

      const el = document.createElement('cca-csp-check') as CcaCspCheck;
      el.origins = [GITHUB];
      el.viewTester = true;
      document.body.appendChild(el);
      mounted.push(el);
      await el.updateComplete;

      expect(el.shadowRoot!.querySelector('*')).toBeNull();
      expect(read).not.toHaveBeenCalled();
    });

    it('gives a non-admin the computed header and the curl, and never writes', async () => {
      vi.spyOn(getContext().auth, 'isAdmin', 'get').mockReturnValue(false);
      const el = await mount(COUCHDB_DEFAULT);

      expect(q(el, '[data-origin-access]')).toBeNull();
      expect(q(el, '[data-unsafe-eval]')).toBeNull();
      expect(q(el, '[data-desired-header]')!.textContent).toBe(EXTENDED);
      expect(q(el, '[data-curl]')!.textContent).toContain(
        'http://localhost:5984/_node/_local/_config/csp/utils_header_value'
      );
      expect(q(el, '[data-curl]')!.textContent).toContain("--data-binary @- <<'JSON'");

      // Control: the switch really is what an admin gets, so the assertions above cannot pass
      // for a typo or for a component that stopped rendering a switch at all.
      vi.spyOn(getContext().auth, 'isAdmin', 'get').mockReturnValue(true);
      const adminEl = await mount(COUCHDB_DEFAULT);
      expect(q(adminEl, '[data-origin-access]')).not.toBeNull();

      expect(write).not.toHaveBeenCalled();
    });

    it('falls back to copy-only when the server refuses the write', async () => {
      // CouchDB answers a non-admin config write with 401 "You are not a server admin." — not a
      // 403 — so this reacts to the refusal itself, never to a status code it assumed.
      vi.spyOn(getContext().csp, 'writeUtilsPolicy').mockRejectedValue(
        new Error('You are not a server admin.')
      );
      const el = await mount(COUCHDB_DEFAULT);

      await el.setOriginAccess(true);
      await el.updateComplete;

      expect(q(el, '[data-origin-access]')).toBeNull();
      expect(q(el, '[data-copy-only]')).not.toBeNull();
      expect(q(el, '[data-error]')!.textContent).toContain('not a server admin');
    });
  });
});
