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
import { LitElement } from 'lit';
import { getContext } from '../src/context';
import '../src/components/cca-not-found';
import type { CcaNotFound } from '../src/components/cca-not-found';

class WaStub extends LitElement {
  createRenderRoot() {
    return this;
  }
}

for (const tag of ['wa-card', 'wa-button', 'wa-icon']) {
  if (!customElements.get(tag)) {
    customElements.define(tag, class extends WaStub {});
  }
}

function getEl(): CcaNotFound {
  const el = document.createElement('cca-not-found') as CcaNotFound;
  document.body.appendChild(el);
  return el;
}

async function updated(el: CcaNotFound) {
  await el.updateComplete;
}

function queryRequired<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Expected element for selector: ${selector}`);
  }
  return element;
}

function requireShadowRoot(el: CcaNotFound): ShadowRoot {
  if (!el.shadowRoot) {
    throw new Error('Expected shadowRoot to exist');
  }
  return el.shadowRoot;
}

describe('cca-not-found', () => {
  let el: CcaNotFound;

  beforeEach(async () => {
    getContext();
    el = getEl();
    await updated(el);
  });

  afterEach(() => {
    el.remove();
    vi.restoreAllMocks();
  });

  it('renders not-found content and action button', () => {
    const root = requireShadowRoot(el);
    expect(queryRequired(root, 'h1').textContent).toContain('404');
    expect(root.textContent).toContain('We checked under every cushion — this page is still missing.');
    expect(root.querySelector('wa-button')).not.toBeNull();
    expect(root.textContent).toContain('The path not found:');
  });

  it('navigates to home when clicking Go home', async () => {
    const navigateSpy = vi.spyOn(getContext().router, 'navigate');

    const root = requireShadowRoot(el);
    const button = queryRequired<HTMLElement>(root, 'wa-button');
    button.click();

    expect(navigateSpy).toHaveBeenCalledWith('/');
  });
});
