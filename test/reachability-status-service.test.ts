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

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ReachabilityStatusService, type StatusUpdate } from "../src/services/reachability-status-service";
import type { ApiClient } from "../src/services/api-client";

const HEARTBEAT_MS = 15_000;

const fakeApi = () =>
  ({ request: vi.fn() }) as unknown as ApiClient & { request: ReturnType<typeof vi.fn> };

const upThenWelcome = (api: ReturnType<typeof fakeApi>, version = "3.5.0") => {
  api.request.mockImplementation((_m: string, path: string) => {
    if (path === "/_up") return Promise.resolve({ status: "ok" });
    if (path === "/") return Promise.resolve({ couchdb: "Welcome", version });
    return Promise.reject(new Error(`unexpected ${path}`));
  });
};

// Every subscribe() call's returned unsub is pushed here; afterEach drains the list so
// no session (and no visibilitychange listener on the shared `document`) outlives its
// test. A test that unsubscribes explicitly mid-test still pushes its unsub — the drain
// then calls it a second time, which Session.remove/destroy tolerate (Set/Map .delete on
// an already-absent entry just returns false, it never throws), so the repeat call is a
// safe no-op.
const cleanups: Array<() => void> = [];

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  vi.useRealTimers();
});

const flush = async () => {
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
};

describe("polling reachability", () => {
  it("checks immediately on first subscribe and reports up with version", async () => {
    const api = fakeApi();
    upThenWelcome(api);
    const svc = new ReachabilityStatusService(api);
    const updates: StatusUpdate[] = [];
    const unsub = svc.subscribe("srv", (u) => updates.push(u));
    cleanups.push(unsub);
    await flush();
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ id: "srv", reachable: true, couch_version: "3.5.0" });
    expect(typeof updates[0].checked_at).toBe("string");
  });

  it("polls every 15s while subscribed and stops after last unsubscribe", async () => {
    const api = fakeApi();
    upThenWelcome(api);
    const svc = new ReachabilityStatusService(api);
    const updates: StatusUpdate[] = [];
    const unsub = svc.subscribe("srv", (u) => updates.push(u));
    cleanups.push(unsub);
    await flush();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(updates).toHaveLength(3);
    unsub();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 3);
    expect(updates).toHaveLength(3);
  });

  it("reports unreachable when /_up fails, without version fetch", async () => {
    const api = fakeApi();
    api.request.mockRejectedValue(new TypeError("net"));
    const svc = new ReachabilityStatusService(api);
    const updates: StatusUpdate[] = [];
    const unsub = svc.subscribe("srv", (u) => updates.push(u));
    cleanups.push(unsub);
    await flush();
    expect(updates[0]).toMatchObject({ reachable: false, couch_version: null });
    expect(api.request).toHaveBeenCalledTimes(1); // no GET / after a failed /_up
  });

  it("replays the last status to a second subscriber without a new check", async () => {
    const api = fakeApi();
    upThenWelcome(api);
    const svc = new ReachabilityStatusService(api);
    const unsub1 = svc.subscribe("srv", () => undefined);
    cleanups.push(unsub1);
    await flush();
    const calls = api.request.mock.calls.length;
    const replay: StatusUpdate[] = [];
    const unsub2 = svc.subscribe("srv", (u) => replay.push(u));
    cleanups.push(unsub2);
    expect(replay).toHaveLength(1);
    expect(api.request.mock.calls.length).toBe(calls);
  });

  it("fetches the version only once across polls", async () => {
    const api = fakeApi();
    upThenWelcome(api);
    const svc = new ReachabilityStatusService(api);
    const unsub = svc.subscribe("srv", () => undefined);
    cleanups.push(unsub);
    await flush();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    const welcomeCalls = api.request.mock.calls.filter(([, p]) => p === "/").length;
    expect(welcomeCalls).toBe(1);
  });

  it("pauses polling while the document is hidden and resumes with a fresh check", async () => {
    const api = fakeApi();
    upThenWelcome(api);
    const svc = new ReachabilityStatusService(api);
    const updates: StatusUpdate[] = [];
    const unsub = svc.subscribe("srv", (u) => updates.push(u));
    cleanups.push(unsub);
    await flush();
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2);
    const whileHidden = updates.length;
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(updates.length).toBe(whileHidden + 1);
  });
});
