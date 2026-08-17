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

import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";

@customElement("cca-repl-issues-panel")
export class CcaReplIssuesPanel extends LitElement {
  static styles = css`
    :host {
      display: block;
    }

    .panel {
      border: 1px solid var(--wa-color-surface-border);
      border-radius: 10px;
      background: var(--wa-color-surface-default);
      box-shadow: 0 8px 24px rgba(15, 23, 42, 0.06);
      padding: 0.9rem;
      position: sticky;
      top: 0.75rem;
    }

    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.5rem;
      margin-bottom: 0.7rem;
    }

    .title {
      margin: 0;
      font-size: var(--wa-font-size-s);
      font-weight: var(--wa-font-weight-bold);
      color: var(--wa-color-text-normal);
    }

    .count {
      border-radius: 999px;
      padding: 0.1rem 0.55rem;
      font-size: var(--wa-font-size-xs);
      font-weight: var(--wa-font-weight-bold);
      border: 1px solid var(--wa-color-surface-border);
      color: var(--wa-color-text-normal);
      background: var(--wa-color-surface-raised);
    }

    .section-title {
      margin: 0.65rem 0 0.35rem;
      font-size: var(--wa-font-size-xs);
      font-weight: var(--wa-font-weight-bold);
      color: var(--wa-color-text-normal);
      letter-spacing: 0.02em;
      text-transform: uppercase;
    }

    ul {
      margin: 0;
      padding-left: 1rem;
      display: grid;
      gap: 0.35rem;
      font-size: var(--wa-font-size-s);
      line-height: var(--wa-line-height-condensed);
    }

    li.blocking {
      color: var(--wa-color-danger-60);
    }

    li.warning {
      color: var(--wa-color-warning-60);
    }

    .empty {
      margin: 0;
      font-size: var(--wa-font-size-s);
      color: var(--wa-color-text-quiet);
    }
  `;

  @property({ type: Array }) blocking: string[] = [];
  @property({ type: Array }) warnings: string[] = [];

  render() {
    const total = this.blocking.length + this.warnings.length;

    return html`
      <aside class="panel" aria-label="Replication issues">
        <div class="header">
          <p class="title">Issues</p>
          <span class="count">${total}</span>
        </div>

        ${total === 0
          ? html`<p class="empty">No issues. This replication is ready.</p>`
          : html`
              ${this.blocking.length > 0
                ? html`
                    <p class="section-title">Required Fixes</p>
                    <ul>
                      ${this.blocking.map(
                        (msg) => html`<li class="blocking">${msg}</li>`,
                      )}
                    </ul>
                  `
                : ""}
              ${this.warnings.length > 0
                ? html`
                    <p class="section-title">Heads Up</p>
                    <ul>
                      ${this.warnings.map(
                        (msg) => html`<li class="warning">${msg}</li>`,
                      )}
                    </ul>
                  `
                : ""}
            `}
      </aside>
    `;
  }
}
