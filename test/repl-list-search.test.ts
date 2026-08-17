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

/**
 * Unit tests for the debounced search box on CcaReplList (#822).
 *
 * Mirrors test/server-list-search-debounce.test.ts: fake timers drive the debounce window,
 * type() dispatches `input` events directly on the (real) wa-input element, and the stale-response
 * test resolves two in-flight fetches out of order to prove the older one is dropped.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { MockInstance } from "vitest";
import { LitElement } from "lit";
import { getContext } from "../src/context";
import type { ReplicatorDoc } from "../src/plugins/replication/types.js";
import "../src/plugins/replication/repl-list.js";
import type { CcaReplList } from "../src/plugins/replication/repl-list.js";

// Stub wa-button/wa-icon/wa-dialog/cca-data-table so the component renders under happy-dom
// (verbatim from repl-list.test.ts). wa-input is left real: server-list-search-debounce.test.ts
// establishes that the real component works fine here without stubbing.
class WaStub extends LitElement {
  createRenderRoot() {
    return this;
  }
}
for (const tag of ["wa-button", "wa-icon", "wa-dialog", "cca-data-table"]) {
  if (!customElements.get(tag)) {
    customElements.define(tag, class extends WaStub {});
  }
}

const ROWS: ReplicatorDoc[] = [
  {
    source: "https://a/db",
    target: { url: "https://b/db" },
    continuous: true,
    cca_server_id: "srv1",
    cca_server_name: "Server 1",
    replicator_doc_id: "repl:1",
  },
];

/** The private surface the stale-response test drives directly. */
type Internals = {
  loading: boolean;
  replications: ReplicatorDoc[];
};

let mounted: HTMLElement[] = [];

/** Mount and let the initial connectedCallback load() (real timers) settle. */
async function mount(serverId = "$all"): Promise<CcaReplList> {
  const el = document.createElement("cca-repl-list") as CcaReplList;
  (el as unknown as { serverId: string }).serverId = serverId;
  document.body.appendChild(el);
  mounted.push(el);
  await el.updateComplete;
  await new Promise((r) => setTimeout(r, 0));
  await el.updateComplete;
  return el;
}

function searchInput(el: CcaReplList): HTMLInputElement {
  return el.shadowRoot!.querySelector("wa-input") as HTMLInputElement;
}

function type(el: CcaReplList, value: string) {
  const input = searchInput(el);
  (input as unknown as { value: string }).value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  vi.spyOn(getContext().replication, "listReplications").mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
  for (const node of mounted) {
    node.remove();
  }
  mounted = [];
  vi.restoreAllMocks();
});

describe("repl-list search debounce", () => {
  it("coalesces rapid keystrokes into one reload with the filter param", async () => {
    const el = await mount();
    const spy = getContext().replication.listReplications as unknown as MockInstance;
    spy.mockClear();
    vi.useFakeTimers();

    for (const v of ["i", "in", "inv"]) type(el, v);

    expect(spy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(250);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls.at(-1)![0]).toMatchObject({ filter: "inv" });
  });

  it("each keystroke restarts the debounce window", async () => {
    const el = await mount();
    const spy = getContext().replication.listReplications as unknown as MockInstance;
    spy.mockClear();
    vi.useFakeTimers();

    type(el, "i");
    vi.advanceTimersByTime(200);
    type(el, "in");
    vi.advanceTimersByTime(200);
    expect(spy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("reloads immediately on clear with no filter", async () => {
    const el = await mount();
    const spy = getContext().replication.listReplications as unknown as MockInstance;
    spy.mockClear();
    vi.useFakeTimers();

    type(el, "inv");
    searchInput(el).dispatchEvent(new CustomEvent("wa-clear", { bubbles: true }));

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls.at(-1)![0] ?? {}).not.toHaveProperty("filter");

    // The pending keystroke reload must have been cancelled, not merely raced.
    vi.advanceTimersByTime(1000);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("never sends server_ids, regardless of the routed server", async () => {
    const spy = getContext().replication.listReplications as unknown as MockInstance;

    await mount("server:1");
    expect(spy.mock.calls.at(-1)![0]).toEqual({});

    spy.mockClear();

    await mount("$all");
    expect(spy.mock.calls.at(-1)![0]).toEqual({});
  });

  it("drops a stale response that resolves after a newer one", async () => {
    const el = await mount();
    const spy = getContext().replication.listReplications as unknown as MockInstance;
    spy.mockClear();
    let resolveStale!: (v: ReplicatorDoc[]) => void;
    let resolveCurrent!: (v: ReplicatorDoc[]) => void;
    spy
      .mockImplementationOnce(() => new Promise((r) => { resolveStale = r; }))
      .mockImplementationOnce(() => new Promise((r) => { resolveCurrent = r; }));
    vi.useFakeTimers();

    type(el, "i");
    vi.advanceTimersByTime(250); // reload 1 (will become stale) in flight
    searchInput(el).dispatchEvent(new CustomEvent("wa-clear", { bubbles: true })); // reload 2 (current)
    expect(spy).toHaveBeenCalledTimes(2);

    const internals = el as unknown as Internals;
    const stale: ReplicatorDoc[] = [
      { source: "https://stale/db", target: { url: "https://stale-b/db" }, continuous: false, replicator_doc_id: "repl:stale" },
    ];

    // The stale response lands first: it must neither replace the rows nor clear the loading flag
    // while the newer request is still in flight.
    resolveStale(stale);
    await vi.advanceTimersByTimeAsync(0);
    expect(internals.loading).toBe(true);
    expect(internals.replications).not.toEqual(stale);

    resolveCurrent(ROWS);
    await vi.advanceTimersByTimeAsync(0);
    expect(internals.replications).toEqual(ROWS);
    expect(internals.loading).toBe(false);
  });
});
