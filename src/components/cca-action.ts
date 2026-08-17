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
import { customElement, property } from 'lit/decorators.js';
import { getLogger } from '../services/log-service.js';

const log = getLogger('components/cca-action');

/** Allowed `wa-button` variants exposed by `cca-action`. */
export type CcaActionVariant = 'brand' | 'neutral' | 'success' | 'warning' | 'danger';

/**
 * Reusable toolbar action: a tooltip-wrapped icon button. Intended to be
 * rendered (and later added/cleared dynamically) by `cca-header` alongside its
 * fixed buttons. Presentational — click behaviour is supplied by consumers via
 * the `action` property.
 *
 * Identity: use the standard `id` attribute (`<cca-action id="save">`) so a host
 * like `cca-header` can track and clear specific actions. `id` is the native
 * `HTMLElement` property and is deliberately not redeclared as a reactive
 * property.
 *
 * Depends on `wa-tooltip`, `wa-button`, and `wa-icon` being registered, which
 * `cca-shell` ensures by importing `webawesome.js` once at startup.
 */
@customElement('cca-action')
export class CcaAction extends LitElement {
  static readonly styles = css`
    :host {
      display: inline-flex;
    }
  `;

  @property({ type: String }) accessor tooltip = '';
  @property({ type: String }) accessor icon = '';
  @property({ type: String }) accessor label = '';
  @property({ type: String }) accessor variant: CcaActionVariant = 'brand';
  @property({ type: Boolean, reflect: true }) accessor disabled = false;
  @property({ attribute: false }) accessor action: ((event: Event) => void) | undefined = undefined;

  private handleAction(event: Event) {
    if (this.disabled) return;
    if (this.action) {
      this.action(event);
      return;
    }
    log.info('clicked with no action handler', { label: this.label || this.icon });
  }

  render() {
    const tooltip = this.tooltip || this.icon;
    const label = this.label || this.icon;
    return html`
      <wa-tooltip for="open-action">${tooltip}</wa-tooltip>
      <wa-button
        id="open-action"
        class="toolbar-help-button"
        appearance="plain"
        pill
        variant=${this.variant}
        ?disabled=${this.disabled}
        @click=${this.handleAction}>
        <wa-icon name=${this.icon} label=${label} class="wa-font-size-l"></wa-icon>
      </wa-button>
    `;
  }
}
