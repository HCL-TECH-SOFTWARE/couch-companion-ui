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
 * Unit tests for CcaDocEditor component.
 *
 * Tests rendering, create-mode behaviour, save navigation, and server-segment guard.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LitElement } from 'lit';
import { getContext } from '../src/context';

// Prevent monaco-editor from initialising in jsdom (canvas pixel-ratio crash).
// Must be called before importing the component that transitively pulls in Monaco.
vi.mock('../src/components/cca-monaco-editor.js', () => ({}));

import type { CcaDocEditor } from '../src/plugins/db-mgmt/doc-editor.js';
import '../src/plugins/db-mgmt/doc-editor.js';

// ---------------------------------------------------------------------------
// Stub wa-* and cca-* custom elements so the component can render in jsdom
// ---------------------------------------------------------------------------
class WaStubDocEditor extends LitElement {
  createRenderRoot() {
    return this;
  }
}

for (const tag of ['wa-button', 'wa-spinner']) {
  if (!customElements.get(tag)) {
    customElements.define(tag, class extends WaStubDocEditor {});
  }
}

// Register a minimal cca-monaco-editor stub so the component template renders.
// The real cca-monaco-editor is mocked at module level above to prevent
// Monaco's canvas initialisation from crashing in happy-dom.
class CcaMonacoEditorMinStub extends HTMLElement {}
if (!customElements.get('cca-monaco-editor')) {
  customElements.define('cca-monaco-editor', CcaMonacoEditorMinStub);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function createEditor(serverId: string, dbName: string, docId: string): CcaDocEditor {
  const el = document.createElement('cca-doc-editor') as CcaDocEditor;
  // Set properties BEFORE appending so connectedCallback sees them
  el.serverId = serverId;
  el.dbName = dbName;
  el.docId = docId;
  document.body.appendChild(el);
  return el;
}

/**
 * Build a Ref-shaped object whose .value satisfies the getValue() duck-type
 * used by _save(). Using a plain object avoids custom-element registry
 * collisions across test files.
 */
function makeEditorRef(json: string) {
  return {
    value: {
      getValue: () => json,
      format: () => { /* no-op */ },
    },
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
describe('CcaDocEditor', () => {
  let element: CcaDocEditor;

  beforeEach(async () => {
    const ctx = getContext();
    vi.spyOn(ctx.dbMgmt, 'saveDocument').mockResolvedValue({ id: 'new-id', rev: '1-abc' } as any);

    element = createEditor('srv1', 'mydb', 'new');
    await element.updateComplete;
    await Promise.resolve();
    await element.updateComplete;
  });

  afterEach(() => {
    element.remove();
    vi.restoreAllMocks();
  });

  describe('Rendering', () => {
    it('mounts in create mode without error', async () => {
      expect(element).toBeDefined();
      expect(element.shadowRoot).toBeDefined();
    });

    it('renders wa-button elements in the shadow DOM', async () => {
      const buttons = element.shadowRoot!.querySelectorAll('wa-button');
      expect(buttons.length).toBeGreaterThan(0);
    });
  });

  describe('_isCreateMode', () => {
    it('is in create mode when docId is "new" (getDoc not called)', async () => {
      vi.restoreAllMocks();
      const ctx = getContext();
      const getDocSpy = vi.spyOn(ctx.dbMgmt, 'getDoc');
      vi.spyOn(ctx.dbMgmt, 'saveDocument').mockResolvedValue({ id: 'new-id', rev: '1-abc' } as any);

      const el = document.createElement('cca-doc-editor') as CcaDocEditor;
      el.serverId = 'srv1';
      el.dbName = 'mydb';
      el.docId = 'new';
      document.body.appendChild(el);
      await el.updateComplete;
      await Promise.resolve();
      await el.updateComplete;

      expect(getDocSpy).not.toHaveBeenCalled();
      el.remove();
    });

    it('calls getDoc when docId is a real document id', async () => {
      vi.restoreAllMocks();
      const ctx = getContext();
      const getDocSpy = vi.spyOn(ctx.dbMgmt, 'getDoc').mockResolvedValue({ _id: 'doc1', _rev: '1-a' } as any);

      const el2 = createEditor('srv1', 'mydb', 'doc1');
      await el2.updateComplete;
      await Promise.resolve();
      await el2.updateComplete;

      expect(getDocSpy).toHaveBeenCalledWith('srv1', 'mydb', 'doc1');
      el2.remove();
    });
  });

  describe('_save navigation — server-segment URL (#518)', () => {
    it('after _save navigates to /databases/<serverId>/<dbName>/documents', async () => {
      const ctx = getContext();
      const navigateSpy = vi.spyOn(ctx.router, 'navigate');

      // @ts-ignore — inject Ref-shaped object that returns valid JSON
      element._editorRef = makeEditorRef('{"a":1}');

      // @ts-ignore — call private _save
      await element._save();

      expect(ctx.dbMgmt.saveDocument).toHaveBeenCalledWith(
        'srv1',
        'mydb',
        expect.objectContaining({ body: { a: 1 } }),
      );
      expect(navigateSpy).toHaveBeenCalledOnce();
      const url: string = navigateSpy.mock.calls[0][0];
      expect(url).toBe('/databases/srv1/mydb/documents');
    });

    it('does not navigate when editor returns invalid JSON', async () => {
      const ctx = getContext();
      const navigateSpy = vi.spyOn(ctx.router, 'navigate');

      // @ts-ignore
      element._editorRef = makeEditorRef('not-json');

      // @ts-ignore
      await element._save();

      expect(ctx.dbMgmt.saveDocument).not.toHaveBeenCalled();
      expect(navigateSpy).not.toHaveBeenCalled();
    });

    it('uses serverId fallback when _selectedServerId is empty', async () => {
      const ctx = getContext();
      const navigateSpy = vi.spyOn(ctx.router, 'navigate');

      // @ts-ignore — clear internal server selection; serverId remains 'srv1'
      element._selectedServerId = '';

      // @ts-ignore
      element._editorRef = makeEditorRef('{"y":3}');

      // @ts-ignore
      await element._save();

      const url: string = navigateSpy.mock.calls[0][0];
      expect(url).toBe('/databases/srv1/mydb/documents');
    });

    it('falls back to $all when both _selectedServerId and serverId are empty', async () => {
      const ctx = getContext();
      const navigateSpy = vi.spyOn(ctx.router, 'navigate');

      // @ts-ignore — clear both server references
      element._selectedServerId = '';
      element.serverId = '';

      // @ts-ignore
      element._editorRef = makeEditorRef('{"x":2}');

      // @ts-ignore
      await element._save();

      const url: string = navigateSpy.mock.calls[0][0];
      expect(url).toBe('/databases/%24all/mydb/documents');
    });
  });

  describe('Back navigation — server-segment URL (#518)', () => {
    it('Back button falls back to /databases/<serverId>/<dbName>/documents', async () => {
      const ctx = getContext();
      // Back returns the user where they came from (#109); the documents list is
      // only the fallback for a deep link with no in-app history behind it.
      const backSpy = vi.spyOn(ctx.router, 'back').mockImplementation(() => {});

      await element.updateComplete;

      const backBtn = [...element.shadowRoot!.querySelectorAll('wa-button')]
        .find((b) => b.textContent?.includes('Back'));
      expect(backBtn).toBeTruthy();
      (backBtn as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));

      expect(backSpy).toHaveBeenCalledOnce();
      expect(backSpy.mock.calls[0][0]).toBe('/databases/srv1/mydb/documents');
    });
  });
});
