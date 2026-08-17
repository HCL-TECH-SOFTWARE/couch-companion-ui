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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Logger, Level } from '../src/services/log-service';

import '../src/components/cca-action';
import type { CcaAction } from '../src/components/cca-action';

function getEl(): CcaAction {
  const el = document.createElement('cca-action') as CcaAction;
  document.body.appendChild(el);
  return el;
}

async function updated(el: CcaAction) {
  await el.updateComplete;
}

function requireShadowRoot(el: CcaAction): ShadowRoot {
  if (!el.shadowRoot) throw new Error('expected shadowRoot');
  return el.shadowRoot;
}

function queryRequired<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`expected element for selector: ${selector}`);
  return element;
}

describe('cca-action', () => {
  let el: CcaAction;

  beforeEach(async () => {
    el = getEl();
    await updated(el);
  });

  afterEach(() => {
    el.remove();
    vi.restoreAllMocks();
  });

  describe('rendering', () => {
    it('renders a wa-button with the default brand variant', () => {
      const btn = queryRequired(requireShadowRoot(el), 'wa-button');
      expect(btn.getAttribute('variant')).toBe('brand');
    });

    it('reflects an overridden variant onto the wa-button', async () => {
      el.variant = 'danger';
      await updated(el);
      const btn = queryRequired(requireShadowRoot(el), 'wa-button');
      expect(btn.getAttribute('variant')).toBe('danger');
    });

    it('passes icon and label to wa-icon', async () => {
      el.icon = 'gear';
      el.label = 'Settings';
      await updated(el);
      const icon = queryRequired(requireShadowRoot(el), 'wa-icon');
      expect(icon.getAttribute('name')).toBe('gear');
      expect(icon.getAttribute('label')).toBe('Settings');
    });

    it('renders the tooltip text', async () => {
      el.tooltip = 'Save changes';
      await updated(el);
      const tip = queryRequired(requireShadowRoot(el), 'wa-tooltip');
      expect(tip.textContent).toContain('Save changes');
    });
  });

  describe('icon fallback', () => {
    it('falls back to icon for tooltip and label when omitted', async () => {
      el.icon = 'gear';
      await updated(el);
      const root = requireShadowRoot(el);
      expect(queryRequired(root, 'wa-tooltip').textContent).toContain('gear');
      expect(queryRequired(root, 'wa-icon').getAttribute('label')).toBe('gear');
    });

    it('prefers explicit tooltip and label over the icon fallback', async () => {
      el.icon = 'gear';
      el.tooltip = 'Settings';
      el.label = 'Open settings';
      await updated(el);
      const root = requireShadowRoot(el);
      expect(queryRequired(root, 'wa-tooltip').textContent).toContain('Settings');
      expect(queryRequired(root, 'wa-icon').getAttribute('label')).toBe('Open settings');
    });
  });

  describe('action handling', () => {
    it('calls the action with the click event when set', async () => {
      const handler = vi.fn();
      el.action = handler;
      await updated(el);
      const btn = queryRequired<HTMLElement>(requireShadowRoot(el), 'wa-button');
      btn.click();
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0]).toBeInstanceOf(Event);
    });

    it('logs via the log-service when no action is set', async () => {
      const infoSpy = vi.fn();
      const original = Logger.logTarget[Level.INFO];
      Logger.logTarget[Level.INFO] = infoSpy;
      try {
        el.icon = 'gear';
        await updated(el);
        const btn = queryRequired<HTMLElement>(requireShadowRoot(el), 'wa-button');
        btn.click();
        expect(infoSpy).toHaveBeenCalled();
      } finally {
        Logger.logTarget[Level.INFO] = original;
      }
    });

    it('renders a disabled wa-button when disabled is set', async () => {
      el.icon = 'floppy-disk';
      el.disabled = true;
      await updated(el);
      const btn = queryRequired(requireShadowRoot(el), 'wa-button');
      expect(btn.hasAttribute('disabled')).toBe(true);
    });

    it('does not invoke action when disabled', async () => {
      el.icon = 'floppy-disk';
      el.disabled = true;
      let called = 0;
      el.action = () => {
        called += 1;
      };
      await updated(el);
      const btn = queryRequired<HTMLElement>(requireShadowRoot(el), 'wa-button');
      btn.click();
      expect(called).toBe(0);
    });
  });

  describe('identity', () => {
    it('exposes the standard id property for host tracking', () => {
      el.id = 'save-action';
      expect(el.id).toBe('save-action');
      expect(document.querySelector('cca-action#save-action')).toBe(el);
    });
  });
});
