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

// Which modal overlay is topmost, right now?
//
// `wa-dialog` and `wa-drawer` render a native <dialog> and open it with showModal(), which joins the
// browser top layer. HTML then makes every node inert that is not a flattened descendant of the
// TOPMOST modal dialog — top-layer membership grants no exemption of its own. So anything that must
// stay clickable above a modal has to live inside it. See #712.
//
// This module knows nothing about what subscribes to it.

/** Web Awesome's overlay events are composed and bubbling, so one document listener sees them all. */
const SHOW_EVENT = 'wa-after-show';
const HIDE_EVENT = 'wa-after-hide';

type Listener = (overlay: Element | null) => void;

const openOverlays: Element[] = [];
const listeners = new Set<Listener>();
let lastReported: Element | null = null;
let wired = false;

/**
 * True when `element` is an overlay that opened a native modal dialog.
 *
 * Eight Web Awesome components emit `wa-after-show` — details, dialog, drawer, dropdown, popover,
 * select, time-input, tooltip — but only `wa-dialog` and `wa-drawer` render a <dialog> and call
 * showModal(). Testing for that property rather than the tag name covers drawers for free, excludes
 * tooltips by construction, and does not rot when Web Awesome adds a component.
 */
function isModalOverlay(element: Element): boolean {
  const nativeDialog = element.shadowRoot?.querySelector('dialog');
  if (!nativeDialog) return false;
  try {
    return nativeDialog.matches(':modal');
  } catch {
    // `:modal` is a young selector. A throw here would take the whole document listener with it.
    return false;
  }
}

/**
 * The topmost overlay still attached to the document.
 *
 * An overlay whose owning component unmounted on a route change never fires `wa-after-hide`, so it
 * would sit on the stack forever and we would relocate into a detached node.
 */
function topmostModal(): Element | null {
  for (let i = openOverlays.length - 1; i >= 0; i--) {
    if (!openOverlays[i].isConnected) openOverlays.splice(i, 1);
  }
  return openOverlays[openOverlays.length - 1] ?? null;
}

function notify(): void {
  const current = topmostModal();
  if (current === lastReported) return;
  lastReported = current;
  for (const listener of listeners) listener(current);
}

/** `event.target` retargets to the outermost shadow host; `composedPath()[0]` is the real emitter. */
function emitterOf(event: Event): Element | null {
  const emitter = event.composedPath()[0];
  return emitter instanceof Element ? emitter : null;
}

function onShow(event: Event): void {
  const emitter = emitterOf(event);
  if (!emitter || !isModalOverlay(emitter)) return;
  if (!openOverlays.includes(emitter)) openOverlays.push(emitter);
  notify();
}

function onHide(event: Event): void {
  const emitter = emitterOf(event);
  if (!emitter) return;
  // Not gated on isModalOverlay: by the time this fires, the dialog is closed and no longer :modal.
  const index = openOverlays.indexOf(emitter);
  if (index !== -1) openOverlays.splice(index, 1);
  notify();
}

/**
 * Calls `onChange` with the topmost open modal overlay, immediately and on every change.
 * Returns a function that unsubscribes.
 */
export function observeTopmostModal(onChange: Listener): () => void {
  if (!wired) {
    document.addEventListener(SHOW_EVENT, onShow);
    document.addEventListener(HIDE_EVENT, onHide);
    wired = true;
  }

  listeners.add(onChange);
  onChange(topmostModal());

  return () => {
    listeners.delete(onChange);
    if (listeners.size > 0) return;

    document.removeEventListener(SHOW_EVENT, onShow);
    document.removeEventListener(HIDE_EVENT, onHide);
    wired = false;
    openOverlays.length = 0;
    lastReported = null;
  };
}
