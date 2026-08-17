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

import { html, css } from "lit";
import { property, state } from "lit/decorators.js";
import { CcaElement } from "./cca-element.js";
import { getContext } from "../context.js";
import type { StatusUpdate } from "../services/reachability-status-service.js";

/**
 * Renders a reachability dot for one server.
 *
 * Usage:
 * ```html
 * <cca-real-time-status id="server:abc" .reachable=${true}></cca-real-time-status>
 * ```
 *
 * The socket, its reconnect backoff, heartbeat and visibility handling all belong to
 * `ReachabilityStatusService` (#710). This component subscribes, renders, and re-emits
 * each update as a `cca-status-update` CustomEvent.
 */
export class CcaRealTimeStatus extends CcaElement {
  static styles = css`
    :host {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      font-size: var(--wa-font-size-s);
    }
    .dot {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .dot.up {
      background: var(--wa-color-success-fill-loud, #22c55e);
    }
    .dot.down {
      background: var(--wa-color-danger-fill-loud, #ef4444);
    }
    .dot.unknown {
      background: var(--wa-color-neutral-fill-loud, #94a3b8);
    }
    .label {
      color: var(--wa-color-text-quiet);
    }
  `;

  /** Server document ID, e.g. `server:uuid` */
  @property({ attribute: "id" }) id = "";

  /**
   * Current known reachability state — seeds the baseline the service sends, so the
   * server can detect and persist changes.
   */
  @property({ type: Boolean }) reachable = false;

  /** When present, shows a text label next to the dot. */
  @property({ type: Boolean, attribute: "show-label" }) showLabel = false;

  @state() private _status: StatusUpdate | null = null;

  private _unsubscribe: (() => void) | null = null;
  /** The `id` we subscribed for — see `updated()`. */
  private _subscribedId: string | null = null;

  override connectedCallback() {
    super.connectedCallback();
    this._subscribe();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._unsubscribeFromStatus();
  }

  override updated(changed: Map<string, unknown>) {
    // `changed.has("id")` alone is true on the *first* update too: tsconfig sets
    // useDefineForClassFields:false, so the `id = ""` field initializer runs through Lit's
    // accessor and lands in changedProperties with an `undefined` old value. Resubscribing
    // on that would open a second socket on every mount. Compare against the id we
    // actually subscribed with instead.
    if (changed.has("id") && this.id !== this._subscribedId) {
      this._unsubscribeFromStatus();
      this._subscribe();
    }
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private _subscribe() {
    if (!this.id) return;
    this._subscribedId = this.id;
    this._unsubscribe = getContext().reachabilityStatus.subscribe(
      this.id,
      (update) => this._onUpdate(update),
      this.reachable,
    );
  }

  private _unsubscribeFromStatus() {
    this._unsubscribe?.();
    this._unsubscribe = null;
    this._subscribedId = null;
  }

  private _onUpdate(update: StatusUpdate) {
    this._status = update;
    this.dispatchEvent(
      new CustomEvent<StatusUpdate>("cca-status-update", {
        detail: update,
        bubbles: true,
        composed: true,
      }),
    );
    this.publish("status:update", { update });
  }

  // ── Render ────────────────────────────────────────────────────────────────

  override render() {
    const up = this._status?.reachable;
    const dotClass = this._status == null ? "unknown" : up ? "up" : "down";
    const label =
      this._status == null ? "checking…" : up ? "Up" : "Unreachable";

    return html`
      <span class="dot ${dotClass}"></span>
      ${this.showLabel ? html`<span class="label">${label}</span>` : ""}
    `;
  }
}

customElements.define("cca-real-time-status", CcaRealTimeStatus);
