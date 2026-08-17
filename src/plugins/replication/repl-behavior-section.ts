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

@customElement('cca-repl-behavior-section')
export class CcaReplBehaviorSection extends LitElement {
  static styles = css`
    :host {
      display: block;
    }

    label {
      font-size: var(--wa-font-size-s);
      font-weight: var(--wa-font-weight-semibold);
      color: var(--wa-color-text-quiet);
      display: grid;
      gap: 0.35rem;
    }

    wa-checkbox {
      padding-right: 0.5rem;
    }

    .helper-label {
      margin-top: 0.25rem;
      font-size: var(--wa-font-size-xs);
      color: var(--wa-color-text-quiet);
    }
  `;

  @property({ type: Boolean }) continuous = true;
  @property({ type: Boolean }) createTarget = true;
  @property({ type: String }) behaviorSummary = '';

  render() {
    return html`
      <div class="section-body">
        <wa-checkbox
          ?checked=${this.continuous}
          @change=${(e: Event) => {
            const target = e.target as HTMLInputElement;
            this.dispatchEvent(
              new CustomEvent('cca-behavior-continuous-change', {
                detail: { continuous: target.checked },
                bubbles: true,
                composed: true
              })
            );
          }}
          >Continuous replication</wa-checkbox
        >
        <wa-checkbox
          ?checked=${this.createTarget}
          @change=${(e: Event) => {
            const target = e.target as HTMLInputElement;
            this.dispatchEvent(
              new CustomEvent('cca-behavior-create-target-change', {
                detail: { createTarget: target.checked },
                bubbles: true,
                composed: true
              })
            );
          }}
          >Create target database automatically</wa-checkbox
        >
        <div class="helper-label">${this.behaviorSummary}</div>
      </div>
    `;
  }
}
