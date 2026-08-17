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
import { customElement } from "lit/decorators.js";
import { getContext } from "../context.js";

/** 404 page — displays the unmatched path via slot content so users can report broken links. */
@customElement("cca-not-found")
export class CcaNotFound extends LitElement {
  render() {
    return html`
      <wa-card class="wa-stack wa-gap-l">
        <h1>
          <wa-icon
            name="triangle-exclamation"
            animation="beat"
            label="Warning not found"
            style="font-size: var(--wa-font-size-2xl); color: var(--wa-color-warning);"
          ></wa-icon>
          404
        </h1>
        <p>We checked under every cushion — this page is still missing.</p>
        <p>
          The path not found: <b> <slot></slot></b>
        </p>
        <div class="actions">
          <wa-button
            variant="brand"
            size="l"
            @click=${() => getContext().router.navigate("/")}
          >
            Go home
          </wa-button>
        </div>
      </wa-card>
    `;
  }
}
