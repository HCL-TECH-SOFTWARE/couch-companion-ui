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
import { customElement } from 'lit/decorators.js';

@customElement('cca-repl-preview')
export class CcaReplPreview extends LitElement {
  static styles = css`
    :host { display: block; }
    h2 { margin: 0 0 1rem; font-size: var(--wa-font-size-l); }
    p { color: var(--wa-color-text-quiet); }
  `;

  render() {
    return html`
      <h2>Replication Preview</h2>
      <p>Use the "Preview" button in the replication editor to see a dry-run of which documents would be replicated.</p>
    `;
  }
}
