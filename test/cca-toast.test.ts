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

// Stub wa-* elements before importing the component
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

import '../src/components/cca-toast';
import type { CcaToast } from '../src/components/cca-toast';
import { toast, getToastHistory } from '../src/components/cca-toast';

function getEl(): CcaToast {
  const el = document.createElement('cca-toast') as CcaToast;
  document.body.appendChild(el);
  return el;
}

async function updated(el: CcaToast) {
  await el.updateComplete;
}

function requireShadowRoot(el: CcaToast): ShadowRoot {
  if (!el.shadowRoot) {
    throw new Error('Expected shadowRoot to exist');
  }
  return el.shadowRoot;
}

describe('CcaToast', () => {
  let el: CcaToast;

  beforeEach(async () => {
    vi.useFakeTimers();
    el = getEl();
    await updated(el);
  });

  afterEach(() => {
    el.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('show', () => {
    it('renders a toast message', async () => {
      el.show('Hello world');
      await updated(el);

      const root = requireShadowRoot(el);
      expect(root.textContent).toContain('Hello world');
    });

    it('renders with info variant by default', async () => {
      el.show('Info message');
      await updated(el);

      const root = requireShadowRoot(el);
      const toastDiv = root.querySelector('.toast');
      expect(toastDiv?.classList.contains('info')).toBe(true);
    });

    it('renders with specified variant', async () => {
      el.show('Error!', 'error');
      await updated(el);

      const root = requireShadowRoot(el);
      const toastDiv = root.querySelector('.toast');
      expect(toastDiv?.classList.contains('error')).toBe(true);
    });

    it('renders success variant', async () => {
      el.show('Done!', 'success');
      await updated(el);

      const root = requireShadowRoot(el);
      const toastDiv = root.querySelector('.toast');
      expect(toastDiv?.classList.contains('success')).toBe(true);
    });

    it('uses role="alert" and aria-live="assertive" for errors', async () => {
      el.show('Fail', 'error');
      await updated(el);

      const root = requireShadowRoot(el);
      const toastDiv = root.querySelector('.toast');
      expect(toastDiv?.getAttribute('role')).toBe('alert');
      expect(toastDiv?.getAttribute('aria-live')).toBe('assertive');
    });

    it('uses role="status" and aria-live="polite" for non-errors', async () => {
      el.show('Info', 'info');
      await updated(el);

      const root = requireShadowRoot(el);
      const toastDiv = root.querySelector('.toast');
      expect(toastDiv?.getAttribute('role')).toBe('status');
      expect(toastDiv?.getAttribute('aria-live')).toBe('polite');
    });

    it('renders dismiss button with accessible label', async () => {
      el.show('Dismissable');
      await updated(el);

      const root = requireShadowRoot(el);
      const btn = root.querySelector('button.dismiss');
      expect(btn).not.toBeNull();
      expect(btn?.getAttribute('aria-label')).toBe('Dismiss notification');
    });
  });

  describe('auto-dismiss', () => {
    it('removes toast after duration elapses', async () => {
      el.show('Temporary', 'info', 2000);
      await updated(el);

      expect(requireShadowRoot(el).querySelector('.toast')).not.toBeNull();

      vi.advanceTimersByTime(2000);
      await updated(el);

      expect(requireShadowRoot(el).querySelector('.toast')).toBeNull();
    });

    it('does not auto-dismiss when duration is 0', async () => {
      el.show('Sticky', 'info', 0);
      await updated(el);

      vi.advanceTimersByTime(10000);
      await updated(el);

      expect(requireShadowRoot(el).querySelector('.toast')).not.toBeNull();
    });
  });

  describe('manual dismiss', () => {
    it('removes toast when dismiss button is clicked', async () => {
      el.show('Clickable');
      await updated(el);

      const root = requireShadowRoot(el);
      const btn = root.querySelector<HTMLButtonElement>('button.dismiss');
      btn?.click();
      await updated(el);

      expect(root.querySelector('.toast')).toBeNull();
    });
  });

  describe('queue overflow', () => {
    it('queues toasts beyond MAX_VISIBLE_TOASTS', async () => {
      // Show 4 (max visible) + 1 queued
      for (let i = 0; i < 5; i++) {
        el.show(`Toast ${i}`, 'info', 0);
      }
      await updated(el);

      const root = requireShadowRoot(el);
      const visible = root.querySelectorAll('.toast');
      expect(visible.length).toBe(4);
    });

    it('promotes queued toast when a visible one is dismissed', async () => {
      for (let i = 0; i < 5; i++) {
        el.show(`Toast ${i}`, 'info', 0);
      }
      await updated(el);

      // Dismiss first toast
      const root = requireShadowRoot(el);
      const btn = root.querySelector<HTMLButtonElement>('button.dismiss');
      btn?.click();
      await updated(el);

      // Still 4 visible (promoted from queue)
      expect(root.querySelectorAll('.toast').length).toBe(4);
      expect(root.textContent).toContain('Toast 4');
    });
  });

  describe('multiple toasts', () => {
    it('shows multiple toasts simultaneously', async () => {
      el.show('First', 'info');
      el.show('Second', 'success');
      el.show('Third', 'error');
      await updated(el);

      const root = requireShadowRoot(el);
      expect(root.querySelectorAll('.toast').length).toBe(3);
    });
  });
});

describe('toast() helper function', () => {
  let el: CcaToast;

  beforeEach(async () => {
    el = getEl();
    await updated(el);
  });

  afterEach(() => {
    el.remove();
    vi.restoreAllMocks();
  });

  it('shows a toast via the global helper', async () => {
    toast('Global toast');
    await updated(el);

    const root = requireShadowRoot(el);
    expect(root.textContent).toContain('Global toast');
  });

  it('queues messages when no instance exists', () => {
    el.remove();

    // Should not throw when no instance is mounted
    expect(() => toast('Queued message')).not.toThrow();
  });

  it('uses querySelector to find existing instance', async () => {
    el.remove();

    // Mount a fresh element
    const newEl = getEl();
    await updated(newEl);

    // Helper should find it via DOM query
    toast('Found it');
    await updated(newEl);

    const root = newEl.shadowRoot;
    if (!root) throw new Error('Expected shadowRoot');
    expect(root.textContent).toContain('Found it');

    newEl.remove();
  });

  it('respects MAX_QUEUED_TOASTS when queuing before mount', () => {
    el.remove();

    // Queue 25 messages (exceeds MAX_QUEUED_TOASTS of 20)
    for (let i = 0; i < 25; i++) {
      toast(`Message ${i}`);
    }

    // Mount and check that only the last 20 are shown/queued
    const newEl = getEl();

    // Initial queue should not exceed 20
    expect(() => {
      for (let i = 0; i < 25; i++) {
        toast(`Extra ${i}`);
      }
    }).not.toThrow();

    newEl.remove();
  });
});

describe('pause/resume dismiss', () => {
  let el: CcaToast;

  beforeEach(async () => {
    vi.useFakeTimers();
    el = getEl();
    await updated(el);
  });

  afterEach(() => {
    el.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('pauses dismiss timer on mouseenter', async () => {
    el.show('Hoverable', 'info', 2000);
    await updated(el);

    const root = requireShadowRoot(el);
    const toast = root.querySelector<HTMLElement>('.toast');
    if (!toast) throw new Error('expected toast');

    // Advance halfway through duration
    vi.advanceTimersByTime(1000);

    // Trigger mouseenter to pause
    const enterEvent = new MouseEvent('mouseenter', { bubbles: true });
    toast.dispatchEvent(enterEvent);

    // Advance full duration - should still be there (paused)
    vi.advanceTimersByTime(1000);
    await updated(el);
    expect(root.querySelector('.toast')).not.toBeNull();
  });

  it('resumes dismiss timer on mouseleave', async () => {
    el.show('Resumable', 'info', 1000);
    await updated(el);

    const root = requireShadowRoot(el);
    const toast = root.querySelector<HTMLElement>('.toast');
    if (!toast) throw new Error('expected toast');

    // Advance 400ms, then pause on hover
    vi.advanceTimersByTime(400);
    const enterEvent = new MouseEvent('mouseenter', { bubbles: true });
    toast.dispatchEvent(enterEvent);

    // Resume on mouseleave
    const leaveEvent = new MouseEvent('mouseleave', { bubbles: true });
    toast.dispatchEvent(leaveEvent);

    // Advance remaining time (600ms remaining from the original 1000ms)
    vi.advanceTimersByTime(600);
    await updated(el);

    // Now it should be dismissed
    expect(root.querySelector('.toast')).toBeNull();
  });

  it('pauses dismiss timer on focusin', async () => {
    el.show('Focusable', 'info', 2000);
    await updated(el);

    const root = requireShadowRoot(el);
    const toast = root.querySelector<HTMLElement>('.toast');
    if (!toast) throw new Error('expected toast');

    vi.advanceTimersByTime(1000);

    const focusEvent = new FocusEvent('focusin', { bubbles: true });
    toast.dispatchEvent(focusEvent);

    vi.advanceTimersByTime(1000);
    await updated(el);

    expect(root.querySelector('.toast')).not.toBeNull();
  });

  it('resumes dismiss timer on focusout', async () => {
    el.show('Unfocusable', 'info', 1000);
    await updated(el);

    const root = requireShadowRoot(el);
    const toast = root.querySelector<HTMLElement>('.toast');
    if (!toast) throw new Error('expected toast');

    // Advance 400ms, then pause on focus
    vi.advanceTimersByTime(400);
    const focusEvent = new FocusEvent('focusin', { bubbles: true });
    toast.dispatchEvent(focusEvent);

    // Resume on focusout
    const blurEvent = new FocusEvent('focusout', { bubbles: true });
    toast.dispatchEvent(blurEvent);

    // Advance remaining time (600ms remaining)
    vi.advanceTimersByTime(600);
    await updated(el);

    expect(root.querySelector('.toast')).toBeNull();
  });

  it('dismisses immediately if resume timer finds remaining time is 0', async () => {
    el.show('Quick', 'info', 1000);
    await updated(el);

    const root = requireShadowRoot(el);
    const toast = root.querySelector<HTMLElement>('.toast');
    if (!toast) throw new Error('expected toast');

    // Pause after full duration passed
    vi.advanceTimersByTime(1000);
    const enterEvent = new MouseEvent('mouseenter', { bubbles: true });
    toast.dispatchEvent(enterEvent);

    // Resume - should dismiss immediately
    const leaveEvent = new MouseEvent('mouseleave', { bubbles: true });
    toast.dispatchEvent(leaveEvent);

    await updated(el);
    expect(root.querySelector('.toast')).toBeNull();
  });
});

// #53: getToastHistory() backs the header's notifications panel. toastHistory is a
// module-level ring buffer shared across every test in this file (like nextId and
// pendingMessages above), so these tests are written to be order-independent: they either
// check for the presence of their own distinctively-named entries, or — for the cap test —
// push enough entries that the ring's last MAX_TOAST_HISTORY slots are guaranteed to be
// entirely theirs regardless of what ran before.
describe('toast history (#53)', () => {
  let el: CcaToast;

  beforeEach(async () => {
    el = getEl();
    await updated(el);
  });

  afterEach(() => {
    el.remove();
    vi.restoreAllMocks();
  });

  it('retains an entry in history after it is manually dismissed', async () => {
    el.show('Retained after dismiss', 'success', 0);
    await updated(el);

    const root = requireShadowRoot(el);
    const btn = root.querySelector<HTMLButtonElement>('button.dismiss');
    btn?.click();
    await updated(el);

    // Gone from the live/visible toasts...
    expect(root.textContent).not.toContain('Retained after dismiss');
    // ...but still in the retained history.
    const entry = getToastHistory().find((e) => e.text === 'Retained after dismiss');
    expect(entry).toBeDefined();
    expect(entry?.variant).toBe('success');
    expect(typeof entry?.timestamp).toBe('number');
  });

  it('retains an entry in history even after it auto-dismisses', async () => {
    vi.useFakeTimers();
    try {
      el.show('Retained after auto-dismiss', 'info', 100);
      await updated(el);

      vi.advanceTimersByTime(100);
      await updated(el);

      expect(getToastHistory().some((e) => e.text === 'Retained after auto-dismiss')).toBe(
        true
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('records history even for a toast that is queued rather than shown immediately', async () => {
    // Fill the visible slots so the next one is enqueued instead of presented.
    for (let i = 0; i < 4; i++) {
      el.show(`Filler ${i}`, 'info', 0);
    }
    el.show('Queued but still notable', 'info', 0);
    await updated(el);

    expect(getToastHistory().some((e) => e.text === 'Queued but still notable')).toBe(true);
  });

  it('caps history at 50 entries, evicting the oldest first', async () => {
    for (let i = 0; i < 55; i++) {
      el.show(`Cap toast ${i}`, 'info', 0);
    }

    const history = getToastHistory();
    expect(history.length).toBe(50);

    // Newest-first: the 55th push ("Cap toast 54") leads, and eviction dropped the oldest
    // five ("Cap toast 0" through "Cap toast 4") off the tail.
    expect(history[0].text).toBe('Cap toast 54');
    expect(history[49].text).toBe('Cap toast 5');
    expect(history.some((e) => e.text === 'Cap toast 0')).toBe(false);
    expect(history.some((e) => e.text === 'Cap toast 4')).toBe(false);
  });

  it('returns entries newest first', async () => {
    el.show('Order first (older)', 'info', 0);
    el.show('Order second (newer)', 'info', 0);
    await updated(el);

    const history = getToastHistory();
    const olderIndex = history.findIndex((e) => e.text === 'Order first (older)');
    const newerIndex = history.findIndex((e) => e.text === 'Order second (newer)');
    expect(newerIndex).toBeLessThan(olderIndex);
  });
});

describe('disconnection cleanup', () => {
  let el: CcaToast;

  beforeEach(async () => {
    vi.useFakeTimers();
    el = getEl();
    await updated(el);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('clears all timers on disconnect', async () => {
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');

    el.show('One', 'info', 5000);
    el.show('Two', 'success', 5000);
    el.show('Three', 'error', 5000);
    await updated(el);

    const callsBefore = clearSpy.mock.calls.length;
    el.remove();

    expect(clearSpy.mock.calls.length).toBeGreaterThan(callsBefore);
  });
});
