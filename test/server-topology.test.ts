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

import { describe, it, expect, vi, afterEach } from "vitest";
import { getContext } from "../src/context";
import type { ReplicatorDoc } from "../src/plugins/replication/types";
import type { Server } from "../src/plugins/server-mgmt/types";
import "../src/plugins/server-mgmt/server-topology";
import type { CcaServerTopology } from "../src/plugins/server-mgmt/server-topology";

let mounted: HTMLElement[] = [];

/** Drains the microtask queue the async load chain (Promise.all of two service calls) runs on. */
async function settle(el: CcaServerTopology) {
  for (let i = 0; i < 10; i++) {
    await el.updateComplete;
    await Promise.resolve();
  }
  await el.updateComplete;
}

async function mount(): Promise<CcaServerTopology> {
  const el = document.createElement("cca-server-topology") as CcaServerTopology;
  document.body.appendChild(el);
  mounted.push(el);
  await settle(el);
  return el;
}

const LOCAL_SERVER: Server = {
  id: "local",
  name: "localhost:5984",
  url: "http://localhost:5984",
  username: "admin",
  location: null,
  reachable: true,
  last_checked: null,
  couch_version: "3.5.0",
  created_at: "",
  updated_at: "",
  configured_idps: null,
  kind: "local",
};

afterEach(() => {
  for (const el of mounted) el.remove();
  mounted = [];
  vi.restoreAllMocks();
});

describe("cca-server-topology", () => {
  it("renders a legend explaining local vs. remote (not contacted) vs. continuous/one-time", async () => {
    vi.spyOn(getContext().serverMgmt, "getServer").mockResolvedValue(LOCAL_SERVER);
    vi.spyOn(getContext().replication, "listReplications").mockResolvedValue([]);

    const el = await mount();

    const legend = el.shadowRoot!.querySelector(".legend")!;
    // Normalized, because the legend prose wraps across source lines.
    const text = legend.textContent!.replace(/\s+/g, " ");
    expect(text).toContain("Local server unreachable");
    expect(text).toContain("Remote endpoint (not contacted)");
    // A remote node is a claim made by a local document, not something observed — the legend has
    // to say so, or the graph reads as if the remote side had been inspected (spec D10).
    expect(text).toContain("may not exist");
    expect(text).toContain("Database replicated from");
    expect(text).toContain("Database replicated to");
    expect(text).toContain("Database replicated both ways");
    expect(text).toContain("Continuous");
    expect(text).toContain("One-time");
    // The server swatch is the graph's own d3.symbol path, not a CSS approximation of it, so the
    // legend cannot come to disagree with what is drawn.
    expect(legend.querySelectorAll("svg.glyph path")).toHaveLength(2);
  });

  it("renders an error state instead of silently showing an empty graph when the load fails", async () => {
    vi.spyOn(getContext().serverMgmt, "getServer").mockResolvedValue(LOCAL_SERVER);
    vi.spyOn(getContext().replication, "listReplications").mockRejectedValue(
      new Error("replicator unreachable"),
    );

    const el = await mount();

    const callout = el.shadowRoot!.querySelector("[data-error]");
    expect(callout).not.toBeNull();
    expect(callout!.textContent).toContain("replicator unreachable");
    // No empty graph silently rendered underneath the error.
    expect(el.shadowRoot!.querySelector(".graph")).toBeNull();
    expect(el.shadowRoot!.querySelector(".legend")).toBeNull();
  });

  it("draws server, databases and the replication between them (#43)", async () => {
    const docs = [
      {
        _id: "r1",
        source: "http://localhost:5984/orders",
        target: "http://localhost:5984/orders_archive",
        continuous: true,
        replicator_doc_id: "r1",
      },
      {
        _id: "r2",
        source: "http://localhost:5984/customers",
        target: "http://localhost:5984/customers_archive",
        continuous: false,
        replicator_doc_id: "r2",
      },
    ] as unknown as ReplicatorDoc[];

    vi.spyOn(getContext().serverMgmt, "getServer").mockResolvedValue(LOCAL_SERVER);
    vi.spyOn(getContext().replication, "listReplications").mockResolvedValue(docs);

    const el = await mount();
    const svg = el.shadowRoot!.querySelector(".graph svg")!;

    // One server, drawn as a d3.symbol path rather than a circle; four databases as circles.
    expect(svg.querySelectorAll("g.node-server path")).toHaveLength(1);
    expect(svg.querySelectorAll("g.node-database circle")).toHaveLength(4);
    expect([...svg.querySelectorAll("g.node text")].map((t) => t.textContent)).toEqual([
      "localhost:5984",
      "orders",
      "orders_archive",
      "customers",
      "customers_archive",
    ]);

    // Both replications used to collapse onto a single local-to-local line, since only the
    // server ids reached this layer.
    const replications = svg.querySelectorAll("line.edge-replication");
    expect(replications).toHaveLength(2);
    expect([...replications].map((l) => l.getAttribute("stroke-dasharray"))).toEqual([
      // Continuous is solid, one-time dashed.
      null,
      "4 2",
    ]);
    // One structural line per database, arrowless: a server does not flow into its databases.
    const hosts = svg.querySelectorAll("line.edge-hosts");
    expect(hosts).toHaveLength(4);
    expect([...hosts].every((l) => l.getAttribute("marker-end") === null)).toBe(true);
  });

  it("draws a both-ways pair as one double-headed edge and a self-replication as a loop (#43)", async () => {
    const docs = [
      { _id: "r1", source: "a", target: "b", continuous: true, replicator_doc_id: "r1" },
      { _id: "r2", source: "b", target: "a", continuous: true, replicator_doc_id: "r2" },
      // Cannot run on CouchDB, and drew as a zero-length line before databases were nodes.
      { _id: "r3", source: "c", target: "c", continuous: false, replicator_doc_id: "r3" },
    ] as unknown as ReplicatorDoc[];

    vi.spyOn(getContext().serverMgmt, "getServer").mockResolvedValue(LOCAL_SERVER);
    vi.spyOn(getContext().replication, "listReplications").mockResolvedValue(docs);

    const el = await mount();
    const svg = el.shadowRoot!.querySelector(".graph svg")!;

    // `a` and `b` share one line, with a head at each end, rather than two lines on top of
    // each other.
    const replications = svg.querySelectorAll("line.edge-replication");
    expect(replications).toHaveLength(1);
    expect(replications[0].getAttribute("marker-start")).toBe("url(#arrow)");
    expect(replications[0].getAttribute("marker-end")).toBe("url(#arrow)");

    const selfLoop = svg.querySelectorAll("path.edge-self");
    expect(selfLoop).toHaveLength(1);
    expect(selfLoop[0].getAttribute("marker-end")).toBe("url(#arrow-tight)");

    const titles = [...svg.querySelectorAll("title")].map((t) => t.textContent);
    expect(titles).toContain("Replication, both ways: 2 documents, continuous");
    expect(titles).toContain("Database a on localhost:5984 — replicated both ways");
  });

  it("marks a node it never contacted as asserted rather than observed (#43)", async () => {
    const docs = [
      {
        _id: "r1",
        source: "http://localhost:5984/a",
        target: "https://remote.example:6984/mirror",
        continuous: true,
        replicator_doc_id: "r1",
      },
    ] as unknown as ReplicatorDoc[];

    vi.spyOn(getContext().serverMgmt, "getServer").mockResolvedValue(LOCAL_SERVER);
    vi.spyOn(getContext().replication, "listReplications").mockResolvedValue(docs);

    const el = await mount();
    const svg = el.shadowRoot!.querySelector(".graph svg")!;

    // Every shape belonging to a remote node is dashed and washed out; every local one is not.
    // A remote node exists only because a local document names it (spec D10), and the graph
    // must not draw that claim the same way it draws something the server confirmed.
    const dashed = [...svg.querySelectorAll("g.node path, g.node circle")].filter(
      (s) => s.getAttribute("stroke-dasharray") !== null,
    );
    expect(dashed).toHaveLength(2);
    expect(dashed.every((s) => s.getAttribute("fill-opacity") === "0.55")).toBe(true);
  });

  it("draws a node for a remote endpoint named by a replication, contacting only the two local services", async () => {
    const docs = [
      {
        _id: "r1",
        source: "http://localhost:5984/a",
        target: "https://remote.example:6984/mirror",
        continuous: true,
        replicator_doc_id: "r1",
      },
    ] as unknown as ReplicatorDoc[];

    vi.spyOn(getContext().serverMgmt, "getServer").mockResolvedValue(LOCAL_SERVER);
    const listReplications = vi
      .spyOn(getContext().replication, "listReplications")
      .mockResolvedValue(docs);
    // The component's only two calls are to these services. Spying on the shared ApiClient
    // too and asserting it is never reached directly is the strongest check available here
    // that no reachability probe ever fires against the synthesized remote node (spec D10) —
    // `buildTopology` itself is documented pure/sync with no I/O, and lint's
    // component -> service -> ApiClient layering rule means this component cannot reach
    // `fetch`/`XMLHttpRequest` directly even if it wanted to.
    const apiRequest = vi.spyOn(getContext().api, "request");

    const el = await mount();

    // d3's force simulation constructs nodes/links synchronously under happy-dom (no throw),
    // but position ticks fire off a timer this test never advances, so x/y/transform are not
    // asserted here — only the structural output: node/link counts and labels.
    const svg = el.shadowRoot!.querySelector(".graph svg");
    expect(svg).not.toBeNull();
    // Two servers, and the one database each of them holds.
    expect(svg!.querySelectorAll("g.node-server path")).toHaveLength(2);
    expect(svg!.querySelectorAll("g.node-database circle")).toHaveLength(2);
    expect(svg!.querySelectorAll("line.edge-replication")).toHaveLength(1);
    expect(svg!.querySelectorAll("line.edge-hosts")).toHaveLength(2);
    const labels = [...svg!.querySelectorAll("text")].map((t) => t.textContent);
    expect(labels).toContain("remote.example:6984");
    expect(labels).toContain("localhost:5984");
    expect(labels).toContain("a");
    expect(labels).toContain("mirror");
    // The remote database is named on the graph, but nothing about it was fetched: its node
    // exists purely because a local `_replicator` document spelled it out (spec D10).
    const titles = [...svg!.querySelectorAll("title")].map((t) => t.textContent);
    expect(titles).toContain(
      "Database mirror on remote.example:6984 (not contacted) — replicated to",
    );
    expect(titles).toContain("Remote endpoint remote.example:6984 (not contacted)");

    expect(listReplications).toHaveBeenCalledTimes(1);
    expect(apiRequest).not.toHaveBeenCalled();
  });
});
