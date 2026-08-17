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

import { LitElement, html, css } from 'lit';
import { customElement, state, query } from 'lit/decorators.js';
import '@awesome.me/webawesome/dist/components/card/card.js';
import '@awesome.me/webawesome/dist/components/callout/callout.js';
import '@awesome.me/webawesome/dist/components/input/input.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/spinner/spinner.js';
import '@awesome.me/webawesome/dist/components/dialog/dialog.js';
import '@awesome.me/webawesome/dist/components/tab-group/tab-group.js';
import '@awesome.me/webawesome/dist/components/tab/tab.js';
import '@awesome.me/webawesome/dist/components/tab-panel/tab-panel.js';
import '../../components/cca-data-table.js';
import '../../components/cca-monaco-editor.js';
import { getContext } from '../../context.js';
import { toast } from '../../components/cca-toast.js';
import { addHeaderActions, clearHeaderActions } from '../../components/cca-header.js';
import type { TableColumn } from '../../components/cca-data-table.js';
import { buildDoc, formatUntil, fromDatetimeLocal, isExpired, parseEntries, toDatetimeLocal, validateEntry } from './banner-doc.js';
import type { BannerEntry } from './types.js';

/** A table row view-model: a banner entry plus its index in the working array. */
type BannerRow = BannerEntry & { _index: number };

/** Edits the companion server's `couchcompanion` `BannerMessages` document: a table of
 *  entries (edited in a modal) on the Form tab, plus a read-only Source/JSON tab. */
@customElement('cca-banner-admin')
export class CcaBannerAdmin extends LitElement {
  static styles = css`
    .id {
      color: var(--wa-color-text-quiet);
      font-size: var(--wa-font-size-s);
      margin-bottom: 0.75rem;
    }
    .fields {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }
    label {
      display: block;
      font-weight: var(--wa-font-weight-bold);
      margin-bottom: 0.2rem;
      font-size: var(--wa-font-size-s);
    }
    .hint {
      font-weight: var(--wa-font-weight-normal);
      color: var(--wa-color-text-quiet);
    }
    .icon-row {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .icon-row wa-input {
      flex: 1;
    }
    .until input {
      font: inherit;
      padding: 0.4rem 0.5rem;
      border: 1px solid var(--wa-color-neutral-border-normal);
      border-radius: var(--wa-border-radius-s, 0.25rem);
      background: var(--wa-color-surface-default, #fff);
      color: inherit;
    }
    .raw {
      height: 50vh;
      border: 1px solid var(--wa-color-neutral-border-normal);
      overflow: hidden;
    }
    .footer {
      display: flex;
      gap: 0.5rem;
      align-items: center;
    }
    .footer .spacer {
      flex: 1;
    }
    .error {
      color: var(--wa-color-danger-on-quiet);
      margin-top: 0.5rem;
    }
    wa-callout[data-unsaved] {
      margin-bottom: var(--wa-space-m, 0.75rem);
    }
    .unsaved-row {
      display: flex;
      align-items: center;
      gap: 1rem;
    }
    .unsaved-row span {
      flex: 1;
    }
  `;

  @state() private _entries: BannerEntry[] = [];
  @state() private _original: Record<string, unknown> | null = null;
  @state() private _serverId = '';
  @state() private _loading = false;
  @state() private _saving = false;
  @state() private _error = '';
  @state() private _activeTab: 'form' | 'source' = 'form';
  /** True when the working entries have unsaved edits (add/edit/delete). */
  @state() private _dirty = false;

  @state() private _modalOpen = false;
  /** Index of the entry being edited, or -1 when adding a new one. */
  @state() private _editIndex = -1;
  @state() private _draft: BannerEntry = { message: '', until: '' };
  @state() private _modalError = '';

  @query('cca-monaco-editor') private _rawEditor?: { setValue(v: string): void };

  override connectedCallback() {
    super.connectedCallback();
    clearHeaderActions();
    addHeaderActions([
      { icon: 'plus', tooltip: 'New Banner', action: () => this.openNew() },
      { icon: 'floppy-disk', tooltip: 'Save', variant: 'brand', action: () => void this.save() }
    ]);
    void this._load();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    clearHeaderActions();
  }

  private async _load() {
    this._loading = true;
    this._error = '';
    try {
      this._serverId = await getContext().bannerAdmin.resolveCompanionServerId();
      const doc = await getContext().bannerAdmin.getBannerDoc(this._serverId);
      this._original = doc;
      this._entries = parseEntries(doc);
      this._dirty = false;
    } catch (err: unknown) {
      this._error = err instanceof Error ? err.message : String(err);
      toast(`Failed to load banners: ${this._error}`, 'error');
    } finally {
      this._loading = false;
    }
  }

  /** Opens the modal to add a new entry. Public for the header action and tests. */
  openNew() {
    this._editIndex = -1;
    this._draft = { message: '', until: '' };
    this._modalError = '';
    this._modalOpen = true;
  }

  private _openEdit(index: number) {
    this._editIndex = index;
    this._draft = { ...this._entries[index] };
    this._modalError = '';
    this._modalOpen = true;
  }

  private _updateDraft(key: keyof BannerEntry, value: string) {
    this._draft = { ...this._draft, [key]: value };
  }

  /** Commits the modal draft into the in-memory list (persisted later by Save). */
  private _commitModal() {
    const err = validateEntry(this._draft);
    if (err) {
      this._modalError = err;
      return;
    }
    if (this._editIndex < 0) {
      this._entries = [...this._entries, this._draft];
    } else {
      const index = this._editIndex;
      this._entries = this._entries.map((e, i) => (i === index ? this._draft : e));
    }
    this._dirty = true;
    this._modalOpen = false;
  }

  /** Removes an entry from the in-memory list (row trash + modal delete). */
  removeEntry(index: number) {
    this._entries = this._entries.filter((_, i) => i !== index);
    this._dirty = true;
  }

  private _deleteFromModal() {
    if (this._editIndex >= 0) this.removeEntry(this._editIndex);
    this._modalOpen = false;
  }

  private _sourceJson(): string {
    return JSON.stringify(buildDoc(this._original, this._entries), null, 2);
  }

  /** Persists the whole document. Public for the header Save action and tests. */
  async save() {
    if (this._saving) return;
    this._error = '';
    for (let i = 0; i < this._entries.length; i++) {
      const err = validateEntry(this._entries[i]);
      if (err) {
        this._error = `Banner ${i + 1}: ${err}`;
        toast(this._error, 'error');
        return;
      }
    }
    const body = buildDoc(this._original, this._entries);
    this._saving = true;
    try {
      await getContext().bannerAdmin.saveBannerDoc(this._serverId, body);
      toast('Banners saved.', 'success');
      await this._load();
    } catch (err: unknown) {
      this._error = err instanceof Error ? err.message : String(err);
      toast(`Failed to save banners: ${this._error}`, 'error');
    } finally {
      this._saving = false;
    }
  }

  override updated() {
    if (this._activeTab === 'source' && this._rawEditor) {
      this._rawEditor.setValue(this._sourceJson());
    }
  }

  private get _columns(): TableColumn<BannerRow>[] {
    return [
      {
        label: 'Icon',
        width: '4rem',
        align: 'center',
        render: (r) => (r.icon ? html`<wa-icon name=${r.icon}></wa-icon>` : '—')
      },
      { label: 'Message', key: 'message' },
      {
        label: 'Until',
        render: (r) => {
          const expired = isExpired(r.until);
          return html`<span data-until ?data-expired=${expired} style=${expired ? 'text-decoration:line-through;opacity:0.65' : ''}
            >${formatUntil(r.until) || '—'}</span
          >`;
        }
      },
      {
        label: 'Link',
        width: '4rem',
        align: 'center',
        render: (r) =>
          r.link
            ? html`<a
                data-link
                href=${r.link}
                target="_blank"
                rel="noopener noreferrer"
                title=${r.link}
                @click=${(e: Event) => e.stopPropagation()}
                ><wa-icon name="link"></wa-icon
              ></a>`
            : ''
      },
      {
        label: '',
        width: '4rem',
        align: 'center',
        render: (r) =>
          html`<wa-button
            data-row-remove
            size="small"
            variant="danger"
            appearance="outlined"
            class="row-action-button"
            @click=${(e: Event) => {
            e.stopPropagation();
            this.removeEntry(r._index);
          }}
            ><wa-icon name="trash-can"></wa-icon
          ></wa-button>`
      }
    ];
  }

  private _renderModal() {
    const isNew = this._editIndex < 0;
    return html`
      <wa-dialog
        data-edit
        label=${isNew ? 'New banner' : 'Edit banner'}
        ?open=${this._modalOpen}
        @wa-after-hide=${(e: Event) => {
          if (e.target === e.currentTarget) this._modalOpen = false;
        }}>
        <div class="fields">
          <div>
            <label>Message</label>
            <wa-input
              data-field="message"
              placeholder="Announcement text"
              .value=${this._draft.message}
              @input=${(e: Event) => this._updateDraft('message', (e.target as HTMLInputElement).value)}></wa-input>
          </div>
          <div>
            <label>Icon <span class="hint">(optional, Web Awesome name)</span></label>
            <div class="icon-row">
              <wa-input
                data-field="icon"
                placeholder="e.g. circle-info"
                .value=${this._draft.icon ?? ''}
                @input=${(e: Event) => this._updateDraft('icon', (e.target as HTMLInputElement).value)}></wa-input>
              ${this._draft.icon ? html`<wa-icon name=${this._draft.icon}></wa-icon>` : ''}
            </div>
          </div>
          <div>
            <label>Link <span class="hint">(optional URL)</span></label>
            <wa-input
              data-field="link"
              type="url"
              placeholder="https://…"
              .value=${this._draft.link ?? ''}
              @input=${(e: Event) => this._updateDraft('link', (e.target as HTMLInputElement).value)}></wa-input>
          </div>
          <div class="until">
            <label>Until</label>
            <input
              data-field="until"
              type="datetime-local"
              .value=${toDatetimeLocal(this._draft.until)}
              @input=${(e: Event) => this._updateDraft('until', fromDatetimeLocal((e.target as HTMLInputElement).value))} />
          </div>
          ${this._modalError ? html`<div class="error">${this._modalError}</div>` : ''}
        </div>
        <div slot="footer" class="footer">
          ${
            isNew
              ? ''
              : html`<wa-button data-modal-delete variant="danger" @click=${() => this._deleteFromModal()}>
                  <wa-icon slot="start" name="trash-can"></wa-icon>Delete
                </wa-button>`
          }
          <span class="spacer"></span>
          <wa-button data-modal-cancel @click=${() => (this._modalOpen = false)}>Cancel</wa-button>
          <wa-button data-modal-save variant="brand" appearance="filled" @click=${() => this._commitModal()}>Save</wa-button>
        </div>
      </wa-dialog>
    `;
  }

  render() {
    if (this._loading) return html`<wa-spinner></wa-spinner>`;
    const rows: BannerRow[] = this._entries.map((e, i) => ({ ...e, _index: i }));
    return html`
      <div class="id">couchcompanion / BannerMessages</div>
      ${
        this._dirty
          ? html`<wa-callout data-unsaved variant="warning" appearance="filled-outlined">
              <wa-icon slot="icon" name="triangle-exclamation"></wa-icon>
              <div class="unsaved-row">
                <span>You have unsaved changes.</span>
                <wa-button data-save-changes variant="brand" appearance="filled" ?loading=${this._saving} @click=${() => void this.save()}>
                  <wa-icon slot="start" name="floppy-disk"></wa-icon>Save changes
                </wa-button>
              </div>
            </wa-callout>`
          : ''
      }
      <wa-tab-group
        .active=${this._activeTab}
        @wa-tab-show=${(e: CustomEvent<{ name: string }>) => (this._activeTab = e.detail.name === 'source' ? 'source' : 'form')}>
        <wa-tab panel="form">Form</wa-tab>
        <wa-tab panel="source">Source</wa-tab>
        <wa-tab-panel name="form">
          <cca-data-table
            .columns=${this._columns as unknown as TableColumn[]}
            .rows=${rows as unknown as Record<string, unknown>[]}
            row-key="_index"
            empty-message="No banners yet — use New Banner to add one."
            @cca-row-click=${(e: CustomEvent<BannerRow>) => this._openEdit(e.detail._index)}></cca-data-table>
        </wa-tab-panel>
        <wa-tab-panel name="source">
          <div class="raw">
            ${
                this._activeTab === 'source'
                  ? html`<cca-monaco-editor language="json" ?readOnly=${true} .value=${this._sourceJson()}></cca-monaco-editor>`
                  : ''
              }
          </div>
        </wa-tab-panel>
      </wa-tab-group>

      ${this._error ? html`<div class="error">${this._error}</div>` : ''} ${this._renderModal()}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'cca-banner-admin': CcaBannerAdmin;
  }
}
