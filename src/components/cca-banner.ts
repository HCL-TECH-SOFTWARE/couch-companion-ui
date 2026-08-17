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

import { LitElement, html, css, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";

/**
 * Presentational announcement banner — surfaces a server-driven message in
 * `wa-page`'s `banner` slot. Renders nothing when `message` is empty so the
 * slot collapses cleanly. Fetch and expiry are owned by `cca-shell`.
 */
@customElement("cca-banner")
export class CcaBanner extends LitElement {
  static styles = css`
    /* wa-page lays out banner-slotted hosts as centered flex containers
       (::slotted(*){display:flex}), so the host fills the slot width and
       centers this content — no :host display rule is needed here. The full-
       width danger fill is applied to the host by cca-shell. */
    .cca-banner {
      display: flex;
      align-items: center;
      gap: var(--wa-space-s);
      margin: 0;
      padding: var(--wa-space-s) var(--wa-space-m);
      background: var(--wa-color-danger-fill-loud);
      color: var(--wa-color-danger-on-loud);
    }
    .cca-banner a {
      color: inherit;
      text-decoration: underline;
    }
  `;

  @property({ type: String }) message?: string;
  @property({ type: String }) icon?: string;
  @property({ type: String }) link?: string;

  render() {
    if (!this.message) {
      return nothing;
    }
    const body = this.link
      ? html`<a
          href=${this.link}
          target="_blank"
          rel="noopener noreferrer"
          >${this.message}</a
        >`
      : html`<span>${this.message}</span>`;
    return html`
      <p class="cca-banner" role="status">
        ${this.icon ? html`<wa-icon name=${this.icon}></wa-icon>` : nothing}
        ${body}
      </p>
    `;
  }
}
