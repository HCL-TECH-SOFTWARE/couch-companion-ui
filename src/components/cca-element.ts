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

import { LitElement } from 'lit';
import type { PropertyValues } from 'lit';
import { property, state } from 'lit/decorators.js';
import { getRouter } from '../customEventRouter.js';
import type { PublishOptions } from '../customEventRouter.js';
import { applyLocaleDetail } from '../i18n.js';
import { getLogger } from '../services/log-service.js';

/**
 * Blocklist of keys that should never be assigned via _applyData
 * to prevent prototype pollution attacks.
 */
const PROTO_POLLUTION_BLOCKLIST = new Set(['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty']);

const log = getLogger('cca-element');

/**
 * Base class for all components, providing LitElement features and custom event router integration.
 * Components inheriting from CcaElement can subscribe/publish events via the router.
 */
export abstract class CcaElement extends LitElement {
  /**
   * Debug flag for this component instance. Set to true to enable debug logging for this instance.
   * Can be set at runtime per instance or via the HTML attribute.
   *
   * @example
   * // Enable debug in a subclass
   * class MyComponent extends CcaElement {
   *   constructor() {
   *     super();
   *     this.debug = true;
   *   }
   * }
   *
   * // Or in HTML: <my-component debug></my-component>
   */
  @property({ type: Boolean }) public debug = false;

  /**
   * The event router instance, injected from the nearest provider in the DOM tree.
   * Falls back to document-level provider if ancestor search fails (e.g., shadow DOM).
   */
  router?: ReturnType<typeof getRouter>;

  /**
   * Finds and returns the event router instance from the nearest cca-router-provider ancestor.
   * If not found (e.g., in shadow DOM or fragments), falls back to searching the entire document.
   * Used to inject the router dependency for event-driven communication.
   * @returns The router instance if found, undefined otherwise
   */
  protected _findRouter(): ReturnType<typeof getRouter> | undefined {
    let provider = this.closest('cca-router-provider') as HTMLElement & { router?: ReturnType<typeof getRouter> };
    if (!provider) {
      // Fallback: get the first provider in the document (global)
      // In case shadow-root or fragment so element can't find nearest cca-router-provider
      provider = document.querySelector('cca-router-provider') as HTMLElement & { router?: ReturnType<typeof getRouter> };
    }
    return provider?.router;
  }

  /**
   * Monotonic counter for fallback instance IDs when crypto.randomUUID is unavailable.
   */
  private static _nextId = 0;

  /**
   * Unique instance ID for DOM tracking only, not for security.
   * Uses crypto.randomUUID() if available, otherwise a counter-based fallback (guaranteed unique per instance).
   * This avoids weak PRNG and satisfies SonarQube.
   */
  private readonly _instanceId: string =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : String(CcaElement._nextId++);
  /**
   * Tracks whether the component has completed its first update lifecycle.
   * Used to trigger _onFirstUpdate() only once after the initial render.
   */
  @state() protected _initialized = false;

  private readonly _boundLocaleChanged = (ev: Event): void => {
    const detail = ev && typeof ev === 'object' && 'detail' in ev ? (ev as { detail: unknown }).detail : undefined;

    applyLocaleDetail(detail);
    this.onLocaleChanged(detail);
    this.requestUpdate();
  };

  // Note: Do NOT look up the router in the constructor!
  // The element is not in the DOM yet, so closest() would return null.
  // Router lookup happens in connectedCallback when the element is attached.

  // Component identity for debugging
  get componentId(): string {
    return this.id || `${this.tagName.toLowerCase()}-${this._instanceId}`;
  }

  connectedCallback(): void {
    super.connectedCallback();
    // Find router when element is in the DOM (this is the correct place!)
    this.router ??= this._findRouter();
    this._subscribeEvents();
    if (typeof window !== 'undefined') {
      window.addEventListener('locale-changed', this._boundLocaleChanged, true);
    }
    this._onConnect();
  }

  disconnectedCallback(): void {
    this._onDisconnect();
    if (typeof window !== 'undefined') {
      window.removeEventListener('locale-changed', this._boundLocaleChanged, true);
    }
    this._unsubscribeEvents();
    super.disconnectedCallback();
  }

  protected willUpdate(changedProperties: PropertyValues): void {
    super.willUpdate(changedProperties);
    this._onWillUpdate(changedProperties);
  }

  protected updated(changedProperties: PropertyValues): void {
    super.updated(changedProperties);
    if (!this._initialized) {
      this._initialized = true;
      this._onFirstUpdate();
    }
    this._onUpdated(changedProperties);
  }

  // Lifecycle extension points for subclasses
  protected _onConnect(): void {
    /* Lifecycle extension point */
  }
  protected _onDisconnect(): void {
    /* Lifecycle extension point */
  }
  protected _onWillUpdate(_changedProperties: PropertyValues): void {
    /* Lifecycle extension point */
  }
  protected _onFirstUpdate(): void {
    /* Lifecycle extension point */
  }
  protected _onUpdated(_changedProperties: PropertyValues): void {
    /* Lifecycle extension point */
  }

  protected onLocaleChanged(_detail: unknown): void {
    /* Locale extension point */
  }

  /**
   * Override in subclasses to declare event subscriptions: { eventName: callback }
   * Example: { 'my-event': this.onHandleEventRouter }
   * By default, no events are subscribed.
   */
  static get eventSubscriptions(): Record<string, ((el: HTMLElement, ev: Event) => void) | undefined> {
    return {};
  }

  /**
   * Publish an event via the router.
   * @param eventName - The name of the event to publish
   * @param data - The data payload for the event
   * @param options - Optional publish options. Pass `{ local: true }` to skip transport relay.
   */
  publish(eventName: string, data: unknown, options?: PublishOptions): void {
    if (!this.router) {
      this.warn(`Cannot publish event '${eventName}': No router found. Ensure <cca-router-provider> is in the DOM.`);
      return;
    }
    if (this.debug || this.router.debug) {
      this.log(`Publishing event: ${eventName}`, data);
    }
    this.router.publish(eventName, data, options);
  }

  /**
   * Conditional debug logging
   */
  protected log(message: string, ...args: unknown[]): void {
    log.debug(`[${this.componentId}] ${message}`, args.length ? { args } : undefined);
  }

  protected warn(message: string, ...args: unknown[]): void {
    log.warn(`[${this.componentId}] ${message}`, args.length ? { args } : undefined);
  }

  /**
   * Subscribe to events declared in eventSubscriptions.
   * Validates router availability and subscription configuration before subscribing.
   */
  _subscribeEvents(): void {
    const ctor = this.constructor as typeof CcaElement;
    const subs = ctor.eventSubscriptions;
    if (!this.router) {
      // Warn if component has subscriptions but no router
      if (subs && Object.keys(subs).length > 0) {
        this.warn('Component has eventSubscriptions but no router found. Ensure <cca-router-provider> is in the DOM.');
      }
      return;
    }
    if (!subs || Object.keys(subs).length === 0) {
      // No events specified, do not subscribe to anything
      return;
    }
    Object.keys(subs).forEach((eventName) => {
      const userCb = subs[eventName];
      // Always call onEventRouter first, then user callback if provided
      const wrappedCb = (subscriber: object, ev: Event): void => {
        // Always extract event.detail (not details)
        const detail = ev && typeof ev === 'object' && 'detail' in ev ? (ev as { detail: unknown }).detail : ev;
        if (this.debug || this.router?.debug) {
          this.log(`Received event: ${eventName}`, detail);
        }
        // Always call onEventRouter for transformDetails and property update
        this.onEventRouter(eventName, { detail });
        // Then call the user callback for extra logic (if not the default)
        if (userCb) {
          userCb.call(this, subscriber as HTMLElement, ev);
        }
      };
      this.router!.subscribe(this, eventName, wrappedCb);
    });
  }

  /**
   * Handles incoming events from the router.
   * Transforms event detail via transformDetails() and applies to properties via _applyData().
   * Override transformDetails() to customize how event data maps to component properties.
   * @param eventName - The name of the event being handled
   * @param event - The event object containing the detail payload
   */
  protected onEventRouter(eventName: string, event: { detail: unknown }): void {
    try {
      const data = this.transformDetails(event.detail);
      this._applyData(this, data);
    } catch (error) {
      this.onEventError(error, eventName, event.detail);
    }
  }

  /**
   * Automatically updates component properties if the keys in data match defined properties.
   * Uses `key in elem` to support Lit @property fields on the prototype.
   * Blocks prototype pollution keys explicitly.
   * @param data - The data object containing properties to apply
   */
  protected _applyData(elem: object, data: unknown): void {
    if (!data || typeof data !== 'object') return;
    const dataObj = data as Record<string, unknown>;
    Object.keys(dataObj).forEach((key) => {
      if (PROTO_POLLUTION_BLOCKLIST.has(key)) return;
      if (key in elem) {
        (elem as Record<string, unknown>)[key] = dataObj[key];
      }
    });
  }

  /**
   * Overridable method to transform event details before applying to properties.
   * Default: returns details as-is.
   * @param details - The raw event detail data
   * @returns The transformed data ready to be applied to component properties
   */
  protected transformDetails(details: unknown): unknown {
    return details;
  }

  /**
   * Overridable error handler for event processing.
   * @param error - The error that occurred during event handling
   * @param eventName - The name of the event that caused the error
   * @param details - The event detail data that was being processed
   */
  protected onEventError(error: unknown, eventName: string, details: unknown): void {
    this.warn(`Error handling event '${eventName}':`, error, details);
  }

  /**
   * Unsubscribe from all events.
   * Safe to call even if router is not available.
   */
  _unsubscribeEvents(): void {
    this.router?.unsubscribe(this);
  }
}
