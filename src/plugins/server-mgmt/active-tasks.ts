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

import { LitElement, html, css, nothing, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import '@awesome.me/webawesome/dist/components/spinner/spinner.js';
import '@awesome.me/webawesome/dist/components/callout/callout.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/tab-group/tab-group.js';
import '@awesome.me/webawesome/dist/components/tab/tab.js';
import '@awesome.me/webawesome/dist/components/relative-time/relative-time.js';
import '@awesome.me/webawesome/dist/components/input/input.js';
import '../../components/cca-data-table.js';
import { getContext } from '../../context.js';
import {
  addHeaderActions,
  clearHeaderActions,
  clearHeaderTitle,
  setHeaderTitle
} from '../../components/cca-header.js';
import type { TableColumn } from '../../components/cca-data-table.js';
import type { ActiveTask, Server } from './types.js';

/** Poll cadence while the page is mounted. CouchDB task progress moves slowly. */
export const POLL_INTERVAL_MS = 60_000;

/** `:serverId` sentinel meaning "every registered server". */
const ALL_SERVERS = '$all';

/** Tab sentinel meaning "every task type". CouchDB type names never start with `$`. */
const ALL_TYPES = '$all';

/** A task, tagged with the server it was fetched from. */
export type TaskRow = ActiveTask & { _serverId: string; _serverName: string };

/**
 * `ApiError.message` is the empty string when the response carries no statusText
 * (every HTTP/2 response). Branching on truthiness anywhere downstream made a
 * *failed* load render as an empty state — see #688. Normalize at the point of
 * capture so the message is always renderable, and branch on `null` instead.
 */
function messageOf(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.trim() === '' ? 'Request failed.' : raw;
}

function tag(task: ActiveTask, serverId: string, serverName: string): TaskRow {
  return { ...task, _serverId: serverId, _serverName: serverName };
}

/**
 * Active-tasks browser (Fauxton-equivalent) over CouchDB's `/_active_tasks`.
 *
 * Server-scoped via the `:serverId` route param, but unlike the configuration
 * screen `$all` here means *every* server rather than "pick one": the component
 * fans out over the registered servers and adds a Server column. A server that
 * fails to answer contributes no rows and is reported as an inline warning — one
 * dead server must not take the page down.
 *
 * Task payloads are heterogeneous, so the type tabs (derived from the data, not
 * from a hard-coded list) each pick their own column set. Data is polled every
 * {@link POLL_INTERVAL_MS}; a failed poll keeps the last good rows on screen and
 * only the initial load can raise an error state.
 */
@customElement('cca-active-tasks')
export class CcaActiveTasks extends LitElement {
  static styles = css`
    :host {
      display: block;
    }
    wa-callout {
      margin-block-end: var(--wa-space-m);
    }
    .warnings {
      display: flex;
      flex-direction: column;
      gap: var(--wa-space-xs);
    }
    .url {
      font-family: var(--wa-font-family-code);
      font-size: var(--wa-font-size-s);
      overflow-wrap: anywhere;
    }
    .filter-row {
      margin-block: var(--wa-space-s) var(--wa-space-m);
    }
    .filter-row wa-input::part(form-control-label) {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }
  `;

  /** Set by the app shell from the `:serverId` route param. `$all` = every server. */
  @property({ type: String }) serverId = '';

  @state() private _tasks: TaskRow[] = [];
  /** Per-server fetch failures in the `$all` fan-out. Non-fatal. */
  @state() private _warnings: string[] = [];
  @state() private _loading = false;
  /** `null` = no error. Never branch on truthiness: the message may be `''` (#688). */
  @state() private _error: string | null = null;
  @state() private _selectedType: string = ALL_TYPES;
  /** Client-side text filter over the loaded tasks (#827). Survives polls: _load only replaces _tasks. */
  @state() private _filter = '';

  private _timer: ReturnType<typeof setInterval> | null = null;
  /** The serverId the current data belongs to — guards the double load on first render. */
  private _loadedFor: string | null = null;

  override connectedCallback() {
    super.connectedCallback();
    clearHeaderActions();
    addHeaderActions([
      {
        icon: 'arrows-rotate',
        tooltip: 'Refresh',
        action: () => void this.refresh()
      }
    ]);
    // Without this the header falls back to the route label, which plugin-loader
    // sets to the owning plugin's name — the page would be titled "server-mgmt".
    setHeaderTitle('Active Tasks');
    // Re-entry after a disconnect: firstUpdated will not run again, so refresh in
    // the background instead. The first mount is loaded by firstUpdated().
    if (this.hasUpdated) void this.refresh();
    this._timer = setInterval(() => void this._load(false), POLL_INTERVAL_MS);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    clearHeaderActions();
    clearHeaderTitle();
    // A leaked interval keeps polling a detached element forever.
    if (this._timer !== null) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  override firstUpdated() {
    void this._load(true);
  }

  override updated(changed: PropertyValues) {
    // Reload when the header's server picker rewrites the :serverId route segment. firstUpdated
    // has already loaded the initial serverId, hence the _loadedFor guard.
    if (changed.has('serverId') && this._loadedFor !== this.serverId) {
      void this._load(true);
    }
  }

  /** Re-fetches without disturbing what is on screen. Public for the header action and tests. */
  refresh(): Promise<void> {
    return this._load(false);
  }

  /**
   * @param initial - when true, shows a spinner and surfaces failures as an error
   *   state. A poll or a manual refresh (false) leaves the last good rows in place
   *   and raises no toast: a transient blip must not blank the table.
   */
  private async _load(initial: boolean): Promise<void> {
    this._loadedFor = this.serverId;
    if (initial) {
      this._loading = true;
      this._error = null;
    }
    try {
      const { tasks, warnings } = await this._fetch();
      this._tasks = tasks;
      this._warnings = warnings;
      this._error = null;
    } catch (err: unknown) {
      if (initial) this._error = messageOf(err);
    } finally {
      if (initial) this._loading = false;
    }
  }

  private get _isAll(): boolean {
    return !this.serverId || this.serverId === ALL_SERVERS;
  }

  /**
   * One server: a failure throws, so the initial load can report it. Every server:
   * failures are collected per server as warnings and the healthy servers' rows are
   * still returned — only the server *list* itself failing throws.
   */
  private async _fetch(): Promise<{ tasks: TaskRow[]; warnings: string[] }> {
    const svc = getContext().serverMgmt;
    if (!this._isAll) {
      const tasks = await svc.getActiveTasks(this.serverId);
      return {
        tasks: (tasks ?? []).map((t) => tag(t, this.serverId, '')),
        warnings: []
      };
    }

    const servers = await this._allServers();
    const results = await Promise.allSettled(servers.map((s) => svc.getActiveTasks(s.id)));
    const tasks: TaskRow[] = [];
    const warnings: string[] = [];
    results.forEach((r, i) => {
      const s = servers[i];
      if (r.status === 'fulfilled') {
        for (const t of r.value ?? []) tasks.push(tag(t, s.id, s.name));
      } else {
        warnings.push(`${s.name || s.id}: ${messageOf(r.reason)}`);
      }
    });
    return { tasks, warnings };
  }

  /** Pages through the whole server list, as ApplicationDashboardService does. */
  private async _allServers(): Promise<Server[]> {
    const all: Server[] = [];
    let bookmark: string | undefined;
    // Defensive cap so a misbehaving bookmark can never loop forever.
    for (let i = 0; i < 100; i++) {
      const { servers, nextBookmark } = await getContext().serverMgmt.listServers({
        limit: 100,
        bookmark
      });
      all.push(...servers);
      if (!nextBookmark || servers.length === 0) break;
      bookmark = nextBookmark;
    }
    return all;
  }

  /** The task types actually present in the data — an unknown future type gets a tab too. */
  private get _types(): string[] {
    return [...new Set(this._tasks.map((t) => t.type))].sort();
  }

  /** Falls back to All when the selected type vanishes from the data between polls. */
  private get _activeType(): string {
    return this._types.includes(this._selectedType) ? this._selectedType : ALL_TYPES;
  }

  /** Case-insensitive substring match over the task's identifying string fields. */
  private _matchesFilter(t: TaskRow): boolean {
    const q = this._filter.trim().toLowerCase();
    if (!q) return true;
    return [
      t.database,
      t.source,
      t.target,
      t.doc_id,
      t.design_document,
      t.node,
      t.type,
      t._serverName,
      t._serverId
    ].some((f) => typeof f === 'string' && f.toLowerCase().includes(q));
  }

  private get _visible(): TaskRow[] {
    const type = this._activeType;
    const byType = type === ALL_TYPES ? this._tasks : this._tasks.filter((t) => t.type === type);
    return byType.filter((t) => this._matchesFilter(t));
  }

  private _time(seconds: number | undefined) {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return '—';
    // started_on / updated_on are Unix *seconds*, not milliseconds.
    return html`<wa-relative-time date=${new Date(seconds * 1000).toISOString()}></wa-relative-time>`;
  }

  private _num(n: number | null | undefined): string {
    return typeof n === 'number' ? String(n) : '—';
  }

  private _text(s: string | null | undefined) {
    return s ? html`<span class="url">${s}</span>` : '—';
  }

  private get _columns(): TableColumn<TaskRow>[] {
    const server: TableColumn<TaskRow>[] = this._isAll
      ? [{ label: 'Server', render: (t) => t._serverName || t._serverId }]
      : [];

    switch (this._activeType) {
      case 'replication':
        return [
          ...server,
          { label: 'Source', render: (t) => this._text(t.source) },
          { label: 'Target', render: (t) => this._text(t.target) },
          { label: 'Continuous', render: (t) => (t.continuous ? 'Yes' : 'No') },
          { label: 'Docs read', align: 'right', render: (t) => this._num(t.docs_read) },
          { label: 'Docs written', align: 'right', render: (t) => this._num(t.docs_written) },
          {
            label: 'Write failures',
            align: 'right',
            render: (t) => this._num(t.doc_write_failures)
          },
          { label: 'Pending', align: 'right', render: (t) => this._num(t.changes_pending) },
          { label: 'Started', render: (t) => this._time(t.started_on) }
        ];

      case 'indexer':
      case 'view_compaction':
      case 'database_compaction':
        return [
          ...server,
          { label: 'Database', render: (t) => this._text(t.database) },
          { label: 'Design doc', render: (t) => this._text(t.design_document) },
          {
            label: 'Progress',
            align: 'right',
            render: (t) => (typeof t.progress === 'number' ? `${t.progress}%` : '—')
          },
          { label: 'Changes done', align: 'right', render: (t) => this._num(t.changes_done) },
          { label: 'Total changes', align: 'right', render: (t) => this._num(t.total_changes) },
          { label: 'Started', render: (t) => this._time(t.started_on) }
        ];

      default:
        // All — and any task type CouchDB grows that has no bespoke view here yet.
        return [
          ...server,
          { label: 'Type', render: (t) => t.type },
          { label: 'Node', render: (t) => t.node },
          { label: 'Database', render: (t) => this._text(t.database) },
          { label: 'Started', render: (t) => this._time(t.started_on) },
          { label: 'Updated', render: (t) => this._time(t.updated_on) }
        ];
    }
  }

  private _renderWarnings() {
    if (this._warnings.length === 0) return nothing;
    return html`
      <wa-callout data-warning variant="warning" appearance="filled-outlined">
        <wa-icon slot="icon" name="triangle-exclamation"></wa-icon>
        <div class="warnings">
          ${this._warnings.map((w) => html`<div data-warning-row>${w}</div>`)}
        </div>
      </wa-callout>
    `;
  }

  render() {
    if (this._loading) return html`<wa-spinner></wa-spinner>`;

    // `!== null`, never a truthiness check: an empty message is still an error (#688).
    if (this._error !== null) {
      return html`
        <wa-callout data-error variant="danger" appearance="filled-outlined">
          <wa-icon slot="icon" name="circle-exclamation"></wa-icon>
          Failed to load active tasks: ${this._error}
        </wa-callout>
      `;
    }

    return html`
      ${this._renderWarnings()}
      <wa-tab-group
        .active=${this._activeType}
        @wa-tab-show=${(e: CustomEvent<{ name: string }>) => (this._selectedType = e.detail.name)}>
        <wa-tab panel=${ALL_TYPES}>All</wa-tab>
        ${this._types.map((t) => html`<wa-tab panel=${t}>${t}</wa-tab>`)}
      </wa-tab-group>
      <div class="filter-row">
        <wa-input
          data-filter
          label="Filter tasks"
          placeholder="Filter…"
          clearable
          .value=${this._filter}
          @input=${(e: Event) => (this._filter = (e.target as HTMLInputElement).value)}
          @wa-clear=${() => (this._filter = '')}></wa-input>
      </div>
      <cca-data-table
        .columns=${this._columns as unknown as TableColumn[]}
        .rows=${this._visible as unknown as Record<string, unknown>[]}
        empty-message=${this._filter.trim() ? 'No matching tasks.' : 'No active tasks.'}></cca-data-table>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'cca-active-tasks': CcaActiveTasks;
  }
}
