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
import { customElement, property, state, query } from 'lit/decorators.js';
import '@awesome.me/webawesome/dist/components/switch/switch.js';
import '@awesome.me/webawesome/dist/components/radio-group/radio-group.js';
import '@awesome.me/webawesome/dist/components/radio/radio.js';
import '@awesome.me/webawesome/dist/components/input/input.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import { getContext } from '../../context.js';
import { toast } from '../../components/cca-toast.js';
import type { NodeConfig } from './types.js';

/** CouchDB's standard CORS defaults, seeded when CORS is first enabled. */
const CORS_DEFAULTS: Record<string, string> = {
  origins: '*',
  credentials: 'true',
  methods: 'GET, PUT, POST, HEAD, DELETE',
  headers: 'accept, authorization, content-type, origin, referer, x-csrf-token'
};

/**
 * Friendlier editor over the CouchDB CORS config keys (`chttpd.enable_cors`
 * and `cors.*`). Each control persists immediately via the config service and
 * emits `cors-changed` so the parent reloads. Reads current state from the
 * `config` snapshot passed by the parent.
 */
@customElement('cca-config-cors')
export class CcaConfigCors extends LitElement {
  static styles = css`
    .row {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      margin-block: 0.75rem;
    }
    ul {
      list-style: none;
      padding: 0;
      margin: 0.5rem 0;
    }
    li {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.2rem 0;
    }
    li span {
      flex: 1;
      font-family: var(--wa-font-family-code, monospace);
    }
    /* Same row-action-button hover treatment cca-data-table.ts gives db-list.ts's row
     * actions (#112), reimplemented locally: this button renders in THIS component's
     * own shadow root (no cross-shadow composition boundary like a table's render()
     * column), so the rule can live here directly. The repeated "li:hover" prefix on
     * the second rule is required, not stylistic — see #110, which shipped once
     * without it and the button-hover state silently never rendered (dropping the
     * prefix makes that selector LESS specific than the row-hover one above, and
     * hovering the button always also satisfies "li:hover" on its own ancestor). */
    li:hover .row-action-button::part(base) {
      color: var(--wa-color-on-normal, var(--wa-color-neutral-on-normal));
      background-color: var(--wa-color-fill-normal, var(--wa-color-neutral-fill-normal));
      border-color: var(--wa-color-border-normal, var(--wa-color-neutral-border-normal));
    }
    li:hover .row-action-button::part(base):hover {
      color: var(--wa-color-on-loud, var(--wa-color-neutral-on-loud));
      background-color: var(--wa-color-fill-loud, var(--wa-color-neutral-fill-loud));
      border-color: transparent;
    }
    .intro {
      color: var(--wa-color-text-quiet);
    }
  `;

  @property({ type: String }) serverId = '';
  @property({ attribute: false }) config: NodeConfig = {};

  @state() private _saving = false;

  @query('[data-new-origin]') private _newOrigin?: HTMLInputElement;

  private get _enabled(): boolean {
    return this.config.chttpd?.enable_cors === 'true';
  }
  private get _origins(): string {
    return this.config.cors?.origins ?? '';
  }
  private get _restricted(): boolean {
    return this._enabled && this._origins !== '' && this._origins !== '*';
  }
  private get _originList(): string[] {
    return this._origins
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s && s !== '*');
  }

  private put(section: string, key: string, value: string): Promise<string> {
    return getContext().config.setConfigValue(this.serverId, section, key, value);
  }

  private emitChanged() {
    this.dispatchEvent(new CustomEvent('cors-changed', { bubbles: true, composed: true }));
  }

  private async run(fn: () => Promise<void>) {
    this._saving = true;
    try {
      await fn();
      this.emitChanged();
    } catch (err: unknown) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      this._saving = false;
    }
  }

  /** Enables/disables CORS; seeds the standard `cors.*` defaults on first enable. */
  async setEnabled(on: boolean) {
    await this.run(async () => {
      await this.put('chttpd', 'enable_cors', String(on));
      if (on && !this.config.cors?.origins) {
        for (const [key, value] of Object.entries(CORS_DEFAULTS)) {
          await this.put('cors', key, value);
        }
      }
    });
  }

  /** All-domains (`*`) vs a restricted origin list. */
  async setMode(mode: 'all' | 'restrict') {
    await this.run(async () => {
      const value = mode === 'all' ? '*' : this._originList.join(', ');
      await this.put('cors', 'origins', value);
    });
  }

  async addOrigin(url: string) {
    const trimmed = url.trim();
    if (!trimmed) return;
    const list = [...this._originList, trimmed];
    await this.run(() => this.put('cors', 'origins', list.join(', ')).then(() => undefined));
  }

  async removeOrigin(url: string) {
    const list = this._originList.filter((o) => o !== url);
    await this.run(() => this.put('cors', 'origins', list.join(', ')).then(() => undefined));
  }

  render() {
    return html`
      <p class="intro">
        Cross-Origin Resource Sharing (CORS) lets browser apps on other origins talk directly to this
        CouchDB server.
      </p>
      <div class="row">
        <wa-switch
          data-cors-toggle
          ?checked=${this._enabled}
          ?disabled=${this._saving}
          @change=${(e: Event) => void this.setEnabled((e.target as HTMLInputElement).checked)}
          >Enable CORS</wa-switch
        >
      </div>
      ${this._enabled
        ? html`
            <wa-radio-group
              data-origins-mode
              .value=${this._restricted ? 'restrict' : 'all'}
              @change=${(e: Event) =>
                void this.setMode((e.target as HTMLInputElement).value as 'all' | 'restrict')}>
              <wa-radio value="all">All domains (*)</wa-radio>
              <wa-radio value="restrict">Restrict to specific origins</wa-radio>
            </wa-radio-group>
            ${this._restricted
              ? html`
                  <ul>
                    ${this._originList.map(
                      (o) => html`<li>
                        <span data-origin>${o}</span>
                        <wa-button
                          data-remove-origin
                          size="small"
                          variant="danger"
                          appearance="outlined"
                          class="row-action-button"
                          @click=${() => void this.removeOrigin(o)}
                          ><wa-icon name="trash-can"></wa-icon
                        ></wa-button>
                      </li>`
                    )}
                  </ul>
                  <div class="row">
                    <wa-input data-new-origin placeholder="https://example.com"></wa-input>
                    <wa-button
                      data-add-origin
                      @click=${() => {
                        const input = this._newOrigin;
                        if (input) {
                          void this.addOrigin(input.value);
                          input.value = '';
                        }
                      }}
                      >Add</wa-button
                    >
                  </div>
                `
              : ''}
          `
        : ''}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'cca-config-cors': CcaConfigCors;
  }
}
