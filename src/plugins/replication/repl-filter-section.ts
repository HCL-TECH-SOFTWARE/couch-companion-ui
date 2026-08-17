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
import './repl-filter-picker.js';

@customElement('cca-repl-filter-section')
export class CcaReplFilterSection extends LitElement {
  static styles = css`
    :host {
      display: block;
    }

    .section-body {
      padding: 0.9rem;
      display: grid;
      gap: 0.9rem;
    }

    .row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 1rem;
    }

    label {
      font-size: var(--wa-font-size-s);
      font-weight: var(--wa-font-weight-semibold);
      color: var(--wa-color-text-quiet);
      display: grid;
      gap: 0.35rem;
    }

    wa-select,
    wa-input,
    wa-textarea {
      width: 100%;
    }

    @media (max-width: 820px) {
      .row {
        grid-template-columns: 1fr;
      }
    }
  `;

  @property({ type: String }) filterFn = '';
  /** Source server/database of the replication — the picker browses these. */
  @property({ type: String }) sourceServer = '';
  @property({ type: String }) sourceDb = '';
  @state() private _pickerOpen = false;

  getFilterDesignDoc() {
    const spit = this.filterFn.split('/');
    if (spit.length === 2) {
      return spit[0];
    }
    return '';
  }

  getFilterFunctionName() {
    const spit = this.filterFn.split('/');
    if (spit.length === 2) {
      return spit[1];
    }
    return '';
  }

  updateFilterDesignDoc(newDesignDoc: string) {
    this.setFilter(newDesignDoc, this.getFilterFunctionName());
  }

  updateFilterFunctionName(newFunctionName: string) {
    this.setFilter(this.getFilterDesignDoc(), newFunctionName);
  }

  private setFilter(designDoc: string, functionName: string) {
    // A CouchDB filter is "designdoc/function"; when both parts are empty the
    // filter is unset, so emit '' rather than a bare '/' (which reads as set).
    this.filterFn = designDoc || functionName ? `${designDoc}/${functionName}` : '';
    this.sendEvent();
  }

  sendEvent() {
    this.dispatchEvent(
      new CustomEvent('cca-filter-fn-change', {
        detail: { filterFn: this.filterFn },
        bubbles: true,
        composed: true
      })
    );
  }

  private _onPicked(e: CustomEvent<{ designDoc: string; filterName: string }>) {
    this._pickerOpen = false;
    this.setFilter(e.detail.designDoc, e.detail.filterName);
  }

  private _onPickCancel() {
    this._pickerOpen = false;
  }

  render() {
    const canBrowse = Boolean(this.sourceServer && this.sourceDb);
    return html`
      <div class="section-body">
        <div class="row">
          <label>
            Design doc name
            <wa-input
              type="text"
              .value=${this.getFilterDesignDoc()}
              placeholder="e.g.: mydesign"
              @input=${(e: Event) => {
                const target = e.target as HTMLInputElement;
                this.updateFilterDesignDoc(target.value || '');
              }}></wa-input>
          </label>
          <label>
            Filter function
            <wa-input
              type="text"
              .value=${this.getFilterFunctionName()}
              placeholder="e.g myfilter"
              @input=${(e: Event) => {
                const target = e.target as HTMLInputElement;
                this.updateFilterFunctionName(target.value || '');
              }}></wa-input>
          </label>
        </div>
        <div>
          <wa-button
            data-browse
            variant="neutral"
            ?disabled=${!canBrowse}
            title=${canBrowse
              ? 'Pick from the source database design documents'
              : 'Select a source server and database first'}
            @click=${() => {
              this._pickerOpen = true;
            }}>
            Browse…
          </wa-button>
        </div>
        <cca-repl-filter-picker
          .open=${this._pickerOpen}
          .serverId=${this.sourceServer}
          .dbName=${this.sourceDb}
          @cca-filter-picked=${this._onPicked}
          @cca-filter-pick-cancel=${this._onPickCancel}></cca-repl-filter-picker>
      </div>
    `;
  }
}
