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
import '../src/components/cca-banner';
import type { CcaBanner } from '../src/components/cca-banner';

class WaStub extends LitElement {
  createRenderRoot() {
    return this;
  }
}

for (const tag of ['wa-icon']) {
  if (!customElements.get(tag)) {
    customElements.define(tag, class extends WaStub {});
  }
}

function mountEl(props: Partial<CcaBanner>): CcaBanner {
  const el = document.createElement('cca-banner') as CcaBanner;
  Object.assign(el, props);
  document.body.appendChild(el);
  return el;
}

async function updated(el: CcaBanner) {
  await el.updateComplete;
}

function requireShadowRoot(el: CcaBanner): ShadowRoot {
  if (!el.shadowRoot) throw new Error('Expected shadowRoot to exist');
  return el.shadowRoot;
}

describe('cca-banner', () => {
  let el: CcaBanner;

  afterEach(() => {
    el?.remove();
    vi.restoreAllMocks();
  });

  it('renders nothing when message is undefined', async () => {
    el = mountEl({});
    await updated(el);

    const root = requireShadowRoot(el);
    expect(root.querySelector('p')).toBeNull();
  });

  it('renders nothing when message is an empty string', async () => {
    el = mountEl({ message: '' });
    await updated(el);

    const root = requireShadowRoot(el);
    expect(root.querySelector('p')).toBeNull();
  });

  it('renders the message inside a p with role="status" when message is set', async () => {
    el = mountEl({ message: 'Maintenance tonight' });
    await updated(el);

    const root = requireShadowRoot(el);
    const p = root.querySelector('p');
    if (!p) throw new Error('expected <p>');
    expect(p.getAttribute('role')).toBe('status');
    expect(p.textContent).toContain('Maintenance tonight');
  });

  it('omits wa-icon when icon is not provided', async () => {
    el = mountEl({ message: 'hello' });
    await updated(el);

    const root = requireShadowRoot(el);
    expect(root.querySelector('wa-icon')).toBeNull();
  });

  it('renders wa-icon with given name when icon is provided', async () => {
    el = mountEl({ message: 'hello', icon: 'circle-info' });
    await updated(el);

    const root = requireShadowRoot(el);
    const icon = root.querySelector('wa-icon');
    if (!icon) throw new Error('expected wa-icon');
    expect(icon.getAttribute('name')).toBe('circle-info');
  });

  it('renders message inside an anchor with safety attributes when link is provided', async () => {
    el = mountEl({
      message: 'Read the notice',
      link: 'https://example.org/notice',
    });
    await updated(el);

    const root = requireShadowRoot(el);
    const anchor = root.querySelector('a');
    if (!anchor) throw new Error('expected anchor');
    expect(anchor.getAttribute('href')).toBe('https://example.org/notice');
    expect(anchor.getAttribute('target')).toBe('_blank');
    expect(anchor.getAttribute('rel')).toBe('noopener noreferrer');
    expect(anchor.textContent).toContain('Read the notice');
  });

  it('renders message without an anchor when link is not provided', async () => {
    el = mountEl({ message: 'plain announcement' });
    await updated(el);

    const root = requireShadowRoot(el);
    expect(root.querySelector('a')).toBeNull();
    expect(root.textContent).toContain('plain announcement');
  });
});
