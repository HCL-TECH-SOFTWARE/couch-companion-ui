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
import { customElement, state } from 'lit/decorators.js';

import { observeTopmostModal } from './modal-overlay-stack.js';

interface ToastMessage {
  id: number;
  text: string;
  variant: 'info' | 'success' | 'error';
}

interface ToastDraft {
  text: string;
  variant: ToastMessage['variant'];
  duration: number;
}

interface TimerState {
  timeoutId: ReturnType<typeof globalThis.setTimeout>;
  remainingMs: number;
  startedAtMs: number;
}

let nextId = 0;
const pendingMessages: ToastDraft[] = [];
const MAX_VISIBLE_TOASTS = 4;
const MAX_QUEUED_TOASTS = 20;
let _instance: CcaToast | null = null;

/**
 * A toast retained for the notifications panel (#53), independent of the live `messages`
 * array — it survives auto-dismiss and manual dismiss alike. Recorded the moment `show()`
 * is called, not when the toast actually becomes visible: a toast evicted from the display
 * queue before ever being shown (see `MAX_QUEUED_TOASTS` below) still represents something
 * that happened and belongs in the history.
 */
export interface ToastHistoryEntry {
  id: number;
  text: string;
  variant: ToastMessage['variant'];
  timestamp: number;
}

let nextHistoryId = 0;
const toastHistory: ToastHistoryEntry[] = [];
/**
 * History cap — a ring buffer, same shape as `MAX_VISIBLE_TOASTS`/`MAX_QUEUED_TOASTS` above.
 * Set higher than the 20-deep display queue: this is a session-long audit trail, not a
 * display backlog, so it can afford to remember further back.
 */
const MAX_TOAST_HISTORY = 50;

function recordHistory(text: string, variant: ToastMessage['variant']) {
  toastHistory.push({ id: nextHistoryId++, text, variant, timestamp: Date.now() });
  if (toastHistory.length > MAX_TOAST_HISTORY) {
    toastHistory.shift();
  }
}

/**
 * Returns the retained toast history, newest first, capped at {@link MAX_TOAST_HISTORY}.
 * Backs the notifications panel (#53).
 */
export function getToastHistory(): ToastHistoryEntry[] {
  return [...toastHistory].reverse();
}

/** Stacking toast container — queues overflow and pauses dismiss on hover so users can read long messages. */
@customElement('cca-toast')
export class CcaToast extends LitElement {
  static styles = css`
    :host {
      position: fixed;
      bottom: 1rem;
      right: 1rem;
      z-index: 1000;
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      max-width: min(360px, calc(100vw - 2rem));
      pointer-events: none;
    }
    .toast {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 0.5rem;
      align-items: start;
      padding: 0.75rem 1rem;
      border-radius: var(--wa-border-radius-m);
      font-size: var(--wa-font-size-s);
      animation: slide-in 200ms ease;
      pointer-events: auto;
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.2);
    }
    /* Each variant pairs a solid fill with the text colour the theme designs for it. The
       loud tiers are deliberately static across wa-light and wa-dark: a solid semantic
       toast keeps its colour, the way a solid button does. */
    .toast.info {
      background: var(--wa-color-brand-fill-loud);
      color: var(--wa-color-brand-on-loud);
    }
    .toast.success {
      background: var(--wa-color-success-fill-loud);
      color: var(--wa-color-success-on-loud);
    }
    .toast.error {
      background: var(--wa-color-danger-fill-loud);
      color: var(--wa-color-danger-on-loud);
    }
    .dismiss {
      appearance: none;
      border: 0;
      background: transparent;
      color: inherit;
      cursor: pointer;
      font: inherit;
      line-height: var(--wa-line-height-condensed);
      opacity: 0.9;
      padding: 0;
    }
    .dismiss:hover {
      opacity: 1;
    }
    @keyframes slide-in {
      from {
        transform: translateX(100%);
        opacity: 0;
      }
      to {
        transform: translateX(0);
        opacity: 1;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .toast {
        animation: none;
      }
    }
  `;

  @state() private messages: ToastMessage[] = [];
  private waitingQueue: ToastDraft[] = [];
  private timers = new Map<number, TimerState>();
  /** Where cca-shell rendered us. Captured on connect, so we can return to the exact slot. */
  private home: { parent: Node; nextSibling: ChildNode | null } | null = null;
  /** True only while we move ourselves between parents. See relocateTo(). */
  private relocating = false;
  private unobserveModal: (() => void) | null = null;

  connectedCallback() {
    super.connectedCallback();
    _instance = this;

    // A relocation disconnects and reconnects us. That is a move, not a mount: keep the
    // subscription and the home we already recorded.
    //
    // wa-dialog fires wa-after-show only once its open animation finishes, so a toast raised in
    // that ~200ms window stays inert until the event lands. That is acceptable: we are a
    // persistent singleton, so we relocate the instant it arrives, and the callers that matter
    // (a failed request behind an open dialog) toast long after the animation.
    if (!this.relocating) {
      if (!this.home && this.parentNode) {
        this.home = { parent: this.parentNode, nextSibling: this.nextSibling };
      }
      this.unobserveModal = observeTopmostModal((overlay) => this.relocateTo(overlay));
    }

    flushPending();
  }

  disconnectedCallback() {
    super.disconnectedCallback();

    // Likewise: a move must not be mistaken for a teardown, or every auto-dismiss timer dies and
    // the toasts hang on screen for ever, looking entirely correct.
    if (this.relocating) return;

    if (_instance === this) {
      _instance = null;
    }
    this.unobserveModal?.();
    this.unobserveModal = null;
    this.home = null;
    for (const timer of this.timers.values()) {
      globalThis.clearTimeout(timer.timeoutId);
    }
    this.timers.clear();
  }

  /**
   * Moves this element into `overlay`, or back to where it was rendered.
   *
   * A modal <dialog> makes everything outside it inert, and the browser top layer grants no
   * exemption — a `popover` promoted after the dialog is still inert and still painted underneath.
   * Living inside the dialog is the only way to stay clickable above one. See #712.
   */
  private relocateTo(overlay: Element | null) {
    if (overlay) {
      if (this.parentNode !== overlay) {
        this.withRelocation(() => overlay.append(this));
      }
      return;
    }

    const home = this.home;
    if (!home || this.parentNode === home.parent) {
      return;
    }
    // The recorded sibling may itself have been removed while we were away.
    const before = home.nextSibling?.parentNode === home.parent ? home.nextSibling : null;
    this.withRelocation(() => home.parent.insertBefore(this, before));
  }

  private withRelocation(move: () => void) {
    this.relocating = true;
    try {
      move();
    } finally {
      this.relocating = false;
    }
  }

  /**
   * Displays a toast or queues it if the visible limit is reached.
   * @param text - message content
   * @param variant - visual style: 'info' | 'success' | 'error'
   * @param duration - auto-dismiss delay in ms; 0 disables auto-dismiss
   */
  show(text: string, variant: ToastMessage['variant'] = 'info', duration = 4000) {
    const draft: ToastDraft = { text, variant, duration };
    recordHistory(text, variant);

    if (this.messages.length >= MAX_VISIBLE_TOASTS) {
      this.enqueue(draft);
      return;
    }

    this.present(draft);
  }

  private dismissById(id: number) {
    this.clearTimer(id);
    this.messages = this.messages.filter((m) => m.id !== id);
    this.promoteFromQueue();
  }

  private present(draft: ToastDraft) {
    const id = nextId++;
    this.messages = [...this.messages, { id, text: draft.text, variant: draft.variant }];
    this.scheduleDismiss(id, draft.duration);
  }

  private enqueue(draft: ToastDraft) {
    if (this.waitingQueue.length >= MAX_QUEUED_TOASTS) {
      this.waitingQueue.shift();
    }
    this.waitingQueue.push(draft);
  }

  private promoteFromQueue() {
    if (this.messages.length >= MAX_VISIBLE_TOASTS) {
      return;
    }

    const next = this.waitingQueue.shift();
    if (!next) {
      return;
    }

    this.present(next);
  }

  private scheduleDismiss(id: number, durationMs: number) {
    if (durationMs <= 0) {
      return;
    }

    const state: TimerState = {
      timeoutId: globalThis.setTimeout(() => {
        this.dismissById(id);
      }, durationMs),
      remainingMs: durationMs,
      startedAtMs: Date.now()
    };
    this.timers.set(id, state);
  }

  private clearTimer(id: number) {
    const timer = this.timers.get(id);
    if (!timer) {
      return;
    }
    globalThis.clearTimeout(timer.timeoutId);
    this.timers.delete(id);
  }

  private pauseDismiss(id: number) {
    const timer = this.timers.get(id);
    if (!timer) {
      return;
    }

    globalThis.clearTimeout(timer.timeoutId);
    const elapsed = Date.now() - timer.startedAtMs;
    timer.remainingMs = Math.max(0, timer.remainingMs - elapsed);
    this.timers.set(id, timer);
  }

  private resumeDismiss(id: number) {
    const timer = this.timers.get(id);
    if (!timer) {
      return;
    }

    if (timer.remainingMs <= 0) {
      this.dismissById(id);
      return;
    }

    timer.startedAtMs = Date.now();
    timer.timeoutId = globalThis.setTimeout(() => {
      this.dismissById(id);
    }, timer.remainingMs);
    this.timers.set(id, timer);
  }

  render() {
    return html`
      ${this.messages.map((m) => {
        const role = m.variant === 'error' ? 'alert' : 'status';
        const live = m.variant === 'error' ? 'assertive' : 'polite';
        return html`
          <div
            class="toast ${m.variant}"
            role=${role}
            aria-live=${live}
            @mouseenter=${() => this.pauseDismiss(m.id)}
            @mouseleave=${() => this.resumeDismiss(m.id)}
            @focusin=${() => this.pauseDismiss(m.id)}
            @focusout=${() => this.resumeDismiss(m.id)}>
            <span>${m.text}</span>
            <button class="dismiss" type="button" aria-label="Dismiss notification" @click=${() => this.dismissById(m.id)}>
              ×
            </button>
          </div>
        `;
      })}
    `;
  }
}

function flushPending() {
  if (!_instance || pendingMessages.length === 0) {
    return;
  }

  const queued = pendingMessages.splice(0, pendingMessages.length);
  for (const message of queued) {
    _instance.show(message.text, message.variant, message.duration);
  }
}

/**
 * Fire-and-forget toast helper — buffers messages if the component isn't mounted yet.
 * @param text - message content
 * @param variant - visual style: 'info' | 'success' | 'error'
 * @param duration - auto-dismiss delay in ms; 0 disables auto-dismiss
 */
export function toast(text: string, variant: ToastMessage['variant'] = 'info', duration = 4000) {
  if (!_instance) {
    _instance = document.querySelector('cca-toast') as CcaToast | null;
  }

  if (_instance) {
    _instance.show(text, variant, duration);
    return;
  }

  if (pendingMessages.length >= MAX_QUEUED_TOASTS) {
    pendingMessages.shift();
  }
  pendingMessages.push({ text, variant, duration });
}
