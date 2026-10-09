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

import { describe, it, expect, afterEach, vi } from "vitest";
import { getContext } from "../src/context";
import "../src/plugins/replication/repl-endpoint";
import type { CcaReplEndpoint } from "../src/plugins/replication/repl-endpoint";
import type { ReplEndpointChangeDetail } from "../src/plugins/replication/types";

async function mount(kind: "source" | "target"): Promise<CcaReplEndpoint> {
  const el = document.createElement("cca-repl-endpoint") as CcaReplEndpoint;
  el.kind = kind;
  el.serverUrl = "https://a:5984";
  el.database = "db1";
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

function collect(el: CcaReplEndpoint): ReplEndpointChangeDetail[] {
  const events: ReplEndpointChangeDetail[] = [];
  el.addEventListener("cca-endpoint-change", (e) =>
    events.push((e as CustomEvent<ReplEndpointChangeDetail>).detail),
  );
  return events;
}

describe("cca-repl-endpoint", () => {
  it("renders server, authentication, database — in that order", async () => {
    const el = await mount("source");
    const root = el.shadowRoot!;
    const text = root.textContent!;
    // The auth panel renders its own title inside its shadow root, so check
    // the title it was given and its DOM position rather than shadow text.
    const panel = root.querySelector("cca-repl-auth-panel")!;
    expect(panel.getAttribute("title")).toBe("Source Authentication");
    const server = root.querySelector("wa-input[data-server-url]")!;
    const db = root.querySelector("wa-input[data-database]")!;
    const follows = Node.DOCUMENT_POSITION_FOLLOWING;
    expect(server.compareDocumentPosition(panel) & follows).toBeTruthy();
    expect(panel.compareDocumentPosition(db) & follows).toBeTruthy();
    expect(text).toContain("Source Server");
    expect(text).toContain("Source Database");
  });

  it("labels the target variant 'Target Server'", async () => {
    const el = await mount("target");
    expect(el.shadowRoot!.textContent).toContain("Target Server");
    expect(el.shadowRoot!.textContent).not.toContain("Target URL");
  });

  it("emits cca-endpoint-change when the server URL is edited", async () => {
    const el = await mount("source");
    const events = collect(el);
    const input = el.shadowRoot!.querySelector<HTMLInputElement>("wa-input[data-server-url]")!;
    input.value = "http://remote:5984";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(events).toEqual([{ kind: "source", serverUrl: "http://remote:5984" }]);
  });

  it("emits cca-endpoint-change when the database is edited", async () => {
    const el = await mount("target");
    const events = collect(el);
    const input = el.shadowRoot!.querySelector<HTMLInputElement>("wa-input[data-database]")!;
    input.value = "orders";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(events).toEqual([{ kind: "target", database: "orders" }]);
  });

  it("forwards auth-panel changes as cca-endpoint-change", async () => {
    const el = await mount("source");
    const events = collect(el);
    const panel = el.shadowRoot!.querySelector("cca-repl-auth-panel")!;
    panel.dispatchEvent(
      new CustomEvent("cca-auth-change", {
        detail: { auth: { Authorization: "Bearer t" } },
        bubbles: true,
        composed: true,
      }),
    );
    expect(events).toEqual([
      { kind: "source", auth: { Authorization: "Bearer t" } },
    ]);
  });

  it("offers Clear only when a database is set, and clearing emits an empty database", async () => {
    const el = await mount("source");
    const events = collect(el);
    el.shadowRoot!.querySelector<HTMLElement>("[data-clear-database]")!.click();
    expect(events).toEqual([{ kind: "source", database: "" }]);
    el.database = "";
    await el.updateComplete;
    expect(el.shadowRoot!.querySelector("[data-clear-database]")).toBeNull();
  });

  it("enables the browse button only while a server URL is entered", async () => {
    const el = await mount("source");
    const btn = () => el.shadowRoot!.querySelector("wa-button[data-browse-dbs]")!;
    expect(btn().hasAttribute("disabled")).toBe(false);
    el.serverUrl = "   ";
    await el.updateComplete;
    expect(btn().hasAttribute("disabled")).toBe(true);
  });

  it("opens the database browser with the entered server and the editor-supplied request auth", async () => {
    const spy = vi
      .spyOn(getContext().replication, "listDatabases")
      .mockResolvedValue([{ db_name: "crm", doc_count: 3 }]);
    const el = await mount("source");
    el.requestAuth = { Authorization: "Bearer t" };
    await el.updateComplete;
    el.shadowRoot!.querySelector<HTMLElement>("wa-button[data-browse-dbs]")!.click();
    await new Promise((r) => setTimeout(r));
    expect(spy).toHaveBeenCalledWith({
      serverUrl: "https://a:5984",
      headers: { Authorization: "Bearer t" },
    });
    const browser = el.shadowRoot!.querySelector("cca-repl-db-browser")!;
    await browser.updateComplete;
    expect(browser.shadowRoot!.querySelector("wa-dialog")!.hasAttribute("open")).toBe(true);
    expect(browser.shadowRoot!.querySelector('[data-db="crm"]')).not.toBeNull();
  });

  it("surfaces a picked database as cca-endpoint-change", async () => {
    const el = await mount("target");
    const events = collect(el);
    el.shadowRoot!.querySelector("cca-repl-db-browser")!.dispatchEvent(
      new CustomEvent("cca-db-browse-pick", {
        detail: { database: "orders" },
        bubbles: true,
        composed: true,
      }),
    );
    expect(events).toEqual([{ kind: "target", database: "orders" }]);
  });

  it("renders the hint when given", async () => {
    const el = await mount("target");
    el.hint = "A target on this server still needs a full URL.";
    await el.updateComplete;
    expect(el.shadowRoot!.textContent).toContain("still needs a full URL");
  });
});
