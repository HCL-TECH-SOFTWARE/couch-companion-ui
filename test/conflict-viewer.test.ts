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
 * Unit tests for CcaConflictViewer.
 *
 * The component must not talk to the network itself: every assertion here
 * stubs ctx.designMgmt, so a reintroduced fetch() would surface as an
 * unstubbed request rather than a passing test.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { CSSResult } from 'lit';
import { getContext } from '../src/context';
import { ApiError } from '../src/services/api-error';
import '../src/components/cca-toast';
import type { CcaToast } from '../src/components/cca-toast';
import { CcaConflictViewer } from '../src/plugins/design-mgmt/conflict-viewer.js';
import type { DesignConflict } from '../src/plugins/design-mgmt/types.js';

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------
const conflictA: DesignConflict = {
  _id: 'conflict-a',
  server_id: 'srv-a',
  db_name: 'animals',
  ddoc_id: '_design/animals',
  couch_rev: '2-abc',
  git_sha: 'deadbeefcafebabe',
  conflict_branch: 'conflict/animals',
  resolved: false,
  detected_at: '2026-07-01T10:00:00Z'
};

// Deliberately a different server_id from conflictA: the unscoped ($all) view
// must span multiple servers to honor #709's acceptance criteria, and its
// card labelling only makes sense to assert when the rows disagree.
const conflictB: DesignConflict = {
  ...conflictA,
  _id: 'conflict-b',
  server_id: 'srv-b',
  db_name: 'plants',
  ddoc_id: '_design/plants'
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const mounted: HTMLElement[] = [];

/** Mounts the singleton toast host so toast() has somewhere to render. */
async function mountToast(): Promise<CcaToast> {
  const el = document.createElement('cca-toast') as CcaToast;
  document.body.appendChild(el);
  mounted.push(el);
  await el.updateComplete;
  return el;
}

/**
 * Lets _onConnect()'s awaited service call settle, then lets Lit re-render.
 * The macrotask hop drains every pending microtask, so this is deterministic
 * for the immediately-resolved spies below — no polling, no waitFor.
 */
async function settle(el: CcaConflictViewer): Promise<void> {
  await el.updateComplete;
  await new Promise(resolve => setTimeout(resolve, 0));
  await el.updateComplete;
}

/**
 * Sets `serverId` before connecting, mirroring how cca-shell assigns route
 * params as element properties prior to mount (users-list precedent) — the
 * component reads it in _onConnect, so it must land before appendChild.
 */
async function mount(serverId?: string): Promise<CcaConflictViewer> {
  const el = document.createElement('cca-conflict-viewer') as CcaConflictViewer;
  if (serverId !== undefined) el.serverId = serverId;
  document.body.appendChild(el);
  mounted.push(el);
  await settle(el);
  return el;
}

function shadow(el: CcaConflictViewer): ShadowRoot {
  if (!el.shadowRoot) throw new Error('expected shadowRoot');
  return el.shadowRoot;
}

function rows(el: CcaConflictViewer): NodeListOf<Element> {
  return shadow(el).querySelectorAll('.conflict');
}

// ---------------------------------------------------------------------------

describe('CcaConflictViewer', () => {
  beforeEach(() => {
    // Every existing test here exercises the admin experience — couchcompanion (D9) gates the
    // whole page, added by Task 8. The 'Admin gating' describe block below overrides this.
    vi.spyOn(getContext().auth, 'isAdmin', 'get').mockReturnValue(true);
  });

  afterEach(() => {
    while (mounted.length) mounted.pop()?.remove();
    vi.restoreAllMocks();
  });

  describe('load', () => {
    beforeEach(() => {
      vi.spyOn(getContext().designMgmt, 'resolveConflict').mockResolvedValue(conflictA);
    });

    it('renders one card per conflict returned by the service', async () => {
      const listSpy = vi
        .spyOn(getContext().designMgmt, 'listConflicts')
        .mockResolvedValue([conflictA, conflictB]);

      const el = await mount();

      expect(listSpy).toHaveBeenCalledOnce();
      expect(rows(el)).toHaveLength(2);
      expect(shadow(el).textContent).toContain('_design/animals');
      expect(shadow(el).textContent).toContain('plants');
    });

    it('shows the empty state when there are no conflicts', async () => {
      vi.spyOn(getContext().designMgmt, 'listConflicts').mockResolvedValue([]);

      const el = await mount();

      expect(rows(el)).toHaveLength(0);
      // "No unresolved conflicts" was false: listConflicts returns acknowledged records too, so an
      // empty list means no conflicts on file at all.
      expect(shadow(el).querySelector('.empty')?.textContent).toContain('No conflicts recorded');
    });

    it('renders an already-resolved conflict as acknowledged, not as a fresh danger card', async () => {
      // The defect: listConflicts returns resolved records (merely sorted last) and every card
      // rendered identically — resolve one, reload, and it was back looking brand new.
      vi.spyOn(getContext().designMgmt, 'listConflicts').mockResolvedValue([
        conflictA,
        { ...conflictB, resolved: true }
      ]);

      const el = await mount();

      expect(rows(el)).toHaveLength(2);
      const resolvedCard = shadow(el).querySelector('.conflict[data-resolved]')!;
      expect(resolvedCard).not.toBeNull();
      expect(resolvedCard.textContent).toContain('plants');
      expect(resolvedCard.querySelector('.resolved-badge')).not.toBeNull();
      // Nothing to acknowledge twice.
      expect(resolvedCard.querySelector('button[data-resolve]')).toBeNull();
      // ...while the unresolved one still offers it.
      const openCard = shadow(el).querySelector('.conflict:not([data-resolved])')!;
      expect(openCard.querySelector('button[data-resolve]')).not.toBeNull();
      expect(openCard.querySelector('.resolved-badge')).toBeNull();
    });
  });

  describe('load failure', () => {
    it('shows an error panel, not the empty state, when the load rejects', async () => {
      vi.spyOn(getContext().designMgmt, 'listConflicts').mockRejectedValue(
        new ApiError(500, 'Database does not exist')
      );

      const el = await mount();

      const panel = shadow(el).querySelector('.load-error');
      expect(panel).not.toBeNull();
      expect(panel!.textContent).toContain('Database does not exist');
      // The lie this test exists to prevent.
      expect(shadow(el).querySelector('.empty')).toBeNull();
      expect(rows(el)).toHaveLength(0);
    });

    it('retries the load when the retry button is pressed', async () => {
      const listSpy = vi
        .spyOn(getContext().designMgmt, 'listConflicts')
        .mockRejectedValueOnce(new ApiError(503, 'Service unavailable'))
        .mockResolvedValueOnce([conflictA]);

      const el = await mount();
      expect(shadow(el).querySelector('.load-error')).not.toBeNull();

      shadow(el).querySelector<HTMLButtonElement>('[data-retry]')!.click();
      await settle(el);

      expect(listSpy).toHaveBeenCalledTimes(2);
      expect(shadow(el).querySelector('.load-error')).toBeNull();
      expect(rows(el)).toHaveLength(1);
    });

    it('shows an error panel, not the empty state, when the load rejects with an empty message', async () => {
      // Regression test: browsers routinely return an empty statusText for
      // HTTP/2 responses, and ApiClient's error path falls back to
      // resp.statusText when the body has neither `detail` nor `title`. An
      // empty ApiError.message must still surface as a load failure, not be
      // swallowed by a truthiness check that lets .empty render instead.
      vi.spyOn(getContext().designMgmt, 'listConflicts').mockRejectedValue(
        new ApiError(500, '')
      );

      const el = await mount();

      const panel = shadow(el).querySelector('.load-error');
      expect(panel).not.toBeNull();
      expect(shadow(el).querySelector('.empty')).toBeNull();
      expect(rows(el)).toHaveLength(0);
    });
  });

  describe('resolve', () => {
    it('marks the row acknowledged in place — not removed — and shows a success toast', async () => {
      const toastEl = await mountToast();
      vi.spyOn(getContext().designMgmt, 'listConflicts').mockResolvedValue([conflictA, conflictB]);
      const resolveSpy = vi
        .spyOn(getContext().designMgmt, 'resolveConflict')
        .mockResolvedValue({ ...conflictA, resolved: true });

      const el = await mount();
      shadow(el).querySelector<HTMLButtonElement>('.conflict button[data-resolve]')!.click();
      await settle(el);
      await toastEl.updateComplete;

      expect(resolveSpy).toHaveBeenCalledWith('conflict-a');
      // The row stays — dropping it made the in-session view disagree with what a reload shows,
      // and hid a document the design list's conflict banner still counts.
      expect(rows(el)).toHaveLength(2);
      const resolvedCard = shadow(el).querySelector('.conflict[data-resolved]')!;
      expect(resolvedCard.textContent).toContain('_design/animals');
      expect(resolvedCard.querySelector('button[data-resolve]')).toBeNull();
      expect(toastEl.shadowRoot!.querySelector('.toast.success')).not.toBeNull();
      expect(toastEl.shadowRoot!.querySelector('.toast.error')).toBeNull();
    });

    it('keeps the row and shows an error toast when the service rejects', async () => {
      const toastEl = await mountToast();
      vi.spyOn(getContext().designMgmt, 'listConflicts').mockResolvedValue([conflictA, conflictB]);
      vi.spyOn(getContext().designMgmt, 'resolveConflict').mockRejectedValue(
        new ApiError(404, 'Conflict not found')
      );

      const el = await mount();
      shadow(el).querySelector<HTMLButtonElement>('.conflict button[data-resolve]')!.click();
      await settle(el);
      await toastEl.updateComplete;

      // The defect this test exists for: the row must survive a failed resolve.
      expect(rows(el)).toHaveLength(2);
      expect(shadow(el).textContent).toContain('_design/animals');

      const errorToast = toastEl.shadowRoot!.querySelector('.toast.error');
      expect(errorToast?.textContent).toContain('Conflict not found');
      expect(toastEl.shadowRoot!.querySelector('.toast.success')).toBeNull();
    });

    it('keeps the row and shows an error toast when the service rejects with an empty message', async () => {
      // Regression test: an ApiError with an empty message (e.g. HTTP/2's
      // empty statusText, no detail/title in the body) must not produce a
      // toast with a dangling colon and no reason.
      const toastEl = await mountToast();
      vi.spyOn(getContext().designMgmt, 'listConflicts').mockResolvedValue([conflictA, conflictB]);
      vi.spyOn(getContext().designMgmt, 'resolveConflict').mockRejectedValue(
        new ApiError(500, '')
      );

      const el = await mount();
      shadow(el).querySelector<HTMLButtonElement>('.conflict button[data-resolve]')!.click();
      await settle(el);
      await toastEl.updateComplete;

      expect(rows(el)).toHaveLength(2);
      expect(shadow(el).textContent).toContain('_design/animals');

      const errorToast = toastEl.shadowRoot!.querySelector('.toast.error');
      expect(errorToast).not.toBeNull();
      expect(errorToast?.textContent).toContain('Unknown error');
      expect(toastEl.shadowRoot!.querySelector('.toast.success')).toBeNull();
    });
  });

  describe('compare versions', () => {
    it('fetches and shows both versions side by side when Compare versions is clicked', async () => {
      vi.spyOn(getContext().designMgmt, 'listConflicts').mockResolvedValue([conflictA]);
      const versionsSpy = vi.spyOn(getContext().designMgmt, 'getConflictVersions').mockResolvedValue({
        couch: { _id: '_design/animals', views: { all: { map: 'couch-version' } } },
        git: { _id: '_design/animals', views: { all: { map: 'git-version' } } }
      });

      const el = await mount();
      shadow(el).querySelector<HTMLButtonElement>('.conflict button[data-compare]')!.click();
      await settle(el);

      expect(versionsSpy).toHaveBeenCalledWith(conflictA);
      const sides = shadow(el).querySelectorAll('.compare-side pre');
      expect(sides).toHaveLength(2);
      expect(sides[0].textContent).toContain('couch-version');
      expect(sides[1].textContent).toContain('git-version');
    });

    it('collapses the comparison on a second click without re-fetching', async () => {
      vi.spyOn(getContext().designMgmt, 'listConflicts').mockResolvedValue([conflictA]);
      const versionsSpy = vi.spyOn(getContext().designMgmt, 'getConflictVersions').mockResolvedValue({
        couch: { _id: '_design/animals' },
        git: null
      });

      const el = await mount();
      const button = () => shadow(el).querySelector<HTMLButtonElement>('.conflict button[data-compare]')!;

      button().click();
      await settle(el);
      expect(shadow(el).querySelectorAll('.compare-side')).toHaveLength(2);

      button().click();
      await settle(el);
      expect(shadow(el).querySelectorAll('.compare-side')).toHaveLength(0);

      button().click();
      await settle(el);
      expect(versionsSpy).toHaveBeenCalledOnce();
    });

    it('shows "(not available)" for a side that could not be resolved', async () => {
      vi.spyOn(getContext().designMgmt, 'listConflicts').mockResolvedValue([conflictA]);
      vi.spyOn(getContext().designMgmt, 'getConflictVersions').mockResolvedValue({
        couch: { _id: '_design/animals' },
        git: null
      });

      const el = await mount();
      shadow(el).querySelector<HTMLButtonElement>('.conflict button[data-compare]')!.click();
      await settle(el);

      const sides = shadow(el).querySelectorAll('.compare-side pre');
      expect(sides[1].textContent).toContain('not available');
    });

    it('shows a message rather than crashing when the fetch rejects', async () => {
      vi.spyOn(getContext().designMgmt, 'listConflicts').mockResolvedValue([conflictA]);
      vi.spyOn(getContext().designMgmt, 'getConflictVersions').mockRejectedValue(new Error('boom'));

      const el = await mount();
      shadow(el).querySelector<HTMLButtonElement>('.conflict button[data-compare]')!.click();
      await settle(el);

      expect(shadow(el).querySelector('.compare')).toBeNull();
      expect(shadow(el).textContent).toMatch(/could not load/i);
    });
  });

  describe('Admin gating (D9 — couchcompanion is admin-only, including reads)', () => {
    beforeEach(() => {
      vi.spyOn(getContext().auth, 'isAdmin', 'get').mockReturnValue(false);
    });

    it('does not attempt to list conflicts for a non-admin — couchcompanion is admin-only', async () => {
      const listSpy = vi.spyOn(getContext().designMgmt, 'listConflicts');

      await mount();

      expect(listSpy).not.toHaveBeenCalled();
    });

    it('explains why conflicts are unavailable rather than a raw 403 panel', async () => {
      const el = await mount();

      expect(shadow(el).textContent).toMatch(/administrator/i);
      expect(shadow(el).querySelector('.load-error[data-admin-only]')).not.toBeNull();
      expect(shadow(el).querySelector('.conflict')).toBeNull();
    });
  });

  describe('layering', () => {
    it('never reads the session token or calls fetch directly', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      vi.spyOn(getContext().designMgmt, 'listConflicts').mockResolvedValue([conflictA]);

      await mount();

      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('serverId scoping', () => {
    it('passes the route serverId to the service', async () => {
      const listSpy = vi
        .spyOn(getContext().designMgmt, 'listConflicts')
        .mockResolvedValue([conflictA]);

      await mount('srv-a');

      expect(listSpy).toHaveBeenCalledWith('srv-a');
    });

    it('treats $all as unscoped and labels each card with its server', async () => {
      const listSpy = vi
        .spyOn(getContext().designMgmt, 'listConflicts')
        .mockResolvedValue([conflictA, conflictB]);

      const el = await mount('$all');

      expect(listSpy).toHaveBeenCalledWith(undefined);
      const cards = rows(el);
      expect(cards).toHaveLength(2);
      expect(cards[0].textContent).toContain(`Server: ${conflictA.server_id}`);
      expect(cards[1].textContent).toContain(`Server: ${conflictB.server_id}`);
    });

    it('scoped view does not label cards with the server', async () => {
      vi.spyOn(getContext().designMgmt, 'listConflicts').mockResolvedValue([conflictA]);

      const el = await mount('srv-a');

      expect(rows(el)).toHaveLength(1);
      expect(shadow(el).textContent).not.toContain('Server:');
    });
  });

  describe('theming', () => {
    it('styles with wa- design tokens, never hardcoded colours', () => {
      const { cssText } = CcaConflictViewer.styles as CSSResult;

      // Hex literals and bare colour keywords break under wa-dark.
      expect(cssText).not.toMatch(/#[0-9a-f]{3,8}\b/i);
      expect(cssText).not.toMatch(/:\s*white\b/);
    });

    // Two guards used to live here, one asserting that every --wa- token this component names is
    // declared by the theme, one asserting it names no --cca- property. Both are now lint rules —
    // cca/no-undefined-wa-token and cca/no-cca-custom-property, in frontend/eslint-rules/ — which
    // check all of src/ rather than one component, and need no token-count pin to stay
    // non-vacuous. See #718 and #729.
  });
});
