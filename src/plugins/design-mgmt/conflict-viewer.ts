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

import { html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { CcaElement } from '../../components/cca-element.js';
import { getContext } from '../../context.js';
import { getLogger } from '../../services/log-service.js';
import { toast } from '../../components/cca-toast.js';
import type { ConflictVersions } from '../../services/design-mgmt-service.js';
import { UNKNOWN_ERROR, type DesignConflict } from './types.js';

const log = getLogger('plugins/design-mgmt/conflict-viewer');

@customElement('cca-conflict-viewer')
export class CcaConflictViewer extends CcaElement {
  static styles = css`
    :host {
      display: block;
      color: var(--wa-color-text-normal);
    }
    h2 {
      margin: 0 0 1rem;
      font-size: var(--wa-font-size-l);
    }
    /* Danger-panel idiom, matching view-editor.ts .ve-test-error. The explicit
       colour is what keeps the card legible under wa-dark. */
    .conflict {
      padding: 0.75rem;
      border: 1px solid var(--wa-color-danger-border-quiet);
      border-radius: var(--wa-border-radius-m);
      margin-bottom: 0.5rem;
      background: var(--wa-color-danger-fill-quiet);
      color: var(--wa-color-danger-on-quiet);
    }
    /* An acknowledged conflict is still on file (and still unreconciled — resolving is an
       acknowledgment, not a sync), so it stays listed. It must not keep shouting: the danger
       treatment is what made a resolved record indistinguishable from a brand-new one after a
       reload. */
    .conflict.resolved {
      border-color: var(--wa-color-surface-border);
      background: var(--wa-color-surface-lowered);
      color: var(--wa-color-text-quiet);
    }
    .resolved-badge {
      display: inline-block;
      margin-left: 0.5rem;
      padding: 0.05rem 0.4rem;
      border-radius: var(--wa-border-radius-s);
      border: 1px solid var(--wa-color-surface-border);
      background: var(--wa-color-surface-default);
      color: var(--wa-color-text-quiet);
      font-size: var(--wa-font-size-xs);
      text-transform: uppercase;
    }
    .conflict-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .conflict-info {
      font-size: var(--wa-font-size-s);
    }
    .conflict-detail {
      font-size: var(--wa-font-size-xs);
      margin-top: 0.25rem;
    }
    /* Sits on the danger fill, so it must state its own colours rather than
       inherit the card's. */
    button {
      padding: 0.25rem 0.75rem;
      border: 1px solid var(--wa-color-surface-border);
      border-radius: var(--wa-border-radius-m);
      background: var(--wa-color-surface-default);
      color: var(--wa-color-text-normal);
      cursor: pointer;
      font-size: var(--wa-font-size-xs);
    }
    .empty {
      color: var(--wa-color-text-quiet);
    }
    .load-error {
      padding: 0.75rem;
      border: 1px solid var(--wa-color-danger-border-quiet);
      border-radius: var(--wa-border-radius-m);
      background: var(--wa-color-danger-fill-quiet);
      color: var(--wa-color-danger-on-quiet);
    }
    .load-error p {
      margin: 0 0 0.5rem;
      font-size: var(--wa-font-size-s);
    }
    .compare {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 0.5rem;
      margin-top: 0.5rem;
    }
    .compare-side h4 {
      margin: 0 0 0.25rem;
      font-size: var(--wa-font-size-xs);
      color: var(--wa-color-text-quiet);
    }
    .compare-side pre {
      margin: 0;
      padding: 0.5rem;
      max-height: 16rem;
      overflow: auto;
      background: var(--wa-color-surface-lowered);
      border: 1px solid var(--wa-color-surface-border);
      border-radius: var(--wa-border-radius-s);
      font-size: var(--wa-font-size-xs);
      white-space: pre-wrap;
      word-break: break-word;
    }
  `;

  /** Route param (:serverId). Empty or "$all" lists conflicts from every server. */
  @property({ type: String }) serverId = '';

  @state() private conflicts: DesignConflict[] = [];
  @state() private loading = true;
  @state() private loadError: string | null = null;

  /** Which conflict's side-by-side comparison is expanded — at most one at a time. */
  @state() private expandedId: string | null = null;
  /** Fetched (or in-flight/failed) versions for the expanded conflict, keyed by conflict `_id`. */
  @state() private versions: Record<string, ConflictVersions | 'loading' | 'error'> = {};

  private get scopedServerId(): string | undefined {
    const sid = this.serverId.trim();
    return sid && sid !== '$all' ? sid : undefined;
  }

  /**
   * `listConflicts`/`resolveConflict` both go through `couchcompanion`, which is admin-only by
   * CouchDB's own default security (D9) — a non-admin gets a guaranteed 403 from a *read* here,
   * not just from resolving one. In practice a non-admin never sees this page's inbound link
   * (`design-list.ts`'s conflict banner only appears once a doc's git-derived sync state says
   * `conflict`, and that state itself comes from the same admin-only store — see
   * `DesignMgmtService.listDesignDocs`'s comment), but a bookmarked or typed-in URL must still
   * explain the 403 cleanly rather than show a raw error panel.
   */
  private get isAdmin(): boolean {
    return getContext().auth.isAdmin;
  }

  /**
   * CcaElement.connectedCallback is `void` and does router wiring before it
   * gets here, so the load hangs off this extension point rather than an
   * `async connectedCallback` override.
   */
  protected override _onConnect(): void {
    if (this.isAdmin) {
      void this.load();
    } else {
      this.loading = false;
    }
  }

  private async load(): Promise<void> {
    this.loading = true;
    this.loadError = null;
    try {
      this.conflicts = await getContext().designMgmt.listConflicts(this.scopedServerId);
    } catch (error) {
      this.conflicts = [];
      const message = error instanceof Error ? error.message : String(error);
      this.loadError = message || UNKNOWN_ERROR;
      log.error('Failed to load design doc conflicts', error as Error);
    } finally {
      this.loading = false;
    }
  }

  /**
   * Marks one conflict acknowledged and updates the row **in place** rather than removing it.
   *
   * Removing it was a lie that only lasted until the next reload: `listConflicts` returns resolved
   * records too (merely sorted last), and every card rendered identically — danger treatment,
   * "Mark Resolved" button, no resolved indicator — so an acknowledged conflict came back looking
   * brand new. Hiding them instead would create the opposite dead end: the design list's own
   * conflict banner still counts the document (acknowledging a conflict does not reconcile the two
   * sides), so its "Review conflicts" link would land on "no conflicts".
   */
  private async resolve(id: string): Promise<void> {
    try {
      // Reconcile against the document the server acted on, not against `id`.
      const resolved = await getContext().designMgmt.resolveConflict(id);
      this.conflicts = this.conflicts.map(c => (c._id === resolved._id ? resolved : c));
      toast('Conflict marked as resolved', 'success');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const detail = message || UNKNOWN_ERROR;
      toast(`Could not resolve conflict: ${detail}`, 'error');
      log.error('Failed to resolve conflict', error as Error);
    }
  }

  /**
   * Toggles the side-by-side comparison for one conflict — collapsing it if already open,
   * otherwise fetching its two versions (once; a cached result or an in-flight/failed fetch is not
   * re-requested). "Mark Resolved" used to be the only affordance here, offered against a list
   * that (before Task 6) nothing ever populated and (even now) shows only revision/sha identifiers
   * — this is what lets someone actually see what they'd be resolving.
   */
  private async toggleCompare(conflict: DesignConflict): Promise<void> {
    if (this.expandedId === conflict._id) {
      this.expandedId = null;
      return;
    }
    this.expandedId = conflict._id;
    if (this.versions[conflict._id]) return;

    this.versions = { ...this.versions, [conflict._id]: 'loading' };
    try {
      const result = await getContext().designMgmt.getConflictVersions(conflict);
      this.versions = { ...this.versions, [conflict._id]: result };
    } catch (error) {
      log.error('Failed to load conflict versions for comparison', error as Error);
      this.versions = { ...this.versions, [conflict._id]: 'error' };
    }
  }

  private renderSide(label: string, body: Record<string, unknown> | null | undefined) {
    return html`
      <div class="compare-side">
        <h4>${label}</h4>
        <pre>${body ? JSON.stringify(body, null, 2) : '(not available)'}</pre>
      </div>
    `;
  }

  private renderComparison(conflict: DesignConflict) {
    if (this.expandedId !== conflict._id) return '';
    const state = this.versions[conflict._id];
    if (state === 'loading' || state === undefined) {
      return html`<p class="empty">Loading versions…</p>`;
    }
    if (state === 'error') {
      return html`<p class="empty">Could not load one or both versions for comparison.</p>`;
    }
    return html`
      <div class="compare">
        ${this.renderSide('CouchDB', state.couch)} ${this.renderSide('Git', state.git)}
      </div>
    `;
  }

  render() {
    if (!this.isAdmin) {
      return html`
        <h2>Design Doc Conflicts</h2>
        <div class="load-error" data-admin-only>
          <p>
            Conflict records live in <code>couchcompanion</code>, which is admin-only by CouchDB's
            own default security. Sign in as a server administrator to view and resolve conflicts.
          </p>
        </div>
      `;
    }
    return html`
      <h2>Design Doc Conflicts</h2>
      ${this.renderBody()}
    `;
  }

  private renderBody() {
    if (this.loading) {
      return html`<p class="empty">Loading conflicts…</p>`;
    }
    if (this.loadError !== null) {
      return html`
        <div class="load-error" role="alert">
          <p>Could not load conflicts: ${this.loadError}</p>
          <button data-retry @click=${() => void this.load()}>Retry</button>
        </div>
      `;
    }
    if (this.conflicts.length === 0) {
      // `listConflicts` returns acknowledged records too, so an empty list genuinely means "no
      // conflicts on file" — the old "No unresolved conflicts" was false the moment one was.
      return html`<p class="empty">No conflicts recorded.</p>`;
    }
    return this.conflicts.map(c => html`
      <div class="conflict ${c.resolved ? 'resolved' : ''}" ?data-resolved=${c.resolved}>
        <div class="conflict-header">
          <div class="conflict-info">
            <strong>${c.ddoc_id}</strong> in ${c.db_name}
            ${c.resolved ? html`<span class="resolved-badge">Resolved</span>` : ''}
          </div>
          <div>
            <button data-compare @click=${() => void this.toggleCompare(c)}>
              ${this.expandedId === c._id ? 'Hide versions' : 'Compare versions'}
            </button>
            ${c.resolved
              ? ''
              : html`<button data-resolve @click=${() => this.resolve(c._id)}>Mark Resolved</button>`}
          </div>
        </div>
        <div class="conflict-detail">
          ${this.scopedServerId ? '' : html`Server: <code>${c.server_id}</code><br/>`}
          CouchDB rev: ${c.couch_rev} | Git SHA: ${c.git_sha?.substring(0, 8) ?? '—'}<br/>
          Conflict branch: <code>${c.conflict_branch}</code><br/>
          Detected: ${new Date(c.detected_at).toLocaleString()}
        </div>
        ${this.renderComparison(c)}
      </div>
    `);
  }
}
