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

import { afterEach, describe, expect, it } from 'vitest';

import { observeTopmostModal } from '../src/components/modal-overlay-stack.js';

/**
 * A stand-in for wa-dialog / wa-drawer: a host whose shadow root holds a native <dialog>.
 *
 * happy-dom returns false for `matches(':modal')` even after showModal(), so modality is stubbed
 * at exactly the seam the module reads. These tests exercise our stack logic; the browser's
 * inertness model is verified separately, in a real browser.
 */
function makeOverlay({ modal = true } = {}): HTMLElement {
  const host = document.createElement('div');
  const root = host.attachShadow({ mode: 'open' });
  const dialog = document.createElement('dialog');
  Object.defineProperty(dialog, 'matches', {
    value: (selector: string) => selector === ':modal' && modal,
  });
  root.append(dialog);
  document.body.append(host);
  return host;
}

/** A stand-in for wa-tooltip: emits the same event, has no <dialog>. */
function makeNonOverlay(): HTMLElement {
  const host = document.createElement('div');
  host.attachShadow({ mode: 'open' });
  document.body.append(host);
  return host;
}

const fire = (host: Element, name: 'wa-after-show' | 'wa-after-hide') =>
  host.dispatchEvent(new CustomEvent(name, { bubbles: true, composed: true }));

const cleanup: Array<() => void> = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()?.();
  document.body.innerHTML = '';
});

/** Subscribes and records every reported value, unsubscribing after the test. */
function observe() {
  const seen: Array<Element | null> = [];
  const stop = observeTopmostModal((overlay) => seen.push(overlay));
  cleanup.push(stop);
  return { seen, stop };
}

describe('observeTopmostModal', () => {
  it('reports null immediately when nothing is open', () => {
    const { seen } = observe();
    expect(seen).toEqual([null]);
  });

  it('reports a modal overlay when it opens, and null when it closes', () => {
    const { seen } = observe();
    const dialog = makeOverlay();

    fire(dialog, 'wa-after-show');
    expect(seen.at(-1)).toBe(dialog);

    fire(dialog, 'wa-after-hide');
    expect(seen.at(-1)).toBeNull();
  });

  it('ignores an emitter with no dialog in its shadow root (a tooltip)', () => {
    const { seen } = observe();
    fire(makeNonOverlay(), 'wa-after-show');
    expect(seen).toEqual([null]);
  });

  it('ignores a dialog that is open but not modal', () => {
    const { seen } = observe();
    fire(makeOverlay({ modal: false }), 'wa-after-show');
    expect(seen).toEqual([null]);
  });

  it('reports the topmost of nested overlays, and the one beneath when it closes', () => {
    const { seen } = observe();
    const outer = makeOverlay();
    const inner = makeOverlay();

    fire(outer, 'wa-after-show');
    fire(inner, 'wa-after-show');
    expect(seen.at(-1)).toBe(inner);

    fire(inner, 'wa-after-hide');
    expect(seen.at(-1)).toBe(outer);
  });

  it('prunes an overlay removed from the DOM without firing wa-after-hide', () => {
    const { seen } = observe();
    const stranded = makeOverlay();
    const later = makeOverlay();

    fire(stranded, 'wa-after-show');
    stranded.remove(); // its owning component unmounted on a route change

    fire(later, 'wa-after-show');
    fire(later, 'wa-after-hide');

    // Without pruning this reports `stranded`, and the toast relocates into a detached node.
    expect(seen.at(-1)).toBeNull();
  });

  it('stops reporting after unsubscribe, and detaches its document listeners', () => {
    const first = observe();
    first.stop();

    const dialog = makeOverlay();
    fire(dialog, 'wa-after-show');
    expect(first.seen).toEqual([null]); // no further reports

    // The last unsubscribe unwires the module, so a fresh subscriber starts from a clean stack.
    const second = observe();
    expect(second.seen).toEqual([null]);
  });

  it('does not report the same overlay twice in a row', () => {
    const { seen } = observe();
    const dialog = makeOverlay();

    fire(dialog, 'wa-after-show');
    fire(dialog, 'wa-after-show'); // a duplicate event must not re-notify
    expect(seen).toEqual([null, dialog]);
  });

  it('survives a modality check that throws', () => {
    const { seen } = observe();
    const host = document.createElement('div');
    const root = host.attachShadow({ mode: 'open' });
    const dialog = document.createElement('dialog');
    Object.defineProperty(dialog, 'matches', {
      value: () => {
        throw new Error(':modal is not supported');
      },
    });
    root.append(dialog);
    document.body.append(host);

    expect(() => fire(host, 'wa-after-show')).not.toThrow();
    expect(seen).toEqual([null]);
  });
});
