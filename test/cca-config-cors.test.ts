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
import { getContext } from '../src/context';
import { CcaConfigCors } from '../src/plugins/config/cca-config-cors';
import type { NodeConfig } from '../src/plugins/config/types';

let mounted: HTMLElement[] = [];

async function mount(config: NodeConfig): Promise<CcaConfigCors> {
  const el = document.createElement('cca-config-cors') as CcaConfigCors;
  el.serverId = 'srv-1';
  el.config = config;
  document.body.appendChild(el);
  mounted.push(el);
  await el.updateComplete;
  return el;
}

describe('cca-config-cors', () => {
  let set: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    set = vi.spyOn(getContext().config, 'setConfigValue').mockResolvedValue('');
  });

  afterEach(() => {
    for (const el of mounted) el.remove();
    mounted = [];
  });

  it('enabling CORS sets enable_cors and seeds the standard cors defaults', async () => {
    const el = await mount({});
    await el.setEnabled(true);
    expect(set).toHaveBeenCalledWith('srv-1', 'chttpd', 'enable_cors', 'true');
    expect(set).toHaveBeenCalledWith('srv-1', 'cors', 'origins', '*');
    expect(set).toHaveBeenCalledWith('srv-1', 'cors', 'credentials', 'true');
    expect(set).toHaveBeenCalledWith(
      'srv-1',
      'cors',
      'methods',
      'GET, PUT, POST, HEAD, DELETE'
    );
  });

  it('disabling CORS sets enable_cors=false and does not seed defaults', async () => {
    const el = await mount({ chttpd: { enable_cors: 'true' }, cors: { origins: '*' } });
    await el.setEnabled(false);
    expect(set).toHaveBeenCalledWith('srv-1', 'chttpd', 'enable_cors', 'false');
    expect(set).not.toHaveBeenCalledWith('srv-1', 'cors', 'credentials', 'true');
  });

  it('does not re-seed defaults when origins already set', async () => {
    const el = await mount({ chttpd: { enable_cors: 'false' }, cors: { origins: 'http://a' } });
    await el.setEnabled(true);
    expect(set).toHaveBeenCalledWith('srv-1', 'chttpd', 'enable_cors', 'true');
    expect(set).toHaveBeenCalledTimes(1);
  });

  it('switching to all-domains writes origins=*', async () => {
    const el = await mount({ chttpd: { enable_cors: 'true' }, cors: { origins: 'http://a' } });
    await el.setMode('all');
    expect(set).toHaveBeenCalledWith('srv-1', 'cors', 'origins', '*');
  });

  it('addOrigin appends to the comma-separated origins list', async () => {
    const el = await mount({
      chttpd: { enable_cors: 'true' },
      cors: { origins: 'http://a, http://b' }
    });
    await el.addOrigin('http://c');
    expect(set).toHaveBeenCalledWith('srv-1', 'cors', 'origins', 'http://a, http://b, http://c');
  });

  it('removeOrigin drops an entry from the list', async () => {
    const el = await mount({
      chttpd: { enable_cors: 'true' },
      cors: { origins: 'http://a, http://b' }
    });
    await el.removeOrigin('http://a');
    expect(set).toHaveBeenCalledWith('srv-1', 'cors', 'origins', 'http://b');
  });

  it('gives the remove-origin button the shared outlined/row-action-button treatment (#112)', async () => {
    const el = await mount({
      chttpd: { enable_cors: 'true' },
      cors: { origins: 'http://a, http://b' }
    });
    const btn = el.shadowRoot!.querySelector('[data-remove-origin]')!;

    expect(btn.getAttribute('appearance')).toBe('outlined');
    expect(btn.classList.contains('row-action-button')).toBe(true);
  });

  it('repeats "li:hover" in the button-hover rule so it outranks the row-hover rule (#112)', () => {
    // Same specificity trap #110 shipped once: ".row-action-button::part(base):hover" alone
    // would be LESS specific than "li:hover .row-action-button::part(base)" and lose the
    // cascade every time the button is actually hovered (hovering it also satisfies
    // "li:hover" on its own ancestor). This pins the fix, not just the class/attribute wiring.
    const css = (CcaConfigCors.styles as { cssText: string }).cssText;
    expect(css).toMatch(/li:hover\s+\.row-action-button::part\(base\):hover\s*\{[^}]*background-color:\s*var\(--wa-color-fill-loud/);
  });

  it('emits cors-changed after a change', async () => {
    const el = await mount({ chttpd: { enable_cors: 'true' }, cors: { origins: '*' } });
    const listener = vi.fn();
    el.addEventListener('cors-changed', listener);
    await el.setMode('all');
    expect(listener).toHaveBeenCalled();
  });
});
