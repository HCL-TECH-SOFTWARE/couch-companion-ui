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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { html } from 'lit';
import { CcaElement } from '../src/components/cca-element';
import { getRouter } from '../src/customEventRouter';
import { getLocale } from '../src/i18n';
import { Logger } from '../src/services/log-service';
import '../src/components/cca-router-provider';

// Note: uses the Lit `static properties` API rather than the `@property`
// decorator. Decorator syntax in a file under test/ fails to parse under
// this project's Vite 8 (rolldown-vite/oxc) toolchain, because oxc only
// honors `experimentalDecorators` for files matched by tsconfig's `include`
// (["src", "vite-env.d.ts"]) - adding "test" there breaks `tsc --noEmit`
// (rootDir violation). `static properties` is reactively equivalent and is
// the pattern already used by other in-repo test harnesses (see
// `WaStub` in cca-banner.test.ts).
//
// `label` is declared with `declare` (type-only, erased at runtime) rather
// than a real class field: a real field would use native-class-field Define
// semantics under this toolchain's ES2022 target and shadow the reactive
// accessor Lit installs for it (see https://lit.dev/msg/class-field-shadowing).
// The default value is assigned in the constructor instead, which goes
// through the Lit-installed setter like `@property() label = ''` does in
// `src/**` (compiled there with `useDefineForClassFields: false`).
class HarnessElement extends CcaElement {
  static properties = { label: { type: String } };
  declare label: string;
  firstUpdateCount = 0;
  localeDetail: unknown = undefined;
  static get eventSubscriptions() {
    return { 'harness-apply': undefined };
  }
  constructor() {
    super();
    this.label = '';
  }
  protected _onFirstUpdate(): void {
    this.firstUpdateCount++;
  }
  protected onLocaleChanged(detail: unknown): void {
    this.localeDetail = detail;
  }
  render() {
    return html`<span>${this.label}</span>`;
  }
}
if (!customElements.get('harness-element')) {
  customElements.define('harness-element', HarnessElement);
}

let provider: HTMLElement;
beforeEach(() => {
  getRouter(true);
  provider = document.createElement('cca-router-provider');
  document.body.appendChild(provider);
});
afterEach(() => {
  document.querySelectorAll('harness-element').forEach((e) => e.remove());
  provider.remove();
  vi.restoreAllMocks();
});

function mountIn(parent: ParentNode): HarnessElement {
  const el = document.createElement('harness-element') as HarnessElement;
  parent.appendChild(el);
  return el;
}

describe('CcaElement', () => {
  it('injects the router from the nearest provider ancestor', () => {
    const el = mountIn(provider);
    expect(el.router).toBe(getRouter());
  });

  it('falls back to a document-level provider when no ancestor exists', () => {
    const el = mountIn(document.body);
    expect(el.router).toBe(getRouter());
  });

  it('runs _onFirstUpdate exactly once', async () => {
    const el = mountIn(provider);
    await el.updateComplete;
    el.label = 'changed';
    await el.updateComplete;
    expect(el.firstUpdateCount).toBe(1);
  });

  it('applies matching event-detail keys onto properties via the router', async () => {
    const el = mountIn(provider);
    await el.updateComplete;
    getRouter().publish('harness-apply', { label: 'from-event' });
    expect(el.label).toBe('from-event');
  });

  it('never assigns prototype-pollution keys', async () => {
    const el = mountIn(provider);
    await el.updateComplete;
    const protoBefore = Object.getPrototypeOf(el);
    getRouter().publish('harness-apply', JSON.parse('{"__proto__":{"polluted":true},"label":"safe"}'));
    expect(el.label).toBe('safe');
    expect(Object.getPrototypeOf(el)).toBe(protoBefore);
  });

  it('warns and no-ops when publishing without a router', () => {
    // Logger.warn's default target captures a direct reference to console.warn
    // at module-load time, so spying on `console.warn` afterward never
    // intercepts it. Spy on the Logger facade itself instead - the important
    // behavior is that publish() does not throw and does log a warning.
    const el = document.createElement('harness-element') as HarnessElement;
    const warnSpy = vi.spyOn(Logger, 'warn').mockImplementation(() => {});
    expect(() => el.publish('whatever', {})).not.toThrow();
    expect(warnSpy).toHaveBeenCalled();
  });

  it('handles locale-changed events and stops after disconnect', () => {
    const el = mountIn(provider);
    window.dispatchEvent(new CustomEvent('locale-changed', { detail: { locale: 'ar-SA' } }));
    expect(el.localeDetail).toEqual({ locale: 'ar-SA' });
    expect(getLocale()).toBe('ar-SA');

    el.remove();
    el.localeDetail = undefined;
    window.dispatchEvent(new CustomEvent('locale-changed', { detail: { locale: 'en-US' } }));
    expect(el.localeDetail).toBeUndefined();
  });
});
