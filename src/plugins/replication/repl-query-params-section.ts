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
import { customElement, property } from 'lit/decorators.js';

@customElement('cca-repl-query-params-section')
export class CcaReplQueryParamsSection extends LitElement {
  static styles = css`
    :host {
      display: block;
    }

    .section-body {
      padding: 0.9rem;
      display: grid;
      gap: 0.9rem;
    }

    label {
      font-size: var(--wa-font-size-s);
      font-weight: var(--wa-font-weight-semibold);
      color: var(--wa-color-text-quiet);
      display: grid;
      gap: 0.35rem;
    }

    wa-textarea {
      width: 100%;
    }

    wa-textarea::part(textarea) {
      font-family: var(--wa-font-family-code);
    }

    .hint {
      margin: 0;
      font-size: var(--wa-font-size-s);
      color: var(--wa-color-text-quiet);
    }
  `;

  @property({ type: String }) queryParamsJson = '';

  render() {
    return html`
      <div class="section-body">
        <label>
          Query Parameters (JSON object)
          <wa-textarea
            .value=${this.queryParamsJson}
            placeholder='e.g.: {"level":"high"}'
            @input=${(e: Event) => {
              const target = e.target as HTMLTextAreaElement;
              this.dispatchEvent(
                new CustomEvent('cca-query-params-change', {
                  detail: { queryParamsJson: target.value || '' },
                  bubbles: true,
                  composed: true
                })
              );
            }}></wa-textarea>
        </label>
        <p class="hint">Passed to the filter function as query parameters. Only used when a Filter is set.</p>
      </div>
    `;
  }
}
