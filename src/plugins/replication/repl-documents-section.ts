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

import { html, css, LitElement } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import '@awesome.me/webawesome/dist/components/tag/tag.js';
import '@awesome.me/webawesome/dist/components/input/input.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';

/** Pill editor for an explicit list of document ids (CouchDB `doc_ids`). */
@customElement('cca-repl-documents-section')
export class CcaReplDocumentsSection extends LitElement {
  static styles = css`
    :host {
      display: block;
    }
    .section-body {
      padding: 0.9rem;
      display: grid;
      gap: 0.9rem;
    }
    .pills {
      display: flex;
      flex-wrap: wrap;
      gap: 0.4rem;
      align-items: center;
    }
    .tag-remove {
      background: none;
      border: none;
      cursor: pointer;
      padding: 0;
      margin-inline-start: 0.35rem;
      color: inherit;
      display: inline-flex;
      align-items: center;
      line-height: var(--wa-line-height-condensed);
    }
    .tag-remove:hover {
      color: var(--wa-color-danger-fill-loud);
    }
    .add-row {
      display: flex;
      gap: 0.5rem;
      align-items: center;
    }
    wa-input {
      flex: 1;
      max-width: 320px;
    }
    .hint {
      margin: 0;
      font-size: var(--wa-font-size-s);
      color: var(--wa-color-text-quiet);
    }
    .status-found {
      color: var(--wa-color-success-fill-loud);
      margin-inline-end: 0.3rem;
    }
    .status-missing {
      color: var(--wa-color-danger-fill-loud);
      margin-inline-end: 0.3rem;
    }
  `;

  @property({ type: Array }) docIds: string[] = [];
  /** True when the editor has a registered source server + database to check against. */
  @property({ type: Boolean }) canVerify = false;
  /** True while the editor is running the existence check. */
  @property({ type: Boolean }) verifying = false;
  /** Ids not found in the source db; null until a verification has run. */
  @property({ attribute: false }) missingIds: string[] | null = null;
  @state() private _input = '';

  private _emit(next: string[]) {
    this.dispatchEvent(
      new CustomEvent('cca-doc-ids-change', {
        detail: { docIds: next },
        bubbles: true,
        composed: true
      })
    );
  }

  private _add() {
    const trimmed = this._input.trim();
    this._input = '';
    if (!trimmed || this.docIds.includes(trimmed)) return;
    this._emit([...this.docIds, trimmed]);
  }

  private _remove(id: string) {
    this._emit(this.docIds.filter((d) => d !== id));
  }

  private _verify() {
    this.dispatchEvent(new CustomEvent('cca-verify-docs', { bubbles: true, composed: true }));
  }

  private _status(id: string): 'found' | 'missing' | null {
    if (this.missingIds === null) return null;
    return this.missingIds.includes(id) ? 'missing' : 'found';
  }

  render() {
    return html`
      <div class="section-body">
        <div class="pills">
          ${this.docIds.map(
            (id) => html`
              <wa-tag pill size="small">
                ${this._status(id) === 'found'
                  ? html`<wa-icon name="circle-check" class="status-found" data-status="found" aria-label="found in source"></wa-icon>`
                  : ''}
                ${this._status(id) === 'missing'
                  ? html`<wa-icon name="triangle-exclamation" class="status-missing" data-status="missing" aria-label="missing from source"></wa-icon>`
                  : ''}
                ${id}
                <button
                  class="tag-remove"
                  aria-label="Remove ${id}"
                  @click=${() => this._remove(id)}>
                  <wa-icon name="x"></wa-icon>
                </button>
              </wa-tag>
            `
          )}
        </div>
        <div class="add-row">
          <wa-input
            placeholder="Document ID"
            .value=${this._input}
            @input=${(e: Event) => {
              this._input = (e.target as HTMLInputElement).value || '';
            }}
            @keydown=${(e: KeyboardEvent) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                this._add();
              }
            }}></wa-input>
          <wa-button variant="brand" @click=${this._add}>Add</wa-button>
          <wa-button
            data-verify
            variant="neutral"
            ?disabled=${!this.canVerify || this.docIds.length === 0 || this.verifying}
            ?loading=${this.verifying}
            title=${this.canVerify ? 'Check that these documents exist in the source database' : 'Select a source server and database first'}
            @click=${this._verify}>
            Verify
          </wa-button>
        </div>
        ${this.missingIds !== null
          ? html`<p class="hint" data-verify-summary>
              ${this.docIds.filter((id) => !this.missingIds?.includes(id)).length} of ${this.docIds.length}
              documents found in the source database.
            </p>`
          : ''}
        <p class="hint">Replicate only these documents by id. Press Enter or Add.</p>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'cca-repl-documents-section': CcaReplDocumentsSection;
  }
}
