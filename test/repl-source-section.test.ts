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

import { describe, it, expect, afterEach } from "vitest";
import { LitElement } from "lit";
import "../src/plugins/replication/repl-source-section.js";
import type { CcaReplSourceSection } from "../src/plugins/replication/repl-source-section.js";

class WaStub extends LitElement {
  value = "";
  createRenderRoot() {
    return this;
  }
}
for (const tag of ["wa-details", "wa-select", "wa-option", "wa-input"]) {
  if (!customElements.get(tag)) {
    customElements.define(tag, class extends WaStub {});
  }
}

function root(el: CcaReplSourceSection): ShadowRoot {
  if (!el.shadowRoot) throw new Error("expected shadowRoot");
  return el.shadowRoot;
}

type Picker = HTMLElement & {
  databases: string[];
  value: string;
  unavailable: boolean;
  reason: string;
  updateComplete: Promise<boolean>;
};

const picker = (el: CcaReplSourceSection) =>
  root(el).querySelector("cca-db-picker") as Picker | null;

/** The picker's own shadow root — where the wa-select / wa-input actually lives. */
function pickerRoot(el: CcaReplSourceSection): ShadowRoot {
  const found = picker(el);
  if (!found?.shadowRoot) throw new Error("expected cca-db-picker shadowRoot");
  return found.shadowRoot;
}

const pickerOptions = (el: CcaReplSourceSection) =>
  [...pickerRoot(el).querySelectorAll("wa-option")].map((o) =>
    o.getAttribute("value"),
  );

async function mount(
  props: Partial<CcaReplSourceSection> = {},
): Promise<CcaReplSourceSection> {
  const el = document.createElement(
    "cca-repl-source-section",
  ) as CcaReplSourceSection;
  Object.assign(el, props);
  document.body.appendChild(el);
  await el.updateComplete;
  await picker(el)?.updateComplete;
  return el;
}

/** Collects cca-source-db-change details at the section boundary. */
function listen(el: CcaReplSourceSection): { sourceDb: string }[] {
  const seen: { sourceDb: string }[] = [];
  el.addEventListener("cca-source-db-change", (e) =>
    seen.push((e as CustomEvent<{ sourceDb: string }>).detail),
  );
  return seen;
}

describe("cca-repl-source-section", () => {
  let el: CcaReplSourceSection;

  afterEach(() => el?.remove());

  it("lays out a read-only server label, database picker and auth on one row", async () => {
    el = await mount();

    const row = root(el).querySelector(".row");
    // Exactly one database control, and it is the shared picker — the source
    // server is fixed (this deployment manages exactly one CouchDB server) and
    // shown as a read-only label instead of a picker (Task 3). The picker owns
    // its own select/input inside its shadow root, so the section's own row
    // must carry no bare wa-select at all.
    expect(row?.querySelectorAll("cca-db-picker").length).toBe(1);
    expect(row?.querySelectorAll("wa-select").length).toBe(0);
    expect(row?.querySelector(".static-value")).toBeTruthy();
    expect(row?.querySelector("cca-repl-auth-panel")).toBeTruthy();
  });

  it("shows the local server in the read-only label, not a picker", async () => {
    el = document.createElement(
      "cca-repl-source-section",
    ) as CcaReplSourceSection;
    el.servers = [{ id: "local", name: "couchdb:5984", url: "https://couchdb:5984" }];
    el.sourceServer = "local";
    document.body.appendChild(el);
    await el.updateComplete;

    expect(root(el).querySelector(".static-value")?.textContent).toContain(
      "couchdb:5984",
    );
    expect(root(el).querySelector("wa-select[value=local]")).toBeNull();
  });

  it("re-dispatches cca-auth-change as cca-source-auth-change", async () => {
    el = document.createElement(
      "cca-repl-source-section",
    ) as CcaReplSourceSection;
    document.body.appendChild(el);
    await el.updateComplete;

    const panel = root(el).querySelector("cca-repl-auth-panel")!;
    let detail: { auth: Record<string, string> } | undefined;
    el.addEventListener("cca-source-auth-change", (e) => {
      detail = (e as CustomEvent<{ auth: Record<string, string> }>).detail;
    });

    panel.dispatchEvent(
      new CustomEvent("cca-auth-change", {
        detail: { auth: { Authorization: "Bearer x" } },
        bubbles: true,
        composed: true,
      }),
    );

    expect(detail?.auth).toEqual({ Authorization: "Bearer x" });
  });

  // ── The database list, and what happens when CouchDB refuses to produce it (#5) ──

  it("forwards the fetched database list to the picker", async () => {
    el = await mount({ databases: ["orders", "invoices"] });

    expect(picker(el)).toBeTruthy();
    expect(picker(el)!.databases).toEqual(["orders", "invoices"]);
    expect(pickerOptions(el)).toEqual(["orders", "invoices"]);
    expect(pickerRoot(el).querySelector("wa-input")).toBeNull();
  });

  it("translates the picker's cca-db-change into cca-source-db-change", async () => {
    el = await mount({ databases: ["orders", "invoices"] });
    expect(picker(el)).toBeTruthy();
    const seen = listen(el);

    picker(el)!.dispatchEvent(
      new CustomEvent("cca-db-change", {
        detail: { database: "invoices" },
        bubbles: true,
        composed: true,
      }),
    );

    expect(seen).toEqual([{ sourceDb: "invoices" }]);
  });

  it("keeps a preselected source database that is absent from the list visible", async () => {
    el = await mount({ databases: ["orders"], sourceDb: "legacy_archive" });

    expect(picker(el)).toBeTruthy();
    expect(picker(el)!.value).toBe("legacy_archive");
    expect(pickerOptions(el)).toContain("legacy_archive");
    expect(pickerOptions(el)).toContain("orders");
  });

  it("degrades to a free-text field with the reason when the list is unavailable", async () => {
    el = await mount({
      databasesUnavailable: true,
      databasesReason: "Listing the databases is a server-administrator action.",
    });

    expect(picker(el)).toBeTruthy();
    expect(pickerRoot(el).querySelector("wa-select")).toBeNull();
    expect(pickerRoot(el).querySelector("wa-input")).toBeTruthy();
    expect(pickerRoot(el).textContent).toContain(
      "Listing the databases is a server-administrator action.",
    );
  });

  it("emits cca-source-db-change for a name typed into the free-text field", async () => {
    el = await mount({ databasesUnavailable: true, databasesReason: "no list" });
    expect(picker(el)).toBeTruthy();
    const seen = listen(el);

    const input = pickerRoot(el).querySelector("wa-input") as HTMLElement & {
      value: string;
    };
    input.value = "typed_by_hand";
    input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));

    expect(seen).toEqual([{ sourceDb: "typed_by_hand" }]);
  });

  // The wa-select the picker replaced carried a blank `Select database` option,
  // which was the only way to un-choose a database. cca-db-picker renders a
  // placeholder instead of that option, so the affordance has to live here.
  it("offers a clear control that puts the source database back to empty", async () => {
    el = await mount({ databases: ["orders"], sourceDb: "orders" });
    const seen = listen(el);

    const clear = root(el).querySelector(
      "[data-clear-source-db]",
    ) as HTMLElement | null;
    expect(clear).toBeTruthy();
    clear!.click();

    expect(seen).toEqual([{ sourceDb: "" }]);
  });

  it("clears from the free-text state too", async () => {
    el = await mount({
      databasesUnavailable: true,
      databasesReason: "no list",
      sourceDb: "typed_by_hand",
    });
    const seen = listen(el);

    (root(el).querySelector("[data-clear-source-db]") as HTMLElement).click();

    expect(seen).toEqual([{ sourceDb: "" }]);
  });

  it("hides the clear control when no source database is selected", async () => {
    el = await mount({ databases: ["orders"] });

    expect(root(el).querySelector("[data-clear-source-db]")).toBeNull();
  });
});
