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
import { LitElement } from "lit";
import "../src/plugins/replication/repl-filter-picker.js";
import type { CcaReplFilterPicker } from "../src/plugins/replication/repl-filter-picker.js";
import { getContext } from "../src/context";

class WaStub extends LitElement {
  value = "";
  open = false;
  createRenderRoot() {
    return this;
  }
}
for (const tag of ["wa-dialog", "wa-select", "wa-option", "wa-button", "wa-spinner"]) {
  if (!customElements.get(tag)) {
    customElements.define(tag, class extends WaStub {});
  }
}

function root(el: CcaReplFilterPicker): ShadowRoot {
  if (!el.shadowRoot) throw new Error("expected shadowRoot");
  return el.shadowRoot;
}

/** Drives the real wa-select change path. */
function selectValue(el: CcaReplFilterPicker, selector: string, value: string) {
  const select = root(el).querySelector(selector) as (HTMLElement & { value: string }) | null;
  if (!select) throw new Error(`expected ${selector} to be present`);
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

async function mountOpen(): Promise<CcaReplFilterPicker> {
  const el = document.createElement("cca-repl-filter-picker") as CcaReplFilterPicker;
  el.serverId = "s1";
  el.dbName = "db1";
  document.body.appendChild(el);
  await el.updateComplete;
  el.open = true;
  await el.updateComplete;
  await vi.waitFor(() =>
    expect(root(el).querySelectorAll("wa-option[data-ddoc]").length).toBeGreaterThan(0)
  );
  return el;
}

describe("cca-repl-filter-picker", () => {
  let el: CcaReplFilterPicker;
  afterEach(() => {
    el?.remove();
    vi.restoreAllMocks();
  });

  it("loads design docs on open and filters on ddoc selection, then emits the pick", async () => {
    const list = vi
      .spyOn(getContext().designMgmt, "listDesignDocs")
      .mockResolvedValue([{ ddoc_id: "_design/flows" } as never]);
    const get = vi
      .spyOn(getContext().designMgmt, "getDesignDoc")
      .mockResolvedValue({ filters: { byUser: "function(){}", byType: "function(){}" } });

    el = await mountOpen();
    expect(list).toHaveBeenCalledWith("s1", "db1");

    selectValue(el, "[data-ddoc-select]", "_design/flows");
    await vi.waitFor(() =>
      expect(root(el).querySelectorAll("wa-option[data-filter]").length).toBe(2)
    );
    expect(get).toHaveBeenCalledWith("s1", "db1", "_design/flows");

    let detail: { designDoc: string; filterName: string } | undefined;
    el.addEventListener("cca-filter-picked", (e) => {
      detail = (e as CustomEvent<{ designDoc: string; filterName: string }>).detail;
    });
    selectValue(el, "[data-filter-select]", "byUser");
    await el.updateComplete;
    (root(el).querySelector("[data-confirm]") as HTMLElement).dispatchEvent(new Event("click"));
    expect(detail).toEqual({ designDoc: "flows", filterName: "byUser" });
    expect(el.open).toBe(false);
  });

  it("shows an empty state for a ddoc without filters and keeps confirm disabled", async () => {
    vi.spyOn(getContext().designMgmt, "listDesignDocs").mockResolvedValue([
      { ddoc_id: "_design/plain" } as never
    ]);
    vi.spyOn(getContext().designMgmt, "getDesignDoc").mockResolvedValue({ views: {} });

    el = await mountOpen();
    selectValue(el, "[data-ddoc-select]", "_design/plain");
    await vi.waitFor(() => expect(root(el).querySelector("[data-no-filters]")).not.toBeNull());
    expect(root(el).querySelector("[data-confirm]")?.hasAttribute("disabled")).toBe(true);
  });

  it("shows an empty state when the database has no design docs", async () => {
    vi.spyOn(getContext().designMgmt, "listDesignDocs").mockResolvedValue([]);
    const picker = document.createElement("cca-repl-filter-picker") as CcaReplFilterPicker;
    picker.serverId = "s1";
    picker.dbName = "db1";
    document.body.appendChild(picker);
    picker.open = true;
    await picker.updateComplete;
    await vi.waitFor(() => expect(picker.shadowRoot?.querySelector("[data-no-ddocs]")).not.toBeNull());
    picker.remove();
  });

  it("emits cancel and closes", async () => {
    vi.spyOn(getContext().designMgmt, "listDesignDocs").mockResolvedValue([
      { ddoc_id: "_design/flows" } as never
    ]);
    el = await mountOpen();
    let cancelled = 0;
    el.addEventListener("cca-filter-pick-cancel", () => { cancelled += 1; });
    (root(el).querySelector("[data-cancel]") as HTMLElement).dispatchEvent(new Event("click"));
    expect(cancelled).toBe(1);
    expect(el.open).toBe(false);
  });

  it("toasts and shows the no-ddocs empty state when listDesignDocs rejects", async () => {
    const toastSpy = vi.spyOn(await import("../src/components/cca-toast.js"), "toast");
    vi.spyOn(getContext().designMgmt, "listDesignDocs").mockRejectedValue(new Error("boom"));

    const picker = document.createElement("cca-repl-filter-picker") as CcaReplFilterPicker;
    picker.serverId = "s1";
    picker.dbName = "db1";
    document.body.appendChild(picker);
    picker.open = true;
    await picker.updateComplete;

    await vi.waitFor(() =>
      expect(picker.shadowRoot?.querySelector("[data-no-ddocs]")).not.toBeNull()
    );
    expect(toastSpy).toHaveBeenCalledWith("boom", "error");
    picker.remove();
  });

  it("toasts and leaves the filter hint when getDesignDoc rejects", async () => {
    const toastSpy = vi.spyOn(await import("../src/components/cca-toast.js"), "toast");
    vi.spyOn(getContext().designMgmt, "listDesignDocs").mockResolvedValue([
      { ddoc_id: "_design/flows" } as never
    ]);
    vi.spyOn(getContext().designMgmt, "getDesignDoc").mockRejectedValue(new Error("kaboom"));

    el = await mountOpen();
    selectValue(el, "[data-ddoc-select]", "_design/flows");

    await vi.waitFor(() => expect(toastSpy).toHaveBeenCalledWith("kaboom", "error"));
    await el.updateComplete;
    expect(root(el).querySelector("[data-no-filters]")).toBeNull();
    expect(root(el).textContent).toContain("Choose a design document to list its filter functions.");
    expect(root(el).querySelector("[data-confirm]")?.hasAttribute("disabled")).toBe(true);
  });
});
