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

import type { RouterTransport } from './transports/router-transport.js';

/**
 * Callback signature for event subscriptions.
 * The first argument is the subscriber token (any object — not limited to DOM Elements).
 */
export type SubscriptionCallback = (subscriber: object, event: Event) => unknown;

/**
 * Options for publish(). Pass `{ local: true }` to skip transport relay and
 * deliver the event only within the current window/tab.
 */
export interface PublishOptions {
  /** When true, the event is dispatched locally only and NOT forwarded to transports. */
  local?: boolean;
}

interface FromSubscriptionCapable {
  fromSubscription?: (result: unknown) => void;
}

let customRouterInstance: CustomEventRouter | null = null;

/**
 * CustomEventRouter - A utility for managing custom events.
 *
 * Subscribers can be any object (DOM Element, plain object, class instance, etc.).
 * Transports can be added to relay events across browser tabs (BroadcastChannel)
 * or background threads (SharedWorker / Web Worker).
 */
class CustomEventRouter {
  // subscriber -> Map(eventName -> callback)
  private readonly _subscriptions: WeakMap<object, Map<string, SubscriptionCallback | undefined>> = new WeakMap();

  // eventName -> Set(subscribers)
  private readonly _eventRegistry: Map<string, Set<object>> = new Map();

  /** @internal - exposed for testing only */
  windowListeners: Map<string, EventListener> = new Map();

  /** Registered transports (BroadcastChannel, SharedWorker, etc.) */
  private readonly _transports: Map<string, RouterTransport> = new Map();

  /** Prevents re-broadcasting events that arrived from a transport (echo loop prevention). */
  private _receivingFromTransport = false;

  /**
   * Global debug flag. When true, all publish/subscribe traffic is logged to the console.
   * Set automatically by <cca-router-provider debug>.
   */
  public debug = false;

  // ---------------------------------------------------------------------------
  // Transport management
  // ---------------------------------------------------------------------------

  /**
   * Add a transport to relay events outside the current window context.
   * Inbound messages from the transport are injected into the local router.
   */
  addTransport = (transport: RouterTransport): void => {
    if (this._transports.has(transport.id)) return;
    this._transports.set(transport.id, transport);
    transport.onReceive((eventName, data) => {
      this._receivingFromTransport = true;
      try {
        this.publish(eventName, data, { local: true });
      } finally {
        this._receivingFromTransport = false;
      }
    });
  };

  /**
   * Remove and destroy a previously registered transport.
   */
  removeTransport = (transport: RouterTransport): void => {
    if (!this._transports.has(transport.id)) return;
    transport.destroy();
    this._transports.delete(transport.id);
  };

  // ---------------------------------------------------------------------------
  // Subscribe / Unsubscribe
  // ---------------------------------------------------------------------------

  /**
   * Subscribe a token (any object) to one or more events.
   *
   * The token can be a DOM Element, a plain object, a class instance — anything.
   * Use the same token to unsubscribe later.
   *
   * @example
   * // From a plain JS module (no Element needed)
   * const token = {};
   * router.subscribe(token, 'status:changed', (token, event) => { ... });
   * // cleanup:
   * router.unsubscribe(token);
   */
  subscribe = (subscriber: object, eventName: string | string[], callback?: SubscriptionCallback): void => {
    if (!subscriber || typeof subscriber !== 'object') {
      throw new Error('First argument must be a non-null object');
    }

    const eventNames = Array.isArray(eventName) ? eventName : [eventName];

    eventNames.forEach((name) => {
      if (!name || typeof name !== 'string') {
        throw new Error('Event name must be a non-empty string');
      }

      let subMap = this._subscriptions.get(subscriber);
      if (!subMap) {
        subMap = new Map();
      }

      if (subMap.has(name)) {
        this.unsubscribeEvent(subscriber, name);
        subMap = this._subscriptions.get(subscriber) ?? new Map();
      }

      subMap.set(name, callback);
      this._subscriptions.set(subscriber, subMap);

      if (!this._eventRegistry.has(name)) {
        this._eventRegistry.set(name, new Set());
        this._createWindowListener(name);
      }
      this._eventRegistry.get(name)!.add(subscriber);
    });
  };

  private readonly _createWindowListener = (eventName: string): void => {
    /* v8 ignore next */
    if (typeof window === 'undefined') return;

    const windowListener: EventListener = (event) => {
      const subscribers = this._eventRegistry.get(eventName);
      /* v8 ignore next */
      if (!subscribers || subscribers.size === 0) return;

      subscribers.forEach((subscriber) => {
        const subMap = this._subscriptions.get(subscriber);
        /* v8 ignore next */
        if (!subMap) return;

        const callback = subMap.get(eventName);
        if (!callback) return;

        const result = callback(subscriber, event);

        const target = subscriber as FromSubscriptionCapable;
        if (result !== undefined && typeof target.fromSubscription === 'function') {
          target.fromSubscription(result);
        }
      });
    };

    window.addEventListener(eventName, windowListener, true);
    this.windowListeners.set(eventName, windowListener);
  };

  unsubscribe = (subscriber: object): void => {
    if (!subscriber || typeof subscriber !== 'object') {
      throw new Error('Argument must be a non-null object');
    }

    const subMap = this._subscriptions.get(subscriber);
    if (!subMap) {
      return;
    }

    Array.from(subMap.keys()).forEach((eventName) => {
      this.unsubscribeEvent(subscriber, eventName);
    });

    this._subscriptions.delete(subscriber);
  };

  unsubscribeEvent = (subscriber: object, eventName: string): boolean => {
    if (!subscriber || typeof subscriber !== 'object') {
      throw new Error('First argument must be a non-null object');
    }

    const subMap = this._subscriptions.get(subscriber);
    if (!subMap) {
      return false;
    }

    if (!subMap.has(eventName)) {
      return false;
    }

    subMap.delete(eventName);

    if (subMap.size <= 0) {
      this._subscriptions.delete(subscriber);
    }

    const eventSet = this._eventRegistry.get(eventName);
    /* v8 ignore next */
    if (eventSet) {
      eventSet.delete(subscriber);
      if (eventSet.size <= 0) {
        this._removeWindowListener(eventName);
        this._eventRegistry.delete(eventName);
      }
    }
    return true;
  };

  private readonly _removeWindowListener = (eventName: string): void => {
    /* v8 ignore next */
    if (typeof window === 'undefined') return;

    const windowListener = this.windowListeners.get(eventName);
    /* v8 ignore next */
    if (windowListener) {
      window.removeEventListener(eventName, windowListener, true);
      this.windowListeners.delete(eventName);
    }
  };

  // ---------------------------------------------------------------------------
  // Query
  // ---------------------------------------------------------------------------

  subscribers = (eventName: string): object[] => {
    if (!eventName || typeof eventName !== 'string') {
      throw new Error('Event name must be a non-empty string');
    }

    const subs = this._eventRegistry.get(eventName);
    if (!subs || subs.size === 0) {
      return [];
    }

    return Array.from(subs);
  };

  subscriptions = (subscriber: object): string[] => {
    if (!subscriber || typeof subscriber !== 'object') {
      throw new Error('Argument must be a non-null object');
    }

    const subMap = this._subscriptions.get(subscriber);
    if (!subMap) {
      return [];
    }

    return Array.from(subMap.keys());
  };

  // ---------------------------------------------------------------------------
  // Publish
  // ---------------------------------------------------------------------------

  /**
   * Publish an event to all local subscribers, then relay via registered transports
   * (unless `options.local` is true or the event arrived from a transport).
   */
  publish = (eventName: string, data?: unknown, options?: PublishOptions): void => {
    if (!eventName || typeof eventName !== 'string') {
      throw new Error('Event name must be a non-empty string');
    }

    const subscribers = this._eventRegistry.get(eventName);
    if (!subscribers || subscribers.size === 0) {
      // Still forward to transports even when no local subscribers
      if (!options?.local && !this._receivingFromTransport) {
        this._forwardToTransports(eventName, data);
      }
      return;
    }

    /* v8 ignore next */
    if (typeof window === 'undefined') return;

    const event = new CustomEvent(eventName, {
      detail: data,
      bubbles: true,
      cancelable: false
    });
    window.dispatchEvent(event);

    // Forward to transports unless suppressed
    if (!options?.local && !this._receivingFromTransport) {
      this._forwardToTransports(eventName, data);
    }
  };

  private readonly _forwardToTransports = (eventName: string, data: unknown): void => {
    this._transports.forEach((transport) => {
      transport.send(eventName, data);
    });
  };

  /**
   * Publish an event directly to subscribers matching a CSS selector.
   * Does NOT relay via transports (selector is not meaningful cross-tab).
   */
  publishTo = (selector: string, eventName: string, data?: unknown): void => {
    if (!selector || typeof selector !== 'string') {
      throw new Error('Selector must be a non-empty string');
    }

    if (!eventName || typeof eventName !== 'string') {
      throw new Error('Event name must be a non-empty string');
    }

    const subscribers = this._eventRegistry.get(eventName);
    if (!subscribers || subscribers.size === 0) {
      return;
    }

    // Filter to subscribers that are DOM Elements matching the selector
    const snapshot = Array.from(subscribers).filter((s): s is Element => s instanceof Element && s.matches(selector));
    if (snapshot.length === 0) {
      return;
    }

    const event = new CustomEvent(eventName, {
      detail: data,
      bubbles: true,
      cancelable: false
    });

    snapshot.forEach((element) => {
      const subMap = this._subscriptions.get(element);
      const callback = subMap?.get(eventName);
      if (callback) {
        const result = callback(element, event);
        const target = element as Element & FromSubscriptionCapable;
        if (result !== undefined && typeof target.fromSubscription === 'function') {
          target.fromSubscription(result);
        }
      }
    });
  };
}

export type { CustomEventRouter };
export type { RouterTransport };

export const getRouter = (reset = false): CustomEventRouter => {
  if (!customRouterInstance || reset) {
    customRouterInstance = new CustomEventRouter();
  }
  return customRouterInstance;
};
