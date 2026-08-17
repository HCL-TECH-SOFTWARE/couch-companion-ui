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

import { LitElement, html, css, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import logoUrl from '../assets/ccalogo32x32.png?url';

@customElement('cca-nav-header')
export class CcaNavHeader extends LitElement {
  static styles = css`
    :host {
      display: flex;
      align-items: flex-start;
      justify-content: center;
      gap: 2px;
      flex-direction: column;
      height: 100%;
      position: relative;
    }
    .navigation-header-content {
      display: flex;
      flex-direction: column;
      justify-content: center;
      min-width: 0;
      padding-inline-start: calc(32px + 2px);
      line-height: var(--wa-line-height-condensed);
    }
    .navigation-header-title {
      color: var(--wa-color-text-normal);
      font-size: var(--wa-font-size-m);
      font-weight: var(--wa-font-weight-bold);
    }
    .navigation-header-server {
      color: var(--wa-color-text-quiet);
      font-size: var(--wa-font-size-xs);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .navigation-header-user {
      color: var(--wa-color-text-normal);
      font-size: var(--wa-font-size-s);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    img {
      width: 32px;
      height: 32px;
      position: absolute;
      top: 50%;
      left: var(--wa-space-s);
      transform: translateY(-50%);
    }
  `;

  @property({ type: String }) companionServer: string | null = null;
  @property({ type: String }) userName: string | null = null;
  /** True while cca-shell.ts's rail toggle has collapsed the nav to icon-only. */
  @property({ type: Boolean }) collapsed = false;

  /** Title/server/user text — omitted entirely when the rail is collapsed to icon-only. */
  private renderLabels() {
    if (this.collapsed) return nothing;
    return html`
      <span class="navigation-header-title">CouchCompanion</span>
      <span class="navigation-header-server">
        Server: ${this.companionServer ?? 'n/a'}
      </span>
      <span class="navigation-header-user">
        User: ${this.userName ?? 'Anonymous'}
      </span>
    `;
  }

  render() {
    return html`
      <div class="navigation-header-content">
        <img src="${logoUrl}" alt="CouchCompanion Logo" />
        ${this.renderLabels()}
      </div>
    `;
  }
}
