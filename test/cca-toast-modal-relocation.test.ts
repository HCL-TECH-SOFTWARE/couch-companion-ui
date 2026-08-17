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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '../src/components/cca-toast.js';
import type { CcaToast } from '../src/components/cca-toast.js';
import { toast } from '../src/components/cca-toast.js';

/** A stand-in for wa-dialog: a host whose shadow root holds a modal native <dialog>. */
function makeOverlay(): HTMLElement {
  const host = document.createElement('div');
  const root = host.attachShadow({ mode: 'open' });
  const dialog = document.createElement('dialog');
  Object.defineProperty(dialog, 'matches', {
    value: (selector: string) => selector === ':modal',
  });
  root.append(dialog);
  document.body.append(host);
  return host;
}

const fire = (host: Element, name: 'wa-after-show' | 'wa-after-hide') =>
  host.dispatchEvent(new CustomEvent(name, { bubbles: true, composed: true }));

const shadowOf = (el: CcaToast): ShadowRoot => {
  if (!el.shadowRoot) throw new Error('expected a shadowRoot');
  return el.shadowRoot;
};

describe('CcaToast relocation into a modal overlay', () => {
  let home: HTMLElement;
  let marker: HTMLElement;
  let el: CcaToast;

  beforeEach(async () => {
    vi.useFakeTimers();
    home = document.createElement('div');
    el = document.createElement('cca-toast') as CcaToast;
    // A sibling AFTER the toast, so "returns home" can mean the exact slot, not merely the parent.
    marker = document.createElement('span');
    home.append(el, marker);
    document.body.append(home);
    await el.updateComplete;
  });

  afterEach(() => {
    home.remove();
    document.body.innerHTML = '';
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('moves into the overlay when a modal dialog opens', async () => {
    const overlay = makeOverlay();
    fire(overlay, 'wa-after-show');
    await el.updateComplete;

    expect(el.parentElement).toBe(overlay);
  });

  it('returns to its exact home position when the dialog closes', async () => {
    const overlay = makeOverlay();
    fire(overlay, 'wa-after-show');
    fire(overlay, 'wa-after-hide');
    await el.updateComplete;

    expect(el.parentElement).toBe(home);
    expect(el.nextSibling).toBe(marker);
  });

  it('follows the topmost overlay when dialogs nest, and back again', async () => {
    const outer = makeOverlay();
    const inner = makeOverlay();

    fire(outer, 'wa-after-show');
    expect(el.parentElement).toBe(outer);

    fire(inner, 'wa-after-show');
    expect(el.parentElement).toBe(inner);

    fire(inner, 'wa-after-hide');
    expect(el.parentElement).toBe(outer);

    fire(outer, 'wa-after-hide');
    expect(el.parentElement).toBe(home);
  });

  // The load-bearing test. Relocation fires disconnectedCallback, which clears every timer.
  // Unguarded, this fails: the toast stays on screen for ever, looking perfectly correct.
  it('keeps auto-dismiss timers alive across a relocation', async () => {
    el.show('boom', 'error', 4000);
    await el.updateComplete;
    expect(shadowOf(el).textContent).toContain('boom');

    fire(makeOverlay(), 'wa-after-show');
    await el.updateComplete;

    vi.advanceTimersByTime(4000);
    await el.updateComplete;

    expect(shadowOf(el).textContent).not.toContain('boom');
  });

  it('keeps serving the toast() helper after a relocation', async () => {
    fire(makeOverlay(), 'wa-after-show');
    await el.updateComplete;

    toast('after the move', 'info');
    await el.updateComplete;

    expect(shadowOf(el).textContent).toContain('after the move');
  });

  it('tears down for real when it is removed from the document', () => {
    el.show('pending', 'info', 4000);
    el.remove();

    // A genuine disconnect must still clear timers; nothing should fire after removal.
    expect(() => vi.advanceTimersByTime(4000)).not.toThrow();
    expect(el.isConnected).toBe(false);
  });
});
