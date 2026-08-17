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

import { html } from 'lit';
import { createRef, Ref, ref } from 'lit/directives/ref.js';
// The API entry, not the package root: `monaco.languages.CompletionItemKind` below is a runtime
// value, so importing `monaco-editor` here would pull the everything-entry — all 80 grammars, every
// contribution — back into the bundle and undo #148 from a file that only wants an enum. What
// registers the editor's features is src/monaco-registrations.ts, imported by cca-monaco-editor.
import * as monaco from 'monaco-editor/editor';

import { CcaElement } from '../../components/cca-element.js';
import { customElement, property, state } from 'lit/decorators.js';
import { toast } from '../../components/cca-toast.js';
import { addHeaderActions, clearHeaderActions } from '../../components/cca-header.js';
import { getContext } from '../../context.js';
import { getLogger } from '../../services/log-service.js';
import { isDatabaseAdmin } from '../../services/db-mgmt-service.js';
import type { CcaMonacoEditor } from '../../components/cca-monaco-editor.js';
import type { TestViewResult } from '../../services/design-mgmt-service.js';
import { GitTokenPrompt, reportSyncToRepoResult } from './git-sync-ui.js';
import '../../components/cca-monaco-editor.js';
import WaCheckbox from '@awesome.me/webawesome/dist/components/checkbox/checkbox.js';
import WaSwitch from '@awesome.me/webawesome/dist/components/switch/switch.js';

const log = getLogger('plugins/design-mgmt/view-editor');

const REDUCE_NONE = '__none__' as const;
const REDUCE_CUSTOM = '__custom__' as const;

const BUILTINS_3X = [
  '_sum',
  '_count',
  '_stats',
  '_approx_count_distinct'
] as const;
const BUILTINS_35 = [
  '_first',
  '_last',
  '_top_1',
  '_top_10',
  '_top_100',
  '_bottom_1',
  '_bottom_10',
  '_bottom_100'
] as const;

function getReduceOptions(couchVersion: string) {
  const [maj, min] = couchVersion.split('.').map((p) => parseInt(p, 10) || 0);
  const has35 = maj > 3 || (maj === 3 && min >= 5);
  return [
    REDUCE_NONE,
    ...BUILTINS_3X,
    ...(has35 ? BUILTINS_35 : []),
    REDUCE_CUSTOM
  ] as const;
}

type DdocView = { map: string; reduce?: string };
type Ddoc = {
  _id?: string;
  _rev?: string;
  views?: Record<string, DdocView>;
  filters?: Record<string, string>;
  lists?: Record<string, string>;
  shows?: Record<string, string>;
  updates?: Record<string, string>;
  validate_doc_update?: string;
  [key: string]: unknown;
};
const SECTION_ORDER = [
  'views',
  'filters',
  'lists',
  'shows',
  'updates',
  'validate'
] as const;
type Section = (typeof SECTION_ORDER)[number];

// ─── Quick-test result state ────────────────────────────────────────────────
// Represents the last run result shown in the inline strip on the Map tab.
//
// `rowCount` rides on every variant, not just `success`: testView's error shapes vary (compile,
// runtime, a broken reduce, a timeout, the in-page fallback's document cap) and a non-null error
// does NOT mean zero rows — a broken reduce still returns the map's rows, and the fallback cap
// returns whatever it managed before capping. Treating error/rows as mutually exclusive would hide
// real output behind an error badge.
type QuickTestState =
  | { status: 'success'; rowCount: number; preview: string }
  | { status: 'warning'; message: string; rowCount: number }
  | { status: 'error'; message: string; rowCount: number };

@customElement('cca-view-editor')
export class CcaViewEditor extends CcaElement {
  private static readonly SECTION_LABELS: Record<Section, string> = {
    views: 'view',
    filters: 'filter',
    lists: 'list',
    shows: 'show',
    updates: 'update',
    validate: 'validate'
  };

  private static readonly SECTION_SIGNATURES: Record<Section, string> = {
    views: 'function(doc)',
    filters: 'function(doc, req)',
    lists: 'function(head, req)',
    shows: 'function(doc, req)',
    updates: 'function(doc, req)',
    validate: 'function(newDoc, oldDoc, userCtx)'
  };

  private static readonly QUICK_TEST_ICONS: Record<QuickTestState['status'], { icon: string; label: string }> = {
    success: { icon: 'circle-check', label: 'Result' },
    warning: { icon: 'triangle-exclamation', label: 'Warning' },
    error: { icon: 'circle-xmark', label: 'Error' }
  };

  @property({ type: String }) serverId = '';
  @property({ type: String }) serverName = '';
  @state() private couchVersion = '';
  @property({ type: String }) dbName = '';
  @property({ type: String }) ddocId = '';
  @state() private repoId: string | null = null;
  /** The git account the linked repository authenticates as — what the token prompt needs to know
   *  whose token to ask for, and under which credential mode to store the answer. */
  @state() private repoAccountId: string | null = null;
  @state() private repoName = '';
  @state() private repoBranch = '';
  @state() private ddoc: Ddoc = {};
  @state() private isJS = false;
  @state() private selectedSection: Section | '' = '';
  @state() private selectedName = '';
  @state() private selectedReduce: string = REDUCE_NONE;
  @state() private rawMode = false;
  @state() private _dirty = false;
  @state() private activeTab: 'map' | 'reduce' | 'test' = 'map';
  @state() private testResult: TestViewResult | null = null;
  @state() private sampleDocs = '[{"_id": "doc1", "name": "Example"}]';
  @state() private saveError: {
    title?: string;
    message: string;
    line?: number;
    functionName?: string;
    errorDetail?: string;
  } | null = null;
  @state() private diffMode = false;
  @state() private diffSnapshot = '';

  @state() private quickTest: QuickTestState | null = null;
  @state() private quickTestRunning = false;

  @state() private syncToRepo = false;
  /**
   * Sync-time token prompt and single retry, shared with `design-list.ts` (see `git-sync-ui.ts`).
   * The whole mechanism used to live in `design-list.ts` alone, while this editor's sync checkbox
   * defaults *on* whenever a repository is linked — so with credential mode `none` (the default,
   * and the recommended one) every save from a freshly loaded tab failed with "Bad credentials"
   * and offered no way to supply the token.
   */
  readonly tokenPrompt = new GitTokenPrompt(this);
  @state() private sampledProperties: string[] = [];
  @state() private completionProvider?: monaco.languages.CompletionItemProvider;
  private editorRef: Ref<CcaMonacoEditor> = createRef();
  private sampleEditorRef: Ref<CcaMonacoEditor> = createRef();
  private _suppressEditorChange = false;

  /** Server admin — the synchronous fast path {@link refreshCanWriteDb} checks before reading
   *  `{db}/_security`; a server admin bypasses every database's security document. Not used
   *  directly to gate anything in this editor — see {@link canWriteDb}. */
  private get isAdmin(): boolean {
    return getContext().auth.isAdmin;
  }

  /**
   * `saveDesignDoc` is a `PUT`, restricted to a *database* admin (named in `{db}/_security.admins`
   * by name or by a shared role) or a server admin — verified live: a plain db member gets 403
   * "You are not a db or server admin.", but a db admin does not. `isAdmin` alone (server-admin
   * only, fix round 1) wrongly locked out a legitimate database admin — CouchDB would have
   * accepted their save. A non-admin/non-db-admin keeps full read access to this editor —
   * browsing functions, running the (client-side, no-CouchDB-write) view tester — but cannot save.
   */
  @state() private canWriteDb = false;

  /**
   * Resolves {@link canWriteDb} once, for this editor's fixed `serverId`/`dbName` (component
   * properties, not expected to change for the component's lifetime). Mirrors
   * `design-list.ts`'s identically-named method; a failed `{db}/_security` read is treated as
   * "cannot confirm, so no" rather than defaulting to permissive.
   */
  private async refreshCanWriteDb(): Promise<void> {
    if (this.isAdmin) {
      this.canWriteDb = true;
      return;
    }
    if (!this.serverId || !this.dbName) {
      this.canWriteDb = false;
      return;
    }
    try {
      const access = await getContext().dbMgmt.listDatabaseAccess(this.serverId, this.dbName);
      const { username, roles } = getContext().auth.state;
      this.canWriteDb = isDatabaseAdmin(access, username, roles);
    } catch (error) {
      log.warn('Could not read database access control; treating as read-only', error instanceof Error ? error : { error });
      this.canWriteDb = false;
    }
  }

  private _beforeUnload = (e: BeforeUnloadEvent) => {
    if (this._dirty) {
      e.preventDefault();
      e.returnValue = true;
      return true;
    }
  };

  async connectedCallback() {
    super.connectedCallback();
    window.addEventListener('beforeunload', this._beforeUnload);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener('beforeunload', this._beforeUnload);
    clearHeaderActions();
  }

  private handleDiffToggle(e: CustomEvent) {
    const checked = (e.target as WaSwitch).checked;
    this.diffMode = checked;
  }

  private getSections(): Array<{
    section: Section;
    label: string;
    fns: string[];
  }> {
    const out: Array<{ section: Section; label: string; fns: string[] }> = [];
    const add = (section: Section, label: string, keys: string[]) => {
      if (keys.length) out.push({ section, label, fns: keys });
    };
    add('views', 'VIEWS', Object.keys(this.ddoc.views ?? {}));
    add('filters', 'FILTERS', Object.keys(this.ddoc.filters ?? {}));
    add('lists', 'LISTS', Object.keys(this.ddoc.lists ?? {}));
    add('shows', 'SHOWS', Object.keys(this.ddoc.shows ?? {}));
    add('updates', 'UPDATES', Object.keys(this.ddoc.updates ?? {}));
    if (this.ddoc.validate_doc_update)
      add('validate', 'VALIDATE', ['validate_doc_update']);
    return out;
  }

  private getFnSource(): string {
    if (!this.selectedSection || !this.selectedName) return '';
    if (this.selectedSection === 'views') {
      const view = this.ddoc.views?.[this.selectedName];
      if (this.activeTab === 'reduce') {
        // Return reduce function if it's a string, empty if it's a built-in or none
        const reduce = view?.reduce;
        return typeof reduce === 'string' ? reduce : '';
      }
      return view?.map ?? '';
    }
    if (this.selectedSection === 'validate')
      return (this.ddoc.validate_doc_update as string) ?? '';
    return (this.ddoc as any)[this.selectedSection]?.[this.selectedName] ?? '';
  }

  private setFnSource(src: string) {
    const ddoc = { ...this.ddoc };
    if (this.selectedSection === 'views') {
      const currentView = ddoc.views?.[this.selectedName] || { map: '' };
      if (this.activeTab === 'reduce') {
        // Update reduce function, preserve map
        ddoc.views = {
          ...ddoc.views,
          [this.selectedName]: { 
            map: currentView.map || '',
            reduce: src 
          }
        };
      } else {
        // Update map function, preserve reduce if it exists
        ddoc.views = {
          ...ddoc.views,
          [this.selectedName]: { 
            ...currentView,
            map: src 
          }
        };
      }
    } else if (this.selectedSection === 'validate') {
      ddoc.validate_doc_update = src;
    } else if (this.selectedSection) {
      (ddoc as any)[this.selectedSection] = {
        ...(ddoc as any)[this.selectedSection],
        [this.selectedName]: src
      };
    }
    this.ddoc = ddoc;
    this._dirty = true;
    // Editing the function invalidates the previous quick-test result.
    this.quickTest = null;
  }

  private selectFn(section: Section, name: string) {
    this.selectedSection = section;
    this.selectedName = name;
  }

  private sectionBadgeLabel(section: Section): string {
    return CcaViewEditor.SECTION_LABELS[section];
  }

  private fnSignature(section: Section): string {
    return CcaViewEditor.SECTION_SIGNATURES[section];
  }

  private handleDeleteFunction() {
    if (!this.selectedSection || !this.selectedName) return;

    const ddoc = { ...this.ddoc };

    if (this.selectedSection === 'validate') {
      delete ddoc.validate_doc_update;
    } else {
      const section = (ddoc as any)[this.selectedSection];
      if (section) {
        delete section[this.selectedName];
        if (Object.keys(section).length === 0) {
          delete (ddoc as any)[this.selectedSection];
        }
      }
    }

    this.ddoc = ddoc;
    this._dirty = true;
    this.quickTest = null;

    const sections = this.getSections();
    if (sections.length > 0 && sections[0].fns.length > 0) {
      this.selectFn(sections[0].section, sections[0].fns[0]);
    } else {
      this.selectedSection = '';
      this.selectedName = '';
    }

    toast('Function deleted', 'info');
  }

  private _serverCacheKey(): string {
    return `server_info_${this.serverId}`;
  }

  /**
   * Versioned (`v2`) because the cached shape gained `repoAccountId`: without the bump, a tab that
   * had already cached the old shape would carry a null account id for the rest of the session,
   * and the save-time token prompt has nothing to ask about without it.
   */
  private _repoCacheKey(): string {
    return `repo_info_v2_${this.serverId}_${this.dbName}`;
  }

  private handleAddFunction(
    type: 'views' | 'filters' | 'updates' | 'validate'
  ) {
    const ddoc = { ...this.ddoc };
    if (type === 'validate') {
      if (ddoc.validate_doc_update) {
        toast('validate_doc_update already exists', 'info');
        return;
      }
      ddoc.validate_doc_update =
        "function(newDoc, oldDoc, userCtx) {\n  // throw { forbidden: 'message' };\n}";
      this.ddoc = ddoc;
      this._dirty = true;
      this.selectFn('validate', 'validate_doc_update');
    } else {
      const base =
        type === 'views'
          ? 'new_view'
          : type === 'filters'
            ? 'new_filter'
            : 'new_update';
      const existing = Object.keys((ddoc as any)[type] ?? {});
      let name = base;
      let i = 1;
      while (existing.includes(name)) name = `${base}_${i++}`;
      const stub =
        type === 'views'
          ? { map: 'function(doc) {\n  emit(doc._id, null);\n}' }
          : type === 'filters'
            ? 'function(doc, req) {\n  return true;\n}'
            : "function(doc, req) {\n  // modify doc\n  return [doc, 'ok'];\n}";
      (ddoc as any)[type] = { ...((ddoc as any)[type] ?? {}), [name]: stub };
      this.ddoc = ddoc;
      this._dirty = true;
      this.selectFn(type, name);
    }
  }

  /** Adding a function is only ever useful if the result can be saved — same gate as Save. */
  private _renderAddFunctionControl() {
    if (!this.canWriteDb) {
      return html`<span class="ve-readonly-note">Read-only</span>`;
    }
    return html`
      <wa-dropdown style="width: 100%;" placement="top">
        <wa-button slot="trigger" size="s" appearance="filled-outlined" style="width: 100%;"
          >+ Add function</wa-button
        >
        <wa-dropdown-item @click=${() => this.handleAddFunction('views')}>View</wa-dropdown-item>
        <wa-dropdown-item @click=${() => this.handleAddFunction('filters')}
          >Filter</wa-dropdown-item
        >
        <wa-dropdown-item @click=${() => this.handleAddFunction('updates')}
          >Update</wa-dropdown-item
        >
        <wa-dropdown-item @click=${() => this.handleAddFunction('validate')}
          >Validate</wa-dropdown-item
        >
      </wa-dropdown>
    `;
  }

  firstUpdated() {
    super.firstUpdated(new Map());

    void this.refreshCanWriteDb();

    // Load server info with caching
    if (this.serverId) {
      const cacheKey = this._serverCacheKey();
      const cached = sessionStorage.getItem(cacheKey);

      if (cached) {
        try {
          const { serverName, couchVersion } = JSON.parse(cached);
          this.serverName = serverName;
          this.couchVersion = couchVersion;
        } catch (e) {
          log.error('Failed to parse cached server info', e as Error);
          sessionStorage.removeItem(cacheKey);
        }
      } else {
        getContext()
          .serverMgmt.getServer(this.serverId)
          .then((raw) => {
            const server = typeof raw === 'string' ? JSON.parse(raw) : raw;
            if (!this.serverName)
              this.serverName = server.name || this.serverId;
            this.couchVersion = server.couch_version ?? '';
            sessionStorage.setItem(
              cacheKey,
              JSON.stringify({
                serverName: this.serverName,
                couchVersion: this.couchVersion
              })
            );
          })
          .catch((error) =>
            toast(`Failed to load server info: ${error}`, 'error')
          );
      }
    }

    // Load repo info with caching
    if (this.serverId && this.dbName) {
      const repoCacheKey = this._repoCacheKey();
      const cachedRepo = sessionStorage.getItem(repoCacheKey);

      if (cachedRepo) {
        try {
          const { repoId, repoName, repoBranch, repoAccountId } = JSON.parse(cachedRepo);
          // Invalidate cache if repo ID uses old colon format
          if (repoId && repoId.includes('repo:')) {
            sessionStorage.removeItem(repoCacheKey);
            throw new Error('Stale cache with old repo ID format');
          }
          this.repoId = repoId;
          this.repoName = repoName ?? '';
          this.repoBranch = repoBranch;
          this.repoAccountId = repoAccountId ?? null;
          if (this.repoId) {
            this.syncToRepo = true;
          }
          // If repoName is missing, invalidate cache and refetch
          if (!repoName && this.repoId) {
            sessionStorage.removeItem(repoCacheKey);
            getContext()
              .designMgmt.getRepo(this.serverId, this.dbName)
              .then(({ repo }) => {
                if (repo) {
                  this.repoName = repo.name ?? '';
                  this.repoAccountId = repo.account_id ?? null;
                  sessionStorage.setItem(
                    repoCacheKey,
                    JSON.stringify({
                      repoId: this.repoId,
                      repoName: this.repoName,
                      repoBranch: this.repoBranch,
                      repoAccountId: this.repoAccountId
                    })
                  );
                }
              })
              .catch(() => {});
          }
        } catch (e) {
          log.error('Failed to parse cached repo info', e as Error);
          sessionStorage.removeItem(repoCacheKey);
          // Fetch fresh data after cache invalidation
          this._fetchRepoInfo(repoCacheKey);
        }
      } else {
        this._fetchRepoInfo(repoCacheKey);
      }
    }

    this.loadDesignDoc();
    this._fetchSampledProperties();
  }

  private _updateHeaderActions() {
    // Lit keeps updating disconnected elements and the header action API is a
    // global singleton — a stale loadDesignDoc continuation resolving after
    // navigation must not clobber the next page's actions (#792).
    if (!this.isConnected) return;
    clearHeaderActions();
    
    if (!this.isJS) return;
    
    addHeaderActions([
      {
        icon: this.rawMode ? 'list' : 'code',
        tooltip: this.rawMode ? 'Switch to Structured View' : 'Switch to Raw JSON',
        label: this.rawMode ? 'Structured' : 'Raw JSON',
        action: () => {
          this.rawMode = !this.rawMode;
          this._updateHeaderActions();
        }
      }
    ]);
  }

  private async _fetchSampledProperties() {
    log.info(`_fetchSampledProperties called. serverId: ${this.serverId}, dbName: ${this.dbName}`);
    
    if (!this.serverId || !this.dbName) {
      log.info('Skipping property sampling: missing serverId or dbName');
      return;
    }

    try {
      log.info('Fetching documents for property sampling...');
      const resp = await getContext().dbMgmt.queryDocuments(
        this.serverId,
        this.dbName,
        {
          selector: { selector: { _id: { $gt: null } } },
          scope: 'full',
          limit: 100
        }
      );
      const docs = (resp.documents ?? []) as Record<string, unknown>[];
      log.info(`Received ${docs.length} documents from query`);
      
      this.sampledProperties = this._extractPropertyNames(docs);
      this.completionProvider = this._buildCompletionProvider();
      log.info(`✓ Sampled ${this.sampledProperties.length} property names from ${docs.length} documents. Sample: ${this.sampledProperties.slice(0, 10).join(', ')}`);
    } catch (error) {
      log.error('Failed to sample properties for autocomplete', error as Error);
    }
  }

  private _buildCompletionProvider(): monaco.languages.CompletionItemProvider {
    return {
      triggerCharacters: ['.'],
      provideCompletionItems: (model, position) => {
        const textBeforeCursor = model.getValueInRange({
          startLineNumber: position.lineNumber,
          startColumn: 1,
          endLineNumber: position.lineNumber,
          endColumn: position.column
        });

        log.debug('Completion triggered:', {
          textBeforeCursor,
          totalProperties: this.sampledProperties.length,
          sampleProps: this.sampledProperties.slice(0, 5)
        });

        // Don't provide suggestions if we don't have any properties
        if (this.sampledProperties.length === 0) {
          log.debug('No sampled properties available');
          return { suggestions: [] };
        }

        const word = model.getWordUntilPosition(position);
        const range = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn
        };

        // Check if we're after 'doc.' (map function context)
        const docAccessMatch = textBeforeCursor.match(/\bdoc\.(\w*)$/);
        
        let relevantProps = this.sampledProperties;
        let isDocAccess = false;
        
        if (docAccessMatch) {
          isDocAccess = true;
          // After 'doc.', show only top-level properties (no dots)
          relevantProps = this.sampledProperties.filter(prop => !prop.includes('.'));
          log.debug(`Filtered for doc access: ${relevantProps.length} properties`);
        } else {
          // Check for nested property access like 'doc.user.'
          const nestedMatch = textBeforeCursor.match(/\bdoc\.([\w.]+\.)$/);
          if (nestedMatch) {
            isDocAccess = true;
            const prefix = nestedMatch[1];
            // Show properties that start with this prefix
            relevantProps = this.sampledProperties
              .filter(prop => prop.startsWith(prefix))
              .map(prop => prop.substring(prefix.length))
              .filter(prop => !prop.includes('.')); // Only immediate children
            log.debug(`Filtered for nested access: ${prefix} -> ${relevantProps.length} properties`);
          }
        }

        // Only provide our suggestions when we detect doc access
        if (!isDocAccess) {
          log.debug('Not in doc access context, skipping suggestions');
          return { suggestions: [] };
        }

        const suggestions: monaco.languages.CompletionItem[] = relevantProps.map(
          (prop, index) => ({
            label: prop,
            kind: monaco.languages.CompletionItemKind.Field,
            detail: 'Document property',
            insertText: prop,
            range,
            sortText: ` ${prop}`, // Space sorts before any letter
            filterText: prop,
            preselect: index === 0 // Preselect first suggestion
          })
        );

        log.debug(`Returning ${suggestions.length} suggestions`);
        return { suggestions };
      }
    };
  }

  private _extractPropertyNames(
    docs: Record<string, unknown>[],
    maxDepth = 3
  ): string[] {
    const properties = new Set<string>();
    const internalFields = new Set([
      '_id',
      '_rev',
      '_attachments',
      '_revisions',
      '_deleted',
      '_deleted_conflicts',
      '_conflicts',
      '_local_seq',
      '_seq',
      '_purge_seq',
      '_replication_id',
      '_replication_state',
      '_replication_state_time',
      '_replication_stats',
      '_replication_reason'
    ]);

    const traverse = (obj: unknown, path: string, depth: number) => {
      if (depth > maxDepth || obj === null || typeof obj !== 'object') return;

      for (const [key, value] of Object.entries(obj)) {
        const fullPath = path ? `${path}.${key}` : key;

        if (!internalFields.has(key)) {
          properties.add(fullPath);
        }

        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
          traverse(value, fullPath, depth + 1);
        }
      }
    };

    for (const doc of docs) {
      if (doc && typeof doc === 'object') {
        traverse(doc, '', 0);
      }
    }

    return Array.from(properties).sort();
  }

  private _fetchRepoInfo(repoCacheKey: string) {
    getContext()
      .designMgmt.getRepo(this.serverId, this.dbName)
      .then(({ repo }) => {
        if (repo) {
          this.repoId = repo._id ?? null;
          this.repoName = repo.name ?? '';
          this.repoAccountId = repo.account_id ?? null;
          // Branch rides on the sync targets, one per (server, database) pair — a repo tracking
          // more than one database has more than one target, so the FIRST one is only ever
          // correct by coincidence. Match on this editor's own (serverId, dbName) instead.
          const matchingTarget = repo.sync_targets?.find(
            (t) => t.server_id === this.serverId && t.db_name === this.dbName
          );
          this.repoBranch = matchingTarget?.branch ?? '';
          if (this.repoId) {
            this.syncToRepo = true;
          }
          sessionStorage.setItem(
            repoCacheKey,
            JSON.stringify({
              repoId: this.repoId,
              repoName: this.repoName,
              repoBranch: this.repoBranch,
              repoAccountId: this.repoAccountId
            })
          );
        }
      })
      .catch((error) => {
        log.debug('No repo configured for this database', error);
      });
  }

  private getEditorValue(): string {
    if (this.rawMode) {
      return JSON.stringify(this.ddoc, null, 2);
    }
    return this.getFnSource();
  }

  private getEditorLanguage(): string {
    return this.rawMode ? 'json' : 'javascript';
  }

  private handleEditorChange(e: CustomEvent) {
    if (this._suppressEditorChange) return;
    const src = e.detail.value;
    this._dirty = true;
    if (this.rawMode || !this.isJS) {
      // Sync raw JSON edits back to structured view
      try {
        const parsed = JSON.parse(src);
        this.ddoc = parsed;
      } catch (error) {
        // Invalid JSON - don't update ddoc, user is still editing
      }
    } else {
      this.setFnSource(src);
    }
  }

  private parseCompilationError(detail: string): {
    message: string;
    line?: number;
    functionName?: string;
  } {
    const lineMatch = detail.match(/Line (\d+): ([^"]+)/);
    const fnMatch = detail.match(
      /in the '([^']+)' (view|filter|update|list|show)/
    );

    return {
      message: lineMatch ? lineMatch[2] : detail,
      line: lineMatch ? parseInt(lineMatch[1]) : undefined,
      functionName: fnMatch ? fnMatch[1] : undefined
    };
  }

  private async loadDesignDoc() {
    if (this.ddocId === '_new') {
      this.ddoc = { _id: '_design/' };
      this.isJS = true; // New design docs default to JS since that's more common and the editor is optimized for it
      this._updateHeaderActions();
      return;
    }
    try {
      const raw = await getContext().designMgmt.getDesignDoc(
        this.serverId,
        this.dbName,
        this.ddocId
      );
      this.ddoc = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Ddoc;
      this.isJS = !this.ddoc.language || this.ddoc.language === 'javascript';
      const sections = this.getSections();
      if (sections.length)
        this.selectFn(sections[0].section, sections[0].fns[0]);
      this._dirty = false;
      this._updateHeaderActions();
    } catch (error) {
      log.error('Failed to load design doc', error as Error);
      toast('Failed to load design document', 'error');
    }
  }

  willUpdate(changedProperties: Map<string, unknown>) {
    super.willUpdate(changedProperties);

    if (changedProperties.has('rawMode')) {
      this._updateHeaderActions();
    }

    if (
      changedProperties.has('selectedName') &&
      this.selectedSection === 'views'
    ) {
      this.selectedReduce =
        this.ddoc.views?.[this.selectedName]?.reduce ?? REDUCE_NONE;
    }

    if (
      changedProperties.has('selectedName') ||
      changedProperties.has('selectedSection')
    ) {
      this.activeTab = 'map';
      this.quickTest = null;

      this.diffMode = false;
      // Capture snapshot when switching to a different function
      this.diffSnapshot = this.getFnSource();
    }

    // When switching between map/reduce tabs, update the editor content
    if (changedProperties.has('activeTab') && this.selectedSection === 'views') {
      this._suppressEditorChange = true;
      // Update editor value on next tick to avoid conflicts
      setTimeout(() => {
        if (this.editorRef.value) {
          this.editorRef.value.setValue(this.getFnSource());
        }
        this._suppressEditorChange = false;
      }, 0);
    }
  }

  // ── Full test (Test tab) ──────────────────────────────────────────────────
  /** The view's stored `reduce`, if it is a custom function or a builtin name (`_count`/`_sum`/
   *  `_stats`/...) — anything else (unset, or the sentinel `REDUCE_NONE`/`REDUCE_CUSTOM` values
   *  the reduce-picker itself uses, never persisted onto the doc) means "no reduce". */
  private getReduceFunctionSource(): string | null {
    const reduce = this.ddoc.views?.[this.selectedName]?.reduce;
    return typeof reduce === 'string' ? reduce : null;
  }

  private async handleTest() {
    if (this.selectedSection !== 'views' || !this.selectedName) {
      toast('Please select a view to test', 'error');
      return;
    }

    try {
      const mapFn = this.ddoc.views?.[this.selectedName]?.map || '';
      const sampleDocs = JSON.parse(this.sampleDocs);
      this.testResult = await getContext().designMgmt.testView({
        map_function: mapFn,
        reduce_function: this.getReduceFunctionSource(),
        sample_docs: sampleDocs
      });
    } catch (error) {
      log.error('Failed to test view', error as Error);
      toast(
        `Failed to test view: ${error instanceof Error ? error.message : String(error)}`,
        'error'
      );
    }
  }

  // ── Quick test (Map tab strip) ────────────────────────────────────────────
  // Runs the same backend call as handleTest but stores the result in
  // quickTest so it can be shown as the inline strip without switching tabs.
  private async handleQuickTest() {
    if (this.selectedSection !== 'views' || !this.selectedName) return;

    this.quickTestRunning = true;
    this.quickTest = null;

    try {
      const mapFn = this.ddoc.views?.[this.selectedName]?.map || '';
      const sampleDocs = JSON.parse(this.sampleDocs);
      const result = await getContext().designMgmt.testView({
        map_function: mapFn,
        reduce_function: this.getReduceFunctionSource(),
        sample_docs: sampleDocs
      });

      // Mirror the result into the full test state as well so the Test tab
      // is already populated if the user switches to it.
      this.testResult = result;

      if (result.error) {
        // A non-null error does not mean zero rows: a broken reduce still returns the map's rows,
        // and the in-page fallback's document cap returns whatever it computed before capping —
        // both keep rows > 0 alongside `error`. Whether rows survived, not the error text, decides
        // warning vs. error: something still worked vs. nothing did.
        const rowCount = result.rows?.length ?? 0;
        this.quickTest =
          rowCount > 0
            ? { status: 'warning', message: result.error, rowCount }
            : { status: 'error', message: result.error, rowCount };
      } else {
        const rows = result.rows ?? [];
        const preview =
          rows.length > 0
            ? JSON.stringify(rows[0]).slice(0, 80) +
              (JSON.stringify(rows[0]).length > 80 ? '…' : '')
            : '(no rows emitted)';
        this.quickTest = {
          status: 'success',
          rowCount: rows.length,
          preview
        };
      }
    } catch (error) {
      // Reached only when JSON.parse(this.sampleDocs) itself throws — testView/runViewIsolated is
      // documented to never reject. No rows were ever produced.
      this.quickTest = {
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
        rowCount: 0
      };
    } finally {
      this.quickTestRunning = false;
    }
  }

  private handleBack() {
    const serverId = encodeURIComponent(this.serverId || '$all');
    const dbParam = this.dbName ? `?database=${encodeURIComponent(this.dbName)}` : '';
    getContext().router.navigate(`/design-docs/${serverId}${dbParam}`);
  }

  private async handleSave() {
    try {
      let body: Ddoc;
      if (this.rawMode || !this.isJS) {
        const editorVal = this.editorRef.value?.getValue();
        if (!editorVal) {
          toast('Editor not ready, please try again', 'info');
          return;
        }
        body = JSON.parse(editorVal);
      } else {
        body = { ...this.ddoc };
      }
      const ddocId =
        this.ddocId === '_new' ? (body._id as string) : this.ddocId;

      if (
        !ddocId ||
        ddocId === '' ||
        ddocId === '_design/' ||
        !ddocId.startsWith('_design/')
      ) {
        toast('No name provided for design document', 'error');
        return;
      }
      await getContext().designMgmt.saveDesignDoc(
        this.serverId,
        this.dbName,
        ddocId,
        body
      );
      this.saveError = null;
      this._dirty = false;
      if (this.syncToRepo && this.repoId) {
        // The save itself is reported on its own, and first: it genuinely succeeded, whatever the
        // sync goes on to say. What follows must not vouch for it, nor it for the sync.
        toast('Design document saved', 'success');
        const repoId = this.repoId;
        try {
          const docKey = `${this.serverId}|${this.dbName}|${ddocId}`;
          // syncToRepo does NOT throw on a conflict or a direction refusal — it returns
          // {status: 'conflict', …} or counts the doc in `skipped`. Discarding the result and
          // toasting an unconditional "saved and synced to repo" claimed a success this code had
          // no way of knowing it had achieved. Wrapped in the token prompt for the same reason
          // design-list's sync is: this checkbox defaults ON whenever a repo is linked, and a
          // credential-mode-'none' account has no token at all on a freshly loaded tab.
          const result = await this.tokenPrompt.run(this.repoAccountId, () =>
            getContext().designMgmt.syncToRepo(repoId, this.dbName, { docs: [docKey] })
          );
          reportSyncToRepoResult(result);
        } catch (error: any) {
          toast(
            `Saved to CouchDB but sync to repo failed: ${error?.message ?? error}`,
            'error'
          );
        }
      } else {
        toast('Design document saved', 'success');
      }

      // Reload to get updated _rev and avoid conflicts, preserving current selection
      if (this.ddocId === '_new') {
        // Transition out of "new doc" mode so loadDesignDoc fetches the
        // persisted document instead of reinitializing an empty template.
        this.ddocId = ddocId;
      }
      const currentSection = this.selectedSection;
      const currentName = this.selectedName;
      await this.loadDesignDoc();
      if (currentSection && currentName) {
        this.selectFn(currentSection, currentName);
      }
    } catch (error: any) {
      const body = error?.body || {};
      const title = body?.title;
      const mainMessage = body?.detail || error?.message || 'Save failed';
      const parsed = this.parseCompilationError(mainMessage);
      const detailedError = body?.errors?.[0]?.message || body?.detail;

      this.saveError = { title, ...parsed, errorDetail: detailedError };
      toast('Save failed - see error details below', 'error');
    }
  }

  // ── Render helpers ────────────────────────────────────────────────────────

  /**
   * Renders the inline quick-test strip shown at the bottom of the Map editor.
   * Three visual states: success (dark, green text), warning (dark, amber),
   * error (red-tinted, red text). The strip also carries the persistent
   * "preview only" note so it is always visible when a result exists.
   */
  private renderQuickTestStrip() {
    const qt = this.quickTest;

    if (!qt) {
      return '';
    }

    const isSuccess = qt.status === 'success';

    return html`
      <div class="ve-quick-strip ve-quick-strip--${qt.status}">
        <span class="ve-quick-strip__label">
          ${this._renderQuickTestState()}
        </span>

        <span class="ve-quick-strip__content">
          ${isSuccess
            ? (qt as Extract<QuickTestState, { status: 'success' }>).preview
            : (qt as Extract<QuickTestState, { status: 'warning' | 'error' }>)
                .message}
        </span>

        ${this._renderQuickTestPreview()}

        <button
          class="ve-quick-strip__link"
          @click=${() => (this.activeTab = 'test')}
        >
          full test →
        </button>
      </div>
    `;
  }

  private get _tooltipContent() {
    return this.repoId
      ? `Syncs to: ${this.repoName} (${this.repoBranch})`
      : 'No repository configured';
  }

  private _renderDdocNameField() {
    if (this.ddocId === '_new') {
      return html`<span style="font-weight:var(--wa-font-weight-normal);color:var(--wa-color-text-normal)"
            >_design/</span
          ><input
            class="ve-ddoc-input"
            placeholder="document-name"
            .value=${(this.ddoc._id ?? '').replace(/^_design\//, '')}
            @input=${(e: Event) => {
              this.ddoc = {
                ...this.ddoc,
                _id: `_design/${(e.target as HTMLInputElement).value}`
              };
              this._dirty = true;
            }}
          />`;
    }
    const ddocName = (this.ddoc._id ?? this.ddocId ?? '').replace(
      /^_design\//,
      '_design/'
    );
    return ddocName;
  }


  private _renderQuickTestState() {
    const qt = this.quickTest;
    if (!qt) return '';

    const { icon, label } = CcaViewEditor.QUICK_TEST_ICONS[qt.status];
    return html`
      <wa-icon name="${icon}" aria-hidden="true"></wa-icon>
      ${label}
    `;
  }

  private _renderQuickTestPreview() {
    const qt = this.quickTest;
    if (!qt) return '';

    // Every variant carries rowCount now — a warning/error with surviving rows says so instead of
    // reading as "nothing came back."
    return html`<span class="ve-quick-strip__meta">
      ${qt.rowCount} row${qt.rowCount !== 1 ? 's' : ''}
    </span>`;
  }

  private _renderSidebarContent() {
    const sections = this.getSections();
    if (sections.length === 0) {
      return html`<div
        style="padding: 1rem 0.75rem; font-size: var(--wa-font-size-s); color: var(--wa-color-text-quiet); line-height: var(--wa-line-height-normal);"
      >
        No functions yet.<br />Use
        <strong>+ Add function</strong> below to get started.
      </div>`;
    }
    return sections.map(
      ({ section, label, fns }) => html`
        <div class="ve-sidebar-section section-${section}">
          <div class="ve-section-header">${label}</div>
          ${fns.map(
            (name) => html`
              <div
                class="ve-fn-item ${this.selectedSection === section &&
                this.selectedName === name
                  ? 'selected'
                  : ''}"
                @click=${() => this.selectFn(section, name)}
              >
                <span class="ve-fn-name">${name}</span>
              </div>
            `
          )}
        </div>
      `
    );
  }

  private _renderViewTabs() {
    if (!this.selectedName || this.rawMode || this.selectedSection !== 'views') {
      return '';
    }
    
    // Only show Reduce tab for custom reduce functions (not built-ins like _sum, _count)
    const reduce = this.ddoc.views?.[this.selectedName]?.reduce;
    const hasCustomReduce = this.selectedReduce === REDUCE_CUSTOM || 
      (this.selectedReduce !== REDUCE_NONE && 
       typeof reduce === 'string' &&
       !reduce.startsWith('_'));
    
    return html`
      <span
        class="ve-tab ${this.activeTab === 'map' ? 'active' : ''}"
        @click=${() => (this.activeTab = 'map')}
        style="cursor: pointer;"
        >Map</span
      >
      ${hasCustomReduce
        ? html`<span
            class="ve-tab ${this.activeTab === 'reduce' ? 'active' : ''}"
            @click=${() => (this.activeTab = 'reduce')}
            style="cursor: pointer;"
            >Reduce</span
          >`
        : ''}
      <span
        class="ve-tab ${this.activeTab === 'test' ? 'active' : ''}"
        @click=${() => (this.activeTab = 'test')}
        style="cursor: pointer;"
        >Test</span
      >
    `;
  }

  private _renderDiffToggle() {
    if (!this.selectedName || this.rawMode) return '';
    return html`
      <wa-switch
        size="s"
        .checked=${this.diffMode}
        @change=${this.handleDiffToggle}
      >
        Show Diff
      </wa-switch>
    `;
  }

  private _renderFunctionHeaderContent() {
    return html`
      <wa-input
        class="ve-fn-name-input"
        size="s"
        ?readonly=${!this.canWriteDb}
        .value=${this.selectedName}
        @change=${(e: Event) => {
          const input = e.target as HTMLInputElement;
          const newName = input.value.trim();
          if (!newName || newName === this.selectedName) return;
          const ddoc = { ...this.ddoc };
          if (this.selectedSection === 'validate') {
            input.value = this.selectedName;
            return;
          }
          const section = this.selectedSection as Exclude<
            Section,
            'validate'
          >;
          const entries = Object.entries(
            (ddoc as any)[section] ?? {}
          );
          const reordered = entries.map(([k, v]) => [
            k === this.selectedName ? newName : k,
            v
          ]);
          (ddoc as any)[section] = Object.fromEntries(reordered);
          this.ddoc = ddoc;
          this._dirty = true;
          this.selectedName = newName;
        }}
      ></wa-input>
      ${this._renderViewTabs()}
      ${this._renderDiffToggle()}
      <span style="flex: 1;"></span>
      ${this.canWriteDb
        ? html`<wa-icon
            class="ve-fn-delete"
            name="trash-can"
            @click=${this.handleDeleteFunction}
            title="Delete function"
          ></wa-icon>`
        : ''}
    `;
  }

  private _renderEmptyFunctionHeader() {
    return html`<span style="color:var(--wa-color-text-quiet)"
      >Select a function from the sidebar</span
    >`;
  }

  private _renderReduceControls() {
    return html`
      <div class="ve-reduce">
        <span class="ve-reduce-label">Reduce</span>
        <wa-select
          size="s"
          name="reduce"
          .value=${this.selectedReduce}
          style="min-width: 160px;"
          @change=${(e: Event) => {
            const val = (e.target as HTMLSelectElement).value;
            this.selectedReduce = val;
            const ddoc = { ...this.ddoc };
            const view = {
              ...ddoc.views?.[this.selectedName]
            } as DdocView;
            if (val === REDUCE_NONE) {
              delete view.reduce;
            } else if (val === REDUCE_CUSTOM) {
              // Initialize with template if empty, otherwise keep existing
              const currentReduce = view.reduce;
              const isEmptyOrBuiltin = !currentReduce || 
                typeof currentReduce === 'string' && currentReduce.startsWith('_');
              
              if (isEmptyOrBuiltin) {
                view.reduce = 'function(keys, values, rereduce) {\n  // TODO: implement custom reduce\n  return null;\n}';
              }
              // Switch to reduce tab
              this.activeTab = 'reduce';
            } else {
              view.reduce = val;
            }
            ddoc.views = {
              ...ddoc.views,
              [this.selectedName]: view
            };
            this.ddoc = ddoc;
            this._dirty = true;
          }}
        >
          ${getReduceOptions(this.couchVersion).map(
            (opt) => html`
              <wa-option value=${opt}>
                ${this._getReduceOptionLabel(opt)}
              </wa-option>
            `
          )}
        </wa-select>
      </div>
      <wa-button
        size="s"
        appearance="filled-outlined"
        variant="neutral"
        ?disabled=${this.quickTestRunning || !this.selectedName}
        @click=${this.handleQuickTest}
      >
        ${this.quickTestRunning
          ? html`<wa-spinner size="s"></wa-spinner>`
          : html`<wa-icon slot="prefix" name="play"></wa-icon>`}
        Run Test
      </wa-button>
    `;
  }

  private _renderEditorContent() {
    if (this.activeTab === 'test' && this.selectedSection === 'views') {
      return this._renderTestTab();
    }
    return this._renderMonacoEditor();
  }

  private _renderTestTab() {
    return html`
      <div class="ve-test-content-inline">
        <div class="ve-test-section-inline">
          <div class="ve-test-section-title">
            Sample Documents (JSON Array)
            <wa-button
              size="s"
              variant="neutral"
              appearance="filled-outlined"
              @click=${this.handleTest}
              ?disabled=${!this.selectedName}
              >Run Test</wa-button
            >
          </div>
          <cca-monaco-editor
            ${ref(this.sampleEditorRef)}
            .value=${this.sampleDocs}
            .language=${'json'}
            @change=${(e: CustomEvent) => {
              this.sampleDocs = e.detail.value;
            }}
          ></cca-monaco-editor>
        </div>

        ${this._renderTestResultsSection()}
      </div>
    `;
  }

  private _renderTestResultsSection() {
    if (!this.testResult) return '';
    return html`
      <div class="ve-test-section-inline">
        <div class="ve-test-section-title">
          Results
          <wa-badge variant="neutral" appearance="accent" pill>
            ${this.testResult.rows?.length ?? 0} rows
          </wa-badge>
        </div>
        ${this.testResult.error
          ? html`<div class="ve-test-errors">
              <div class="ve-test-error">
                ${this.testResult.error}
              </div>
            </div>`
          : ''}
        <pre class="ve-test-results">
${JSON.stringify(this.testResult.rows, null, 2)}</pre
        >
        <div class="ve-test-note">
          <em
            >Runs the actual map (and, if set, reduce) function against the sample documents above,
            in your browser — not against live CouchDB, and never against real data unless you paste
            it in as a sample.</em
          >
        </div>
      </div>
    `;
  }

  private _renderMonacoEditor() {
    const isView = this.selectedSection === 'views';
    const isMapTab = this.activeTab === 'map';

    return html`
      <cca-monaco-editor
        ${ref(this.editorRef)}
        .value=${this.getEditorValue()}
        .language=${this.getEditorLanguage()}
        .diffMode=${this.diffMode && !this.rawMode}
        .originalValue=${this.diffSnapshot}
        .completionProvider=${this.completionProvider}
        .readOnly=${!this.canWriteDb}
        @change=${this.handleEditorChange}
      ></cca-monaco-editor>

      ${isView && !this.rawMode && isMapTab ? this.renderQuickTestStrip() : ''}
    `;
  }

  private _renderSaveErrorPanel() {
    if (!this.saveError) return '';
    return html`
      <div class="ve-error-panel">
        <wa-callout
          variant="danger"
          appearance="filled-outlined"
          closable
          @wa-close=${() => {
            this.saveError = null;
          }}
        >
          <wa-icon slot="icon" name="triangle-exclamation"></wa-icon>
          <div class="ve-error-content">
            <div class="ve-error-message">
              ${this.saveError.title
                ? html`<strong>${this.saveError.title}</strong><br />`
                : ''}
              ${this.saveError.line
                ? html`<strong>Line ${this.saveError.line}:</strong>
                    ${this.saveError.message}`
                : this.saveError.message}
            </div>
            ${this.saveError.functionName
              ? html`<div class="ve-error-meta">
                  Function:
                  <strong>"${this.saveError.functionName}"</strong>
                </div>`
              : ''}
          </div>
        </wa-callout>
      </div>
    `;
  }

  private _getReduceOptionLabel(opt: string): string {
    if (opt === REDUCE_NONE) return '(none)';
    if (opt === REDUCE_CUSTOM) return 'custom\u2026';
    return opt;
  }

  private _renderSaveAction() {
    if (this.canWriteDb) {
      return html`<wa-button size="s" variant="neutral" appearance="accent" @click=${this.handleSave}
        >Save</wa-button
      >`;
    }
    return html`
      <wa-tooltip for="ve-readonly-note"
        >Only a database or server administrator can save design documents.</wa-tooltip
      >
      <span id="ve-readonly-note" class="ve-readonly-note">Read-only</span>
    `;
  }

  private renderHeader() {
    return html`
      <div class="ve-header">
        <div class="ve-breadcrumb">
          ${this._renderDdocNameField()}<span class="sep">·</span
          ><span class="sub">${this.dbName} on ${this.serverName}</span>
        </div>
        <div class="ve-header-actions">${this._renderSaveAction()}</div>
      </div>
    `;
  }

  render() {
    const sections = this.getSections();
    const isView = this.selectedSection === 'views';
    const isMapTab = this.activeTab === 'map';

    // ── Non-JS design docs: minimal layout (header + editor only) ──────────
    if (!this.isJS) {
      return html`
        <style>
          /* shared host/header styles */
          :host {
            display: flex;
            flex-direction: column;
            height: calc(100vh - 200px);
            min-height: 400px;
            border: 1px solid var(--wa-color-border-quiet);
            border-radius: var(--wa-border-radius-m);
            overflow: hidden;
            background: var(--wa-color-surface-default, #fff);
          }
          .ve-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 0.5rem 1rem;
            border-bottom: 1px solid var(--wa-color-border-quiet);
            gap: 1rem;
            flex-shrink: 0;
            background: var(--wa-color-surface-default);
          }
          .ve-breadcrumb {
            font-size: var(--wa-font-size-m);
            font-weight: var(--wa-font-weight-bold);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            color: var(--wa-color-text-normal);
          }
          .ve-breadcrumb .sep {
            font-weight: var(--wa-font-weight-normal);
            color: var(--wa-color-text-quiet);
            margin: 0 0.35rem;
          }
          .ve-breadcrumb .sub {
            font-weight: var(--wa-font-weight-normal);
            color: var(--wa-color-text-quiet);
          }
          .ve-ddoc-input {
            font-size: var(--wa-font-size-m);
            font-weight: var(--wa-font-weight-bold);
            border: none;
            border-bottom: 2px solid var(--wa-color-brand-border-loud);
            background: transparent;
            color: var(--wa-color-text-normal);
            outline: none;
            min-width: 180px;
            padding: 0 0.1rem;
          }
          .ve-header-actions {
            display: flex;
            align-items: center;
            gap: 0.5rem;
            flex-shrink: 0;
          }
          .ve-readonly-note {
            font-size: var(--wa-font-size-s);
            color: var(--wa-color-text-quiet);
          }
          .pre-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 0.25rem 1rem;
            border-bottom: 1px solid var(--wa-color-border-quiet);
            background: var(--wa-color-surface-default);
            color: var(--wa-color-text-normal);
          }
          /* A tooltip is a neutral chip, not a brand surface. The loud neutral tier inverts
             under wa-dark — dark chip / white text becomes light chip / dark text. */
          wa-tooltip::part(body) {
            background: var(--wa-color-neutral-fill-loud);
            color: var(--wa-color-neutral-on-loud);
            font-size: var(--wa-font-size-xs);
          }
          #sync-to-repo-cb {
            font-size: var(--wa-font-size-s);
            color: var(--wa-color-text-normal);
          }
          #sync-to-repo-cb::part(control) {
            border-radius: var(--wa-border-radius-s);
          }
        </style>

        <div class="pre-header">
          <wa-button
            size="s"
            appearance="plain"
            variant="neutral"
            @click=${this.handleBack}
            style="font-size: 0.8125rem"
          >
            <wa-icon name="angle-left"></wa-icon>Back
          </wa-button>
          <wa-checkbox
            id="sync-to-repo-cb"
            size="l"
            .checked=${this.syncToRepo}
            @change=${(e: Event) => {
              this.syncToRepo = (e.target as HTMLInputElement).checked;
            }}
            >Sync to Repo</wa-checkbox
          >
          <wa-tooltip for="sync-to-repo-cb" placement="bottom" without-arrow>
            ${this._tooltipContent}
          </wa-tooltip>
        </div>

        ${this.renderHeader()}

${this.tokenPrompt.render()}

        <cca-monaco-editor
          ${ref(this.editorRef)}
          .value=${JSON.stringify(this.ddoc, null, 2)}
          .language=${'json'}
          .completionProvider=${this.completionProvider}
          .readOnly=${!this.canWriteDb}
          @change=${this.handleEditorChange}
          style="flex: 1; width: 100%; min-height: 300px;"
        ></cca-monaco-editor>
      `;
    }

    // ── JS design docs: full layout ────────────────────────────────────────
    return html`
      <style>
        /* ── Shell ──────────────────────────────────────────────────────── */
        :host {
          display: flex;
          flex-direction: column;
          /* height, not min-height (#88): the non-JS branch above already gets this right.
           * With only a min-height, nothing below ever has to shrink, so map/reduce/test
           * content past the fold grows the whole page instead of scrolling inside
           * .ve-test-content-inline / .ve-editor-area, which are already built with
           * flex: 1; min-height: 0 and overflow: auto for exactly this case — they just
           * never got the chance to engage. */
          height: calc(100vh - 200px);
          border: 1px solid var(--wa-color-border-quiet);
          border-radius: var(--wa-border-radius-m);
          overflow: hidden;
          background: var(--wa-color-surface-default, #fff);
        }
        .doc-editor-main {
          flex: 1;
          min-height: 0;
          border: 1px solid var(--wa-color-border-quiet);
          border-radius: var(--wa-border-radius-m);
          display: flex;
          flex-direction: column;
        }

        /* ── Header ─────────────────────────────────────────────────────── */
        .ve-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0.5rem 1rem;
          border-bottom: 1px solid var(--wa-color-border-quiet);
          gap: 1rem;
          flex-shrink: 0;
          background: var(--wa-color-surface-default);
          color: var(--wa-color-text-normal);
        }
        .ve-breadcrumb {
          font-size: var(--wa-font-size-m);
          font-weight: var(--wa-font-weight-bold);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          color: var(--wa-color-text-normal);
        }
        .ve-breadcrumb .sep {
          font-weight: var(--wa-font-weight-normal);
          color: var(--wa-color-text-quiet);
          margin: 0 0.35rem;
        }
        .ve-breadcrumb .sub {
          font-weight: var(--wa-font-weight-normal);
          color: var(--wa-color-text-quiet);
        }
        .ve-ddoc-input {
          font-size: var(--wa-font-size-m);
          font-weight: var(--wa-font-weight-bold);
          border: none;
          border-bottom: 2px solid var(--wa-color-brand-border-loud);
          background: transparent;
          color: var(--wa-color-text-normal);
          outline: none;
          min-width: 180px;
          padding: 0 0.1rem;
        }
        .ve-header-actions {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          flex-shrink: 0;
        }
        .ve-readonly-note {
          font-size: var(--wa-font-size-s);
          color: var(--wa-color-text-quiet);
        }

        /* ── Body split ─────────────────────────────────────────────────── */
        .ve-body {
          flex: 1;
          min-height: 0;
          --divider-width: 1px;
        }
        .ve-body::part(divider) {
          background-color: var(--wa-color-border-quiet);
        }
        .ve-body::part(panel-start),
        .ve-body::part(panel-end) {
          overflow: hidden;
        }

        /* ── Sidebar ────────────────────────────────────────────────────── */
        .ve-sidebar {
          height: 100%;
          display: flex;
          flex-direction: column;
          overflow: hidden;
          background: var(--wa-color-surface-default);
          color: var(--wa-color-text-normal);
        }
        .ve-sidebar-sections {
          flex: 1;
          overflow-y: auto;
          min-height: 0;
        }
        .ve-sidebar-section {
          border-left: 3px solid transparent;
          margin-left: 0.5rem;
          margin-top: 0.75rem;
        }
        .ve-sidebar-section.section-views {
          border-left-color: var(--wa-color-blue-50);
        }
        .ve-sidebar-section.section-filters {
          border-left-color: var(--wa-color-yellow-60);
        }
        .ve-sidebar-section.section-updates {
          border-left-color: var(--wa-color-red-50);
        }
        .ve-sidebar-section.section-validate {
          border-left-color: var(--wa-color-gray-40);
        }
        .ve-sidebar-section.section-lists {
          border-left-color: var(--wa-color-green-60);
        }
        .ve-sidebar-section.section-shows {
          border-left-color: var(--wa-color-purple-50);
        }

        .ve-section-header {
          font-size: var(--wa-font-size-s);
          font-weight: var(--wa-font-weight-bold);
          padding: 0.25rem 0.75rem;
          color: var(--wa-color-text-normal);
        }
        .ve-fn-item {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0.3rem 0.25rem;
          border-radius: 4px;
          cursor: pointer;
          font-size: var(--wa-font-size-s);
          gap: 0.4rem;
          border-left: 3px solid transparent;
          color: var(--wa-color-text-normal);
        }
        .ve-fn-item:hover {
          background: var(--wa-color-fill-quiet);
        }
        .ve-fn-item.selected {
          background: var(--wa-color-brand-fill-loud);
          color: var(--wa-color-brand-on-loud);
          font-weight: var(--wa-font-weight-bold);
        }
        .ve-fn-name {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          flex: 1;
          min-width: 0;
          padding: 0 0.25rem;
        }
        .ve-sidebar-footer {
          display: flex;
          align-items: center;
          min-height: 40px;
          padding: 0.5rem;
          border-top: 1px solid var(--wa-color-border-quiet);
          background: var(--wa-color-surface-default);
        }
        .ve-sidebar-footer wa-dropdown {
          width: 100%;
        }
        .ve-sidebar-footer wa-dropdown::part(menu) {
          width: 100% !important;
          min-width: 100% !important;
          box-sizing: border-box;
        }
        .ve-sidebar-footer wa-dropdown::part(item) {
          width: 100%;
          box-sizing: border-box;
        }

        /* ── Editor area ────────────────────────────────────────────────── */
        .ve-editor-area {
          flex: 1;
          display: flex;
          flex-direction: column;
          min-width: 0;
          min-height: 0;
          overflow: hidden;
          background: var(--wa-color-surface-default);
        }
        .ve-fn-header {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          padding: 0.35rem 1rem;
          border-bottom: 1px solid var(--wa-color-border-quiet);
          background: var(--wa-color-surface-default);
          color: var(--wa-color-text-normal);
          font-size: var(--wa-font-size-s);
          flex-shrink: 0;
        }
        .ve-fn-delete {
          margin-left: auto;
          cursor: pointer;
          color: var(--wa-color-danger-on-quiet);
          opacity: 0.7;
          transition: opacity 0.15s;
        }
        .ve-fn-delete:hover {
          opacity: 1;
        }

        .ve-fn-name-input {
          font-size: var(--wa-font-size-s);
          font-weight: var(--wa-font-weight-bold);
          border: none;
          border-bottom: 2px solid transparent;
          background: transparent;
          color: var(--wa-color-text-normal);
          outline: none;
          padding: 0 0.1rem;
          min-width: 80px;
          max-width: 200px;
        }
        .ve-fn-sig {
          color: var(--wa-color-text-quiet);
          font-size: var(--wa-font-size-s);
        }
        .ve-tab {
          padding: 0.2rem 0.65rem;
          border-radius: 4px 4px 0 0;
          background: var(--wa-color-surface-raised);
          border: 1px solid var(--wa-color-border-quiet);
          border-bottom: none;
          font-size: var(--wa-font-size-s);
          color: var(--wa-color-text-normal);
          font-weight: var(--wa-font-weight-semibold);
          cursor: pointer;
          transition: all 0.15s ease;
        }
        .ve-tab.active {
          background: var(--wa-color-brand-fill-loud);
          color: var(--wa-color-brand-on-loud);
          border-color: var(--wa-color-brand-border-loud);
        }
        .ve-tab:hover:not(.active) {
          background: var(--wa-color-surface-default);
        }
        .ve-editor-area cca-monaco-editor {
          flex: 1;
          width: 100%;
          min-height: 300px;
        }
        .editor-container {
          flex: 1;
          width: 100%;
          min-height: 300px;
          height: 100%;
          position: relative;
          overflow: hidden;
        }

        .ve-quick-strip {
          display: flex;
          align-items: center;
          gap: 0.625rem;
          min-height: 40px;
          padding: 0.5rem 1rem;
          font-size: var(--wa-font-size-s);
          border-top: 1px solid transparent;
          flex-shrink: 0;
        }
        .ve-quick-strip--success {
          background: var(--wa-color-surface-lowered);
          border-top-color: var(--wa-color-border-quiet);
        }
        .ve-quick-strip--success .ve-quick-strip__label {
          color: var(--wa-color-success-on-normal);
        }
        .ve-quick-strip--success .ve-quick-strip__content {
          font-family: var(--wa-font-family-code);
          color: var(--wa-color-success-on-quiet);
          flex: 1;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .ve-quick-strip--success .ve-quick-strip__meta {
          color: var(--wa-color-text-quiet);
          white-space: nowrap;
          font-size: var(--wa-font-size-xs);
        }
        .ve-quick-strip--warning {
          background: var(--wa-color-warning-fill-quiet);
          border-top-color: var(--wa-color-warning-border-quiet);
        }
        .ve-quick-strip--warning .ve-quick-strip__label {
          color: var(--wa-color-warning-on-normal);
        }
        .ve-quick-strip--warning .ve-quick-strip__content {
          color: var(--wa-color-warning-on-normal);
          flex: 1;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .ve-quick-strip--error {
          background: var(--wa-color-danger-fill-quiet);
          border-top-color: var(--wa-color-danger-border-quiet);
        }
        .ve-quick-strip--error .ve-quick-strip__label {
          color: var(--wa-color-danger-on-normal);
        }
        .ve-quick-strip--error .ve-quick-strip__content {
          color: var(--wa-color-danger-on-normal);
          flex: 1;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .ve-quick-strip__label {
          display: flex;
          align-items: center;
          gap: 0.3rem;
          font-weight: var(--wa-font-weight-semibold);
          white-space: nowrap;
          font-size: var(--wa-font-size-xs);
          text-transform: uppercase;
          letter-spacing: 0.04em;
        }
        .ve-quick-strip__link {
          font-size: var(--wa-font-size-xs);
          color: var(--wa-color-text-link);
          background: none;
          border: none;
          padding: 0;
          cursor: pointer;
          white-space: nowrap;
          text-decoration: none;
        }
        .ve-quick-strip__link:hover {
          text-decoration: underline;
        }

        /* ── Persistent preview footer ───────────────────────────────────── */
        .ve-preview-footer {
          display: flex;
          align-items: center;
          gap: 0.35rem;
          padding: 0.3rem 1rem;
          font-size: var(--wa-font-size-xs);
          color: var(--wa-color-text-quiet);
          border-top: 1px solid var(--wa-color-border-quiet);
          background: var(--wa-color-surface-default);
          flex-shrink: 0;
        }
        .ve-preview-icon {
          font-size: var(--wa-font-size-s);
          opacity: 0.6;
        }

        /* ── Bottom bar ─────────────────────────────────────────────────── */
        .ve-bottom {
          display: flex;
          align-items: center;
          gap: 0.75rem;
          padding: 0.5rem 1rem;
          min-height: 40px;
          border-top: 1px solid var(--wa-color-border-quiet);
          background: var(--wa-color-surface-default);
          color: var(--wa-color-text-normal);
          font-size: var(--wa-font-size-s);
          flex-shrink: 0;
        }
        .ve-reduce {
          display: flex;
          align-items: center;
          gap: 0.4rem;
        }
        .ve-reduce-label {
          color: var(--wa-color-text-quiet);
          white-space: nowrap;
        }
        .ve-spacer {
          flex: 1;
        }

        /* ── Test tab content ───────────────────────────────────────────── */
        .ve-test-content-inline {
          flex: 1;
          display: flex;
          flex-direction: column;
          gap: 1rem;
          padding: 1rem;
          min-width: 0;
          overflow: auto;
          color: var(--wa-color-text-normal);
        }
        .ve-test-section-inline {
          display: flex;
          flex-direction: column;
          gap: 0.5rem;
          min-width: 0;
          overflow: hidden;
        }
        .ve-test-section-title {
          font-size: var(--wa-font-size-s);
          font-weight: var(--wa-font-weight-bold);
          display: flex;
          align-items: center;
          gap: 0.5rem;
          color: var(--wa-color-text-normal);
        }
        .ve-test-section-inline cca-monaco-editor {
          height: 150px !important;
          max-height: 150px !important;
          width: 100%;
          min-width: 0;
          border: 1px solid var(--wa-color-border-quiet);
          border-radius: var(--wa-border-radius-m);
          overflow: hidden;
          flex-shrink: 0;
        }
        .ve-test-results {
          margin: 0;
          padding: 0.75rem;
          background: var(--wa-color-surface-raised);
          border: 1px solid var(--wa-color-border-quiet);
          border-radius: var(--wa-border-radius-m);
          overflow-x: auto;
          font-size: var(--wa-font-size-s);
          max-height: 100px;
          overflow-y: auto;
          color: var(--wa-color-text-normal);
        }
        .ve-test-errors {
          display: flex;
          flex-direction: column;
          gap: 0.5rem;
        }
        .ve-test-error {
          padding: 0.5rem;
          background: var(--wa-color-danger-fill-quiet);
          border: 1px solid var(--wa-color-danger-border-quiet);
          border-radius: var(--wa-border-radius-m);
          color: var(--wa-color-danger-on-quiet);
          font-size: var(--wa-font-size-s);
        }
        .ve-test-note {
          font-size: var(--wa-font-size-xs);
          color: var(--wa-color-text-quiet);
          font-style: italic;
        }

        /* ── Save-error panel ───────────────────────────────────────────── */
        .ve-error-panel {
          flex-shrink: 0;
          padding: 0.75rem 1rem;
        }
        .ve-error-panel wa-callout {
          margin: 0;
        }
        .ve-error-content {
          display: flex;
          flex-direction: column;
          gap: 0.75rem;
        }
        .ve-error-message {
          font-size: var(--wa-font-size-m);
          line-height: var(--wa-line-height-normal);
          color: var(--wa-color-danger-on-quiet);
        }
        .ve-error-meta {
          font-size: var(--wa-font-size-s);
          color: var(--wa-color-text-quiet);
          margin-top: 0.25rem;
        }
        .ve-error-detail {
          background: var(--wa-color-neutral-fill-quiet);
          padding: 0.1rem 0.5rem;
          border-radius: var(--wa-border-radius-m);
          font-family: var(--wa-font-family-code);
          font-size: var(--wa-font-size-xs);
          line-height: var(--wa-line-height-normal);
          white-space: pre-wrap;
          word-break: break-word;
          max-height: 80px;
          overflow-y: auto;
          border: 1px solid var(--wa-color-border-quiet);
        }
        .pre-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 0.25rem 1rem;
          border-bottom: 1px solid var(--wa-color-border-quiet);
          background: var(--wa-color-surface-default);
          color: var(--wa-color-text-normal);
        }
        /* A tooltip is a neutral chip, not a brand surface. The loud neutral tier inverts
           under wa-dark — dark chip / white text becomes light chip / dark text. */
        wa-tooltip::part(body) {
          background: var(--wa-color-neutral-fill-loud);
          color: var(--wa-color-neutral-on-loud);
          font-size: var(--wa-font-size-xs);
        }
        #sync-to-repo-cb {
          font-size: var(--wa-font-size-s);
          color: var(--wa-color-text-normal);
        }
        #sync-to-repo-cb::part(control) {
          border-radius: var(--wa-border-radius-s);
        }
      </style>

      <div class="pre-header">
        <wa-button
          size="s"
          appearance="plain"
          variant="neutral"
          @click=${this.handleBack}
          style="font-size: 0.8125rem"
        >
          <wa-icon name="angle-left"></wa-icon>Back
        </wa-button>
        <wa-checkbox
          id="sync-to-repo-cb"
          size="l"
          .checked=${this.syncToRepo}
          @change=${(e: Event) => {
            this.syncToRepo = (e.target as HTMLInputElement).checked;
          }}
          >Sync to Repo</wa-checkbox
        >
        <wa-tooltip for="sync-to-repo-cb" placement="bottom" without-arrow>
          ${this._tooltipContent}
        </wa-tooltip>
      </div>

      ${this.renderHeader()}

      <!-- Body -->
      <wa-split-panel class="ve-body" position="20">
        <!-- Sidebar -->
        <div slot="start" class="ve-sidebar">
          <div class="ve-sidebar-sections">
            ${this._renderSidebarContent()}
          </div>
          <div class="ve-sidebar-footer">
            ${this._renderAddFunctionControl()}
          </div>
        </div>

        <!-- Editor area -->
        <div slot="end" class="ve-editor-area">
          <!-- Function header with tabs -->
          <div class="ve-fn-header">
            ${this.selectedName ? this._renderFunctionHeaderContent() : this._renderEmptyFunctionHeader()}
          </div>

          <!-- Monaco / Test Content -->
          ${this._renderEditorContent()}

          <!-- Save-error panel -->
          ${this._renderSaveErrorPanel()}

          <!-- Bottom bar -->
          <div class="ve-bottom">
            <span class="ve-spacer"></span>
            ${isView && !this.rawMode ? this._renderReduceControls() : html`<span class="ve-spacer"></span>`}
          </div>
        </div>
      </wa-split-panel>

      ${this.tokenPrompt.render()}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'cca-view-editor': CcaViewEditor;
  }
}
