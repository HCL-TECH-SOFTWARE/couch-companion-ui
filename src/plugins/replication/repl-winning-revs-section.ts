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

@customElement('cca-repl-winning-revs-section')
export class CcaReplWinningRevsSection extends LitElement {
  static styles = css`
    :host {
      display: block;
    }

    .section-body {
      padding: 0.9rem;
      display: grid;
      gap: 0.9rem;
    }

    .hint {
      margin: 0;
      font-size: var(--wa-font-size-s);
      color: var(--wa-color-text-quiet);
    }
  `;

  @property({ type: Boolean }) winningRevsOnly = false;

  render() {
    return html`
      <div class="section-body">
        <wa-checkbox
          ?checked=${this.winningRevsOnly}
          @change=${(e: Event) => {
            const target = e.target as HTMLInputElement;
            this.dispatchEvent(
              new CustomEvent('cca-winning-revs-change', {
                detail: { winningRevsOnly: target.checked },
                bubbles: true,
                composed: true
              })
            );
          }}
          >Replicate only winning revisions</wa-checkbox
        >
        <p class="hint">Skips conflicting revisions; the target receives each document's winning revision only. Requires CouchDB 3.2+.</p>
      </div>
    `;
  }
}
