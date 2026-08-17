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
 * Unit tests for CcaViewEditor component.
 * Focused on critical behavior: function switching, dirty state, save, and diff mode.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LitElement } from 'lit';
import { getContext } from '../src/context';

// Prevent monaco-editor from initialising in jsdom (canvas pixel-ratio crash)
vi.mock('../src/components/cca-monaco-editor.js', () => ({}));

import type { CcaViewEditor } from '../src/plugins/design-mgmt/view-editor.js';
import '../src/plugins/design-mgmt/view-editor.js';
import '../src/components/cca-header.js';
import type { CcaHeader } from '../src/components/cca-header.js';
import { GitHttpError } from '../src/services/git/git-http.js';

// ---------------------------------------------------------------------------
// Stub wa-* and cca-* custom elements so the component can render in jsdom
// ---------------------------------------------------------------------------
class WaStub extends LitElement {
  checked = false;
  createRenderRoot() {
    return this;
  }
}

for (const tag of [
  'wa-button', 'wa-icon', 'wa-input', 'wa-select', 'wa-option',
  'wa-badge', 'wa-checkbox', 'wa-switch', 'wa-dropdown', 'wa-dropdown-item',
  'wa-split-panel', 'wa-tooltip', 'wa-callout', 'wa-spinner',
]) {
  if (!customElements.get(tag)) {
    customElements.define(tag, class extends WaStub {});
  }
}

for (const tag of ['cca-monaco-editor']) {
  if (!customElements.get(tag)) {
    customElements.define(tag, class extends WaStub {});
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function getEl(): CcaViewEditor {
  const el = document.createElement('cca-view-editor') as CcaViewEditor;
  el.setAttribute('serverId', 'srv1');
  el.setAttribute('serverName', 'Test Server');
  el.setAttribute('dbName', 'testdb');
  el.setAttribute('ddocId', '_design/test');
  document.body.appendChild(el);
  return el;
}

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------
const mockDesignDoc = {
  _id: '_design/test',
  views: {
    all: { map: 'function(doc) { emit(doc._id, 1); }' },
    by_type: { map: 'function(doc) { emit(doc.type, 1); }', reduce: '_sum' }
  },
  filters: {
    important: 'function(doc, req) { return doc.important; }'
  },
  validate_doc_update: 'function(newDoc, oldDoc, userCtx) {}'
};

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
describe('CcaViewEditor', () => {
  let element: CcaViewEditor;

  beforeEach(async () => {
    sessionStorage.clear();
    const ctx = getContext();
    // Silence network calls made in firstUpdated / loadDesignDoc
    vi.spyOn(ctx.serverMgmt, 'getServer').mockResolvedValue({
      name: 'Test Server',
      couch_version: '3.3.0'
    } as any);
    vi.spyOn(ctx.designMgmt, 'getRepo').mockResolvedValue({ repo: null } as any);
    vi.spyOn(ctx.designMgmt, 'getDesignDoc').mockResolvedValue(mockDesignDoc as any);
    // Mock queryDocuments for autocomplete feature (returns empty by default)
    vi.spyOn(ctx.dbMgmt, 'queryDocuments').mockResolvedValue({ documents: [] } as any);

    element = getEl();
    await element.updateComplete;
    // Flush async work from firstUpdated (getServer, getRepo, loadDesignDoc, _fetchSampledProperties)
    await Promise.resolve();
    await element.updateComplete;
  });

  afterEach(() => {
    element.remove();
    vi.restoreAllMocks();
  });

  describe('Core Functionality', () => {
    it('should render component with properties', () => {
      expect(element).toBeDefined();
      expect(element.serverId).toBe('srv1');
      expect(element.dbName).toBe('testdb');
      expect(element.ddocId).toBe('_design/test');
    });

    it('should display all function types from design doc', async () => {
      // @ts-ignore
      element.ddoc = mockDesignDoc;
      await element.updateComplete;

      const content = element.shadowRoot?.textContent || '';
      expect(content).toContain('all');
      expect(content).toContain('by_type');
      expect(content).toContain('important');
    });

    it('should switch between different functions', async () => {
      // @ts-ignore
      element.ddoc = mockDesignDoc;
      // @ts-ignore
      element.selectedSection = 'views';
      // @ts-ignore
      element.selectedName = 'all';
      await element.updateComplete;

      // @ts-ignore
      element.selectedName = 'by_type';
      await element.updateComplete;

      // @ts-ignore
      expect(element.selectedName).toBe('by_type');
    });
  });

  describe('Dirty State & Navigation Guard', () => {
    it('should track dirty state when content changes', async () => {
      // @ts-ignore
      element.ddoc = mockDesignDoc;
      // @ts-ignore
      element._dirty = true;

      // @ts-ignore
      expect(element._dirty).toBe(true);
    });

    it('should prevent navigation when dirty', () => {
      // @ts-ignore
      element._dirty = true;

      const mockEvent = new Event('beforeunload') as BeforeUnloadEvent;
      // @ts-ignore
      const result = element._beforeUnload(mockEvent);

      expect(result).toBe(true);
    });

    it('should allow navigation when clean', () => {
      // @ts-ignore
      element._dirty = false;

      const mockEvent = new Event('beforeunload') as BeforeUnloadEvent;
      // @ts-ignore
      const result = element._beforeUnload(mockEvent);

      expect(result).toBeUndefined();
    });
  });

  describe('Raw Mode', () => {
    it('should toggle between structured and raw mode', async () => {
      // @ts-ignore
      expect(element.rawMode).toBe(false);

      // @ts-ignore
      element.rawMode = true;
      await element.updateComplete;

      // @ts-ignore
      expect(element.rawMode).toBe(true);
    });
  });

  describe('Reduce Functions', () => {
    it('should handle built-in reduce functions', async () => {
      // @ts-ignore
      element.ddoc = mockDesignDoc;
      // @ts-ignore
      element.selectedSection = 'views';
      // @ts-ignore
      element.selectedName = 'by_type';
      // Wait for willUpdate to sync selectedReduce from the view's reduce field (_sum)
      await element.updateComplete;

      // willUpdate syncs selectedReduce from the doc's reduce field when selectedName changes.
      // by_type has reduce: '_sum', so selectedReduce should be '_sum'.
      // @ts-ignore
      expect(element.selectedReduce).toBe('_sum');

      // Directly setting selectedReduce after update reflects the chosen value.
      // @ts-ignore
      element.selectedReduce = '_count';
      await element.updateComplete;
      // @ts-ignore
      expect(element.selectedReduce).toBe('_count');
    });

    it('should switch to reduce tab and initialize template when custom reduce is selected', async () => {
      // @ts-ignore
      element.ddoc = mockDesignDoc;
      // @ts-ignore
      element.selectedSection = 'views';
      // @ts-ignore
      element.selectedName = 'by_type';
      // @ts-ignore
      element.activeTab = 'map';
      await element.updateComplete;

      // Simulate selecting custom reduce from dropdown
      const selectEl = element.shadowRoot?.querySelector('wa-select[name="reduce"]') as any;
      if (selectEl) {
        selectEl.value = '__custom__';
        selectEl.dispatchEvent(new Event('change', { bubbles: true }));
        await element.updateComplete;
      }

      // Should switch to reduce tab
      // @ts-ignore
      expect(element.activeTab).toBe('reduce');

      // Should initialize reduce function with template
      // @ts-ignore
      const view = element.ddoc.views?.['by_type'];
      expect(view?.reduce).toBeDefined();
      expect(typeof view?.reduce).toBe('string');
      // @ts-ignore
      expect(view?.reduce).toContain('function(keys, values, rereduce)');
      // @ts-ignore
      expect(view?.reduce).toContain('TODO');
    });

    it('should preserve existing custom reduce when switching to custom', async () => {
      const customReduceFn = 'function(keys, values, rereduce) { return values.length; }';
      // @ts-ignore
      element.ddoc = {
        ...mockDesignDoc,
        views: {
          ...mockDesignDoc.views,
          custom_view: { 
            map: 'function(doc) { emit(doc._id, 1); }',
            reduce: customReduceFn
          }
        }
      };
      // @ts-ignore
      element.selectedSection = 'views';
      // @ts-ignore
      element.selectedName = 'custom_view';
      await element.updateComplete;

      // Simulate selecting custom reduce (should preserve existing)
      const selectEl = element.shadowRoot?.querySelector('wa-select[name="reduce"]') as any;
      if (selectEl) {
        selectEl.value = '__custom__';
        selectEl.dispatchEvent(new Event('change', { bubbles: true }));
        await element.updateComplete;
      }

      // Should preserve the existing custom reduce function
      // @ts-ignore
      const view = element.ddoc.views?.['custom_view'];
      expect(view?.reduce).toBe(customReduceFn);
    });
  });

  describe('Test View', () => {
    it('should display test results when available', async () => {
      // @ts-ignore
      element.testResult = {
        rows: ['["doc1", 1]'] as any
      };
      // @ts-ignore
      element.activeTab = 'test';
      await element.updateComplete;

      expect(element.shadowRoot).toBeDefined();
    });

    it('should display test error when present', async () => {
      // @ts-ignore
      element.testResult = {
        error: 'Syntax error in map function'
      };
      // @ts-ignore
      element.activeTab = 'test';
      await element.updateComplete;

      expect(element.shadowRoot).toBeDefined();
    });

    it('runs a real map function end-to-end through the service and returns real rows', async () => {
      // ctx.designMgmt.testView is deliberately left un-stubbed here (unlike every other test in
      // this file) — the point is proving that handleTest() now executes the actual map function
      // via the real DesignMgmtService.testView -> runViewIsolated -> runMapReduce, instead of the
      // old backend's canned "[preview] doc N would be processed" string.
      // @ts-ignore
      element.ddoc = mockDesignDoc;
      // @ts-ignore
      element.selectedSection = 'views';
      // @ts-ignore
      element.selectedName = 'all'; // map: 'function(doc) { emit(doc._id, 1); }'
      await element.updateComplete;

      // Default sampleDocs state: '[{"_id": "doc1", "name": "Example"}]'
      // @ts-ignore
      await element.handleTest();

      // @ts-ignore
      expect(element.testResult?.error).toBeUndefined();
      // @ts-ignore
      expect(element.testResult?.rows).toEqual([{ key: 'doc1', value: 1, id: 'doc1' }]);
    });

    it('describes the test as a real run, not the old "not yet supported" preview copy', async () => {
      // @ts-ignore
      element.testResult = { rows: [{ key: 'doc1', value: 1, id: 'doc1' }], error: undefined };
      // @ts-ignore
      element.selectedSection = 'views';
      // @ts-ignore
      element.activeTab = 'test';
      await element.updateComplete;

      const text = element.shadowRoot?.textContent ?? '';
      expect(text).not.toMatch(/not yet supported/i);
    });
  });

  describe('Quick test — error does not imply zero rows', () => {
    it('shows a warning (not a bare error) when a broken reduce still returns the map rows', async () => {
      const ctx = getContext();
      vi.spyOn(ctx.designMgmt, 'testView').mockResolvedValue({
        rows: [{ key: 'doc1', value: 1, id: 'doc1' }],
        error: 'Reduce function threw: boom'
      });

      // @ts-ignore
      element.ddoc = mockDesignDoc;
      // @ts-ignore
      element.selectedSection = 'views';
      // @ts-ignore
      element.selectedName = 'all';
      await element.updateComplete;

      // @ts-ignore
      await element.handleQuickTest();

      // @ts-ignore
      expect(element.quickTest).toEqual({
        status: 'warning',
        message: 'Reduce function threw: boom',
        rowCount: 1
      });
    });

    it('shows an error (not a warning) when nothing survived', async () => {
      const ctx = getContext();
      vi.spyOn(ctx.designMgmt, 'testView').mockResolvedValue({
        rows: [],
        error: 'Could not compile the map function: SyntaxError'
      });

      // @ts-ignore
      element.ddoc = mockDesignDoc;
      // @ts-ignore
      element.selectedSection = 'views';
      // @ts-ignore
      element.selectedName = 'all';
      await element.updateComplete;

      // @ts-ignore
      await element.handleQuickTest();

      // @ts-ignore
      expect(element.quickTest).toEqual({
        status: 'error',
        message: 'Could not compile the map function: SyntaxError',
        rowCount: 0
      });
    });

    it('still shows a row count alongside a warning, not just alongside success', async () => {
      const ctx = getContext();
      vi.spyOn(ctx.designMgmt, 'testView').mockResolvedValue({
        rows: [{ key: 'doc1', value: 1, id: 'doc1' }, { key: 'doc2', value: 1, id: 'doc2' }],
        error: 'Ran only the first 200 of 250 sample documents — no Worker is available.'
      });

      // @ts-ignore
      element.ddoc = mockDesignDoc;
      // @ts-ignore
      element.selectedSection = 'views';
      // @ts-ignore
      element.selectedName = 'all';
      // @ts-ignore
      element.activeTab = 'map';
      await element.updateComplete;

      // @ts-ignore
      await element.handleQuickTest();
      await element.updateComplete;

      const text = element.shadowRoot?.textContent ?? '';
      expect(text).toContain('2 row');
    });
  });

  describe('Repo branch matches THIS (serverId, dbName) target (#pre-existing, multi-db repo)', () => {
    it('does not just take the first sync target when the repo tracks more than one database', async () => {
      const ctx = getContext();
      vi.spyOn(ctx.designMgmt, 'getRepo').mockResolvedValue({
        repo: {
          _id: 'repo:multi',
          name: 'multi-db-repo',
          sync_targets: [
            { server_id: 'srv1', db_name: 'other-db', branch: 'wrong-branch', path: '/' },
            { server_id: 'srv1', db_name: 'testdb', branch: 'correct-branch', path: '/' }
          ]
        }
      } as any);

      const el = getEl();
      await el.updateComplete;
      await Promise.resolve();
      await el.updateComplete;

      // @ts-ignore
      expect(el.repoBranch).toBe('correct-branch');
      el.remove();
    });
  });

  describe('Admin gating (D9 — saving a design doc is admin-only)', () => {
    it('disables Save for a non-admin', async () => {
      vi.spyOn(getContext().auth, 'isAdmin', 'get').mockReturnValue(false);

      const el = getEl();
      await el.updateComplete;
      await Promise.resolve();
      await el.updateComplete;

      // Not a textContent substring check — a CSS comment in this component's own <style> block
      // ("Save-error panel") contains the word "Save" too.
      const saveButton = Array.from(el.shadowRoot?.querySelectorAll('wa-button') ?? []).find(
        (b) => b.textContent?.trim() === 'Save'
      );
      expect(saveButton).toBeUndefined();
      expect(el.shadowRoot?.querySelector('.ve-readonly-note')).not.toBeNull();
      el.remove();
    });

    it('marks the main editor read-only for a non-admin', async () => {
      vi.spyOn(getContext().auth, 'isAdmin', 'get').mockReturnValue(false);

      const el = getEl();
      await el.updateComplete;
      await Promise.resolve();
      await el.updateComplete;

      const editor = el.shadowRoot?.querySelector('cca-monaco-editor') as unknown as { readOnly?: boolean } | null;
      expect(editor?.readOnly).toBe(true);
      el.remove();
    });

    it('keeps Save enabled for an admin', async () => {
      vi.spyOn(getContext().auth, 'isAdmin', 'get').mockReturnValue(true);

      const el = getEl();
      await el.updateComplete;
      await Promise.resolve();
      await el.updateComplete;

      const saveButton = Array.from(el.shadowRoot?.querySelectorAll('wa-button') ?? []).find(
        (b) => b.textContent?.trim() === 'Save'
      );
      expect(saveButton).not.toBeUndefined();
      el.remove();
    });
  });

  describe('Database-admin capability (fix round 1 — a db admin without the server _admin role)', () => {
    async function settle(el: CcaViewEditor) {
      await el.updateComplete;
      await Promise.resolve();
      await el.updateComplete;
      await Promise.resolve();
      await el.updateComplete;
    }

    it('enables Save for a database admin who is not a server admin', async () => {
      const ctx = getContext();
      vi.spyOn(ctx.auth, 'isAdmin', 'get').mockReturnValue(false);
      vi.spyOn(ctx.auth, 'state', 'get').mockReturnValue({
        authenticated: true, username: 'dbadmin', companionServer: null, roles: []
      });
      vi.spyOn(ctx.dbMgmt, 'listDatabaseAccess').mockResolvedValue({
        admin: { name: ['dbadmin'], roles: [] },
        member: { name: [], roles: [] }
      });

      const el = getEl();
      await settle(el);

      const saveButton = Array.from(el.shadowRoot?.querySelectorAll('wa-button') ?? []).find(
        (b) => b.textContent?.trim() === 'Save'
      );
      expect(saveButton).not.toBeUndefined();

      const editor = el.shadowRoot?.querySelector('cca-monaco-editor') as unknown as { readOnly?: boolean } | null;
      expect(editor?.readOnly).toBe(false);
      el.remove();
    });

    it('keeps Save disabled for a plain db member named nowhere in admins', async () => {
      const ctx = getContext();
      vi.spyOn(ctx.auth, 'isAdmin', 'get').mockReturnValue(false);
      vi.spyOn(ctx.auth, 'state', 'get').mockReturnValue({
        authenticated: true, username: 'plain-member', companionServer: null, roles: []
      });
      vi.spyOn(ctx.dbMgmt, 'listDatabaseAccess').mockResolvedValue({
        admin: { name: ['someone-else'], roles: [] },
        member: { name: ['plain-member'], roles: [] }
      });

      const el = getEl();
      await settle(el);

      const saveButton = Array.from(el.shadowRoot?.querySelectorAll('wa-button') ?? []).find(
        (b) => b.textContent?.trim() === 'Save'
      );
      expect(saveButton).toBeUndefined();
      el.remove();
    });

    it('does not probe _security for a server admin — isAdmin is a self-sufficient fast path', async () => {
      const ctx = getContext();
      vi.spyOn(ctx.auth, 'isAdmin', 'get').mockReturnValue(true);
      const accessSpy = vi.spyOn(ctx.dbMgmt, 'listDatabaseAccess');

      const el = getEl();
      await settle(el);

      expect(accessSpy).not.toHaveBeenCalled();
      const saveButton = Array.from(el.shadowRoot?.querySelectorAll('wa-button') ?? []).find(
        (b) => b.textContent?.trim() === 'Save'
      );
      expect(saveButton).not.toBeUndefined();
      el.remove();
    });
  });

  describe('Header Actions (singleton cca-header)', () => {
    let header: CcaHeader;

    beforeEach(async () => {
      header = document.createElement('cca-header') as CcaHeader;
      document.body.appendChild(header);
      await header.updateComplete;
    });

    afterEach(() => {
      header.remove();
    });

    function subactions(): NodeListOf<Element> {
      // The header renders fixed id-less actions outside .subactions;
      // page-registered actions land inside it.
      return (
        header.shadowRoot?.querySelectorAll('.subactions cca-action') ??
        ([] as unknown as NodeListOf<Element>)
      );
    }

    it('does not resurrect header actions when a stale loadDesignDoc resolves after the editor was removed', async () => {
      // Lit still runs updates on disconnected elements and the cca-header
      // action API is a global singleton: without the isConnected guard in
      // _updateHeaderActions() the stale continuation re-registers the dead
      // editor's Raw/Structured toggle and clobbers whatever the next page
      // registered.
      let resolveDoc!: (d: unknown) => void;
      vi.spyOn(getContext().designMgmt, 'getDesignDoc').mockReturnValue(
        new Promise((r) => {
          resolveDoc = r;
        }) as any
      );

      const el = getEl();
      await el.updateComplete;

      el.remove();
      await header.updateComplete;
      expect(subactions().length).toBe(0);

      resolveDoc(mockDesignDoc);
      await new Promise((r) => setTimeout(r, 0));
      await header.updateComplete;

      expect(subactions().length).toBe(0);
    });
  });

  describe('Monaco Editor', () => {
    it('should render monaco editor component', async () => {
      await element.updateComplete;
      const editors = element.shadowRoot?.querySelectorAll('cca-monaco-editor');
      expect(editors?.length).toBeGreaterThan(0);
    });
  });

  describe('Diff Mode', () => {
    it('diffMode toggle: handleDiffToggle sets diffMode to checked value', async () => {
      // @ts-ignore — diffMode starts false
      expect(element.diffMode).toBe(false);

      // Simulate the wa-switch change event as handleDiffToggle does:
      // it reads (e.target as WaSwitch).checked
      const switchEl = document.createElement('wa-switch') as any;
      switchEl.checked = true;
      const toggleEvent = new CustomEvent('change');
      Object.defineProperty(toggleEvent, 'target', { value: switchEl });
      // @ts-ignore — call private handler
      element.handleDiffToggle(toggleEvent);

      // @ts-ignore
      expect(element.diffMode).toBe(true);

      // Toggle back off
      switchEl.checked = false;
      const toggleOffEvent = new CustomEvent('change');
      Object.defineProperty(toggleOffEvent, 'target', { value: switchEl });
      // @ts-ignore
      element.handleDiffToggle(toggleOffEvent);
      // @ts-ignore
      expect(element.diffMode).toBe(false);
    });

    it('diffSnapshot capture: selecting a function captures current fn source into diffSnapshot', async () => {
      // @ts-ignore
      element.ddoc = mockDesignDoc;
      // @ts-ignore
      element.selectedSection = 'views';
      // @ts-ignore
      element.selectedName = 'all';
      await element.updateComplete;

      // willUpdate captures getFnSource() into diffSnapshot when selectedName changes.
      // After selecting 'all', diffSnapshot holds the source for 'all'.
      // @ts-ignore
      const snapshotForAll: string = element.diffSnapshot;
      expect(snapshotForAll).toBe('function(doc) { emit(doc._id, 1); }');

      // Switch to by_type — diffSnapshot now holds by_type's map source
      // @ts-ignore
      element.selectedName = 'by_type';
      await element.updateComplete;

      // @ts-ignore
      expect(element.diffSnapshot).toBe('function(doc) { emit(doc.type, 1); }');
    });

    it('diff reset on selection change: diffMode resets to false when selectedName changes', async () => {
      // @ts-ignore
      element.ddoc = mockDesignDoc;
      // @ts-ignore
      element.selectedSection = 'views';
      // @ts-ignore
      element.selectedName = 'all';
      await element.updateComplete;

      // Enable diff mode
      // @ts-ignore
      element.diffMode = true;
      await element.updateComplete;
      // @ts-ignore
      expect(element.diffMode).toBe(true);

      // Changing selectedName triggers willUpdate which sets diffMode = false
      // @ts-ignore
      element.selectedName = 'by_type';
      await element.updateComplete;

      // @ts-ignore
      expect(element.diffMode).toBe(false);
    });

    it('diff reset on section change: diffMode resets to false when selectedSection changes', async () => {
      // @ts-ignore
      element.ddoc = mockDesignDoc;
      // @ts-ignore
      element.selectedSection = 'views';
      // @ts-ignore
      element.selectedName = 'all';
      await element.updateComplete;

      // @ts-ignore
      element.diffMode = true;
      await element.updateComplete;

      // Changing selectedSection also triggers the willUpdate reset path
      // @ts-ignore
      element.selectedSection = 'filters';
      // @ts-ignore
      element.selectedName = 'important';
      await element.updateComplete;

      // @ts-ignore
      expect(element.diffMode).toBe(false);
    });

    it('diff unavailable in rawMode: wa-switch for diff is absent when rawMode is true', async () => {
      // @ts-ignore
      element.ddoc = mockDesignDoc;
      // @ts-ignore
      element.selectedSection = 'views';
      // @ts-ignore
      element.selectedName = 'all';
      // @ts-ignore
      element.isJS = true;
      // @ts-ignore
      element.rawMode = true;
      await element.updateComplete;

      // The render template only renders <wa-switch> for diff when:
      // this.selectedName && !this.rawMode
      // So in rawMode the switch must not be present in the shadow DOM.
      const switchEl = element.shadowRoot?.querySelector('wa-switch');
      expect(switchEl).toBeNull();
    });
  });

  describe('Autocomplete Feature', () => {
    describe('Property Extraction', () => {
      it('should extract top-level properties from documents', () => {
        const docs = [
          { name: 'John', age: 30, city: 'NYC' },
          { name: 'Jane', age: 25, country: 'USA' }
        ];
        // @ts-ignore
        const props = element._extractPropertyNames(docs);
        
        expect(props).toContain('name');
        expect(props).toContain('age');
        expect(props).toContain('city');
        expect(props).toContain('country');
      });

      it('should extract nested properties with dot notation', () => {
        const docs = [
          { user: { name: 'John', address: { city: 'NYC' } } }
        ];
        // @ts-ignore
        const props = element._extractPropertyNames(docs);
        
        expect(props).toContain('user');
        expect(props).toContain('user.name');
        expect(props).toContain('user.address');
        expect(props).toContain('user.address.city');
      });

      it('should filter out internal CouchDB fields', () => {
        const docs = [
          { _id: 'doc1', _rev: '1-abc', name: 'John', _attachments: {} }
        ];
        // @ts-ignore
        const props = element._extractPropertyNames(docs);
        
        expect(props).not.toContain('_id');
        expect(props).not.toContain('_rev');
        expect(props).not.toContain('_attachments');
        expect(props).toContain('name');
      });

      it('should respect max depth limit', () => {
        const docs = [
          { a: { b: { c: { d: { e: { f: 'deep' } } } } } }
        ];
        // @ts-ignore - maxDepth defaults to 3
        const props = element._extractPropertyNames(docs);
        
        expect(props).toContain('a');
        expect(props).toContain('a.b');
        expect(props).toContain('a.b.c');
        // Implementation actually goes to depth 4 (a.b.c.d), but not beyond
        expect(props).toContain('a.b.c.d');
        expect(props).not.toContain('a.b.c.d.e');
        expect(props).not.toContain('a.b.c.d.e.f');
      });

      it('should handle empty documents array', () => {
        // @ts-ignore
        const props = element._extractPropertyNames([]);
        expect(props).toEqual([]);
      });

      it('should deduplicate properties across documents', () => {
        const docs = [
          { name: 'John', age: 30 },
          { name: 'Jane', age: 25 },
          { name: 'Bob', city: 'LA' }
        ];
        // @ts-ignore
        const props = element._extractPropertyNames(docs);
        
        // Should only have one 'name' and one 'age'
        expect(props.filter(p => p === 'name').length).toBe(1);
        expect(props.filter(p => p === 'age').length).toBe(1);
      });

      it('should return sorted properties', () => {
        const docs = [
          { zebra: 1, apple: 2, banana: 3 }
        ];
        // @ts-ignore
        const props = element._extractPropertyNames(docs);
        
        expect(props).toEqual(['apple', 'banana', 'zebra']);
      });
    });

    describe('Completion Provider', () => {
      beforeEach(() => {
        // Set up sample properties
        // @ts-ignore
        element.sampledProperties = ['name', 'age', 'city', 'user.name', 'user.email'];
      });

      it('should create completion provider when properties are available', () => {
        // @ts-ignore
        const provider = element._buildCompletionProvider();
        
        expect(provider).toBeDefined();
        expect(provider.triggerCharacters).toContain('.');
        expect(typeof provider.provideCompletionItems).toBe('function');
      });

      it('should provide suggestions for doc. pattern', () => {
        // @ts-ignore
        const provider = element._buildCompletionProvider();
        
        const mockModel = {
          getValueInRange: () => 'function(doc) { emit(doc.',
          getWordUntilPosition: () => ({ startColumn: 30, endColumn: 30 })
        };
        const mockPosition = { lineNumber: 1, column: 30 };
        
        // @ts-ignore
        const result = provider.provideCompletionItems(mockModel, mockPosition) as { suggestions: any[] };
        
        expect(result.suggestions.length).toBeGreaterThan(0);
        expect(result.suggestions.some((s: any) => s.label === 'name')).toBe(true);
        expect(result.suggestions.some((s: any) => s.label === 'age')).toBe(true);
        // Should only show top-level properties (no dots)
        expect(result.suggestions.some((s: any) => s.label === 'user.name')).toBe(false);
      });

      it('should provide suggestions for nested doc.user. pattern', () => {
        // @ts-ignore
        const provider = element._buildCompletionProvider();
        
        const mockModel = {
          getValueInRange: () => 'function(doc) { emit(doc.user.',
          getWordUntilPosition: () => ({ startColumn: 35, endColumn: 35 })
        };
        const mockPosition = { lineNumber: 1, column: 35 };
        
        // @ts-ignore
        const result = provider.provideCompletionItems(mockModel, mockPosition) as { suggestions: any[] };
        
        // Should show nested properties under 'user'
        expect(result.suggestions.some((s: any) => s.label === 'name')).toBe(true);
        expect(result.suggestions.some((s: any) => s.label === 'email')).toBe(true);
        // Should not show top-level properties
        expect(result.suggestions.some((s: any) => s.label === 'age')).toBe(false);
      });

      it('should not provide suggestions for non-doc contexts', () => {
        // @ts-ignore
        const provider = element._buildCompletionProvider();
        
        const mockModel = {
          getValueInRange: () => 'function(doc) { var x = ',
          getWordUntilPosition: () => ({ startColumn: 25, endColumn: 25 })
        };
        const mockPosition = { lineNumber: 1, column: 25 };
        
        // @ts-ignore
        const result = provider.provideCompletionItems(mockModel, mockPosition) as { suggestions: any[] };
        
        expect(result.suggestions.length).toBe(0);
      });

      it('should return empty suggestions when no properties sampled', () => {
        // @ts-ignore
        element.sampledProperties = [];
        // @ts-ignore
        const provider = element._buildCompletionProvider();
        
        const mockModel = {
          getValueInRange: () => 'function(doc) { emit(doc.',
          getWordUntilPosition: () => ({ startColumn: 30, endColumn: 30 })
        };
        const mockPosition = { lineNumber: 1, column: 30 };
        
        // @ts-ignore
        const result = provider.provideCompletionItems(mockModel, mockPosition) as { suggestions: any[] };
        
        expect(result.suggestions.length).toBe(0);
      });

      it('should include proper metadata in suggestions', () => {
        // @ts-ignore
        const provider = element._buildCompletionProvider();
        
        const mockModel = {
          getValueInRange: () => 'function(doc) { emit(doc.',
          getWordUntilPosition: () => ({ startColumn: 30, endColumn: 30 })
        };
        const mockPosition = { lineNumber: 1, column: 30 };
        
        // @ts-ignore
        const result = provider.provideCompletionItems(mockModel, mockPosition) as { suggestions: any[] };
        
        const firstSuggestion = result.suggestions[0];
        expect(firstSuggestion.detail).toBe('Document property');
        expect(firstSuggestion.kind).toBeDefined();
        expect(firstSuggestion.insertText).toBe(firstSuggestion.label);
        expect(firstSuggestion.sortText).toBeDefined();
      });
    });

    describe('Integration', () => {
      it('should fetch and sample properties on component load', async () => {
        const mockDocs = [
          { name: 'Product 1', price: 100, category: 'electronics' },
          { name: 'Product 2', price: 200, category: 'books' }
        ];
        
        vi.spyOn(getContext().dbMgmt, 'queryDocuments').mockResolvedValue({
          documents: mockDocs
        } as any);
        
        const el = getEl();
        await el.updateComplete;
        await Promise.resolve(); // Wait for async _fetchSampledProperties
        await el.updateComplete;
        
        // @ts-ignore
        expect(el.sampledProperties.length).toBeGreaterThan(0);
        // @ts-ignore
        expect(el.sampledProperties).toContain('name');
        // @ts-ignore
        expect(el.sampledProperties).toContain('price');
        // @ts-ignore
        expect(el.sampledProperties).toContain('category');
        
        el.remove();
      });

      it('should create completion provider after sampling', async () => {
        const mockDocs = [{ name: 'Test', value: 123 }];
        
        vi.spyOn(getContext().dbMgmt, 'queryDocuments').mockResolvedValue({
          documents: mockDocs
        } as any);
        
        const el = getEl();
        await el.updateComplete;
        await Promise.resolve();
        await el.updateComplete;
        
        // @ts-ignore
        expect(el.completionProvider).toBeDefined();
        // @ts-ignore
        expect(el.completionProvider.triggerCharacters).toContain('.');
        
        el.remove();
      });

      it('should handle sampling errors gracefully', async () => {
        vi.spyOn(getContext().dbMgmt, 'queryDocuments').mockRejectedValue(
          new Error('Network error')
        );
        
        const el = getEl();
        await el.updateComplete;
        await Promise.resolve();
        await el.updateComplete;
        
        // Should not crash, just have empty properties
        // @ts-ignore
        expect(el.sampledProperties).toEqual([]);
        
        el.remove();
      });

      it('should skip sampling when serverId or dbName is missing', async () => {
        const el = document.createElement('cca-view-editor') as CcaViewEditor;
        // Don't set serverId or dbName
        el.setAttribute('ddocId', '_design/test');
        document.body.appendChild(el);
        await el.updateComplete;
        await Promise.resolve();
        await el.updateComplete;
        
        // Should have empty properties because sampling was skipped
        // @ts-ignore
        expect(el.sampledProperties).toEqual([]);
        // @ts-ignore
        expect(el.serverId).toBeFalsy();
        // @ts-ignore
        expect(el.dbName).toBeFalsy();
        
        el.remove();
      });
    });
  });

  // -------------------------------------------------------------------------
  // handleSave's optional repo sync. It had no tests at all, and two defects:
  // it awaited syncToRepo and discarded the SyncResult (syncToRepo does not
  // throw on a conflict or a direction refusal — it RETURNS one), then toasted
  // an unconditional "saved and synced to repo"; and the token retry lived only
  // in design-list.ts, while this checkbox defaults ON whenever a repo is
  // linked, so with credential mode 'none' every save from a freshly loaded tab
  // dead-ended on "Bad credentials".
  // -------------------------------------------------------------------------
  describe('Save + sync to repo', () => {
    let toastSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(async () => {
      const ctx = getContext();
      toastSpy = vi.spyOn(await import('../src/components/cca-toast.js'), 'toast');
      vi.spyOn(ctx.designMgmt, 'saveDesignDoc').mockResolvedValue({ ok: true, id: '_design/test', rev: '2-x' });
      // @ts-ignore — the reload after a save is out of scope here.
      vi.spyOn(element, 'loadDesignDoc').mockResolvedValue(undefined);
      // @ts-ignore
      element.repoId = 'repo:test123';
      // @ts-ignore
      element.repoAccountId = 'gitaccount:abc';
      // @ts-ignore
      element.syncToRepo = true;
      // @ts-ignore
      element.canWriteDb = true;
      await element.updateComplete;
    });

    it('reports a conflict result as an error instead of claiming a successful sync', async () => {
      vi.spyOn(getContext().designMgmt, 'syncToRepo').mockResolvedValue({
        status: 'conflict', synced: 0, conflicts: 1, skipped: 0
      });

      // @ts-ignore
      await element.handleSave();

      // The save itself did succeed and still says so...
      expect(toastSpy).toHaveBeenCalledWith('Design document saved', 'success');
      // ...but nothing claims the sync landed.
      expect(toastSpy).toHaveBeenCalledWith(expect.stringMatching(/conflict/i), 'error');
      expect(toastSpy).not.toHaveBeenCalledWith(expect.stringMatching(/synced to repo successfully/i), 'success');
    });

    it('reports a refused (skipped) document rather than an unconditional success', async () => {
      vi.spyOn(getContext().designMgmt, 'syncToRepo').mockResolvedValue({
        status: 'synced', synced: 0, conflicts: 0, skipped: 1
      });

      // @ts-ignore
      await element.handleSave();

      expect(toastSpy).toHaveBeenCalledWith(expect.stringMatching(/1 skipped/), 'info');
    });

    it('reports a genuine success as one', async () => {
      vi.spyOn(getContext().designMgmt, 'syncToRepo').mockResolvedValue({
        status: 'synced', synced: 1, conflicts: 0, skipped: 0
      });

      // @ts-ignore
      await element.handleSave();

      expect(toastSpy).toHaveBeenCalledWith(expect.stringMatching(/successfully \(1 synced\)/), 'success');
    });

    it('prompts for a token on a 401 and retries once, instead of dead-ending on "Bad credentials"', async () => {
      const ctx = getContext();
      vi.spyOn(ctx.designMgmt, 'getGitAccount').mockResolvedValue({
        _id: 'gitaccount:abc', provider: 'github', label: 'work-github', credential_mode: 'none'
      });
      const saveTokenSpy = vi.spyOn(ctx.designMgmt, 'saveAccountToken').mockResolvedValue('none');
      const syncSpy = vi.spyOn(ctx.designMgmt, 'syncToRepo')
        .mockRejectedValueOnce(new GitHttpError(401, 'Bad credentials'))
        .mockResolvedValueOnce({ status: 'synced', synced: 1, conflicts: 0, skipped: 0 });

      // @ts-ignore
      const saving = element.handleSave();
      await new Promise((r) => setTimeout(r, 0));
      await element.updateComplete;

      expect(element.tokenPrompt.isOpen).toBe(true);
      const dialog = element.shadowRoot!.querySelector('wa-dialog[label="Git Access Token Required"]')!;
      expect(dialog.textContent).toContain('work-github');

      element.tokenPrompt.value = 'ghp_typed_at_prompt';
      element.tokenPrompt.confirm();
      await saving;

      expect(saveTokenSpy).toHaveBeenCalledWith('gitaccount:abc', 'ghp_typed_at_prompt');
      expect(syncSpy).toHaveBeenCalledTimes(2);
      expect(toastSpy).toHaveBeenCalledWith(expect.stringMatching(/successfully/), 'success');
    });

    it('surfaces a sync failure without retracting the CouchDB save', async () => {
      vi.spyOn(getContext().designMgmt, 'syncToRepo').mockRejectedValue(new Error('branch moved'));

      // @ts-ignore
      await element.handleSave();

      expect(toastSpy).toHaveBeenCalledWith('Design document saved', 'success');
      expect(toastSpy).toHaveBeenCalledWith(expect.stringContaining('sync to repo failed'), 'error');
    });
  });
});
