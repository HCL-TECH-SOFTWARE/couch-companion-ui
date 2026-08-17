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

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getRouter } from '../src/customEventRouter';
import type { RouterTransport } from '../src/transports/router-transport';

let router: ReturnType<typeof getRouter>;
beforeEach(() => {
  router = getRouter(true);
});

function makeTransport(id = 't1') {
  const sent: Array<[string, unknown]> = [];
  let handler: ((eventName: string, data: unknown) => void) | undefined;
  const transport: RouterTransport & { sent: typeof sent; inject: (e: string, d: unknown) => void } = {
    id,
    sent,
    send: (eventName, data) => { sent.push([eventName, data]); },
    onReceive: (h) => { handler = h; },
    destroy: () => {},
    inject: (e, d) => handler?.(e, d)
  };
  return transport;
}

describe('customEventRouter', () => {
  it('returns a singleton and resets on demand', () => {
    const a = getRouter();
    expect(getRouter()).toBe(a);
    expect(getRouter(true)).not.toBe(a);
  });

  it('delivers a published event with its detail payload', () => {
    const token = {};
    const cb = vi.fn();
    router.subscribe(token, 'evt-deliver', cb);
    router.publish('evt-deliver', { value: 42 });
    expect(cb).toHaveBeenCalledTimes(1);
    expect((cb.mock.calls[0][1] as CustomEvent).detail).toEqual({ value: 42 });
    router.unsubscribe(token);
  });

  it('stops delivering after unsubscribe', () => {
    const token = {};
    const cb = vi.fn();
    router.subscribe(token, 'evt-unsub', cb);
    router.unsubscribe(token);
    router.publish('evt-unsub', {});
    expect(cb).not.toHaveBeenCalled();
  });

  it('unsubscribeEvent removes a single event only', () => {
    const token = {};
    const cbA = vi.fn();
    const cbB = vi.fn();
    router.subscribe(token, 'evt-a', cbA);
    router.subscribe(token, 'evt-b', cbB);
    expect(router.unsubscribeEvent(token, 'evt-a')).toBe(true);
    router.publish('evt-a', {});
    router.publish('evt-b', {});
    expect(cbA).not.toHaveBeenCalled();
    expect(cbB).toHaveBeenCalledTimes(1);
    router.unsubscribe(token);
  });

  it('subscribe accepts an array of event names', () => {
    const token = {};
    const cb = vi.fn();
    router.subscribe(token, ['evt-x', 'evt-y'], cb);
    router.publish('evt-x', {});
    router.publish('evt-y', {});
    expect(cb).toHaveBeenCalledTimes(2);
    router.unsubscribe(token);
  });

  it('re-subscribing the same event replaces the callback', () => {
    const token = {};
    const first = vi.fn();
    const second = vi.fn();
    router.subscribe(token, 'evt-re', first);
    router.subscribe(token, 'evt-re', second);
    router.publish('evt-re', {});
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    router.unsubscribe(token);
  });

  it('exposes subscribers() and subscriptions() queries', () => {
    const token = {};
    router.subscribe(token, 'evt-q', vi.fn());
    expect(router.subscribers('evt-q')).toContain(token);
    expect(router.subscriptions(token)).toEqual(['evt-q']);
    router.unsubscribe(token);
    expect(router.subscribers('evt-q')).toEqual([]);
  });

  it('removes the window listener when the last subscriber leaves', () => {
    const token = {};
    router.subscribe(token, 'evt-win', vi.fn());
    expect(router.windowListeners.has('evt-win')).toBe(true);
    router.unsubscribe(token);
    expect(router.windowListeners.has('evt-win')).toBe(false);
  });

  it('publishTo delivers only to DOM subscribers matching the selector', () => {
    const match = document.createElement('div');
    match.className = 'target';
    const other = document.createElement('div');
    document.body.append(match, other);
    const cbMatch = vi.fn();
    const cbOther = vi.fn();
    router.subscribe(match, 'evt-sel', cbMatch);
    router.subscribe(other, 'evt-sel', cbOther);
    router.publishTo('.target', 'evt-sel', { hi: true });
    expect(cbMatch).toHaveBeenCalledTimes(1);
    expect(cbOther).not.toHaveBeenCalled();
    router.unsubscribe(match);
    router.unsubscribe(other);
    match.remove();
    other.remove();
  });

  it('validates arguments', () => {
    expect(() => router.subscribe(null as unknown as object, 'x')).toThrow();
    expect(() => router.publish('')).toThrow();
    expect(() => router.subscribers('')).toThrow();
  });

  it('invokes fromSubscription when a callback returns a value', () => {
    const token = { fromSubscription: vi.fn() };
    router.subscribe(token, 'evt-from', () => 'result');
    router.publish('evt-from', {});
    expect(token.fromSubscription).toHaveBeenCalledWith('result');
    router.unsubscribe(token);
  });

  it('forwards published events to transports unless local', () => {
    const t = makeTransport();
    router.addTransport(t);
    const token = {};
    router.subscribe(token, 'evt-t', vi.fn());
    router.publish('evt-t', { a: 1 });
    expect(t.sent).toEqual([['evt-t', { a: 1 }]]);
    router.publish('evt-t', { b: 2 }, { local: true });
    expect(t.sent).toEqual([['evt-t', { a: 1 }]]);
    router.unsubscribe(token);
    router.removeTransport(t);
  });

  it('does not re-forward events received from a transport (echo loop)', () => {
    const t = makeTransport();
    router.addTransport(t);
    const token = {};
    const cb = vi.fn();
    router.subscribe(token, 'evt-echo', cb);
    t.inject('evt-echo', { fromRemote: true });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(t.sent).toEqual([]);
    router.unsubscribe(token);
    router.removeTransport(t);
  });

  it('addTransport dedups by id, keeping only the first-registered transport', () => {
    const first = makeTransport('dup-id');
    const second = makeTransport('dup-id');
    router.addTransport(first);
    router.addTransport(second);
    const token = {};
    router.subscribe(token, 'evt-dedup', vi.fn());
    router.publish('evt-dedup', { a: 1 });
    expect(first.sent).toEqual([['evt-dedup', { a: 1 }]]);
    expect(second.sent).toEqual([]);
    router.unsubscribe(token);
    router.removeTransport(first);
  });

  it('removeTransport calls destroy() on the transport', () => {
    const t = makeTransport('destroy-me');
    let destroyed = false;
    t.destroy = () => { destroyed = true; };
    router.addTransport(t);
    router.removeTransport(t);
    expect(destroyed).toBe(true);
  });
});
